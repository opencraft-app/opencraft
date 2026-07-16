package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

const googleOAuthStateCookieName = "lc_google_oauth_state"
const googleOAuthStateCookiePath = "/auth/oauth/google/callback"
const googleOAuthReturnToCookieName = "lc_google_oauth_return_to"

// GoogleOAuthClient 是 Google OAuth 客户端的接口，便于测试时替换实现。
type GoogleOAuthClient interface {
	ExchangeCode(ctx context.Context, code string, redirectURI string) (*GoogleOAuthToken, error)
	ResolveIdentity(ctx context.Context, accessToken string) (service.OAuthSignInInput, error)
}

// GoogleOAuthToken 持有 Google OAuth token 交换结果。
type GoogleOAuthToken struct {
	AccessToken string
	ExpiresIn   int
}

// GoogleOAuthConfig 是 Google OAuth 的配置结构体。
type GoogleOAuthConfig struct {
	ClientID        string
	ClientSecret    string
	RedirectURI     string
	FrontendBaseURL string
	PublicBaseURL   string
	StateTTL        time.Duration
	Client          GoogleOAuthClient
}

type googleOAuth struct {
	clientID        string
	redirectURI     string
	frontendBaseURL string
	publicBaseURL   string
	stateTTL        time.Duration
	client          GoogleOAuthClient
}

func newGoogleOAuth(config *GoogleOAuthConfig) *googleOAuth {
	if config == nil {
		return nil
	}

	clientID := strings.TrimSpace(config.ClientID)
	clientSecret := strings.TrimSpace(config.ClientSecret)
	redirectURI := strings.TrimSpace(config.RedirectURI)
	if clientID == "" || clientSecret == "" || redirectURI == "" {
		return nil
	}

	stateTTL := config.StateTTL
	if stateTTL <= 0 {
		stateTTL = 10 * time.Minute
	}

	client := config.Client
	if client == nil {
		client = &googleOAuthHTTPClient{
			oauthConfig: &oauth2.Config{
				ClientID:     clientID,
				ClientSecret: clientSecret,
				Endpoint:     google.Endpoint,
				Scopes:       []string{"openid", "email", "profile"},
			},
			httpClient: http.DefaultClient,
		}
	}

	return &googleOAuth{
		clientID:        clientID,
		redirectURI:     redirectURI,
		frontendBaseURL: strings.TrimRight(strings.TrimSpace(config.FrontendBaseURL), "/"),
		publicBaseURL:   strings.TrimRight(strings.TrimSpace(config.PublicBaseURL), "/"),
		stateTTL:        stateTTL,
		client:          client,
	}
}

// StartGoogleOAuth 生成 state、写 cookie 并重定向到 Google 授权页面。
func (h *Handler) StartGoogleOAuth(ctx *gin.Context) {
	if h.googleOAuth == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}

	nonce, err := newOAuthState()
	if err != nil {
		ctx.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	startState, err := buildOAuthStartState(ctx.Request, "google", googleOAuthStateCookiePath, h.googleOAuth.redirectURIForRequest(ctx.Request), nonce)
	if err != nil {
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     googleOAuthStateCookieName,
		Value:    startState.CookieValue,
		Path:     googleOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   int(h.googleOAuth.stateTTL / time.Second),
	})
	setOAuthReturnToCookie(ctx, googleOAuthReturnToCookieName, googleOAuthStateCookiePath, readReturnToFromRequest(ctx.Request), h.cookieSecure, h.googleOAuth.stateTTL, h.validatedReturnToURL)

	ctx.Redirect(http.StatusTemporaryRedirect, h.googleOAuth.authorizeURL(startState.StateParam, startState.RedirectURI))
}

// HandleGoogleOAuthCallback 处理 Google OAuth 回调，完成 token 交换和登录。
func (h *Handler) HandleGoogleOAuthCallback(ctx *gin.Context) {
	if h.googleOAuth == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}

	code := strings.TrimSpace(ctx.Query("code"))
	state := strings.TrimSpace(ctx.Query("state"))
	logger := requestLogger(ctx, nil)
	exchangeRedirectURI := h.googleOAuth.redirectURIForRequest(ctx.Request)

	if relayState, ok := parseOAuthRelayState(state); ok {
		if err := validateOAuthRelayStateForProvider("google", relayState); err != nil {
			logger.Warn("google oauth callback failed", "stage", "relay_state_validation", "err", err)
			ctx.Redirect(http.StatusTemporaryRedirect, h.googleOAuth.frontendURL(ctx.Request, "/?oauth_error=google_state_mismatch"))
			return
		}
		if isOAuthRelayIssuerCallback(ctx.Request, relayState) {
			target, err := relayCallbackURLWithOriginalQuery("google", relayState.TargetCallbackURI, ctx.Request.URL.RawQuery)
			if err != nil {
				logger.Warn("google oauth relay callback failed", "stage", "target_query", "err", err)
				ctx.Redirect(http.StatusTemporaryRedirect, h.googleOAuth.frontendURL(ctx.Request, "/?oauth_error=google_state_mismatch"))
				return
			}
			ctx.Redirect(http.StatusTemporaryRedirect, target)
			return
		}
		if !isOAuthRelayTargetCallback(ctx.Request, relayState) {
			logger.Warn("google oauth callback failed", "stage", "relay_target_mismatch")
			ctx.Redirect(http.StatusTemporaryRedirect, h.googleOAuth.frontendURL(ctx.Request, "/?oauth_error=google_state_mismatch"))
			return
		}
		exchangeRedirectURI = relayState.IssuerRedirectURI
		expectedState := ""
		if cookie, err := ctx.Request.Cookie(googleOAuthStateCookieName); err == nil {
			expectedState = strings.TrimSpace(cookie.Value)
		}
		validatedSuccessTarget := h.readValidatedOAuthReturnToCookie(ctx.Request, googleOAuthReturnToCookieName)
		h.clearGoogleOAuthStateCookie(ctx)
		clearOAuthReturnToCookie(ctx, googleOAuthReturnToCookieName, googleOAuthStateCookiePath, h.cookieSecure)
		h.handleGoogleOAuthCallbackAfterState(ctx, code, relayState.Nonce, expectedState, validatedSuccessTarget, exchangeRedirectURI, logger)
		return
	}

	expectedState := ""
	if cookie, err := ctx.Request.Cookie(googleOAuthStateCookieName); err == nil {
		expectedState = strings.TrimSpace(cookie.Value)
	}
	validatedSuccessTarget := h.readValidatedOAuthReturnToCookie(ctx.Request, googleOAuthReturnToCookieName)
	h.clearGoogleOAuthStateCookie(ctx)
	clearOAuthReturnToCookie(ctx, googleOAuthReturnToCookieName, googleOAuthStateCookiePath, h.cookieSecure)
	h.handleGoogleOAuthCallbackAfterState(ctx, code, state, expectedState, validatedSuccessTarget, exchangeRedirectURI, logger)
}

func (h *Handler) handleGoogleOAuthCallbackAfterState(ctx *gin.Context, code string, state string, expectedState string, validatedSuccessTarget string, exchangeRedirectURI string, logger interface {
	Warn(msg string, keysAndValues ...any)
	Error(msg string, keysAndValues ...any)
	Info(msg string, keysAndValues ...any)
}) {
	if code == "" || state == "" || expectedState == "" || state != expectedState {
		logger.Warn(
			"google oauth callback failed",
			"stage", "state_mismatch",
			"has_code", code != "",
			"has_state", state != "",
			"has_cookie_state", expectedState != "",
		)
		ctx.Redirect(http.StatusTemporaryRedirect, h.googleOAuth.frontendURL(ctx.Request, "/?oauth_error=google_state_mismatch"))
		return
	}

	requestCtx := ctx.Request.Context()
	token, err := h.googleOAuth.client.ExchangeCode(requestCtx, code, exchangeRedirectURI)
	if err != nil || strings.TrimSpace(token.AccessToken) == "" {
		logger.Error("google oauth callback failed", "stage", "exchange", "err", err)
		ctx.Redirect(http.StatusTemporaryRedirect, h.googleOAuth.frontendURL(ctx.Request, "/?oauth_error=google_exchange_failed"))
		return
	}

	identity, err := h.googleOAuth.client.ResolveIdentity(requestCtx, token.AccessToken)
	if err != nil {
		logger.Error("google oauth callback failed", "stage", "identity", "err", err)
		ctx.Redirect(http.StatusTemporaryRedirect, h.googleOAuth.frontendURL(ctx.Request, "/?oauth_error=google_identity_failed"))
		return
	}
	identity.InviteCode = h.inviteTicketFromRequest(ctx)
	session, err := h.service.SignInWithOAuth(requestCtx, identity)
	if err != nil {
		logger.Error(
			"google oauth callback failed",
			"stage", "sign_in",
			"provider", identity.Provider,
			"subject", identity.ProviderSubject,
			"err", err,
		)
		ctx.Redirect(http.StatusTemporaryRedirect, h.googleOAuth.frontendURL(ctx.Request, "/?oauth_error=google_sign_in_failed"))
		return
	}

	logger.Info("google oauth callback succeeded", "user_id", session.User.ID)
	h.clearInviteTicketCookie(ctx)
	h.syncOAuthAvatar(requestCtx, logger, "google", session.User.ID, identity.AvatarURL, session.User.AvatarSource)
	h.setSessionCookie(ctx, session.Token)
	h.redirectOAuthSuccess(ctx, validatedSuccessTarget, h.googleOAuth.successFrontendURL(ctx.Request, "/", session.Token), session)
}

func (h *Handler) clearGoogleOAuthStateCookie(ctx *gin.Context) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     googleOAuthStateCookieName,
		Value:    "",
		Path:     googleOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   -1,
	})
}

func (g *googleOAuth) authorizeURL(state string, redirectURI string) string {
	query := url.Values{}
	query.Set("response_type", "code")
	query.Set("client_id", g.clientID)
	query.Set("redirect_uri", strings.TrimSpace(redirectURI))
	query.Set("state", state)
	query.Set("scope", "openid email profile")
	query.Set("access_type", "offline")
	return "https://accounts.google.com/o/oauth2/v2/auth?" + query.Encode()
}

func (g *googleOAuth) frontendURL(request *http.Request, path string) string {
	baseURL := g.frontendBaseURLForRequest(request)
	if baseURL == "" {
		return path
	}
	if strings.HasPrefix(path, "/") {
		return baseURL + path
	}
	return baseURL + "/" + path
}

func (g *googleOAuth) successFrontendURL(request *http.Request, path string, sessionToken string) string {
	return oauthSuccessFrontendURL(g.frontendBaseURLForRequest(request), path, sessionToken)
}

func (g *googleOAuth) redirectURIForRequest(request *http.Request) string {
	requestHost := requestHostWithoutPort(request)
	defaultHost := hostWithoutPortFromURL(g.publicBaseURL)
	if requestHost == "" || requestHost == defaultHost || !strings.HasPrefix(requestHost, "api.") {
		return g.redirectURI
	}
	return replaceURLHost(g.redirectURI, requestHost, requestScheme(request))
}

func (g *googleOAuth) frontendBaseURLForRequest(request *http.Request) string {
	requestHost := requestHostWithoutPort(request)
	defaultHost := hostWithoutPortFromURL(g.publicBaseURL)
	if requestHost == "" || requestHost == defaultHost || !strings.HasPrefix(requestHost, "api.") {
		return g.frontendBaseURL
	}
	return requestScheme(request) + "://" + strings.TrimPrefix(requestHost, "api.")
}

// googleOAuthHTTPClient 是 Google OAuth 的真实 HTTP 实现。
type googleOAuthHTTPClient struct {
	oauthConfig *oauth2.Config
	httpClient  *http.Client
}

func (c *googleOAuthHTTPClient) ExchangeCode(ctx context.Context, code string, redirectURI string) (*GoogleOAuthToken, error) {
	cfg := *c.oauthConfig
	cfg.RedirectURL = redirectURI

	token, err := cfg.Exchange(ctx, code, oauth2.SetAuthURLParam("redirect_uri", redirectURI))
	if err != nil {
		return nil, fmt.Errorf("google token exchange failed: %w", err)
	}
	if strings.TrimSpace(token.AccessToken) == "" {
		return nil, fmt.Errorf("google token exchange returned empty access token")
	}

	expiresIn := 0
	if !token.Expiry.IsZero() {
		expiresIn = int(time.Until(token.Expiry).Seconds())
		if expiresIn < 0 {
			expiresIn = 0
		}
	}

	return &GoogleOAuthToken{
		AccessToken: token.AccessToken,
		ExpiresIn:   expiresIn,
	}, nil
}

func (c *googleOAuthHTTPClient) ResolveIdentity(ctx context.Context, accessToken string) (service.OAuthSignInInput, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.googleapis.com/oauth2/v3/userinfo", nil)
	if err != nil {
		return service.OAuthSignInInput{}, fmt.Errorf("build google userinfo request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))

	httpClient := c.httpClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return service.OAuthSignInInput{}, fmt.Errorf("google userinfo request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return service.OAuthSignInInput{}, fmt.Errorf("read google userinfo response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return service.OAuthSignInInput{}, fmt.Errorf("google userinfo request failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var userInfo struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if err := json.Unmarshal(body, &userInfo); err != nil {
		return service.OAuthSignInInput{}, fmt.Errorf("decode google userinfo response: %w", err)
	}
	if strings.TrimSpace(userInfo.Sub) == "" {
		return service.OAuthSignInInput{}, fmt.Errorf("google userinfo returned empty sub")
	}

	return service.OAuthSignInInput{
		Provider:        "google",
		ProviderSubject: strings.TrimSpace(userInfo.Sub),
		Email:           strings.TrimSpace(userInfo.Email),
		EmailVerified:   userInfo.EmailVerified,
		Name:            strings.TrimSpace(userInfo.Name),
		AvatarURL:       strings.TrimSpace(userInfo.Picture),
	}, nil
}
