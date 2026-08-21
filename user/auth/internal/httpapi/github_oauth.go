package httpapi

import (
	"context"
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

const githubOAuthStateCookieName = "lc_github_oauth_state"
const githubOAuthStateCookiePath = "/auth/oauth/github/callback"
const githubOAuthReturnToCookieName = "lc_github_oauth_return_to"
const githubOAuthCallbackTimeout = 25 * time.Second

// GitHubOAuthClient 是 GitHub OAuth 客户端的接口，便于测试时替换实现。
type GitHubOAuthClient interface {
	ExchangeCode(ctx context.Context, code string, redirectURI string) (*GitHubOAuthToken, error)
	ResolveIdentity(ctx context.Context, accessToken string) (service.OAuthSignInInput, error)
}

// GitHubOAuthToken 持有 GitHub OAuth token 交换结果。
type GitHubOAuthToken struct {
	AccessToken string
	Scope       string
	TokenType   string
}

// GitHubOAuthConfig 是 GitHub OAuth 的配置结构体。
type GitHubOAuthConfig struct {
	ClientID             string
	ClientSecret         string
	RedirectURI          string
	FrontendBaseURL      string
	PublicBaseURL        string
	StateTTL             time.Duration
	Client               GitHubOAuthClient
	RegistrationDisabled bool
}

type githubOAuth struct {
	clientID             string
	clientSecret         string
	redirectURI          string
	frontendBaseURL      string
	publicBaseURL        string
	stateTTL             time.Duration
	client               GitHubOAuthClient
	registrationDisabled bool
}

func newGitHubOAuth(config *GitHubOAuthConfig) *githubOAuth {
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
		client = &gitHubOAuthHTTPClient{
			clientID:     clientID,
			clientSecret: clientSecret,
			httpClient:   http.DefaultClient,
		}
	}

	return &githubOAuth{
		clientID:             clientID,
		clientSecret:         clientSecret,
		redirectURI:          redirectURI,
		frontendBaseURL:      strings.TrimRight(strings.TrimSpace(config.FrontendBaseURL), "/"),
		publicBaseURL:        strings.TrimRight(strings.TrimSpace(config.PublicBaseURL), "/"),
		stateTTL:             stateTTL,
		client:               client,
		registrationDisabled: config.RegistrationDisabled,
	}
}

// StartGitHubOAuth 生成 state、写 cookie 并重定向到 GitHub 授权页面。
func (h *Handler) StartGitHubOAuth(ctx *gin.Context) {
	if h.githubOAuth == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}

	nonce, err := newOAuthState()
	if err != nil {
		ctx.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	startState, err := buildOAuthStartState(ctx.Request, "github", githubOAuthStateCookiePath, h.githubOAuth.redirectURIForRequest(ctx.Request), nonce)
	if err != nil {
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     githubOAuthStateCookieName,
		Value:    startState.CookieValue,
		Path:     githubOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   int(h.githubOAuth.stateTTL / time.Second),
	})
	validatedReturnTo := h.readValidatedReturnToFromRequest(ctx.Request)
	setOAuthReturnToCookie(ctx, githubOAuthReturnToCookieName, githubOAuthStateCookiePath, validatedReturnTo, h.cookieSecure, h.githubOAuth.stateTTL)

	ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.authorizeURL(startState.StateParam, startState.RedirectURI))
}

// HandleGitHubOAuthCallback 处理 GitHub OAuth 回调，完成 token 交换和登录。
func (h *Handler) HandleGitHubOAuthCallback(ctx *gin.Context) {
	if h.githubOAuth == nil {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}

	code := strings.TrimSpace(ctx.Query("code"))
	state := strings.TrimSpace(ctx.Query("state"))
	logger := requestLogger(ctx, nil)
	exchangeRedirectURI := h.githubOAuth.redirectURIForRequest(ctx.Request)

	if relayState, ok := parseOAuthRelayState(state); ok {
		if err := validateOAuthRelayStateForProvider("github", relayState); err != nil {
			logger.Warn("github oauth callback failed", "stage", "relay_state_validation", "err", err)
			ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.frontendURL(ctx.Request, "/?oauth_error=github_state_mismatch"))
			return
		}
		if isOAuthRelayIssuerCallback(ctx.Request, relayState) {
			target, err := relayCallbackURLWithOriginalQuery("github", relayState.TargetCallbackURI, ctx.Request.URL.RawQuery)
			if err != nil {
				logger.Warn("github oauth relay callback failed", "stage", "target_query", "err", err)
				ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.frontendURL(ctx.Request, "/?oauth_error=github_state_mismatch"))
				return
			}
			ctx.Redirect(http.StatusTemporaryRedirect, target)
			return
		}
		if !isOAuthRelayTargetCallback(ctx.Request, relayState) {
			logger.Warn("github oauth callback failed", "stage", "relay_target_mismatch")
			ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.frontendURL(ctx.Request, "/?oauth_error=github_state_mismatch"))
			return
		}
		exchangeRedirectURI = relayState.IssuerRedirectURI
		expectedState := ""
		if cookie, err := ctx.Request.Cookie(githubOAuthStateCookieName); err == nil {
			expectedState = strings.TrimSpace(cookie.Value)
		}
		validatedSuccessTarget := h.readValidatedOAuthReturnToCookie(ctx.Request, githubOAuthReturnToCookieName)
		h.clearGitHubOAuthStateCookie(ctx)
		clearOAuthReturnToCookie(ctx, githubOAuthReturnToCookieName, githubOAuthStateCookiePath, h.cookieSecure)
		h.handleGitHubOAuthCallbackAfterState(ctx, code, relayState.Nonce, expectedState, validatedSuccessTarget, exchangeRedirectURI, logger)
		return
	}

	expectedState := ""
	if cookie, err := ctx.Request.Cookie(githubOAuthStateCookieName); err == nil {
		expectedState = strings.TrimSpace(cookie.Value)
	}
	validatedSuccessTarget := h.readValidatedOAuthReturnToCookie(ctx.Request, githubOAuthReturnToCookieName)
	h.clearGitHubOAuthStateCookie(ctx)
	clearOAuthReturnToCookie(ctx, githubOAuthReturnToCookieName, githubOAuthStateCookiePath, h.cookieSecure)
	h.handleGitHubOAuthCallbackAfterState(ctx, code, state, expectedState, validatedSuccessTarget, exchangeRedirectURI, logger)
}

func (h *Handler) handleGitHubOAuthCallbackAfterState(ctx *gin.Context, code string, state string, expectedState string, validatedSuccessTarget string, exchangeRedirectURI string, logger interface {
	Warn(msg string, keysAndValues ...any)
	Error(msg string, keysAndValues ...any)
	Info(msg string, keysAndValues ...any)
}) {
	if code == "" || state == "" || expectedState == "" || state != expectedState {
		logger.Warn(
			"github oauth callback failed",
			"stage", "state_mismatch",
			"has_code", code != "",
			"has_state", state != "",
			"has_cookie_state", expectedState != "",
		)
		ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.frontendURL(ctx.Request, "/?oauth_error=github_state_mismatch"))
		return
	}

	requestCtx := ctx.Request.Context()
	token, err := h.githubOAuth.client.ExchangeCode(requestCtx, code, exchangeRedirectURI)
	if err != nil || strings.TrimSpace(token.AccessToken) == "" {
		logger.Error("github oauth callback failed", "stage", "exchange", "err", err)
		ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.frontendURL(ctx.Request, "/?oauth_error=github_exchange_failed"))
		return
	}

	identity, err := h.githubOAuth.client.ResolveIdentity(requestCtx, token.AccessToken)
	if err != nil {
		logger.Error("github oauth callback failed", "stage", "identity", "err", err)
		ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.frontendURL(ctx.Request, "/?oauth_error=github_identity_failed"))
		return
	}
	identity.InviteCode = h.inviteTicketFromRequest(ctx)
	identity.RegistrationDisabled = h.githubOAuth.registrationDisabled
	identity.ClientIP = ctx.ClientIP()
	identity.ClientUA = ctx.Request.UserAgent()
	session, err := h.service.SignInWithOAuth(requestCtx, identity)
	if err != nil {
		logger.Error(
			"github oauth callback failed",
			"stage", "sign_in",
			"provider", identity.Provider,
			"subject", identity.ProviderSubject,
			"err", err,
		)
		var serviceErr *service.Error
		if errors.As(err, &serviceErr) {
			switch serviceErr.Code {
			case "oauth_registration_disabled":
				ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.frontendURL(ctx.Request, "/?oauth_error=github_registration_disabled"))
				return
			case "registration_email_suffix_blocked":
				ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.frontendURL(ctx.Request, "/?oauth_error=github_email_suffix_blocked"))
				return
			case "oauth_registration_email_required":
				ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.frontendURL(ctx.Request, "/?oauth_error=github_email_required"))
				return
			}
		}
		ctx.Redirect(http.StatusTemporaryRedirect, h.githubOAuth.frontendURL(ctx.Request, "/?oauth_error=github_sign_in_failed"))
		return
	}

	logger.Info("github oauth callback succeeded", "user_id", session.User.ID)
	h.clearInviteTicketCookie(ctx)
	h.syncOAuthAvatar(requestCtx, logger, "github", session.User.ID, identity.AvatarURL, session.User.AvatarSource)
	h.setSessionCookie(ctx, session.Token)
	h.redirectOAuthSuccess(ctx, validatedSuccessTarget, h.githubOAuth.successFrontendURL(ctx.Request, "/", session.Token), session)
}

func (h *Handler) clearGitHubOAuthStateCookie(ctx *gin.Context) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     githubOAuthStateCookieName,
		Value:    "",
		Path:     githubOAuthStateCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   -1,
	})
}

func (g *githubOAuth) authorizeURL(state string, redirectURI string) string {
	query := url.Values{}
	query.Set("client_id", g.clientID)
	query.Set("redirect_uri", strings.TrimSpace(redirectURI))
	query.Set("state", state)
	query.Set("scope", "read:user user:email")
	return "https://github.com/login/oauth/authorize?" + query.Encode()
}

func (g *githubOAuth) frontendURL(request *http.Request, path string) string {
	baseURL := g.frontendBaseURLForRequest(request)
	if baseURL == "" {
		return path
	}
	if strings.HasPrefix(path, "/") {
		return baseURL + path
	}
	return baseURL + "/" + path
}

func (g *githubOAuth) successFrontendURL(request *http.Request, path string, sessionToken string) string {
	return oauthSuccessFrontendURL(g.frontendBaseURLForRequest(request), path, sessionToken)
}

func (g *githubOAuth) redirectURIForRequest(request *http.Request) string {
	requestHost := requestHostWithoutPort(request)
	defaultHost := hostWithoutPortFromURL(g.publicBaseURL)
	if requestHost == "" || requestHost == defaultHost || !strings.HasPrefix(requestHost, "api.") {
		return g.redirectURI
	}
	return replaceURLHost(g.redirectURI, requestHost, requestScheme(request))
}

func (g *githubOAuth) frontendBaseURLForRequest(request *http.Request) string {
	requestHost := requestHostWithoutPort(request)
	defaultHost := hostWithoutPortFromURL(g.publicBaseURL)
	if requestHost == "" || requestHost == defaultHost || !strings.HasPrefix(requestHost, "api.") {
		return g.frontendBaseURL
	}
	return requestScheme(request) + "://" + strings.TrimPrefix(requestHost, "api.")
}

// gitHubOAuthHTTPClient 是 GitHub OAuth 的真实 HTTP 实现。
type gitHubOAuthHTTPClient struct {
	clientID     string
	clientSecret string
	httpClient   *http.Client
}

func (c *gitHubOAuthHTTPClient) ExchangeCode(ctx context.Context, code string, redirectURI string) (*GitHubOAuthToken, error) {
	payload := map[string]string{
		"client_id":     c.clientID,
		"client_secret": c.clientSecret,
		"code":          code,
		"redirect_uri":  redirectURI,
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("build github token request body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://github.com/login/oauth/access_token", strings.NewReader(string(bodyBytes)))
	if err != nil {
		return nil, fmt.Errorf("build github token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	httpClient := c.httpClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("github token request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read github token response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("github token request failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		Scope       string `json:"scope"`
		TokenType   string `json:"token_type"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.Unmarshal(respBody, &tokenResp); err != nil {
		return nil, fmt.Errorf("decode github token response: %w", err)
	}
	if strings.TrimSpace(tokenResp.Error) != "" {
		return nil, fmt.Errorf("github token exchange failed: %s", strings.TrimSpace(tokenResp.ErrorDesc))
	}
	if strings.TrimSpace(tokenResp.AccessToken) == "" {
		return nil, fmt.Errorf("github token exchange returned empty access token")
	}

	return &GitHubOAuthToken{
		AccessToken: tokenResp.AccessToken,
		Scope:       tokenResp.Scope,
		TokenType:   tokenResp.TokenType,
	}, nil
}

func (c *gitHubOAuthHTTPClient) ResolveIdentity(ctx context.Context, accessToken string) (service.OAuthSignInInput, error) {
	user, err := c.loadGitHubUser(ctx, accessToken)
	if err != nil {
		return service.OAuthSignInInput{}, err
	}

	// 若用户没有公开邮箱，则调用 /user/emails 获取已验证的主邮箱
	email := strings.TrimSpace(user.Email)
	if email == "" {
		email, err = c.loadPrimaryEmail(ctx, accessToken)
		if err != nil {
			// 邮箱获取失败不致命，仅记录；登录时 email 为空
			email = ""
		}
	}

	return service.OAuthSignInInput{
		Provider:        "github",
		ProviderSubject: strconv.FormatInt(user.ID, 10),
		Email:           email,
		EmailVerified:   email != "", // GitHub 仅返回已验证邮箱
		Name:            strings.TrimSpace(firstNonEmpty(user.Name, user.Login)),
		AvatarURL:       strings.TrimSpace(user.AvatarURL),
	}, nil
}

func (c *gitHubOAuthHTTPClient) loadGitHubUser(ctx context.Context, accessToken string) (*githubUserResponse, error) {
	body, err := c.doGitHubAPI(ctx, accessToken, "https://api.github.com/user")
	if err != nil {
		return nil, err
	}

	var user githubUserResponse
	if err := json.Unmarshal(body, &user); err != nil {
		return nil, fmt.Errorf("decode github user response: %w", err)
	}
	if user.ID == 0 {
		return nil, fmt.Errorf("github user returned zero ID")
	}
	return &user, nil
}

func (c *gitHubOAuthHTTPClient) loadPrimaryEmail(ctx context.Context, accessToken string) (string, error) {
	body, err := c.doGitHubAPI(ctx, accessToken, "https://api.github.com/user/emails")
	if err != nil {
		return "", err
	}

	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := json.Unmarshal(body, &emails); err != nil {
		return "", fmt.Errorf("decode github emails response: %w", err)
	}

	for _, e := range emails {
		if e.Primary && e.Verified {
			return strings.TrimSpace(e.Email), nil
		}
	}
	return "", nil
}

func (c *gitHubOAuthHTTPClient) doGitHubAPI(ctx context.Context, accessToken string, apiURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build github api request: %w", err)
	}
	req.Header.Set("Authorization", "token "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/vnd.github+json")

	httpClient := c.httpClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("github api request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read github api response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("github api request failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

type githubUserResponse struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	AvatarURL string `json:"avatar_url"`
}
