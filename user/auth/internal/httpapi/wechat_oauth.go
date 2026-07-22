package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

const wechatOAuthStateCookieName = "lc_wechat_oauth_state"
const wechatOAuthStateCookiePath = "/auth/oauth/wechat/callback"
const wechatOAuthModeCookieName = "lc_wechat_oauth_mode"
const wechatOAuthScopeCookieName = "lc_wechat_oauth_scope"
const wechatOAuthReturnToCookieName = "lc_wechat_oauth_return_to"

type wechatOAuthMode string

const (
	wechatOAuthModeWebsite         wechatOAuthMode = "website"
	wechatOAuthModeOfficialAccount wechatOAuthMode = "official_account"
)

type WeChatOAuthClient interface {
	ExchangeCode(ctx context.Context, code string, redirectURI string) (*WeChatOAuthToken, error)
	ResolveIdentity(ctx context.Context, token *WeChatOAuthToken) (service.OAuthSignInInput, error)
}

type WeChatOAuthToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int    `json:"expires_in"`
	OpenID       string `json:"openid"`
	UnionID      string `json:"unionid,omitempty"`
	Scope        string `json:"scope,omitempty"`
}

type WeChatOAuthConfig struct {
	AppID           string
	AppSecret       string
	RedirectURI     string
	Website         WeChatOAuthAppConfig
	OfficialAccount WeChatOAuthAppConfig
	FrontendBaseURL string
	PublicBaseURL   string
	StateTTL        time.Duration
	Client          WeChatOAuthClient
}

type WeChatOAuthAppConfig struct {
	AppID       string
	AppSecret   string
	RedirectURI string
	Client      WeChatOAuthClient
}

type wechatOAuthApp struct {
	mode             wechatOAuthMode
	appID            string
	redirectURI      string
	authorizeBaseURL string
	scope            string
	client           WeChatOAuthClient
}

type wechatOAuth struct {
	website         *wechatOAuthApp
	officialAccount *wechatOAuthApp
	frontendBaseURL string
	publicBaseURL   string
	stateTTL        time.Duration
}

func newWeChatOAuth(config *WeChatOAuthConfig) *wechatOAuth {
	if config == nil {
		return nil
	}

	stateTTL := config.StateTTL
	if stateTTL <= 0 {
		stateTTL = 10 * time.Minute
	}

	websiteConfig := config.Website
	if strings.TrimSpace(websiteConfig.AppID) == "" && strings.TrimSpace(websiteConfig.AppSecret) == "" && strings.TrimSpace(websiteConfig.RedirectURI) == "" {
		websiteConfig = WeChatOAuthAppConfig{
			AppID:       config.AppID,
			AppSecret:   config.AppSecret,
			RedirectURI: config.RedirectURI,
			Client:      config.Client,
		}
	}
	website := newWeChatOAuthApp(wechatOAuthModeWebsite, websiteConfig, "https://open.weixin.qq.com/connect/qrconnect", "snsapi_login")
	officialAccount := newWeChatOAuthApp(wechatOAuthModeOfficialAccount, config.OfficialAccount, "https://open.weixin.qq.com/connect/oauth2/authorize", "snsapi_userinfo")
	if website == nil && officialAccount == nil {
		return nil
	}

	return &wechatOAuth{
		website:         website,
		officialAccount: officialAccount,
		frontendBaseURL: strings.TrimRight(strings.TrimSpace(config.FrontendBaseURL), "/"),
		publicBaseURL:   strings.TrimRight(strings.TrimSpace(config.PublicBaseURL), "/"),
		stateTTL:        stateTTL,
	}
}

func newWeChatOAuthApp(mode wechatOAuthMode, config WeChatOAuthAppConfig, authorizeBaseURL string, scope string) *wechatOAuthApp {
	appID := strings.TrimSpace(config.AppID)
	appSecret := strings.TrimSpace(config.AppSecret)
	redirectURI := strings.TrimSpace(config.RedirectURI)
	if appID == "" || appSecret == "" || redirectURI == "" {
		return nil
	}

	client := config.Client
	if client == nil {
		client = &wechatOAuthHTTPClient{
			appID:       appID,
			appSecret:   appSecret,
			redirectURI: redirectURI,
			httpClient:  &http.Client{Timeout: 10 * time.Second},
		}
	}

	return &wechatOAuthApp{
		mode:             mode,
		appID:            appID,
		redirectURI:      redirectURI,
		authorizeBaseURL: authorizeBaseURL,
		scope:            scope,
		client:           client,
	}
}

func (h *Handler) StartWeChatOAuth(ctx *gin.Context) {
	if h.wechatOAuth == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}

	app, err := h.wechatOAuth.startAppForRequest(ctx.Request)
	if err != nil {
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}
	if app == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}
	scope, err := requestedWeChatOAuthScope(ctx.Request, app)
	if err != nil {
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	nonce, err := newOAuthState()
	if err != nil {
		ctx.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	startState, err := buildOAuthStartState(ctx.Request, "wechat", wechatOAuthStateCookiePath, app.redirectURIForRequest(ctx.Request), nonce)
	if err != nil {
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     wechatOAuthStateCookieName,
		Value:    startState.CookieValue,
		Path:     wechatOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   int(h.wechatOAuth.stateTTL / time.Second),
	})
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     wechatOAuthModeCookieName,
		Value:    string(app.mode),
		Path:     wechatOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   int(h.wechatOAuth.stateTTL / time.Second),
	})
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     wechatOAuthScopeCookieName,
		Value:    scope,
		Path:     wechatOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   int(h.wechatOAuth.stateTTL / time.Second),
	})
	validatedReturnTo := h.readValidatedReturnToFromRequest(ctx.Request)
	setOAuthReturnToCookie(ctx, wechatOAuthReturnToCookieName, wechatOAuthStateCookiePath, validatedReturnTo, h.cookieSecure, h.wechatOAuth.stateTTL)

	ctx.Redirect(http.StatusTemporaryRedirect, app.authorizeURL(startState.StateParam, startState.RedirectURI, scope))
}

func (h *Handler) HandleWeChatOAuthCallback(ctx *gin.Context) {
	if h.wechatOAuth == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}

	code := strings.TrimSpace(ctx.Query("code"))
	state := strings.TrimSpace(ctx.Query("state"))
	logger := requestLogger(ctx, nil)
	app := h.wechatOAuth.callbackAppForRequest(ctx.Request)
	if app == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}
	exchangeRedirectURI := app.redirectURIForRequest(ctx.Request)

	if relayState, ok := parseOAuthRelayState(state); ok {
		if err := validateOAuthRelayStateForProvider("wechat", relayState); err != nil {
			logger.Warn("wechat oauth callback failed", "stage", "relay_state_validation", "err", err)
			ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.frontendURL(ctx.Request, "/?oauth_error=wechat_state_mismatch"))
			return
		}
		if isOAuthRelayIssuerCallback(ctx.Request, relayState) {
			target, err := relayCallbackURLWithOriginalQuery("wechat", relayState.TargetCallbackURI, ctx.Request.URL.RawQuery)
			if err != nil {
				logger.Warn("wechat oauth relay callback failed", "stage", "target_query", "err", err)
				ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.frontendURL(ctx.Request, "/?oauth_error=wechat_state_mismatch"))
				return
			}
			ctx.Redirect(http.StatusTemporaryRedirect, target)
			return
		}
		if !isOAuthRelayTargetCallback(ctx.Request, relayState) {
			logger.Warn("wechat oauth callback failed", "stage", "relay_target_mismatch")
			ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.frontendURL(ctx.Request, "/?oauth_error=wechat_state_mismatch"))
			return
		}
		exchangeRedirectURI = relayState.IssuerRedirectURI
		expectedState := ""
		if cookie, err := ctx.Request.Cookie(wechatOAuthStateCookieName); err == nil {
			expectedState = strings.TrimSpace(cookie.Value)
		}
		validatedSuccessTarget := h.readValidatedOAuthReturnToCookie(ctx.Request, wechatOAuthReturnToCookieName)
		scope := readWeChatOAuthScopeCookie(ctx.Request, app.scope)
		h.clearWeChatOAuthStateCookie(ctx)
		h.clearWeChatOAuthModeCookie(ctx)
		h.clearWeChatOAuthScopeCookie(ctx)
		clearOAuthReturnToCookie(ctx, wechatOAuthReturnToCookieName, wechatOAuthStateCookiePath, h.cookieSecure)
		h.handleWeChatOAuthCallbackAfterState(ctx, app, scope, code, relayState.Nonce, expectedState, validatedSuccessTarget, exchangeRedirectURI, logger)
		return
	}

	expectedState := ""
	if cookie, err := ctx.Request.Cookie(wechatOAuthStateCookieName); err == nil {
		expectedState = strings.TrimSpace(cookie.Value)
	}
	validatedSuccessTarget := h.readValidatedOAuthReturnToCookie(ctx.Request, wechatOAuthReturnToCookieName)
	scope := readWeChatOAuthScopeCookie(ctx.Request, app.scope)
	h.clearWeChatOAuthStateCookie(ctx)
	h.clearWeChatOAuthModeCookie(ctx)
	h.clearWeChatOAuthScopeCookie(ctx)
	clearOAuthReturnToCookie(ctx, wechatOAuthReturnToCookieName, wechatOAuthStateCookiePath, h.cookieSecure)
	h.handleWeChatOAuthCallbackAfterState(ctx, app, scope, code, state, expectedState, validatedSuccessTarget, exchangeRedirectURI, logger)
}

func (h *Handler) handleWeChatOAuthCallbackAfterState(ctx *gin.Context, app *wechatOAuthApp, scope string, code string, state string, expectedState string, validatedSuccessTarget string, exchangeRedirectURI string, logger interface {
	Warn(msg string, keysAndValues ...any)
	Error(msg string, keysAndValues ...any)
	Info(msg string, keysAndValues ...any)
}) {
	if app == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}
	if code == "" || state == "" || expectedState == "" || state != expectedState {
		logger.Warn(
			"wechat oauth callback failed",
			"stage", "state_mismatch",
			"has_code", code != "",
			"has_state", state != "",
			"has_cookie_state", expectedState != "",
		)
		ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.frontendURL(ctx.Request, "/?oauth_error=wechat_state_mismatch"))
		return
	}

	requestCtx := ctx.Request.Context()
	token, err := app.client.ExchangeCode(requestCtx, code, exchangeRedirectURI)
	if err != nil || strings.TrimSpace(token.AccessToken) == "" {
		logger.Error("wechat oauth callback failed", "stage", "exchange", "err", err)
		ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.frontendURL(ctx.Request, "/?oauth_error=wechat_exchange_failed"))
		return
	}
	if isWeChatOAuthBaseScope(scope) {
		openID := strings.TrimSpace(token.OpenID)
		if openID == "" {
			logger.Error("wechat oauth callback failed", "stage", "openid", "err", "missing_openid")
			ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.frontendURL(ctx.Request, "/auth/wechat-pay?oauth_error=wechat_openid_failed"))
			return
		}
		redirectURL := h.wechatOAuth.frontendURL(ctx.Request, "/auth/wechat-pay")
		if validatedSuccessTarget != "" {
			redirectURL = validatedSuccessTarget
		}
		ctx.Redirect(http.StatusTemporaryRedirect, appendQueryParamToReturnTo(redirectURL, "openid", openID))
		return
	}

	identity, err := app.client.ResolveIdentity(requestCtx, token)
	if err != nil {
		logger.Error("wechat oauth callback failed", "stage", "identity", "err", err)
		ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.frontendURL(ctx.Request, "/?oauth_error=wechat_identity_failed"))
		return
	}
	identity.InviteCode = h.inviteTicketFromRequest(ctx)
	session, err := h.service.SignInWithOAuth(requestCtx, identity)
	if err != nil {
		logger.Error(
			"wechat oauth callback failed",
			"stage", "sign_in",
			"provider", identity.Provider,
			"subject", identity.ProviderSubject,
			"err", err,
		)
		ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.frontendURL(ctx.Request, "/?oauth_error=wechat_sign_in_failed"))
		return
	}

	logger.Info("wechat oauth callback succeeded", "user_id", session.User.ID)
	h.clearInviteTicketCookie(ctx)
	if h.avatarStore != nil && strings.TrimSpace(identity.AvatarURL) != "" && strings.TrimSpace(session.User.AvatarSource) != "upload" {
		objectKey, syncErr := h.avatarStore.SyncRemoteAvatar(requestCtx, session.User.ID, identity.AvatarURL)
		if syncErr != nil {
			logger.Warn("wechat oauth avatar sync failed", "user_id", session.User.ID, "err", syncErr)
		} else if _, persistErr := h.service.SetUserAvatar(requestCtx, session.User.ID, objectKey, "oauth_wechat"); persistErr != nil {
			logger.Warn("wechat oauth avatar persist failed", "user_id", session.User.ID, "err", persistErr)
		}
	}
	h.setSessionCookie(ctx, session.Token)
	h.redirectOAuthSuccess(ctx, validatedSuccessTarget, h.wechatOAuth.successFrontendURL(ctx.Request, "/", session.Token), session)
}

func (h *Handler) clearWeChatOAuthStateCookie(ctx *gin.Context) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     wechatOAuthStateCookieName,
		Value:    "",
		Path:     wechatOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   -1,
	})
}

func (h *Handler) clearWeChatOAuthModeCookie(ctx *gin.Context) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     wechatOAuthModeCookieName,
		Value:    "",
		Path:     wechatOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   -1,
	})
}

func (h *Handler) clearWeChatOAuthScopeCookie(ctx *gin.Context) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     wechatOAuthScopeCookieName,
		Value:    "",
		Path:     wechatOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   -1,
	})
}

func (w *wechatOAuth) startAppForRequest(request *http.Request) (*wechatOAuthApp, error) {
	if w == nil {
		return nil, nil
	}
	mode, err := requestedWeChatOAuthMode(request)
	if err != nil {
		return nil, err
	}
	if mode == "" {
		if isWeChatInAppBrowser(request) && w.officialAccount != nil {
			mode = wechatOAuthModeOfficialAccount
		} else {
			mode = wechatOAuthModeWebsite
		}
	}
	return w.appForMode(mode), nil
}

func (w *wechatOAuth) callbackAppForRequest(request *http.Request) *wechatOAuthApp {
	if w == nil {
		return nil
	}
	mode := wechatOAuthMode("")
	if request != nil {
		if cookie, err := request.Cookie(wechatOAuthModeCookieName); err == nil {
			mode = wechatOAuthMode(strings.TrimSpace(cookie.Value))
		}
	}
	if app := w.appForMode(mode); app != nil {
		return app
	}
	if w.website != nil {
		return w.website
	}
	return w.officialAccount
}

func (w *wechatOAuth) appForMode(mode wechatOAuthMode) *wechatOAuthApp {
	switch mode {
	case wechatOAuthModeOfficialAccount:
		return w.officialAccount
	case wechatOAuthModeWebsite, "":
		return w.website
	default:
		return nil
	}
}

func requestedWeChatOAuthMode(request *http.Request) (wechatOAuthMode, error) {
	if request == nil || request.URL == nil {
		return "", nil
	}
	mode := wechatOAuthMode(strings.TrimSpace(request.URL.Query().Get("mode")))
	switch mode {
	case "", wechatOAuthModeWebsite, wechatOAuthModeOfficialAccount:
		return mode, nil
	default:
		return "", fmt.Errorf("unsupported wechat oauth mode %q", mode)
	}
}

func requestedWeChatOAuthScope(request *http.Request, app *wechatOAuthApp) (string, error) {
	if app == nil {
		return "", errors.New("missing wechat oauth app")
	}
	requested := ""
	if request != nil && request.URL != nil {
		requested = strings.TrimSpace(request.URL.Query().Get("scope"))
	}
	switch requested {
	case "":
		return app.scope, nil
	case "base", "snsapi_base":
		if app.mode != wechatOAuthModeOfficialAccount {
			return "", fmt.Errorf("unsupported wechat oauth base scope for mode %q", app.mode)
		}
		return "snsapi_base", nil
	case "userinfo", "snsapi_userinfo":
		if app.mode != wechatOAuthModeOfficialAccount {
			return "", fmt.Errorf("unsupported wechat oauth userinfo scope for mode %q", app.mode)
		}
		return "snsapi_userinfo", nil
	case "login", "snsapi_login":
		if app.mode != wechatOAuthModeWebsite {
			return "", fmt.Errorf("unsupported wechat oauth login scope for mode %q", app.mode)
		}
		return "snsapi_login", nil
	default:
		return "", fmt.Errorf("unsupported wechat oauth scope %q", requested)
	}
}

func readWeChatOAuthScopeCookie(request *http.Request, fallback string) string {
	if request == nil {
		return strings.TrimSpace(fallback)
	}
	cookie, err := request.Cookie(wechatOAuthScopeCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return strings.TrimSpace(fallback)
	}
	return strings.TrimSpace(cookie.Value)
}

func isWeChatOAuthBaseScope(scope string) bool {
	return strings.TrimSpace(scope) == "snsapi_base"
}

func isWeChatInAppBrowser(request *http.Request) bool {
	if request == nil {
		return false
	}
	return strings.Contains(strings.ToLower(request.UserAgent()), "micromessenger")
}

func (w *wechatOAuthApp) authorizeURL(state string, redirectURI string, scope string) string {
	query := url.Values{}
	query.Set("appid", w.appID)
	query.Set("redirect_uri", strings.TrimSpace(redirectURI))
	query.Set("response_type", "code")
	if strings.TrimSpace(scope) == "" {
		scope = w.scope
	}
	query.Set("scope", strings.TrimSpace(scope))
	query.Set("state", state)
	return w.authorizeBaseURL + "?" + query.Encode() + "#wechat_redirect"
}

func (w *wechatOAuthApp) redirectURIForRequest(request *http.Request) string {
	return w.redirectURI
}

func (w *wechatOAuth) frontendURL(request *http.Request, path string) string {
	baseURL := w.frontendBaseURLForRequest(request)
	if baseURL == "" {
		return path
	}
	if strings.HasPrefix(path, "/") {
		return baseURL + path
	}
	return baseURL + "/" + path
}

func (w *wechatOAuth) successFrontendURL(request *http.Request, path string, sessionToken string) string {
	return oauthSuccessFrontendURL(w.frontendBaseURLForRequest(request), path, sessionToken)
}

func (w *wechatOAuth) frontendBaseURLForRequest(request *http.Request) string {
	requestHost := requestHostWithoutPort(request)
	defaultHost := hostWithoutPortFromURL(w.publicBaseURL)
	if requestHost == "" || requestHost == defaultHost || !strings.HasPrefix(requestHost, "api.") {
		return w.frontendBaseURL
	}
	return requestScheme(request) + "://" + strings.TrimPrefix(requestHost, "api.")
}

type wechatOAuthHTTPClient struct {
	appID       string
	appSecret   string
	redirectURI string
	httpClient  *http.Client
}

func (c *wechatOAuthHTTPClient) ExchangeCode(ctx context.Context, code string, redirectURI string) (*WeChatOAuthToken, error) {
	query := url.Values{}
	query.Set("appid", c.appID)
	query.Set("secret", c.appSecret)
	query.Set("code", strings.TrimSpace(code))
	query.Set("grant_type", "authorization_code")
	if strings.TrimSpace(redirectURI) != "" {
		query.Set("redirect_uri", strings.TrimSpace(redirectURI))
	}
	body, err := c.doGET(ctx, "https://api.weixin.qq.com/sns/oauth2/access_token?"+query.Encode())
	if err != nil {
		return nil, err
	}
	return decodeWeChatOAuthToken(body)
}

func (c *wechatOAuthHTTPClient) ResolveIdentity(ctx context.Context, token *WeChatOAuthToken) (service.OAuthSignInInput, error) {
	if token == nil || strings.TrimSpace(token.AccessToken) == "" || strings.TrimSpace(token.OpenID) == "" {
		return service.OAuthSignInInput{}, errors.New("missing wechat token identity")
	}
	profile, err := c.loadProfile(ctx, token.AccessToken, token.OpenID)
	if err != nil {
		return service.OAuthSignInInput{}, err
	}
	subject := strings.TrimSpace(token.UnionID)
	if subject == "" {
		subject = strings.TrimSpace(profile.UnionID)
	}
	if subject == "" {
		return service.OAuthSignInInput{}, errors.New("wechat unionid missing")
	}
	return service.OAuthSignInInput{
		Provider:        "wechat",
		ProviderSubject: subject,
		Name:            strings.TrimSpace(profile.Nickname),
		AvatarURL:       strings.TrimSpace(profile.HeadImgURL),
	}, nil
}

type wechatUserInfoResponse struct {
	OpenID     string `json:"openid"`
	Nickname   string `json:"nickname"`
	HeadImgURL string `json:"headimgurl"`
	UnionID    string `json:"unionid"`
	ErrCode    int    `json:"errcode"`
	ErrMsg     string `json:"errmsg"`
}

func (c *wechatOAuthHTTPClient) loadProfile(ctx context.Context, accessToken string, openID string) (*wechatUserInfoResponse, error) {
	query := url.Values{}
	query.Set("access_token", strings.TrimSpace(accessToken))
	query.Set("openid", strings.TrimSpace(openID))
	query.Set("lang", "zh_CN")
	body, err := c.doGET(ctx, "https://api.weixin.qq.com/sns/userinfo?"+query.Encode())
	if err != nil {
		return nil, err
	}
	var payload wechatUserInfoResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode wechat user info: %w", err)
	}
	if payload.ErrCode != 0 {
		return nil, fmt.Errorf("wechat user info failed: %s", strings.TrimSpace(payload.ErrMsg))
	}
	if strings.TrimSpace(payload.OpenID) == "" {
		return nil, errors.New("wechat user info missing openid")
	}
	return &payload, nil
}

func (c *wechatOAuthHTTPClient) doGET(ctx context.Context, requestURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build wechat oauth request: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("wechat oauth request failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read wechat oauth response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("wechat oauth response status %d", resp.StatusCode)
	}
	return body, nil
}

func decodeWeChatOAuthToken(body []byte) (*WeChatOAuthToken, error) {
	var payload struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		OpenID       string `json:"openid"`
		UnionID      string `json:"unionid"`
		Scope        string `json:"scope"`
		ErrCode      int    `json:"errcode"`
		ErrMsg       string `json:"errmsg"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode wechat oauth token: %w", err)
	}
	if payload.ErrCode != 0 {
		return nil, fmt.Errorf("wechat token exchange failed: %s", strings.TrimSpace(payload.ErrMsg))
	}
	if strings.TrimSpace(payload.AccessToken) == "" {
		return nil, errors.New("wechat token exchange missing access_token")
	}
	return &WeChatOAuthToken{
		AccessToken:  payload.AccessToken,
		RefreshToken: payload.RefreshToken,
		ExpiresIn:    payload.ExpiresIn,
		OpenID:       payload.OpenID,
		UnionID:      payload.UnionID,
		Scope:        payload.Scope,
	}, nil
}
