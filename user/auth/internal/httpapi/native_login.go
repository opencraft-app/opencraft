package httpapi

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/oidc"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

const nativeClientID = "opencraft-native-v1"
const nativeRedirectURI = "opencraft://auth/lightvela"
const nativeCodeTTL = 2 * time.Minute

var nativeStatePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43,128}$`)
var nativeVerifierPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)

func (h *Handler) googleLoginErrorURL(request *http.Request, path string) string {
	if h.nativeCodes != nil {
		if target, ok := nativeLoginTarget(h.readValidatedOAuthReturnToCookie(request, googleOAuthReturnToCookieName)); ok {
			return nativeRedirectURI + "?" + url.Values{"state": {target.Query().Get("state")}, "error": {"login_failed"}}.Encode()
		}
	}
	return h.googleOAuth.frontendURL(request, path)
}

// The OAuth return cookie transports public transaction parameters only. This
// target is NOT part of the generic web return_to allowlist/token redirect path.
func nativeLoginTarget(raw string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "opencraft" || u.Host != "auth" || u.Path != "/lightvela" || u.User != nil || u.Opaque != "" || u.RawPath != "" || u.Fragment != "" {
		return nil, false
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(q) != 3 || len(q["state"]) != 1 || len(q["code_challenge"]) != 1 || len(q["code_challenge_method"]) != 1 || q.Get("code_challenge_method") != "S256" || !nativeStatePattern.MatchString(q.Get("state")) {
		return nil, false
	}
	challenge := q.Get("code_challenge")
	b, err := base64.RawURLEncoding.DecodeString(challenge)
	if err != nil || len(b) != 32 || base64.RawURLEncoding.EncodeToString(b) != challenge {
		return nil, false
	}
	return u, true
}

func (h *Handler) StartNativeLogin(ctx *gin.Context) {
	ctx.Header("Cache-Control", "no-store")
	if h.nativeCodes == nil || h.googleOAuth == nil {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "native_login_unavailable"})
		return
	}
	q, parseErr := url.ParseQuery(ctx.Request.URL.RawQuery)
	if parseErr != nil || len(q) != 4 || len(q["redirect_uri"]) != 1 || q.Get("redirect_uri") != nativeRedirectURI {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	q.Del("redirect_uri")
	target := nativeRedirectURI + "?" + q.Encode()
	if _, ok := nativeLoginTarget(target); !ok {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	// Reuse Google state, relay, identity verification and session creation.
	ctx.Request.URL.RawQuery = url.Values{"return_to": {target}}.Encode()
	h.StartGoogleOAuth(ctx)
}

func (h *Handler) nativeLoginSuccess(ctx *gin.Context, target *url.URL, session *service.AuthSession) string {
	q := url.Values{"state": {target.Query().Get("state")}}
	code, err := randomHex(32)
	if err == nil && session != nil && !session.Impersonated && h.nativeCodes != nil {
		now := time.Now().UTC()
		err = h.nativeCodes.CreateAuthorizationCode(ctx.Request.Context(), oidc.CreateAuthorizationCodeInput{
			Code: code, ClientID: nativeClientID, UserID: session.User.ID,
			RedirectURI: nativeRedirectURI, Scope: "native:session",
			CodeChallenge: target.Query().Get("code_challenge"),
			CreatedAt:     now, ExpiresAt: now.Add(nativeCodeTTL),
		})
		if err == nil {
			q.Set("code", code)
		}
	}
	if q.Get("code") == "" {
		q.Set("error", "native_login_unavailable")
	}
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Referrer-Policy", "no-referrer")
	return nativeRedirectURI + "?" + q.Encode()
}

func (h *Handler) ExchangeNativeLogin(ctx *gin.Context) {
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Pragma", "no-cache")
	if h.nativeCodes == nil {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "native_login_unavailable"})
		return
	}
	var input struct {
		Code        string `json:"code"`
		Verifier    string `json:"code_verifier"`
		RedirectURI string `json:"redirect_uri"`
	}
	ctx.Request.Body = http.MaxBytesReader(ctx.Writer, ctx.Request.Body, 4096)
	if err := ctx.ShouldBindJSON(&input); err != nil || input.RedirectURI != nativeRedirectURI || len(input.Code) != 64 || !nativeVerifierPattern.MatchString(input.Verifier) {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	record, err := h.nativeCodes.ConsumeAuthorizationCode(ctx.Request.Context(), oidc.ConsumeAuthorizationCodeInput{
		Code: input.Code, ClientID: nativeClientID, RedirectURI: nativeRedirectURI,
		Verifier: input.Verifier, Now: time.Now().UTC(),
	})
	if err != nil || record == nil || record.Scope != "native:session" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_grant"})
		return
	}
	session, err := h.service.CreateSessionForUser(ctx.Request.Context(), record.UserID, h.sessionTTL)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_grant"})
		return
	}
	// Only the TLS response to a verified code holder carries the credential.
	ctx.JSON(http.StatusOK, gin.H{"session_token": session.Token, "token_type": "Bearer"})
}
