package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
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
}

// NewRouter 装配 trade 服务的 HTTP Router。
//
// 当前迭代（迭代 4）暴露：
//   - GET  /healthz                    存活探针
//   - POST /trade/jifei/callback       jifei 回调统一 endpoint（Q60 dispatcher，三段式 interfaceName 路由）
//
// 已注册 interfaceName（迭代 4 全部为 stub，迭代 5/6 接入真实 handler）：
//   - lightvela.pass.checkCreate     → stub（迭代 5 替换）
//   - lightvela.pass.createResource  → stub（迭代 6 替换）
//
// 后续迭代逐步补充：
//   - 迭代 5：checkCreate handler（实时 5 项校验，不写 trade_flow，每次独立校验，无幂等）
//   - 迭代 6：createResource handler（Q61 抢占式幂等 + Q56 退款响应分类）
//   - 迭代 5/6：内部接口 /internal/trade/inquiry/batch / /internal/trade/orders / pay-url 等
//   - 迭代 7：reconcile worker（不在 router 中暴露，独立 goroutine）
func NewRouter(cfg ServerConfig) *gin.Engine {
	router := gin.New()
	router.Use(gin.Recovery())

	router.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// jifei 回调统一 endpoint（Q60）+ Q58 framework builder + Q60 dispatcher
	builder := jifei.NewFrameworkBuilder(cfg.JifeiComponentName, cfg.JifeiProtocolVersion)
	dispatcher := jifei.NewDispatcher(cfg.JifeiOurInterfacePrefix, builder)
	jifei.InstallStubHandlers(dispatcher)
	router.POST("/trade/jifei/callback", jifei.CallbackHandler(dispatcher))

	return router
}
