package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.woa.com/wisp/mono/trade/internal/cloudbillingclient"
	"git.woa.com/wisp/mono/trade/internal/config"
	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/dianshiclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/logic/activity"
	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/orderstatus"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/shadowclient"
	"git.woa.com/wisp/mono/trade/internal/store"
	"git.woa.com/wisp/mono/trade/internal/worker"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	mysqlStore, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init mysql store: %v", err)
	}
	defer mysqlStore.Close()

	// ctl 反向调用客户端：
	//   - checkCreate 阶段（迭代 5）：GetBundleByID + ListPassesByUser
	//   - createResource 阶段（迭代 6）：CompletePass
	//   - 询价 / 下单（迭代 8A）：GetBundleByID（确认 bundle 存在 + 在售）
	ctlClient := ctlclient.New(cfg.CtlInternalBaseURL, cfg.InternalServiceToken)

	// account binding 反向调用客户端（迭代 8B-1）：
	//   - 询价 (inquiry.Service.Quote) / 下单 (placeorder.Service.PlaceOrder) 在调用方
	//     未显式提供 uin/app_id 时，按 externalUserId 反查云账号身份
	//   - cfg.AccountBindingInternalBaseURL 已在 config.Load() 强校验非空
	shadowResolverClient := shadowclient.New(cfg.AccountBindingInternalBaseURL, cfg.InternalServiceToken)
	var shadowClient shadowclient.Client = shadowResolverClient
	var shadowCredentialClient shadowclient.CredentialClient = shadowResolverClient
	if cfg.ShadowMockEnabled {
		shadowClient = newMockShadowClient(cfg.ShadowMockUin, cfg.ShadowMockAppID)
		shadowCredentialClient = nil
		log.Printf("[shadow] mock enabled")
	}

	// jifei CGW 出向客户端（迭代 8A）：
	//   - 询价：GetPrice
	//   - 下单：GenerateDeals
	//
	// 配置缺失（JifeiCGWGatewayURL 空）允许启动 — 内部 RPC 调用时会因 baseURL 空报错；
	// 这是为了让"仅承载 jifei 回调的本地起服"也能工作（联调期未配置出向）。
	//
	// **v1.7.4 协议校准**：第二参数改为 cfg.JifeiCGWXQCloudUserID（仅测试环境带，
	// 测试 uin 如 700000164995；现网空字符串 → jifeiclient.do 跳过 x-qcloud-user-id
	// header 注入，由部署侧出口 IP 鉴权）。原值 cfg.JifeiComponentName 是 9B 期占位。
	//
	// **Q-D-SIG-1~6 销毁链路签名分叉**：通过 Options 注入 jifei 计费网关三件套
	// （BillingAPIGWBaseURL / BillingAppID / BillingAppSecret），ModifyResourceStatus
	// 出向时由 jifeiclient 内部走 doSigned 路径，HMAC-SHA256 签名 envelope.interface.auth；
	// 询价 / 下单 / 支付不受影响仍走非签名路径。三者任一为空时，仅在调用 ModifyResourceStatus
	// 时报错，不影响其他接口（联调期允许销毁链路未配置时启动）。
	jifeiClient := jifeiclient.New(
		cfg.JifeiCGWGatewayURL,
		cfg.JifeiCGWXQCloudUserID,
		jifeiclient.Options{
			BillingAPIGWBaseURL: cfg.JifeiBillingAPIGWURL,
			BillingAppID:        cfg.JifeiBillingAppID,
			BillingAppSecret:    cfg.JifeiBillingAppSecret,
			// v1.7.x 国际站接入 A3：出向 envelope.interface.extraPara 按 site 注入
			// site / language（intl → site="2" language="en"；cn / 空 / 非法 → 不注入）。
			SiteKind: cfg.SiteKind,
		},
	)

	var cloudBillingClient cloudbillingclient.Client
	if cfg.SiteKind == "intl" {
		billingClient, billingErr := cloudbillingclient.NewTencentCloudClient(cloudbillingclient.Config{
			Region:        cfg.BillingCloudAPIRegion,
			Endpoint:      cfg.BillingCloudAPIEndpoint,
			XQCloudUserID: cfg.BillingCloudAPIXQCloudUserID,
			CloudLadder: cloudbillingclient.CloudLadderConfig{
				GatewayBaseURL: cfg.BillingCloudAPICloudLadderGatewayURL,
				RouteID:        cfg.BillingCloudAPICloudLadderRouteID,
				Secret:         cfg.BillingCloudAPICloudLadderHMACSecret,
			},
		})
		if billingErr != nil {
			log.Printf("[billing-cloudapi] unavailable: %v", billingErr)
		} else {
			cloudBillingClient = billingClient
			log.Printf("[billing-cloudapi] activated: endpoint=%s routeID=%s",
				cfg.BillingCloudAPIEndpoint, cfg.BillingCloudAPICloudLadderRouteID)
		}
	}

	// 点石出向客户端 + 活动 Resolver（设计稿 .tmp/dianshi-activity-bundle-design.md §5.1 / §5.2）。
	//
	// 同进同退语义：仅在 cfg.DianshiPriceBaseURL + cfg.DianshiOrderBaseURL 同时非空时构造
	// dianshiClient + activityResolver；部分缺失已在 config.Load fail-fast 拦住，此处只看
	// 全部非空 / 都为空两种合法状态。为 nil 时 inquiry / placeorder / createresource 都走
	// jifei 单路径，与 v1.7.x 历史行为完全一致。
	var (
		dianshiClient    dianshiclient.Client
		activityResolver activity.Resolver
	)
	if cfg.DianshiPriceBaseURL != "" && cfg.DianshiOrderBaseURL != "" {
		dianshiClient = dianshiclient.New(cfg.DianshiPriceBaseURL, cfg.DianshiOrderBaseURL)
		activityResolver = activity.NewResolver(mysqlStore)
		log.Printf("[dianshi] activated: priceBaseURL=%s orderBaseURL=%s",
			cfg.DianshiPriceBaseURL, cfg.DianshiOrderBaseURL)
	} else {
		log.Printf("[dianshi] disabled: DIANSHI_PRICE_BASE_URL / DIANSHI_ORDER_BASE_URL not set; activity branch will not be activated")
	}

	// 业务 service 装配（迭代 8A，8B-1 起注入 shadowClient）：
	//   - inquiry：批量询价
	//   - placeorder：下单 + pay-url
	inquirySvc := inquiry.New(inquiry.Deps{
		CTLClient:    ctlClient,
		BundleStore:  mysqlStore,
		JifeiClient:  jifeiClient,
		ShadowClient: shadowClient,
		// v1.7.x 国际站接入 A6.1：出向 GetPrice envelope.resInfo.region/zone/currency 按 site 决定。
		SiteKind: cfg.SiteKind,
		// 北京 2 预发布接入 2026-06-12：region 字段 override（LIGHTVELA_TRADE_REGION env）。
		RegionOverride: cfg.RegionOverride,
		// 询价专用 shadow binding 兜底身份；付费下单仍由 placeorder 强校验真实绑定。
		InquiryFallbackUin:   cfg.InquiryFallbackUin,
		InquiryFallbackAppID: cfg.InquiryFallbackAppID,
		// 点石活动接入（设计稿 §5.3）：同进同退，都为 nil 时 inquiry 走 jifei 单路径。
		ActivityResolver: activityResolver,
		DianshiClient:    dianshiClient,
	})
	placeOrderSvc := placeorder.New(placeorder.Deps{
		CTLClient:              ctlClient,
		BundleStore:            mysqlStore,
		JifeiClient:            jifeiClient,
		CloudBillingClient:     cloudBillingClient,
		ShadowCredentialClient: shadowCredentialClient,
		PaymentContextClient:   shadowResolverClient,
		BillingPayRedirectURL:  cfg.BillingCloudAPIPayRedirectURL,
		OrderWriter:            mysqlStore,
		OrderStore:             mysqlStore,
		ShadowClient:           shadowClient,
		// v1.7.x 国际站接入 A6.1：出向 envelope.resInfo.region/zone + trade_order.region_id
		// 同源同值，按 site 决定。
		SiteKind: cfg.SiteKind,
		// 北京 2 预发布接入 2026-06-12：region 字段 override（LIGHTVELA_TRADE_REGION env）。
		RegionOverride: cfg.RegionOverride,
		// 点石活动接入（设计稿 §5.4）：同进同退，都为 nil 时 placeorder 走 jifei 单路径。
		ActivityResolver: activityResolver,
		DianshiClient:    dianshiClient,
	})

	// v1.7.32：订单状态反查业务 service（设计稿 .tmp/ctl-order-status-query-design.md §5.2）。
	orderStatusSvc := orderstatus.New(orderstatus.Deps{
		OrderStore:  mysqlStore,
		OrderWriter: mysqlStore,
		JifeiClient: jifeiClient,
	})

	router := httpapi.NewRouter(httpapi.ServerConfig{
		InternalServiceToken:    cfg.InternalServiceToken,
		JifeiComponentName:      cfg.JifeiComponentName,
		JifeiProtocolVersion:    cfg.JifeiProtocolVersion,
		JifeiOurInterfacePrefix: cfg.JifeiOurInterfacePrefix,
		// 迭代 5：checkCreate handler 业务依赖。
		OrderStore:  mysqlStore,
		BundleStore: mysqlStore,
		CTLClient:   ctlClient,
		// 迭代 6：createResource handler 抢占式幂等。
		FlowStore: mysqlStore,
		// 迭代 8A 起：trade_order 写端 DAO 已实现，注入 mysqlStore；
		// createResource handler 在收尾阶段反向回填 resource_id + status='provisioned'。
		OrderUpdater: mysqlStore,
		// 点石活动接入（设计稿 §5.6）：createResource handler 在 trade_order.source='dianshi'
		// 时 INSERT participation。两者同进同退；activityResolver==nil 时一并传 nil，
		// createResource handler 自动跳过 participation 分支。
		ActivityStore: func() store.ActivityStore {
			if activityResolver != nil {
				return mysqlStore
			}
			return nil
		}(),
		ActivityDB: func() *sql.DB {
			if activityResolver != nil {
				return mysqlStore.DB()
			}
			return nil
		}(),
		// 点石后台管理查询/删除入口：用于 admin 侧清理订单/参与记录后重试下单。
		DianshiAdminStore: mysqlStore,
		// 迭代 8A 起：内部 RPC 业务 service。
		InquiryService:    inquirySvc,
		PlaceOrderService: placeOrderSvc,
		// D-2 销毁链路用户主动入口（设计稿 §3.5 + §11-A Q26）：
		// internalapi.deleteResourceHandler 调 JifeiClient.ModifyResourceStatus(PRE_DESTROY)。
		JifeiClient: jifeiClient,
		// v1.7.32 订单状态反查业务 service。
		OrderStatusService: orderStatusSvc,
		// v1.7.x 国际站接入 A6.1 + A6.2 + A6.3：由 server.NewRouter 内部贯穿到
		// internalapi.Deps.SiteKind / destroyresource.Deps.SiteKind / isolateresource.Deps.SiteKind /
		// queryflow.Deps.SiteKind / resourcequery.Deps.SiteKind 五个下游注入点。
		SiteKind: cfg.SiteKind,
		// 北京 2 预发布接入 2026-06-12：region 字段 override，与 SiteKind 同路径贯穿到
		// 上述 5 个下游注入点。
		RegionOverride: cfg.RegionOverride,
	})

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// 迭代 7：trade_flow reconcile worker（Q61 兜底分支）。
	//   - 周期扫描 status='in_progress' AND created_time < NOW()-30min 的孤儿记录
	//   - Prober 本期为 nil（保守模式：仅日志告警，不自动升级状态）；
	//     迭代 8 ctl 暴露按 dealName 反查 pass 的接口后，注入真实 prober 自动升级
	//   - 优雅停机：捕获 SIGINT/SIGTERM 后 cancel ctx，worker 退出后再关 HTTP server
	reconcileWorker := worker.New(mysqlStore, worker.Config{
		// 全部走默认值（Interval=5min, StaleThreshold=30min, BatchLimit=100）
	})
	rootCtx, cancelRoot := context.WithCancel(context.Background())
	go reconcileWorker.Run(rootCtx)

	// 信号处理：SIGINT / SIGTERM → 关停 worker + http server
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		s := <-sigCh
		log.Printf("trade received signal %v, shutting down...", s)
		cancelRoot()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("http server shutdown error: %v", err)
		}
	}()

	// v1.7.x 国际站接入：启动日志加 site/region 一行，便于排障时一眼看出当前 Pod
	// 跳到哪个站点 / 哪个地域（cn=广州 1/100001 / intl=Singapore 9/900001）。
	// 北京 2 预发布接入 2026-06-12：region 字段受 LIGHTVELA_TRADE_REGION env override（例：
	// SiteKind=cn + RegionOverride=ap-beijing → 8/800001/北京）。
	lhRegion := region.Resolve(cfg.SiteKind, cfg.RegionOverride)
	log.Printf("trade listening on %s (siteKind=%q regionOverride=%q regionId=%d zoneId=%d regionName=%s)",
		cfg.Addr, cfg.SiteKind, cfg.RegionOverride, lhRegion.RegionID, lhRegion.ZoneID, lhRegion.RegionName)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen and serve: %v", err)
	}
	cancelRoot()
}
