package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/ticket/internal/service"
	"git.woa.com/wisp/mono/ticket/internal/store"
)

type ServerConfig struct {
	AllowedOrigins []string
	AdminToken     string
}

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

// --- User routes ---

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

// --- helpers ---

func writeErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrInvalidInput):
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_input"})
	case errors.Is(err, service.ErrForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
	case errors.Is(err, service.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "not_found"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal"})
	}
}

func corsMiddleware(allowed []string) gin.HandlerFunc {
	set := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		set[o] = struct{}{}
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if _, ok := set[origin]; ok {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// userAuthMiddleware TODO: 对接统一登录（session cookie）；骨架期用 X-User-Id / X-Realm 头，仅内网/开发环境使用。
func userAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetHeader("X-User-Id")
		realm := c.GetHeader("X-Realm")
		if uid == "" || realm == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Set("user_id", uid)
		c.Set("realm", realm)
		c.Next()
	}
}

// --- DTO ---

type ticketDTO struct {
	ID        string    `json:"id"`
	Subject   string    `json:"subject"`
	Status    string    `json:"status"`
	Category  string    `json:"category"`
	Realm     string    `json:"realm"`
	Assignee  *string   `json:"assignee"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type messageDTO struct {
	ID         string    `json:"id"`
	TicketID   string    `json:"ticket_id"`
	AuthorType string    `json:"author_type"`
	AuthorID   *string   `json:"author_id"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"created_at"`
}

func toTicketDTO(t store.Ticket) ticketDTO {
	dto := ticketDTO{
		ID:        t.ID,
		Subject:   t.Subject,
		Status:    t.Status,
		Category:  t.Category,
		Realm:     t.Realm,
		CreatedAt: t.CreatedAt,
		UpdatedAt: t.UpdatedAt,
	}
	if t.Assignee.Valid {
		v := t.Assignee.String
		dto.Assignee = &v
	}
	return dto
}

func toTicketDTOs(items []store.Ticket) []ticketDTO {
	out := make([]ticketDTO, 0, len(items))
	for _, t := range items {
		out = append(out, toTicketDTO(t))
	}
	return out
}

func toMessageDTO(m store.TicketMessage) messageDTO {
	dto := messageDTO{
		ID:         m.ID,
		TicketID:   m.TicketID,
		AuthorType: m.AuthorType,
		Body:       m.Body,
		CreatedAt:  m.CreatedAt,
	}
	if m.AuthorID.Valid {
		v := m.AuthorID.String
		dto.AuthorID = &v
	}
	return dto
}

func toMessageDTOs(items []store.TicketMessage) []messageDTO {
	out := make([]messageDTO, 0, len(items))
	for _, m := range items {
		out = append(out, toMessageDTO(m))
	}
	return out
}
