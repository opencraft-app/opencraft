package httpapi

import (
	"net/http"
	"regexp"

	"github.com/gin-gonic/gin"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/oidc"
)

// This is a session adapter for registered first-party OIDC clients, not a
// second authentication or authorization-code issuer. All providers use the
// existing /oauth2/authorize page and the same atomic code store.
func (h *Handler) ExchangeFirstPartySession(ctx *gin.Context) {
	h.exchangeFirstPartySession(ctx, "")
}

// ExchangeNativeLogin is a compatibility alias for released app versions.
// It owns no independent flow and delegates to the same adapter.
func (h *Handler) ExchangeNativeLogin(ctx *gin.Context) {
	h.exchangeFirstPartySession(ctx, oidc.NativeClientID)
}

func (h *Handler) exchangeFirstPartySession(ctx *gin.Context, impliedClientID string) {
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Pragma", "no-cache")
	if !h.oidcReady() {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "session_exchange_unavailable"})
		return
	}
	var input struct {
		ClientID    string `json:"client_id"`
		Code        string `json:"code"`
		Verifier    string `json:"code_verifier"`
		RedirectURI string `json:"redirect_uri"`
	}
	ctx.Request.Body = http.MaxBytesReader(ctx.Writer, ctx.Request.Body, 4096)
	if err := ctx.ShouldBindJSON(&input); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	if impliedClientID != "" {
		if input.ClientID != "" && input.ClientID != impliedClientID {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		input.ClientID = impliedClientID
	}
	if !oidc.IsFirstPartySessionClient(input.ClientID) || !authorizationCodePattern.MatchString(input.Code) {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	record, err := h.oidc.Provider.ConsumeAuthorizationCode(ctx.Request.Context(), oidc.TokenRequest{
		GrantType: "authorization_code", Code: input.Code, ClientID: input.ClientID,
		RedirectURI: input.RedirectURI, CodeVerifier: input.Verifier,
	})
	if err != nil || record == nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_grant"})
		return
	}
	session, err := h.service.CreateSessionForUser(ctx.Request.Context(), record.UserID, h.sessionTTL)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_grant"})
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"session_token": session.Token, "token_type": "Bearer"})
}

var authorizationCodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
