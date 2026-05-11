package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/internalapi"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/logic/checkcreate"
	"git.woa.com/wisp/mono/trade/internal/logic/createresource"
	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
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
}

// NewRouter 装配 trade 服务的 HTTP Router。
//
// 当前迭代（迭代 8A）暴露：
//   - GET  /healthz                    存活探针
//   - POST /trade/jifei/callback       jifei 回调统一 endpoint（Q60 dispatcher，三段式 interfaceName 路由）
//   - POST /internal/trade/inquiry/batch  ctl → trade 批量询价（设计稿 §3.3）
//   - POST /internal/trade/orders         ctl → trade 下单（设计稿 §4.2.1）
//   - POST /internal/trade/orders/:dealName/pay-url  ctl → trade 拉支付 url（设计稿 §4.2.2）
//
// 已注册 interfaceName：
//   - lightvela.pass.checkCreate     → 真 handler（迭代 5，logic/checkcreate）
//   - lightvela.pass.createResource  → 真 handler（迭代 6，logic/createresource）
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
		OrderStore:   cfg.OrderStore,
		OrderUpdater: cfg.OrderUpdater, // 迭代 8A 起 main.go 注入 mysqlStore；旧调用方仍允许 nil
		FlowStore:    cfg.FlowStore,
		CTLClient:    cfg.CTLClient,
		Builder:      builder,
	})

	router.POST("/trade/jifei/callback", jifei.CallbackHandler(dispatcher))

	// 3. 注册内部 RPC（迭代 8A）。
	//    InquiryService / PlaceOrderService 允许 nil 兼容仅承载 jifei 回调的旧测试用例；
	//    nil 时 /internal/trade/* 路由不挂载（实现：Install 内部 panic 仅在 Service 注入时触发）。
	if cfg.InquiryService != nil && cfg.PlaceOrderService != nil {
		internalapi.Install(router, internalapi.Deps{
			InternalServiceToken: cfg.InternalServiceToken,
			Inquiry:              cfg.InquiryService,
			PlaceOrder:           cfg.PlaceOrderService,
		})
	}

	return router
}
