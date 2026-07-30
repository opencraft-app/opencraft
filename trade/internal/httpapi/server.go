package httpapi

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/internalapi"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/logic/checkcreate"
	"git.woa.com/wisp/mono/trade/internal/logic/checkrenew"
	"git.woa.com/wisp/mono/trade/internal/logic/createresource"
	"git.woa.com/wisp/mono/trade/internal/logic/destroyresource"
	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/isolateresource"
	"git.woa.com/wisp/mono/trade/internal/logic/orderstatus"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
	"git.woa.com/wisp/mono/trade/internal/logic/queryflow"
	"git.woa.com/wisp/mono/trade/internal/logic/renewresource"
	"git.woa.com/wisp/mono/trade/internal/logic/resourcequery"
	"git.woa.com/wisp/mono/trade/internal/logic/transferresource"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ServerConfig 是 NewRouter 的输入参数。
type ServerConfig struct {
	// InternalServiceToken 用于校验 ctl → trade 内部接口调用方身份。
	InternalServiceToken string

	// JifeiComponentName / JifeiProtocolVersion / JifeiOurInterfacePrefix 是
	// jifei callback dispatcher（Q60）+ 出口 framework builder（Q58）的协议层配置；
	// 由 cmd/trade/main.go 从 config.Config 直传到此结构。
	JifeiComponentName      string
	JifeiProtocolVersion    string
	JifeiOurInterfacePrefix string

	// 迭代 5 起新增：jifei 回调 handler 的业务依赖。
	//   - OrderStore：trade_order 反查（§5.2 #3/#4 + §6.2 T2）
	//   - BundleStore：trade_bundle_definition 反查（Q54 5 维对账，仅 checkCreate 用）
	//   - CTLClient：ctl/bundle + ctl/pass 反向调
	//
	// 迭代 6 起新增：
	//   - FlowStore：trade_flow 抢占式幂等（Q61，仅 createResource 用）
	//   - OrderUpdater：trade_order 反向回填 resource_id（迭代 8A 真实接线后填 mysqlStore）
	//
	// 迭代 8A 起新增：
	//   - InquiryService / PlaceOrderService：内部 RPC `/internal/trade/inquiry/batch`、
	//     `/internal/trade/orders`、`/internal/trade/orders/:dealName/pay-url` 的业务实现
	//
	// OrderStore / BundleStore / CTLClient / FlowStore / InquiryService / PlaceOrderService
	// 必填，nil 视为编程错（没接好线），NewRouter 会 panic 让启动期立即暴露。
	// OrderUpdater 允许 nil（向后兼容旧调用方；迭代 8A 起 main.go 应注入 mysqlStore）。
	OrderStore        store.OrderStore
	BundleStore       store.BundleDefinitionStore
	CTLClient         ctlclient.Client
	FlowStore         store.FlowStore
	OrderUpdater      createresource.OrderProvisionUpdater
	InquiryService    *inquiry.Service
	PlaceOrderService *placeorder.Service

	// ActivityStore 是点石活动写端（设计稿 .tmp/dianshi-activity-bundle-design.md §5.6.1 / §3.2）。
	// 允许 nil；nil 时 createResource handler 跳过 INSERT participation 分支，
	// 与 v1.7.x 历史行为完全一致（jifei 单路径）。main.go 在 cfg.DianshiPriceBaseURL +
	// cfg.DianshiOrderBaseURL 同时非空时才注入 mysqlStore；两者同进同退。
	ActivityStore store.ActivityStore

	// ActivityDB 是 trade 主库 *sql.DB，createResource handler 在 source=='dianshi' 分支下
	// 开事务 INSERT trade_user_activity_participation 需要。与 ActivityStore 同进同退；
	// ActivityStore 为 nil 时 ActivityDB 也可为 nil（不使用）。
	ActivityDB *sql.DB

	// DianshiAdminStore 是点石后台管理查询/删除订单与参与记录的 DAO。
	// 生产路径注入 mysqlStore；nil 时不挂载 /internal/trade/dianshi/*。
	DianshiAdminStore store.DianshiAdminStore

	// JifeiClient 是 trade → jifei CGW 出向客户端（D-2 销毁链路用户主动入口用）。
	//
	// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 + §3.6
	// 用途：internalapi.deleteResourceHandler 调
	//       JifeiClient.ModifyResourceStatus(operateName=PRE_DESTROY) 通知 jifei 启动销毁。
	//
	// 允许 nil（向后兼容仅承载 jifei 回调测试 / 旧调用方）；nil 时
	// /internal/trade/resources/:resourceID/delete 路由不挂载。
	JifeiClient jifeiclient.Client

	// OrderStatusService 是订单状态反查业务服务（v1.7.32 引入）。
	//
	// 设计稿：.tmp/ctl-order-status-query-design.md §5.2 + §5.4
	// 用途：internalapi.queryOrderStatusHandler 调 OrderStatusService.QueryStatus 完成
	//       trade_order 反查 + B4 越权校验 + B1 终态短路 + jifei.getDealsByKeyIndex 反查 + B2 同步。
	//
	// 允许 nil（向后兼容仅承载旧调用方）；nil 时
	// /internal/trade/orders/:dealName/query-status 路由不挂载。
	OrderStatusService *orderstatus.Service

	// SiteKind（v1.7.x 国际站接入 A6.3 新增）：trade 内部部署站点语义字面量。
	//
	// 设计稿：.tmp/trade-international-site-design.md v1.1 §3.1 A6
	// 取值："cn" / "intl"；空 / 非法值由 region.Resolve 兜底为 cn。
	// 用途：NewRouter 在装配 5 个下游点（destroyresource / isolateresource / queryflow /
	//   resourcequery / internalapi）时透传该字段，让该 5 点同步使用本站点 region
	//   与 jifei 出入向互评。
	SiteKind string

	// RegionOverride（北京 2 预发布接入 2026-06-12 新增）：腾讯云 region 字面量 override。
	//
	// 取值：空 / "ap-guangzhou" / "ap-beijing" / "ap-shanghai" / "ap-singapore" 等（注册在 region.regionTable）。
	// 由 LIGHTVELA_TRADE_REGION env 注入，未注册字面量在 config.Load 期 fail-fast。
	// 与 SiteKind 同路径透穿到上述 5 个下游注入点。
	RegionOverride string
}

// NewRouter 装配 trade 服务的 HTTP Router。
//
// 当前迭代（迭代 8A + trade-pass-isolate Sub-4 + trade-pass-renew R-C）暴露：
//   - GET  /healthz                                       存活探针
//   - POST /trade/jifei/callback                          jifei 回调统一 endpoint（Q60 dispatcher，三段式 interfaceName 路由）
//   - POST /internal/trade/inquiry/batch                  ctl → trade 批量询价（设计稿 §3.3）
//   - POST /internal/trade/orders                         ctl → trade 下单（设计稿 §4.2.1）
//   - POST /internal/trade/orders/place-and-pay           ctl → trade 下单+支付一体化（迭代 8B-1.5）
//   - POST /internal/trade/orders/renew                   ctl → trade 续费下单（trade-pass-renew §4.3 / R-C-7）
//   - POST /internal/trade/orders/:dealName/pay-url       ctl → trade 拉支付 url（设计稿 §4.2.2）
//   - POST /internal/trade/orders/:dealName/query-status  ctl → trade 订单状态反查（v1.7.32）
//   - POST /internal/trade/flows/:flowID/complete         ctl → trade 异步隔离完成回调（Sub-4 §4.2.3）
//   - POST /internal/trade/resources/:resourceID/delete   ctl → trade 销毁链路用户主动入口（D-2 §3.5）
//
// 已注册 interfaceName：
//   - lightvela.pass.checkCreate       → 真 handler（迭代 5，logic/checkcreate）
//   - lightvela.pass.createResource    → 真 handler（迭代 6，logic/createresource）
//   - lightvela.pass.getAllAppIds      → 真 handler（迭代 11B，logic/resourcequery）
//   - lightvela.pass.getUserResources  → 真 handler（迭代 11B，logic/resourcequery）
//   - lightvela.pass.queryResource     → 真 handler（迭代 11B，logic/resourcequery）
//   - lightvela.pass.isolateResource   → 真 handler（Sub-4，logic/isolateresource）
//   - lightvela.pass.queryFlow         → 真 handler（Sub-4，logic/queryflow）
//   - lightvela.pass.checkRenew        → 真 handler（R-C-2，logic/checkrenew）
//   - lightvela.pass.renewResource     → 真 handler（R-C-3，logic/renewresource）
//   - lightvela.pass.destroyResource   → 真 handler 骨架（D-1，logic/destroyresource）—
//     D-1 切片仅落地抢占 + 返 flowId，**不调 ctl**；D-5 切片补 CTLClient.DestroyPass 反向调
//
// 后续迭代逐步补充：
//   - 迭代 7：reconcile worker（不在 router 中暴露，独立 goroutine）
//   - 迭代 8B：ctl 仓 handler 改造，调用 trade /internal/trade/* 接口
func NewRouter(cfg ServerConfig) *gin.Engine {
	if cfg.OrderStore == nil || cfg.BundleStore == nil || cfg.CTLClient == nil || cfg.FlowStore == nil {
		// 启动期编程错（依赖未注入）—— 立即 panic 而不是延迟到第一个请求。
		panic("httpapi.NewRouter: OrderStore / BundleStore / CTLClient / FlowStore must be non-nil (iteration 6+)")
	}

	router := gin.New()
	router.Use(gin.Recovery())

	router.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// jifei 回调统一 endpoint（Q60）+ Q58 framework builder + Q60 dispatcher。
	builder := jifei.NewFrameworkBuilder(cfg.JifeiComponentName, cfg.JifeiProtocolVersion)
	dispatcher := jifei.NewDispatcher(cfg.JifeiOurInterfacePrefix, builder)

	// 1. 注册 checkCreate 真 handler（迭代 5）。
	checkcreate.Install(dispatcher, checkcreate.Deps{
		OrderStore:  cfg.OrderStore,
		BundleStore: cfg.BundleStore,
		CTLClient:   cfg.CTLClient,
		Builder:     builder,
	})

	// 2. 注册 createResource 真 handler（迭代 6）。
	createresource.Install(dispatcher, createresource.Deps{
		OrderStore:    cfg.OrderStore,
		OrderUpdater:  cfg.OrderUpdater, // 迭代 8A 起 main.go 注入 mysqlStore；旧调用方仍允许 nil
		FlowStore:     cfg.FlowStore,
		CTLClient:     cfg.CTLClient,
		Builder:       builder,
		ActivityStore: cfg.ActivityStore, // 点石活动接入（设计稿 §5.6.1）；nil 时跳过 INSERT participation 分支
		DB:            cfg.ActivityDB,
	})

	// 3. 注册资源反查三件套真 handler（迭代 11B）。
	//    getAllAppIds / getUserResources / queryResource 共用 Deps（CTLClient + BundleStore + Builder）。
	//    设计稿：trade-resource-query-design §3.1 / §8 11B；PDF：getAllAppIds / getUserResources / queryResource（2026-05-09）。
	resourcequery.Install(dispatcher, resourcequery.Deps{
		CTLClient:      cfg.CTLClient,
		BundleStore:    cfg.BundleStore,
		Builder:        builder,
		SiteKind:       cfg.SiteKind, // v1.7.x A6.3
		RegionOverride: cfg.RegionOverride,
	})

	// 4. 注册 isolateResource 真 handler（迭代 trade-pass-isolate Sub-4）。
	//    设计稿：.tmp/trade-pass-isolate-design.md §3 / §11 Q3+Q19+Q22。
	//    抢占式 trade_flow 幂等 + ctl /internal/ctl/pass/isolate 同步驱动。
	isolateresource.Install(dispatcher, isolateresource.Deps{
		FlowStore:      cfg.FlowStore,
		CTLClient:      cfg.CTLClient,
		Builder:        builder,
		SiteKind:       cfg.SiteKind, // v1.7.x A6.3
		RegionOverride: cfg.RegionOverride,
	})

	// 5. 注册 queryFlow 真 handler（迭代 trade-pass-isolate Sub-4）。
	//    设计稿：.tmp/trade-pass-isolate-design.md §3 / §11 Q22=B3。
	//    jifei 主动轮询 trade_flow 终态映射（completed→0 / in_progress→2 / failed→3）。
	queryflow.Install(dispatcher, queryflow.Deps{
		FlowStore:      cfg.FlowStore,
		Builder:        builder,
		SiteKind:       cfg.SiteKind, // v1.7.x A6.3
		RegionOverride: cfg.RegionOverride,
	})

	// 6. 注册 checkRenew 真 handler（R-C-2）。
	//    设计稿：.tmp/trade-pass-renew-design.md §3.6 R-C-2 / §12 Q12=a + Q14=a。
	//    jifei 续费检查回调：5 码归并 + timeUnit 严格 {y,m,d} + ctl/pass 反查 renewable。
	checkrenew.Install(dispatcher, checkrenew.Deps{
		CTLClient: cfg.CTLClient,
		Builder:   builder,
	})

	// 7. 注册 renewResource 真 handler（R-C-3）。
	//    设计稿：.tmp/trade-pass-renew-design.md §3.6 R-C-3 / §12 Q11=a。
	//    抢占式 trade_flow 幂等 + 反向调 ctl/pass.RenewPass 同步驱动 renewing 状态机。
	renewresource.Install(dispatcher, renewresource.Deps{
		OrderStore: cfg.OrderStore,
		FlowStore:  cfg.FlowStore,
		CTLClient:  cfg.CTLClient,
		Builder:    builder,
	})

	// 8. 注册 destroyResource 真 handler（D-5b）。
	//    设计稿：.tmp/trade-pass-destroy-design.md §3.4 D-5b + §11 Q1 / Q24 / Q26。
	//    抢占式 trade_flow 幂等（与 isolate 复用 TryAcquireSlotForIsolate 范式）+
	//    赢家分支反向调 ctl /internal/ctl/passes/{pass_id}/destroy（含 destroyReason 透传 Q24）+
	//    ctl 调用失败 DeleteByID 回滚 trade_flow + classifyCTLError 4xx/5xx 分类映射。
	destroyresource.Install(dispatcher, destroyresource.Deps{
		FlowStore:      cfg.FlowStore,
		CTLClient:      cfg.CTLClient,
		Builder:        builder,
		SiteKind:       cfg.SiteKind, // v1.7.x A6.3
		RegionOverride: cfg.RegionOverride,
	})

	// 9. 注册 transferResource 真 handler（外部资源迁入）。
	//    计费迁移单回调 trade 后，trade 反向调 ctl /internal/ctl/passes/transfer，
	//    仅迁移既有 pass 的 bundle/uin/app_id，不创建新 pass。
	transferresource.Install(dispatcher, transferresource.Deps{
		FlowStore: cfg.FlowStore,
		CTLClient: cfg.CTLClient,
		Builder:   builder,
	})

	router.POST("/trade/jifei/callback", jifei.CallbackHandler(dispatcher))

	// 6. 注册内部 RPC（迭代 8A + Sub-4 callback）。
	//    InquiryService / PlaceOrderService 允许 nil 兼容仅承载 jifei 回调的旧测试用例；
	//    nil 时 /internal/trade/* 路由不挂载（实现：Install 内部 panic 仅在 Service 注入时触发）。
	//    FlowStore 注入后挂载 POST /internal/trade/flows/:flowID/complete（Sub-4 ctl→trade callback）。
	if cfg.InquiryService != nil && cfg.PlaceOrderService != nil {
		provisionedOrderStore, _ := cfg.OrderStore.(store.ProvisionedCreateOrderStore)
		internalapi.Install(router, internalapi.Deps{
			InternalServiceToken: cfg.InternalServiceToken,
			Inquiry:              cfg.InquiryService,
			PlaceOrder:           cfg.PlaceOrderService,
			FlowStore:            cfg.FlowStore,
			// D-2 销毁链路用户主动入口（设计稿 §3.5 + §11-A Q26）：BundleStore + JifeiClient
			// 任一 nil 时 internalapi 不挂载 /internal/trade/resources/:resourceID/delete 路由。
			BundleStore: cfg.BundleStore,
			JifeiClient: cfg.JifeiClient,
			// v1.7.32 订单状态反查（设计稿 .tmp/ctl-order-status-query-design.md §5.4）：
			// nil 时 internalapi 不挂载 /internal/trade/orders/:dealName/query-status 路由。
			OrderStatus:           cfg.OrderStatusService,
			ProvisionedOrderStore: provisionedOrderStore,
			// v1.7.x A6.3：SiteKind 透传给 deleteResourceHandler（装配期解析为 region 三元组）。
			SiteKind: cfg.SiteKind,
			// 北京 2 预发布接入 2026-06-12：region 字段 override，与 SiteKind 同路径。
			RegionOverride: cfg.RegionOverride,
			// 点石后台管理查询/删除入口。
			DianshiAdminStore: cfg.DianshiAdminStore,
		})
	}

	return router
}
