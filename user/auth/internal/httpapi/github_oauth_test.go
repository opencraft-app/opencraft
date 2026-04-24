package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

// ─── stub ────────────────────────────────────────────────────────────────────

type stubGitHubOAuthClient struct {
	identity    service.OAuthSignInInput
	exchangeErr error
	identityErr error
	accessToken string
}

func (s *stubGitHubOAuthClient) ExchangeCode(_ context.Context, code string, _ string) (*GitHubOAuthToken, error) {
	if s.exchangeErr != nil {
		return nil, s.exchangeErr
	}
	token := s.accessToken
	if token == "" {
		token = "github-access-token-" + strings.TrimSpace(code)
	}
	return &GitHubOAuthToken{AccessToken: token}, nil
}

func (s *stubGitHubOAuthClient) ResolveIdentity(_ context.Context, _ string) (service.OAuthSignInInput, error) {
	if s.identityErr != nil {
		return service.OAuthSignInInput{}, s.identityErr
	}
	identity := s.identity
	if identity.Provider == "" {
		identity.Provider = "github"
	}
	if identity.ProviderSubject == "" {
		identity.ProviderSubject = "github-id-default"
	}
	if identity.Name == "" {
		identity.Name = "GitHub用户"
	}
	return identity, nil
}

// ─── router helpers ──────────────────────────────────────────────────────────

func newAuthTestRouterWithGitHub(client GitHubOAuthClient) *gin.Engine {
	return newAuthTestRouterWithGitHubAndAvatarStore(client, nil)
}

func newAuthTestRouterWithGitHubAndAvatarStore(client GitHubOAuthClient, avatarStore AvatarStore) *gin.Engine {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
	})
	return NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteNoneMode,
		SessionTTL:     30 * 24 * time.Hour,
		AvatarStore:    avatarStore,
		GitHubOAuth: &GitHubOAuthConfig{
			ClientID:        "github-client-id-test",
			ClientSecret:    "github-client-secret-test",
			RedirectURI:     "https://lightclaw.tech/auth/oauth/github/callback",
			FrontendBaseURL: "https://lightclaw.pages.dev",
			PublicBaseURL:   "https://lightclaw.tech",
			Client:          client,
			StateTTL:        10 * time.Minute,
		},
	})
}

// ─── tests ───────────────────────────────────────────────────────────────────

func TestGitHubOAuthStartRedirectsToAuthorizeAndSetsStateCookie(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGitHub(&stubGitHubOAuthClient{})

	recorder := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/github/start", nil)
	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	if !strings.HasPrefix(location, "https://github.com/login/oauth/authorize?") {
		t.Fatalf("expected github authorize redirect, got %q", location)
	}

	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	query := parsed.Query()
	if query.Get("client_id") != "github-client-id-test" {
		t.Fatalf("expected github client_id in redirect, got %q", query.Get("client_id"))
	}
	if query.Get("redirect_uri") != "https://lightclaw.tech/auth/oauth/github/callback" {
		t.Fatalf("expected redirect_uri in redirect, got %q", query.Get("redirect_uri"))
	}
	if strings.TrimSpace(query.Get("scope")) == "" {
		t.Fatal("expected scope to be present in authorize redirect")
	}
	if strings.TrimSpace(query.Get("state")) == "" {
		t.Fatal("expected state to be present in authorize redirect")
	}

	stateCookie := cookieFromRecorderByName(t, recorder, "lc_github_oauth_state")
	if stateCookie.Value == "" {
		t.Fatal("expected github oauth state cookie to be set")
	}
	if !stateCookie.HttpOnly {
		t.Fatal("expected github oauth state cookie to be httpOnly")
	}
}

func TestGitHubOAuthStartUsesSiteRedirectForSiteHost(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGitHub(&stubGitHubOAuthClient{})

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/github/start", nil)
	request.Host = "api.lightclaw.site"
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	if got := parsed.Query().Get("redirect_uri"); got != "https://api.lightclaw.site/auth/oauth/github/callback" {
		t.Fatalf("expected site redirect_uri, got %q", got)
	}
}

func TestGitHubOAuthStartSetsReturnToCookieWhenAllowed(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGitHub(&stubGitHubOAuthClient{})

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/github/start?return_to="+url.QueryEscape("https://console.foo.tencent.com/dashboard/settings?tab=github#apps"), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	returnToCookie := cookieFromRecorderByName(t, recorder, githubOAuthReturnToCookieName)
	if got := returnToCookie.Value; got != "https://console.foo.tencent.com/dashboard/settings?tab=github#apps" {
		t.Fatalf("expected github return_to cookie, got %q", got)
	}
}

func TestGitHubOAuthCallbackStateMismatchRedirectsWithError(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGitHub(&stubGitHubOAuthClient{})

	recorder := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/github/callback?code=some-code&state=wrong-state",
		nil,
		// no state cookie → mismatch
	)
	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth callback, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	if !strings.Contains(location, "oauth_error=github_state_mismatch") {
		t.Fatalf("expected github_state_mismatch error in redirect, got %q", location)
	}
}

func TestGitHubOAuthCallbackExchangeFailureRedirectsWithError(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGitHub(&stubGitHubOAuthClient{
		exchangeErr: errors.New("token exchange failed"),
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/github/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_github_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/github/callback?code=bad-code&state="+url.QueryEscape(state),
		nil,
		stateCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if !strings.Contains(callback.Header().Get("Location"), "oauth_error=github_exchange_failed") {
		t.Fatalf("expected github_exchange_failed error in redirect, got %q", callback.Header().Get("Location"))
	}
}

func TestGitHubOAuthCallbackIdentityFailureRedirectsWithError(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGitHub(&stubGitHubOAuthClient{
		identityErr: errors.New("github api request failed"),
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/github/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_github_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/github/callback?code=ok-code&state="+url.QueryEscape(state),
		nil,
		stateCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if !strings.Contains(callback.Header().Get("Location"), "oauth_error=github_identity_failed") {
		t.Fatalf("expected github_identity_failed error in redirect, got %q", callback.Header().Get("Location"))
	}
}

func TestGitHubOAuthCallbackCreatesSessionAndRedirectsToDashboard(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGitHub(&stubGitHubOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "github",
			ProviderSubject: "github-id-123",
			Email:           "dev@example.com",
			EmailVerified:   true,
			Name:            "GitHub漫游者",
			AvatarURL:       "https://avatars.githubusercontent.com/u/123?v=4",
		},
	})

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/github/start", nil)
	if start.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth start, got %d: %s", start.Code, start.Body.String())
	}
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_github_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/github/callback?code=github-code-123&state="+url.QueryEscape(state),
		nil,
		stateCookie,
		inviteCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}

	sessionCookie := sessionCookieFromRecorder(t, callback)

	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Scheme != "https" || location.Host != "lightclaw.pages.dev" || location.Path != "/" {
		t.Fatalf("expected callback redirect to frontend home, got %q", callback.Header().Get("Location"))
	}

	fragment := url.Values{}
	if location.Fragment != "" {
		fragment, err = url.ParseQuery(location.Fragment)
		if err != nil {
			t.Fatalf("parse callback redirect fragment: %v", err)
		}
	}
	if got := fragment.Get("session_token"); got != sessionCookie.Value {
		t.Fatalf("expected callback redirect fragment to include session token %q, got %q", sessionCookie.Value, got)
	}

	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from current session, got %d: %s", current.Code, current.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, current, &response)
	if response.Session.User == nil || response.Session.User.Name != "GitHub漫游者" {
		t.Fatalf("expected github callback to create session for provider user, got %+v", response.Session.User)
	}
}

func TestGitHubOAuthCallbackPrefersReturnToRedirect(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGitHub(&stubGitHubOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "github",
			ProviderSubject: "github-id-return-to",
			Email:           "return@example.com",
			EmailVerified:   true,
			Name:            "GitHub回跳用户",
		},
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/github/start?return_to="+url.QueryEscape("https://console.foo.tencent.com/dashboard/settings?tab=github#apps"), nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, githubOAuthStateCookieName)
	returnToCookie := cookieFromRecorderByName(t, start, githubOAuthReturnToCookieName)

	callback := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/github/callback?code=github-code-return&state="+url.QueryEscape(state), nil, stateCookie, returnToCookie)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}

	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Host != "console.foo.tencent.com" || location.Path != "/dashboard/settings" || location.RawQuery != "tab=github" {
		t.Fatalf("expected github callback to use return_to, got %q", callback.Header().Get("Location"))
	}
	fragment, err := url.ParseQuery(location.Fragment)
	if err != nil {
		t.Fatalf("parse callback redirect fragment: %v", err)
	}
	if fragment.Get("session_token") == "" {
		t.Fatal("expected session_token in github return_to redirect fragment")
	}
}

func TestGitHubOAuthCallbackSignsInUsableUserForFirstTimeSignIn(t *testing.T) {
	t.Parallel()

	// 新 GitHub 用户，无邀请码 → service 允许登录但 InviteRequired=true
	router := newAuthTestRouterWithGitHub(&stubGitHubOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "github",
			ProviderSubject: "github-id-no-invite",
			Email:           "noinvite@example.com",
			EmailVerified:   true,
			Name:            "GitHub新人",
		},
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/github/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_github_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/github/callback?code=github-code-missing-invite&state="+url.QueryEscape(state),
		nil,
		stateCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}

	location := callback.Header().Get("Location")
	parsedLocation, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if parsedLocation.Scheme != "https" || parsedLocation.Host != "lightclaw.pages.dev" || parsedLocation.Path != "/" {
		t.Fatalf("expected callback redirect to frontend landing page, got %q", location)
	}
	// 新用户（无邀请码）：仍然成功登录，session_token 包含在 fragment 中
	if !strings.Contains(parsedLocation.Fragment, "session_token=") {
		t.Fatalf("expected github callback to return session token fragment, got %q", location)
	}

	sessionCookie := sessionCookieFromRecorder(t, callback)
	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from current session, got %d: %s", current.Code, current.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, current, &response)
	if response.Session.User == nil || response.Session.User.InviteRequired {
		t.Fatalf("expected first-time github user to skip invite gating, got %+v", response.Session.User)
	}
}

func TestGitHubOAuthCallbackRedirectsBackToSiteFrontend(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGitHub(&stubGitHubOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "github",
			ProviderSubject: "github-id-site",
			Email:           "site@example.com",
			EmailVerified:   true,
			Name:            "GitHub站点用户",
		},
	})

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	startReq := httptest.NewRequest(http.MethodGet, "/auth/oauth/github/start", nil)
	startReq.Host = "api.lightclaw.site"
	startReq.Header.Set("X-Forwarded-Proto", "https")
	startRecorder := httptest.NewRecorder()
	router.ServeHTTP(startRecorder, startReq)
	if startRecorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth start, got %d: %s", startRecorder.Code, startRecorder.Body.String())
	}
	startLocation, err := url.Parse(startRecorder.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, startRecorder, "lc_github_oauth_state")

	callbackReq := httptest.NewRequest(http.MethodGet, "/auth/oauth/github/callback?code=github-code-site&state="+url.QueryEscape(state), nil)
	callbackReq.Host = "api.lightclaw.site"
	callbackReq.Header.Set("X-Forwarded-Proto", "https")
	callbackReq.AddCookie(stateCookie)
	callbackReq.AddCookie(inviteCookie)
	callbackRecorder := httptest.NewRecorder()
	router.ServeHTTP(callbackRecorder, callbackReq)

	if callbackRecorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth callback, got %d: %s", callbackRecorder.Code, callbackRecorder.Body.String())
	}

	location, err := url.Parse(callbackRecorder.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Scheme != "https" || location.Host != "lightclaw.site" || location.Path != "/" {
		t.Fatalf("expected callback redirect to site frontend home, got %q", callbackRecorder.Header().Get("Location"))
	}
}

func TestGitHubOAuthCallbackSyncsAvatarWhenUserHasNoUploadedAvatar(t *testing.T) {
	t.Parallel()

	avatarStore := &stubAvatarStore{
		objectKey: "avatars/usr_github/current.jpg",
	}
	router := newAuthTestRouterWithGitHubAndAvatarStore(&stubGitHubOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "github",
			ProviderSubject: "github-id-avatar-sync",
			Email:           "avatar@example.com",
			EmailVerified:   true,
			Name:            "GitHub头像用户",
			AvatarURL:       "https://avatars.githubusercontent.com/u/456?v=4",
		},
	}, avatarStore)

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/github/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_github_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/github/callback?code=github-code-sync&state="+url.QueryEscape(state),
		nil,
		stateCookie,
		inviteCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from github oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if avatarStore.lastRemoteUserID == "" {
		t.Fatal("expected github oauth callback to sync avatar into local storage")
	}
	if avatarStore.lastRemoteURL == "" {
		t.Fatal("expected github oauth callback to pass remote avatar url")
	}
}

func TestGitHubOAuthNotRegistered(t *testing.T) {
	t.Parallel()

	// 不设置 GitHubOAuth 配置 → 路由不注册 → 404
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
	})
	router := NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteNoneMode,
		SessionTTL:     30 * 24 * time.Hour,
	})

	recorder := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/github/start", nil)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when github oauth not configured, got %d", recorder.Code)
	}
}
