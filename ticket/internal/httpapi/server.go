// Package httpapi 组装 ticket HTTP 服务的路由与中间件。
//
// 文件划分：
//   - server.go     入口 NewRouter / ServerConfig（本文件）
//   - user.go       /tickets/*  用户侧路由
//   - admin.go      /admin/tickets/*  运营侧路由
//   - middleware.go 认证与 CORS 中间件
//   - errors.go     统一错误响应 writeErr
//   - dto.go        请求/响应 DTO 及 store→DTO 映射
package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/ticket/internal/service"
)

// ServerConfig 是路由组装所需的运行时配置。
type ServerConfig struct {
	// AllowedOrigins 是允许的 CORS Origin 白名单，空则关闭跨域。
	AllowedOrigins []string
	// AdminToken 是运营侧共享密钥，通过 X-Admin-Token 头校验。
	// 生产环境应替换为 admin-gateway 下发的 JWT。
	AdminToken string
}

// NewRouter 组装完整的 HTTP handler。
// 所有子路由的 helper（writeErr / toTicketDTO 等）位于同包的
// errors.go 与 dto.go，跨文件同包内可直接调用。
func NewRouter(svc *service.Service, cfg ServerConfig) http.Handler {
	r := gin.New()
	r.Use(gin.Recovery(), corsMiddleware(cfg.AllowedOrigins))

	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	registerUserRoutes(r, svc)
	registerAdminRoutes(r, svc, cfg.AdminToken)
	return r
}
