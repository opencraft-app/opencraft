package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/federation"
)

const (
	federationSwitchCookieName = "lc_federation_switch"
	defaultFederationSwitchTTL = 5 * time.Minute
)

func registerFederationSwitchRoutes(router gin.IRoutes, handler *Handler) {
	if handler.federation == nil || handler.federation.Codec == nil {
		return
	}
	router.POST("/auth/federation/switch/prepare", handler.prepareFederationSwitch)
	router.DELETE("/auth/federation/switch", handler.cancelFederationSwitch)
}

func (h *Handler) prepareFederationSwitch(ctx *gin.Context) {
	sourceToken := tokenFromContext(ctx)
	session, err := h.service.CurrentSession(ctx, sourceToken)
	if err != nil || session.Impersonated {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	now := h.federationNow()
	ttl := h.federation.SwitchTTL
	if ttl <= 0 {
		ttl = defaultFederationSwitchTTL
	}
	token, err := h.federation.Codec.IssueSwitch(federation.SwitchClaims{
		SourceSessionToken: sourceToken,
		UserID:             session.User.ID,
		IssuedAt:           now,
		ExpiresAt:          now.Add(ttl),
	})
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "switch_prepare_failed"})
		return
	}
	h.setFederationSwitchCookie(ctx, token, ttl)
	ctx.Status(http.StatusNoContent)
}

func (h *Handler) cancelFederationSwitch(ctx *gin.Context) {
	h.clearFederationSwitchCookie(ctx)
	ctx.Status(http.StatusNoContent)
}

func (h *Handler) completeFederationSwitch(ctx *gin.Context, newSessionToken string) {
	if h.federation == nil || h.federation.Codec == nil {
		return
	}
	cookie, err := ctx.Request.Cookie(federationSwitchCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return
	}
	defer h.clearFederationSwitchCookie(ctx)
	claims, err := h.federation.Codec.ParseSwitch(cookie.Value, h.federationNow())
	if err != nil || claims.SourceSessionToken == strings.TrimSpace(newSessionToken) {
		return
	}
	sourceSession, err := h.service.CurrentSession(ctx, claims.SourceSessionToken)
	if err != nil || sourceSession.Impersonated || sourceSession.User.ID != claims.UserID {
		return
	}
	if err := h.service.SignOut(ctx, claims.SourceSessionToken); err != nil {
		requestLogger(ctx, nil).Warn("federation account switch could not revoke source session", "err", err)
	}
}

func (h *Handler) setFederationSwitchCookie(ctx *gin.Context, token string, ttl time.Duration) {
	setSessionCookie(ctx, federationSwitchCookieName, token, h.cookieSecure, h.cookieSameSite, ttl)
}

func (h *Handler) clearFederationSwitchCookie(ctx *gin.Context) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name: federationSwitchCookieName, Value: "", Path: "/", HttpOnly: true,
		SameSite: h.cookieSameSite, Secure: h.cookieSecure, MaxAge: -1,
	})
}
