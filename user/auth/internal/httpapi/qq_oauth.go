package httpapi

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

const qqOAuthStateCookieName = "lc_qq_oauth_state"
const qqOAuthStateCookiePath = "/auth/oauth/qq/callback"
const qqOAuthReturnToCookieName = "lc_qq_oauth_return_to"
const defaultQQOAuthAuthorizeURL = "https://graph.qq.com/oauth2.0/authorize"
const defaultQQOAuthAPIBaseURL = "https://graph.qq.com"

type QQOAuthClient interface {
	ExchangeCode(ctx context.Context, code string, redirectURI string) (*QQOAuthToken, error)
	ResolveIdentity(ctx context.Context, accessToken string) (service.OAuthSignInInput, error)
}

type QQOAuthToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int    `json:"expires_in"`
}

type QQOAuthConfig struct {
	AppID                string
	AppKey               string
	RedirectURI          string
	AuthorizeURL         string
	APIBaseURL           string
	FrontendBaseURL      string
	PublicBaseURL        string
	StateTTL             time.Duration
	Client               QQOAuthClient
	RegistrationDisabled bool
}

type qqOAuth struct {
	appID                string
	redirectURI          string
	authorizeEndpoint    string
	frontendBaseURL      string
	publicBaseURL        string
	stateTTL             time.Duration
	client               QQOAuthClient
	registrationDisabled bool
}

func newQQOAuth(config *QQOAuthConfig) *qqOAuth {
	if config == nil {
		return nil
	}

	appID := strings.TrimSpace(config.AppID)
	appKey := strings.TrimSpace(config.AppKey)
	redirectURI := strings.TrimSpace(config.RedirectURI)
	if appID == "" || appKey == "" || redirectURI == "" {
		return nil
	}
	authorizeURL := strings.TrimSpace(config.AuthorizeURL)
	if authorizeURL == "" {
		authorizeURL = defaultQQOAuthAuthorizeURL
	}
	apiBaseURL := strings.TrimRight(strings.TrimSpace(config.APIBaseURL), "/")
	if apiBaseURL == "" {
		apiBaseURL = defaultQQOAuthAPIBaseURL
	}

	stateTTL := config.StateTTL
	if stateTTL <= 0 {
		stateTTL = 10 * time.Minute
	}

	client := config.Client
	if client == nil {
		client = &qqOAuthHTTPClient{
			appID:       appID,
			appKey:      appKey,
			redirectURI: redirectURI,
			apiBaseURL:  apiBaseURL,
			httpClient:  http.DefaultClient,
		}
	}

	return &qqOAuth{
		appID:                appID,
		redirectURI:          redirectURI,
		authorizeEndpoint:    authorizeURL,
		frontendBaseURL:      strings.TrimRight(strings.TrimSpace(config.FrontendBaseURL), "/"),
		publicBaseURL:        strings.TrimRight(strings.TrimSpace(config.PublicBaseURL), "/"),
		stateTTL:             stateTTL,
		client:               client,
		registrationDisabled: config.RegistrationDisabled,
	}
}

func (h *Handler) StartQQOAuth(ctx *gin.Context) {
	if h.qqOAuth == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}

	nonce, err := newOAuthState()
	if err != nil {
		ctx.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	startState, err := buildOAuthStartState(ctx.Request, "qq", qqOAuthStateCookiePath, h.qqOAuth.redirectURIForRequest(ctx.Request), nonce)
	if err != nil {
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     qqOAuthStateCookieName,
		Value:    startState.CookieValue,
		Path:     qqOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   int(h.qqOAuth.stateTTL / time.Second),
	})
	validatedReturnTo := h.readValidatedReturnToFromRequest(ctx.Request)
	setOAuthReturnToCookie(ctx, qqOAuthReturnToCookieName, qqOAuthStateCookiePath, validatedReturnTo, h.cookieSecure, h.qqOAuth.stateTTL)

	ctx.Redirect(http.StatusTemporaryRedirect, h.qqOAuth.authorizeURL(startState.StateParam, startState.RedirectURI))
}

func (h *Handler) HandleQQOAuthCallback(ctx *gin.Context) {
	if h.qqOAuth == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}

	code := strings.TrimSpace(ctx.Query("code"))
	state := strings.TrimSpace(ctx.Query("state"))
	logger := requestLogger(ctx, nil)
	exchangeRedirectURI := h.qqOAuth.redirectURIForRequest(ctx.Request)

	if relayState, ok := parseOAuthRelayState(state); ok {
		if err := validateOAuthRelayStateForProvider("qq", relayState); err != nil {
			logger.Warn("qq oauth callback failed", "stage", "relay_state_validation", "err", err)
			ctx.Redirect(http.StatusTemporaryRedirect, h.qqOAuth.frontendURL(ctx.Request, "/?oauth_error=qq_state_mismatch"))
			return
		}
		if isOAuthRelayIssuerCallback(ctx.Request, relayState) {
			target, err := relayCallbackURLWithOriginalQuery("qq", relayState.TargetCallbackURI, ctx.Request.URL.RawQuery)
			if err != nil {
				logger.Warn("qq oauth relay callback failed", "stage", "target_query", "err", err)
				ctx.Redirect(http.StatusTemporaryRedirect, h.qqOAuth.frontendURL(ctx.Request, "/?oauth_error=qq_state_mismatch"))
				return
			}
			ctx.Redirect(http.StatusTemporaryRedirect, target)
			return
		}
		if !isOAuthRelayTargetCallback(ctx.Request, relayState) {
			logger.Warn("qq oauth callback failed", "stage", "relay_target_mismatch")
			ctx.Redirect(http.StatusTemporaryRedirect, h.qqOAuth.frontendURL(ctx.Request, "/?oauth_error=qq_state_mismatch"))
			return
		}
		exchangeRedirectURI = relayState.IssuerRedirectURI
		expectedState := ""
		if cookie, err := ctx.Request.Cookie(qqOAuthStateCookieName); err == nil {
			expectedState = strings.TrimSpace(cookie.Value)
		}
		validatedSuccessTarget := h.readValidatedOAuthReturnToCookie(ctx.Request, qqOAuthReturnToCookieName)
		h.clearQQOAuthStateCookie(ctx)
		clearOAuthReturnToCookie(ctx, qqOAuthReturnToCookieName, qqOAuthStateCookiePath, h.cookieSecure)
		h.handleQQOAuthCallbackAfterState(ctx, code, relayState.Nonce, expectedState, validatedSuccessTarget, exchangeRedirectURI, logger)
		return
	}

	expectedState := ""
	if cookie, err := ctx.Request.Cookie(qqOAuthStateCookieName); err == nil {
		expectedState = strings.TrimSpace(cookie.Value)
	}
	validatedSuccessTarget := h.readValidatedOAuthReturnToCookie(ctx.Request, qqOAuthReturnToCookieName)
	h.clearQQOAuthStateCookie(ctx)
	clearOAuthReturnToCookie(ctx, qqOAuthReturnToCookieName, qqOAuthStateCookiePath, h.cookieSecure)
	h.handleQQOAuthCallbackAfterState(ctx, code, state, expectedState, validatedSuccessTarget, exchangeRedirectURI, logger)
}

func (h *Handler) handleQQOAuthCallbackAfterState(ctx *gin.Context, code string, state string, expectedState string, validatedSuccessTarget string, exchangeRedirectURI string, logger interface {
	Warn(msg string, keysAndValues ...any)
	Error(msg string, keysAndValues ...any)
	Info(msg string, keysAndValues ...any)
}) {
	if code == "" || state == "" || expectedState == "" || state != expectedState {
		logger.Warn(
			"qq oauth callback failed",
			"stage", "state_mismatch",
			"has_code", code != "",
			"has_state", state != "",
			"has_cookie_state", expectedState != "",
		)
		ctx.Redirect(http.StatusTemporaryRedirect, h.qqOAuth.frontendURL(ctx.Request, "/?oauth_error=qq_state_mismatch"))
		return
	}

	requestCtx := ctx.Request.Context()
	token, err := h.qqOAuth.client.ExchangeCode(requestCtx, code, exchangeRedirectURI)
	if err != nil || strings.TrimSpace(token.AccessToken) == "" {
		logger.Error("qq oauth callback failed", "stage", "exchange", "err", err)
		ctx.Redirect(http.StatusTemporaryRedirect, h.qqOAuth.frontendURL(ctx.Request, "/?oauth_error=qq_exchange_failed"))
		return
	}

	identity, err := h.qqOAuth.client.ResolveIdentity(requestCtx, token.AccessToken)
	if err != nil {
		logger.Error("qq oauth callback failed", "stage", "identity", "err", err)
		ctx.Redirect(http.StatusTemporaryRedirect, h.qqOAuth.frontendURL(ctx.Request, "/?oauth_error=qq_identity_failed"))
		return
	}
	identity.InviteCode = h.inviteTicketFromRequest(ctx)
	identity.RegistrationDisabled = h.qqOAuth.registrationDisabled
	session, err := h.service.SignInWithOAuth(requestCtx, identity)
	if err != nil {
		logger.Error(
			"qq oauth callback failed",
			"stage", "sign_in",
			"provider", identity.Provider,
			"subject", identity.ProviderSubject,
			"err", err,
		)
		var serviceErr *service.Error
		if errors.As(err, &serviceErr) && serviceErr.Code == "oauth_registration_disabled" {
			ctx.Redirect(http.StatusTemporaryRedirect, h.qqOAuth.frontendURL(ctx.Request, "/?oauth_error=qq_registration_disabled"))
			return
		}
		ctx.Redirect(http.StatusTemporaryRedirect, h.qqOAuth.frontendURL(ctx.Request, "/?oauth_error=qq_sign_in_failed"))
		return
	}

	logger.Info(
		"qq oauth callback succeeded",
		"user_id", session.User.ID,
	)
	h.clearInviteTicketCookie(ctx)
	h.syncOAuthAvatar(requestCtx, logger, "qq", session.User.ID, identity.AvatarURL, session.User.AvatarSource)
	h.setSessionCookie(ctx, session.Token)
	h.completeFederationSwitch(ctx, session.Token)
	h.redirectOAuthSuccess(ctx, validatedSuccessTarget, h.qqOAuth.successFrontendURL(ctx.Request, "/", session.Token), session)
}

func (h *Handler) clearQQOAuthStateCookie(ctx *gin.Context) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     qqOAuthStateCookieName,
		Value:    "",
		Path:     qqOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   -1,
	})
}

func (q *qqOAuth) authorizeURL(state string, redirectURI string) string {
	query := url.Values{}
	query.Set("response_type", "code")
	query.Set("client_id", q.appID)
	query.Set("redirect_uri", strings.TrimSpace(redirectURI))
	query.Set("state", state)
	query.Set("scope", "get_user_info")
	return q.authorizeEndpoint + "?" + query.Encode()
}

func (q *qqOAuth) frontendURL(request *http.Request, path string) string {
	baseURL := q.frontendBaseURLForRequest(request)
	if baseURL == "" {
		return path
	}
	if strings.HasPrefix(path, "/") {
		return baseURL + path
	}
	return baseURL + "/" + path
}

func (q *qqOAuth) successFrontendURL(request *http.Request, path string, sessionToken string) string {
	return oauthSuccessFrontendURL(q.frontendBaseURLForRequest(request), path, sessionToken)
}

func (q *qqOAuth) redirectURIForRequest(request *http.Request) string {
	requestHost := requestHostWithoutPort(request)
	defaultHost := hostWithoutPortFromURL(q.publicBaseURL)
	if requestHost == "" || requestHost == defaultHost || !strings.HasPrefix(requestHost, "api.") {
		return q.redirectURI
	}
	return replaceURLHost(q.redirectURI, requestHost, requestScheme(request))
}

func (q *qqOAuth) frontendBaseURLForRequest(request *http.Request) string {
	requestHost := requestHostWithoutPort(request)
	defaultHost := hostWithoutPortFromURL(q.publicBaseURL)
	if requestHost == "" || requestHost == defaultHost || !strings.HasPrefix(requestHost, "api.") {
		return q.frontendBaseURL
	}
	return requestScheme(request) + "://" + strings.TrimPrefix(requestHost, "api.")
}

func replaceURLHost(rawURL string, host string, scheme string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return rawURL
	}
	if strings.TrimSpace(scheme) != "" {
		parsed.Scheme = strings.TrimSpace(scheme)
	}
	parsed.Host = strings.TrimSpace(host)
	return parsed.String()
}

func hostWithoutPortFromURL(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(parsed.Hostname())
}

func requestHostWithoutPort(request *http.Request) string {
	if request == nil {
		return ""
	}
	if forwardedHost := strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-Host"), ",")[0]); forwardedHost != "" {
		host := strings.TrimSpace(strings.Split(forwardedHost, ":")[0])
		if host != "" {
			return host
		}
	}
	if host := strings.TrimSpace(request.Host); host != "" {
		return strings.TrimSpace(strings.Split(host, ":")[0])
	}
	return ""
}

func requestScheme(request *http.Request) string {
	if request == nil {
		return "https"
	}
	if forwardedProto := strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-Proto"), ",")[0]); forwardedProto != "" {
		return strings.ToLower(forwardedProto)
	}
	if request.TLS != nil {
		return "https"
	}
	return "http"
}

type qqOAuthHTTPClient struct {
	appID       string
	appKey      string
	redirectURI string
	apiBaseURL  string
	httpClient  *http.Client
}

func (c *qqOAuthHTTPClient) ExchangeCode(ctx context.Context, code string, redirectURI string) (*QQOAuthToken, error) {
	query := url.Values{}
	query.Set("grant_type", "authorization_code")
	query.Set("client_id", c.appID)
	query.Set("client_secret", c.appKey)
	query.Set("code", code)
	query.Set("redirect_uri", strings.TrimSpace(redirectURI))
	query.Set("fmt", "json")

	body, err := c.doGET(ctx, c.endpoint("/oauth2.0/token")+"?"+query.Encode())
	if err != nil {
		return nil, err
	}

	return decodeQQOAuthToken(body)
}

func (c *qqOAuthHTTPClient) ResolveIdentity(ctx context.Context, accessToken string) (service.OAuthSignInInput, error) {
	openID, err := c.loadOpenID(ctx, accessToken)
	if err != nil {
		return service.OAuthSignInInput{}, err
	}

	profile, err := c.loadProfile(ctx, accessToken, openID)
	if err != nil {
		return service.OAuthSignInInput{}, err
	}

	return service.OAuthSignInInput{
		Provider:        "qq",
		ProviderSubject: openID,
		Name:            strings.TrimSpace(profile.Nickname),
		AvatarURL: firstNonEmpty(
			strings.TrimSpace(profile.FigureurlQq2),
			strings.TrimSpace(profile.FigureurlQq1),
			strings.TrimSpace(profile.Figureurl2),
			strings.TrimSpace(profile.Figureurl1),
		),
	}, nil
}

func (c *qqOAuthHTTPClient) loadOpenID(ctx context.Context, accessToken string) (string, error) {
	query := url.Values{}
	query.Set("access_token", accessToken)

	body, err := c.doGET(ctx, c.endpoint("/oauth2.0/me")+"?"+query.Encode())
	if err != nil {
		return "", err
	}

	payloadText := strings.TrimSpace(string(body))
	payloadText = strings.TrimPrefix(payloadText, "callback(")
	payloadText = strings.TrimSuffix(payloadText, ");")
	payloadText = strings.TrimSpace(payloadText)

	var payload struct {
		ClientID         string `json:"client_id"`
		OpenID           string `json:"openid"`
		Error            int    `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.Unmarshal([]byte(payloadText), &payload); err != nil {
		return "", fmt.Errorf("decode qq openid response: %w", err)
	}
	if payload.Error != 0 {
		return "", fmt.Errorf("qq openid lookup failed: %s", strings.TrimSpace(payload.ErrorDescription))
	}
	if strings.TrimSpace(payload.OpenID) == "" {
		return "", fmt.Errorf("qq openid lookup returned empty openid")
	}
	return strings.TrimSpace(payload.OpenID), nil
}

func (c *qqOAuthHTTPClient) loadProfile(ctx context.Context, accessToken string, openID string) (*qqUserInfoResponse, error) {
	query := url.Values{}
	query.Set("access_token", accessToken)
	query.Set("oauth_consumer_key", c.appID)
	query.Set("openid", openID)

	body, err := c.doGET(ctx, c.endpoint("/user/get_user_info")+"?"+query.Encode())
	if err != nil {
		return nil, err
	}

	var payload qqUserInfoResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode qq user info response: %w", err)
	}
	if payload.Ret != 0 {
		return nil, fmt.Errorf("qq user info lookup failed: %s", strings.TrimSpace(payload.Msg))
	}
	return &payload, nil
}

func (c *qqOAuthHTTPClient) doGET(ctx context.Context, requestURL string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build qq oauth request: %w", err)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("qq oauth request failed: %w", err)
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read qq oauth response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("qq oauth request failed: status=%d body=%s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

func (c *qqOAuthHTTPClient) endpoint(path string) string {
	baseURL := strings.TrimRight(strings.TrimSpace(c.apiBaseURL), "/")
	if baseURL == "" {
		baseURL = defaultQQOAuthAPIBaseURL
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return baseURL + path
}

type qqUserInfoResponse struct {
	Ret          int    `json:"ret"`
	Msg          string `json:"msg"`
	Nickname     string `json:"nickname"`
	Figureurl1   string `json:"figureurl_1"`
	Figureurl2   string `json:"figureurl_2"`
	FigureurlQq1 string `json:"figureurl_qq_1"`
	FigureurlQq2 string `json:"figureurl_qq_2"`
}

func newOAuthState() (string, error) {
	var raw [16]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func decodeQQOAuthToken(body []byte) (*QQOAuthToken, error) {
	var payload struct {
		AccessToken      string          `json:"access_token"`
		RefreshToken     string          `json:"refresh_token,omitempty"`
		ExpiresIn        json.RawMessage `json:"expires_in"`
		Error            int             `json:"error"`
		ErrorDescription string          `json:"error_description"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode qq token response: %w", err)
	}
	if payload.Error != 0 {
		return nil, fmt.Errorf("qq token exchange failed: %s", strings.TrimSpace(payload.ErrorDescription))
	}
	if strings.TrimSpace(payload.AccessToken) == "" {
		return nil, fmt.Errorf("qq token exchange returned empty access token")
	}

	expiresIn, err := parseFlexibleJSONInt(payload.ExpiresIn)
	if err != nil {
		return nil, fmt.Errorf("decode qq token expires_in: %w", err)
	}

	return &QQOAuthToken{
		AccessToken:  payload.AccessToken,
		RefreshToken: payload.RefreshToken,
		ExpiresIn:    expiresIn,
	}, nil
}

func parseFlexibleJSONInt(raw json.RawMessage) (int, error) {
	if len(raw) == 0 {
		return 0, nil
	}

	var numeric int
	if err := json.Unmarshal(raw, &numeric); err == nil {
		return numeric, nil
	}

	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return 0, err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return 0, nil
	}

	numeric64, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return 0, err
	}
	return int(numeric64), nil
}
