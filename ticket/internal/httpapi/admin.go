package httpapi

import (
	"crypto/subtle"
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/ticket/internal/service"
)

// registerAdminRoutes 挂 /admin/tickets 下的受理接口。
// realm 隔离由 adminAuthMiddleware 前置注入到 gin context。
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
		var req struct {
			Body string `json:"body"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_body"})
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
		var req struct {
			Status string `json:"status"`
			Note   string `json:"note"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_body"})
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

// adminAuthMiddleware 校验共享 AdminToken + realm/agent header。
// 后续替换为 admin-gateway 下发的 JWT。
func adminAuthMiddleware(expected string) gin.HandlerFunc {
	return func(c *gin.Context) {
		got := c.GetHeader("X-Admin-Token")
		if expected == "" || subtle.ConstantTimeCompare([]byte(got), []byte(expected)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		realm := c.GetHeader("X-Realm")
		agent := c.GetHeader("X-Agent-Id")
		if realm == "" || agent == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Set("realm", realm)
		c.Set("agent_id", agent)
		c.Next()
	}
}
