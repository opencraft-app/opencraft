package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// ServerConfig 是 NewRouter 的输入参数。
type ServerConfig struct {
	// InternalServiceToken 用于校验 ctl → trade 内部接口调用方身份。
	InternalServiceToken string
}

// NewRouter 装配 trade 服务的 HTTP Router。
//
// 当前迭代（迭代 1）仅暴露：
//   - GET  /healthz                    存活探针
//   - POST /trade/jifei/callback       jifei 回调统一 endpoint（Q60，dispatcher 占位，迭代 4 实现）
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

	// jifei 回调统一 endpoint（Q60）
	// 真正的 dispatcher（按 PDF framework 双层 framework.componentName 路由 checkCreate /
	// createResource / queryFlow / queryResources 等子接口）将在迭代 4 实现，本迭代仅暴露占位。
	router.POST("/trade/jifei/callback", placeholderJifeiCallback)

	return router
}

func placeholderJifeiCallback(c *gin.Context) {
	c.JSON(http.StatusNotImplemented, gin.H{
		"returnCode":    501,
		"returnValue":   501,
		"returnMessage": "jifei callback dispatcher not implemented yet (planned: iteration 4)",
	})
}
