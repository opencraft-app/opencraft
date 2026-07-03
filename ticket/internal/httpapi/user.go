package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/ticket/internal/service"
)

// registerUserRoutes 挂用户侧 /tickets 路由。
// 使用同包内的 helper：writeErr（errors.go）与 toTicketDTO/toMessageDTO（dto.go）。
func registerUserRoutes(r *gin.Engine, svc *service.Service) {
	g := r.Group("/tickets", userAuthMiddleware())

	g.GET("", func(c *gin.Context) {
		uid := c.GetString("user_id")
		items, err := svc.ListMyTickets(c.Request.Context(), uid)
		if err != nil {
			writeErr(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": toTicketDTOs(items)})
	})

	g.POST("", func(c *gin.Context) {
		var req struct {
			Subject  string `json:"subject"`
			Category string `json:"category"`
			Body     string `json:"body"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_body"})
			return
		}
		uid := c.GetString("user_id")
		realm := c.GetString("realm")
		t, err := svc.CreateTicket(c.Request.Context(), uid, realm, req.Subject, req.Category, req.Body)
		if err != nil {
			writeErr(c, err)
			return
		}
		c.JSON(http.StatusCreated, toTicketDTO(*t))
	})

	g.GET("/:id", func(c *gin.Context) {
		uid := c.GetString("user_id")
		t, msgs, err := svc.GetMyTicketDetail(c.Request.Context(), uid, c.Param("id"))
		if err != nil {
			writeErr(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"ticket":   toTicketDTO(*t),
			"messages": toMessageDTOs(msgs),
		})
	})

	g.POST("/:id/messages", func(c *gin.Context) {
		var req struct {
			Body string `json:"body"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_body"})
			return
		}
		uid := c.GetString("user_id")
		m, err := svc.AppendUserMessage(c.Request.Context(), uid, c.Param("id"), req.Body)
		if err != nil {
			writeErr(c, err)
			return
		}
		c.JSON(http.StatusCreated, toMessageDTO(*m))
	})
}
