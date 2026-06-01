package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

const defaultE2ESessionTTL = 2 * time.Hour
const maxE2ESessionTTL = 24 * time.Hour

type adminE2EHandler struct {
	service        *service.Service
	cookieSecure   bool
	cookieSameSite http.SameSite
	sessionTTL     time.Duration
}

type createE2ESessionRequest struct {
	UserID     string `json:"userId"`
	ReturnTo   string `json:"returnTo"`
	TTLSeconds int    `json:"ttlSeconds"`
}

type adminE2ESessionResponse struct {
	UserID       string `json:"userId"`
	SessionToken string `json:"sessionToken"`
	LoginURL     string `json:"loginUrl,omitempty"`
	ExpiresAt    string `json:"expiresAt"`
	Impersonated bool   `json:"impersonated"`
}

func registerAdminE2ERoutes(group *gin.RouterGroup, authService *service.Service, config ServerConfig) {
	ttl := config.E2ESessionTTL
	if ttl <= 0 {
		ttl = defaultE2ESessionTTL
	}
	handler := &adminE2EHandler{
		service:        authService,
		cookieSecure:   config.CookieSecure,
		cookieSameSite: config.CookieSameSite,
		sessionTTL:     ttl,
	}
	group.POST("/session-mint", handler.createSession)
}

func (h *adminE2EHandler) createSession(ctx *gin.Context) {
	var req createE2ESessionRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_request", Message: "请求格式不正确。"})
		return
	}

	ttl := h.sessionTTL
	if req.TTLSeconds > 0 {
		ttl = time.Duration(req.TTLSeconds) * time.Second
	}
	if ttl <= 0 || ttl > maxE2ESessionTTL {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_session_ttl", Message: "session TTL 必须大于 0 且不超过 24 小时。"})
		return
	}

	loginURL := ""
	if strings.TrimSpace(req.ReturnTo) != "" {
		if _, err := parseImpersonationReturnTo(req.ReturnTo); err != nil {
			ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_return_to", Message: "returnTo 必须是包含 scheme 和 host 的绝对 URL。"})
			return
		}
	}

	session, err := h.service.CreateSessionForUser(ctx.Request.Context(), req.UserID, ttl)
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}
	if strings.TrimSpace(req.ReturnTo) != "" {
		loginURL, err = buildImpersonationLoginURL(req.ReturnTo, session.Token)
		if err != nil {
			ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_return_to", Message: "returnTo 必须是包含 scheme 和 host 的绝对 URL。"})
			return
		}
	}

	setSessionCookie(ctx, sessionCookieName, session.Token, h.cookieSecure, h.cookieSameSite, session.ExpiresAt.Sub(session.AuthenticatedAt))
	ctx.JSON(http.StatusOK, adminE2ESessionResponse{
		UserID:       session.User.ID,
		SessionToken: session.Token,
		LoginURL:     loginURL,
		ExpiresAt:    session.ExpiresAt.UTC().Format(timeRFC3339Milli),
		Impersonated: session.Impersonated,
	})
}
