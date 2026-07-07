package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/ticket/internal/service"
)

// registerAdminRoutes 挂运营侧 /admin/tickets 路由。
// realm 隔离由 adminAuthMiddleware（middleware.go）前置注入到 gin context。
//
// 本文件使用同包内的 helper：
//   - writeErr           errors.go
//   - toTicketDTO(s)     dto.go
//   - toMessageDTO(s)    dto.go
//   - adminAuthMiddleware middleware.go
//   - validateUUID       validate.go
//
// Go 同 package 内跨文件符号无需 import，直接可见。
func registerAdminRoutes(r *gin.Engine, svc *service.Service, adminToken string) {
	g := r.Group("/admin/tickets", adminAuthMiddleware(adminToken))

	g.GET("", func(c *gin.Context) {
		realm := c.GetString("realm")
		status := c.Query("status")
		assignee := c.Query("assignee")
		items, err := svc.AdminListTickets(c.Request.Context(), realm, status, assignee)
		if err != nil {
			writeErr(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": toTicketDTOs(items)})
	})

	g.GET("/:id", func(c *gin.Context) {
		if !validateUUID(c, "id") {
			return
		}
		realm := c.GetString("realm")
		t, msgs, err := svc.AdminGetTicketDetail(c.Request.Context(), realm, c.Param("id"))
		if err != nil {
			writeErr(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"ticket":   toTicketDTO(*t),
			"messages": toMessageDTOs(msgs),
		})
	})

	g.POST("/:id/reply", func(c *gin.Context) {
		if !validateUUID(c, "id") {
			return
		}
		var req struct {
			Body string `json:"body"`
		}
		if !bindAndValidateJSON(c, &req) {
			return
		}
		if !requireNonEmpty(c, req.Body, "body") {
			return
		}
		if !requireMaxLength(c, req.Body, maxBodyLen, "body") {
			return
		}
		realm := c.GetString("realm")
		agentID := c.GetString("agent_id")
		m, err := svc.AdminReply(c.Request.Context(), realm, agentID, c.Param("id"), req.Body)
		if err != nil {
			writeErr(c, err)
			return
		}
		c.JSON(http.StatusCreated, toMessageDTO(*m))
	})

	g.PATCH("/:id/status", func(c *gin.Context) {
		if !validateUUID(c, "id") {
			return
		}
		var req struct {
			Status string `json:"status"`
			Note   string `json:"note"`
		}
		if !bindAndValidateJSON(c, &req) {
			return
		}
		if !requireNonEmpty(c, req.Status, "status") {
			return
		}
		realm := c.GetString("realm")
		agentID := c.GetString("agent_id")
		t, err := svc.AdminUpdateStatus(c.Request.Context(), realm, agentID, c.Param("id"), req.Status, req.Note)
		if err != nil {
			writeErr(c, err)
			return
		}
		c.JSON(http.StatusOK, toTicketDTO(*t))
	})
}
