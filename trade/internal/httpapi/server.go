package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/logic/checkcreate"
	"git.woa.com/wisp/mono/trade/internal/logic/createresource"
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
	//   - OrderUpdater：trade_order 反向回填 resource_id（迭代 8 接线，本期允许 nil）
	//
	// OrderStore / BundleStore / CTLClient / FlowStore 必填，nil 视为编程错（没接好线），
	// NewRouter 会 panic 让启动期立即暴露。OrderUpdater 允许 nil（迭代 8 PlaceOrder 写端
	// 落地前 trade_order 表只读）。
	OrderStore   store.OrderStore
	BundleStore  store.BundleDefinitionStore
	CTLClient    ctlclient.Client
	FlowStore    store.FlowStore
	OrderUpdater createresource.OrderProvisionUpdater
}

// NewRouter 装配 trade 服务的 HTTP Router。
//
// 当前迭代（迭代 6）暴露：
//   - GET  /healthz                    存活探针
//   - POST /trade/jifei/callback       jifei 回调统一 endpoint（Q60 dispatcher，三段式 interfaceName 路由）
//
// 已注册 interfaceName：
//   - lightvela.pass.checkCreate     → 真 handler（迭代 5，logic/checkcreate）
//   - lightvela.pass.createResource  → 真 handler（迭代 6，logic/createresource）
//
// 后续迭代逐步补充：
//   - 迭代 7：reconcile worker（不在 router 中暴露，独立 goroutine）
//   - 迭代 8：内部接口 /internal/trade/inquiry/batch / /internal/trade/orders / pay-url 等
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
		OrderUpdater: cfg.OrderUpdater, // 允许 nil，迭代 8 PlaceOrder 写端落地后接线
		FlowStore:    cfg.FlowStore,
		CTLClient:    cfg.CTLClient,
		Builder:      builder,
	})

	router.POST("/trade/jifei/callback", jifei.CallbackHandler(dispatcher))

	return router
}
