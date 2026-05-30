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
const wechatOAuthReturnToCookieName = "lc_wechat_oauth_return_to"

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
	FrontendBaseURL string
	PublicBaseURL   string
	StateTTL        time.Duration
	Client          WeChatOAuthClient
}

type wechatOAuth struct {
	appID           string
	redirectURI     string
	frontendBaseURL string
	publicBaseURL   string
	stateTTL        time.Duration
	client          WeChatOAuthClient
}

func newWeChatOAuth(config *WeChatOAuthConfig) *wechatOAuth {
	if config == nil {
		return nil
	}

	appID := strings.TrimSpace(config.AppID)
	appSecret := strings.TrimSpace(config.AppSecret)
	redirectURI := strings.TrimSpace(config.RedirectURI)
	if appID == "" || appSecret == "" || redirectURI == "" {
		return nil
	}

	stateTTL := config.StateTTL
	if stateTTL <= 0 {
		stateTTL = 10 * time.Minute
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

	return &wechatOAuth{
		appID:           appID,
		redirectURI:     redirectURI,
		frontendBaseURL: strings.TrimRight(strings.TrimSpace(config.FrontendBaseURL), "/"),
		publicBaseURL:   strings.TrimRight(strings.TrimSpace(config.PublicBaseURL), "/"),
		stateTTL:        stateTTL,
		client:          client,
	}
}

func (h *Handler) StartWeChatOAuth(ctx *gin.Context) {
	if h.wechatOAuth == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}

	nonce, err := newOAuthState()
	if err != nil {
		ctx.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	startState, err := buildOAuthStartState(ctx.Request, "wechat", wechatOAuthStateCookiePath, h.wechatOAuth.redirectURIForRequest(ctx.Request), nonce)
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
	setOAuthReturnToCookie(ctx, wechatOAuthReturnToCookieName, wechatOAuthStateCookiePath, readReturnToFromRequest(ctx.Request), h.cookieSecure, h.wechatOAuth.stateTTL, h.validatedReturnToURL)

	ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.authorizeURL(startState.StateParam, startState.RedirectURI))
}

func (h *Handler) HandleWeChatOAuthCallback(ctx *gin.Context) {
	if h.wechatOAuth == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}

	code := strings.TrimSpace(ctx.Query("code"))
	state := strings.TrimSpace(ctx.Query("state"))
	logger := requestLogger(ctx, nil)
	exchangeRedirectURI := h.wechatOAuth.redirectURIForRequest(ctx.Request)

	if relayState, ok := parseOAuthRelayState(state); ok {
		if err := validateOAuthRelayStateForProvider("wechat", relayState); err != nil {
			logger.Warn("wechat oauth callback failed", "stage", "relay_state_validation", "err", err)
			ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.frontendURL(ctx.Request, "/?oauth_error=wechat_state_mismatch"))
			return
		}
		if isOAuthRelayIssuerCallback(ctx.Request, relayState) {
			target, err := relayCallbackURLWithOriginalQuery(relayState.TargetCallbackURI, ctx.Request.URL.RawQuery)
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
		returnTo := readOAuthReturnToCookie(ctx.Request, wechatOAuthReturnToCookieName)
		h.clearWeChatOAuthStateCookie(ctx)
		clearOAuthReturnToCookie(ctx, wechatOAuthReturnToCookieName, wechatOAuthStateCookiePath, h.cookieSecure)
		h.handleWeChatOAuthCallbackAfterState(ctx, code, relayState.Nonce, expectedState, returnTo, exchangeRedirectURI, logger)
		return
	}

	expectedState := ""
	if cookie, err := ctx.Request.Cookie(wechatOAuthStateCookieName); err == nil {
		expectedState = strings.TrimSpace(cookie.Value)
	}
	returnTo := readOAuthReturnToCookie(ctx.Request, wechatOAuthReturnToCookieName)
	h.clearWeChatOAuthStateCookie(ctx)
	clearOAuthReturnToCookie(ctx, wechatOAuthReturnToCookieName, wechatOAuthStateCookiePath, h.cookieSecure)
	h.handleWeChatOAuthCallbackAfterState(ctx, code, state, expectedState, returnTo, exchangeRedirectURI, logger)
}

func (h *Handler) handleWeChatOAuthCallbackAfterState(ctx *gin.Context, code string, state string, expectedState string, returnTo string, exchangeRedirectURI string, logger interface {
	Warn(msg string, keysAndValues ...any)
	Error(msg string, keysAndValues ...any)
	Info(msg string, keysAndValues ...any)
}) {
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
	token, err := h.wechatOAuth.client.ExchangeCode(requestCtx, code, exchangeRedirectURI)
	if err != nil || strings.TrimSpace(token.AccessToken) == "" {
		logger.Error("wechat oauth callback failed", "stage", "exchange", "err", err)
		ctx.Redirect(http.StatusTemporaryRedirect, h.wechatOAuth.frontendURL(ctx.Request, "/?oauth_error=wechat_exchange_failed"))
		return
	}

	identity, err := h.wechatOAuth.client.ResolveIdentity(requestCtx, token)
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
	redirectURL := h.oauthSuccessRedirectURL(ctx, returnTo, h.wechatOAuth.successFrontendURL(ctx.Request, "/", session.Token), session)
	ctx.Redirect(http.StatusTemporaryRedirect, redirectURL)
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

func (w *wechatOAuth) authorizeURL(state string, redirectURI string) string {
	query := url.Values{}
	query.Set("appid", w.appID)
	query.Set("redirect_uri", strings.TrimSpace(redirectURI))
	query.Set("response_type", "code")
	query.Set("scope", "snsapi_login")
	query.Set("state", state)
	return "https://open.weixin.qq.com/connect/qrconnect?" + query.Encode() + "#wechat_redirect"
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
	redirectURL := w.frontendURL(request, path)
	if strings.TrimSpace(sessionToken) == "" {
		return redirectURL
	}

	parsed, err := url.Parse(redirectURL)
	if err != nil {
		return redirectURL
	}
	fragment := url.Values{}
	fragment.Set("session_token", strings.TrimSpace(sessionToken))
	parsed.Fragment = fragment.Encode()
	return parsed.String()
}

func (w *wechatOAuth) redirectURIForRequest(request *http.Request) string {
	return w.redirectURI
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
		subject = strings.TrimSpace(profile.OpenID)
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
