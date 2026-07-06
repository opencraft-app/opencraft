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
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/ticket/internal/service"
)

// ErrAdminTokenEmpty 表示启动配置里 AdminToken 为空，服务拒绝启动。
// fail-fast 语义：避免生产环境因为空 token 导致运营接口被空口令绕过。
var ErrAdminTokenEmpty = errors.New("httpapi: AdminToken must not be empty")

// ServerConfig 是路由组装所需的运行时配置。
type ServerConfig struct {
	// AllowedOrigins 是允许的 CORS Origin 白名单。
	//
	// 特殊值：
	//   - nil / [] 空切片：关闭跨域（不设置任何 Access-Control-* 头）。
	//   - 含 "*"：允许任意 Origin（此时 Access-Control-Allow-Credentials 会被强制关闭，
	//     以符合浏览器同源策略——* + credentials 组合会被浏览器拒绝）。
	//   - 其他：仅命中白名单的 Origin 才回显。
	AllowedOrigins []string

	// AdminToken 是运营侧共享密钥，通过 X-Admin-Token 头校验（/admin/tickets 仍使用）。
	// 必须非空；空值会导致 NewRouter 返回 ErrAdminTokenEmpty。
	// 生产环境应替换为 admin-gateway 下发的 JWT。
	AdminToken string

	// SupportAgentIDs 是反馈后台（/support/feedback/list、/sign）允许的运营用户
	// 白名单（lightclaw 用户 ID）。空则反馈后台接口恒 401。
	SupportAgentIDs []string

	// SupportCOS 是反馈系统 COS 客户端（服务端私有凭证）。
	// 允许为 nil：为 nil 时反馈相关接口返回 503。
	SupportCOS *SupportCosClient
}

// NewRouter 组装完整的 HTTP handler。
//
// 启动期硬校验（fail-fast）：
//   - AdminToken 为空 → 返回 ErrAdminTokenEmpty，服务不启动
//
// 所有子路由的 helper（writeErr / toTicketDTO 等）位于同包的
// errors.go 与 dto.go，跨文件同包内可直接调用。
func NewRouter(svc *service.Service, cfg ServerConfig) (http.Handler, error) {
	if cfg.AdminToken == "" {
		return nil, ErrAdminTokenEmpty
	}

	r := gin.New()
	r.Use(gin.Recovery(), corsMiddleware(cfg.AllowedOrigins))

	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	if svc != nil {
		registerUserRoutes(r, svc)
		registerAdminRoutes(r, svc, cfg.AdminToken)
	} else {
		// 纯反馈模式：工单接口返回 503
		ticketUnavailable := func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ticket_system_unavailable"})
		}
		r.GET("/tickets", ticketUnavailable)
		r.POST("/tickets", ticketUnavailable)
		r.GET("/tickets/:id", ticketUnavailable)
		r.POST("/tickets/:id/messages", ticketUnavailable)
		r.GET("/admin/tickets", ticketUnavailable)
		r.GET("/admin/tickets/:id", ticketUnavailable)
		r.POST("/admin/tickets/:id/reply", ticketUnavailable)
		r.PATCH("/admin/tickets/:id/status", ticketUnavailable)
	}
	registerSupportRoutes(r, svc, cfg.SupportCOS, cfg.SupportAgentIDs)
	return r, nil
}
