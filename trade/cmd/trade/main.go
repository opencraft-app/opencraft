package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.woa.com/wisp/mono/trade/internal/config"
	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
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

	// shadow 反向调用客户端（迭代 8B-1）：
	//   - 询价 (inquiry.Service.Quote) / 下单 (placeorder.Service.PlaceOrder) 在调用方
	//     未显式提供 uin/app_id 时，按 externalUserId 反查云账号身份
	//   - cfg.ShadowInternalBaseURL 已在 config.Load() 强校验非空
	shadowClient := shadowclient.New(cfg.ShadowInternalBaseURL, cfg.InternalServiceToken)

	// jifei CGW 出向客户端（迭代 8A）：
	//   - 询价：GetPrice
	//   - 下单：GenerateDeals
	//
	// 配置缺失（JifeiCGWGatewayURL 空）允许启动 — 内部 RPC 调用时会因 baseURL 空报错；
	// 这是为了让"仅承载 jifei 回调的本地起服"也能工作（联调期未配置出向）。
	jifeiClient := jifeiclient.New(
		cfg.JifeiCGWGatewayURL,
		cfg.JifeiComponentName, // 复用 trade 自家 componentName 作为 x-qcloud-user-id 兜底
	)

	// 业务 service 装配（迭代 8A，8B-1 起注入 shadowClient）：
	//   - inquiry：批量询价
	//   - placeorder：下单 + pay-url
	inquirySvc := inquiry.New(inquiry.Deps{
		CTLClient:    ctlClient,
		BundleStore:  mysqlStore,
		JifeiClient:  jifeiClient,
		ShadowClient: shadowClient,
	})
	placeOrderSvc := placeorder.New(placeorder.Deps{
		CTLClient:    ctlClient,
		BundleStore:  mysqlStore,
		JifeiClient:  jifeiClient,
		OrderWriter:  mysqlStore,
		OrderStore:   mysqlStore,
		ShadowClient: shadowClient,
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
		// 迭代 8A 起：内部 RPC 业务 service。
		InquiryService:    inquirySvc,
		PlaceOrderService: placeOrderSvc,
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

	log.Printf("trade listening on %s", cfg.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen and serve: %v", err)
	}
	cancelRoot()
}
