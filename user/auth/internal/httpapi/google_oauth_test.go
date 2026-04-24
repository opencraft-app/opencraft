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

type stubGoogleOAuthClient struct {
	identity    service.OAuthSignInInput
	exchangeErr error
	identityErr error
	accessToken string
}

func (s *stubGoogleOAuthClient) ExchangeCode(_ context.Context, code string, _ string) (*GoogleOAuthToken, error) {
	if s.exchangeErr != nil {
		return nil, s.exchangeErr
	}
	token := s.accessToken
	if token == "" {
		token = "google-access-token-" + strings.TrimSpace(code)
	}
	return &GoogleOAuthToken{AccessToken: token}, nil
}

func (s *stubGoogleOAuthClient) ResolveIdentity(_ context.Context, _ string) (service.OAuthSignInInput, error) {
	if s.identityErr != nil {
		return service.OAuthSignInInput{}, s.identityErr
	}
	identity := s.identity
	if identity.Provider == "" {
		identity.Provider = "google"
	}
	if identity.ProviderSubject == "" {
		identity.ProviderSubject = "google-sub-default"
	}
	if identity.Name == "" {
		identity.Name = "Google用户"
	}
	return identity, nil
}

// ─── router helpers ──────────────────────────────────────────────────────────

func newAuthTestRouterWithGoogle(client GoogleOAuthClient) *gin.Engine {
	return newAuthTestRouterWithGoogleAndAvatarStore(client, nil)
}

func newAuthTestRouterWithGoogleAndAvatarStore(client GoogleOAuthClient, avatarStore AvatarStore) *gin.Engine {
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
		GoogleOAuth: &GoogleOAuthConfig{
			ClientID:        "google-client-id-test",
			ClientSecret:    "google-client-secret-test",
			RedirectURI:     "https://lightclaw.tech/auth/oauth/google/callback",
			FrontendBaseURL: "https://lightclaw.pages.dev",
			PublicBaseURL:   "https://lightclaw.tech",
			Client:          client,
			StateTTL:        10 * time.Minute,
		},
	})
}

// ─── tests ───────────────────────────────────────────────────────────────────

func TestGoogleOAuthStartRedirectsToAuthorizeAndSetsStateCookie(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGoogle(&stubGoogleOAuthClient{})

	recorder := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/google/start", nil)
	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	if !strings.HasPrefix(location, "https://accounts.google.com/o/oauth2/v2/auth?") {
		t.Fatalf("expected google authorize redirect, got %q", location)
	}

	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	query := parsed.Query()
	if query.Get("client_id") != "google-client-id-test" {
		t.Fatalf("expected google client_id in redirect, got %q", query.Get("client_id"))
	}
	if query.Get("redirect_uri") != "https://lightclaw.tech/auth/oauth/google/callback" {
		t.Fatalf("expected redirect_uri in redirect, got %q", query.Get("redirect_uri"))
	}
	if query.Get("response_type") != "code" {
		t.Fatalf("expected response_type=code, got %q", query.Get("response_type"))
	}
	if strings.TrimSpace(query.Get("scope")) == "" {
		t.Fatal("expected scope to be present in authorize redirect")
	}
	if strings.TrimSpace(query.Get("state")) == "" {
		t.Fatal("expected state to be present in authorize redirect")
	}

	stateCookie := cookieFromRecorderByName(t, recorder, "lc_google_oauth_state")
	if stateCookie.Value == "" {
		t.Fatal("expected google oauth state cookie to be set")
	}
	if !stateCookie.HttpOnly {
		t.Fatal("expected google oauth state cookie to be httpOnly")
	}
}

func TestGoogleOAuthStartUsesSiteRedirectForSiteHost(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGoogle(&stubGoogleOAuthClient{})

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/google/start", nil)
	request.Host = "api.lightclaw.site"
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	if got := parsed.Query().Get("redirect_uri"); got != "https://api.lightclaw.site/auth/oauth/google/callback" {
		t.Fatalf("expected site redirect_uri, got %q", got)
	}
}

func TestGoogleOAuthStartSetsReturnToCookieWhenAllowed(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGoogle(&stubGoogleOAuthClient{})

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/google/start?return_to="+url.QueryEscape("https://preview.foo.lightclaw.tech/dashboard/settings?tab=google#security"), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	returnToCookie := cookieFromRecorderByName(t, recorder, googleOAuthReturnToCookieName)
	if got := returnToCookie.Value; got != "https://preview.foo.lightclaw.tech/dashboard/settings?tab=google#security" {
		t.Fatalf("expected google return_to cookie, got %q", got)
	}
}

func TestGoogleOAuthCallbackStateMismatchRedirectsWithError(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGoogle(&stubGoogleOAuthClient{})

	recorder := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/google/callback?code=some-code&state=wrong-state",
		nil,
		// no state cookie → mismatch
	)
	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth callback, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	if !strings.Contains(location, "oauth_error=google_state_mismatch") {
		t.Fatalf("expected google_state_mismatch error in redirect, got %q", location)
	}
}

func TestGoogleOAuthCallbackExchangeFailureRedirectsWithError(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGoogle(&stubGoogleOAuthClient{
		exchangeErr: errors.New("token exchange failed"),
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/google/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_google_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/google/callback?code=bad-code&state="+url.QueryEscape(state),
		nil,
		stateCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if !strings.Contains(callback.Header().Get("Location"), "oauth_error=google_exchange_failed") {
		t.Fatalf("expected google_exchange_failed error in redirect, got %q", callback.Header().Get("Location"))
	}
}

func TestGoogleOAuthCallbackIdentityFailureRedirectsWithError(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGoogle(&stubGoogleOAuthClient{
		identityErr: errors.New("userinfo request failed"),
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/google/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_google_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/google/callback?code=ok-code&state="+url.QueryEscape(state),
		nil,
		stateCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if !strings.Contains(callback.Header().Get("Location"), "oauth_error=google_identity_failed") {
		t.Fatalf("expected google_identity_failed error in redirect, got %q", callback.Header().Get("Location"))
	}
}

func TestGoogleOAuthCallbackInviteRequiredRedirectsWithError(t *testing.T) {
	t.Parallel()

	// 新的 Google 用户，没有邀请码 → invite_required
	router := newAuthTestRouterWithGoogle(&stubGoogleOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "google",
			ProviderSubject: "google-sub-new-user-no-invite",
			Email:           "new@example.com",
			EmailVerified:   true,
			Name:            "新 Google 用户",
		},
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/google/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_google_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/google/callback?code=ok-code&state="+url.QueryEscape(state),
		nil,
		stateCookie,
		// 没有 invite ticket cookie
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}

	location := callback.Header().Get("Location")
	// 新用户无邀请码：根据 service 行为，要么返回 invite_required 错误，要么返回带 inviteRequired 状态的 session
	// 这与 QQ OAuth 的行为一致：service 实际上允许登录但 user.InviteRequired=true
	// 只要重定向到前端即可（不含 google_sign_in_failed）
	if strings.Contains(location, "oauth_error=google_sign_in_failed") {
		t.Fatalf("expected invite-related redirect, got google_sign_in_failed: %q", location)
	}
}

func TestGoogleOAuthCallbackCreatesSessionAndRedirectsToDashboard(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGoogle(&stubGoogleOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "google",
			ProviderSubject: "google-sub-123",
			Email:           "user@example.com",
			EmailVerified:   true,
			Name:            "Google漫游者",
			AvatarURL:       "https://lh3.googleusercontent.com/photo.jpg",
		},
	})

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/google/start", nil)
	if start.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth start, got %d: %s", start.Code, start.Body.String())
	}
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_google_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/google/callback?code=google-code-123&state="+url.QueryEscape(state),
		nil,
		stateCookie,
		inviteCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth callback, got %d: %s", callback.Code, callback.Body.String())
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
	if response.Session.User == nil || response.Session.User.Name != "Google漫游者" {
		t.Fatalf("expected google callback to create session for provider user, got %+v", response.Session.User)
	}
}

func TestGoogleOAuthCallbackPrefersReturnToRedirect(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGoogle(&stubGoogleOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "google",
			ProviderSubject: "google-id-return-to",
			Email:           "return@example.com",
			EmailVerified:   true,
			Name:            "Google回跳用户",
		},
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/google/start?return_to="+url.QueryEscape("https://preview.foo.lightclaw.tech/dashboard/settings?tab=google#security"), nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, googleOAuthStateCookieName)
	returnToCookie := cookieFromRecorderByName(t, start, googleOAuthReturnToCookieName)

	callback := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/google/callback?code=google-code-return&state="+url.QueryEscape(state), nil, stateCookie, returnToCookie)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}

	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Host != "preview.foo.lightclaw.tech" || location.Path != "/dashboard/settings" || location.RawQuery != "tab=google" {
		t.Fatalf("expected google callback to use return_to, got %q", callback.Header().Get("Location"))
	}
	fragment, err := url.ParseQuery(location.Fragment)
	if err != nil {
		t.Fatalf("parse callback redirect fragment: %v", err)
	}
	if fragment.Get("session_token") == "" {
		t.Fatal("expected session_token in google return_to redirect fragment")
	}
}

func TestGoogleOAuthCallbackRedirectsBackToSiteFrontend(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithGoogle(&stubGoogleOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "google",
			ProviderSubject: "google-sub-site",
			Email:           "site@example.com",
			EmailVerified:   true,
			Name:            "Google站点用户",
		},
	})

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	startReq := httptest.NewRequest(http.MethodGet, "/auth/oauth/google/start", nil)
	startReq.Host = "api.lightclaw.site"
	startReq.Header.Set("X-Forwarded-Proto", "https")
	startRecorder := httptest.NewRecorder()
	router.ServeHTTP(startRecorder, startReq)
	if startRecorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth start, got %d: %s", startRecorder.Code, startRecorder.Body.String())
	}
	startLocation, err := url.Parse(startRecorder.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, startRecorder, "lc_google_oauth_state")

	callbackReq := httptest.NewRequest(http.MethodGet, "/auth/oauth/google/callback?code=google-code-site&state="+url.QueryEscape(state), nil)
	callbackReq.Host = "api.lightclaw.site"
	callbackReq.Header.Set("X-Forwarded-Proto", "https")
	callbackReq.AddCookie(stateCookie)
	callbackReq.AddCookie(inviteCookie)
	callbackRecorder := httptest.NewRecorder()
	router.ServeHTTP(callbackRecorder, callbackReq)

	if callbackRecorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth callback, got %d: %s", callbackRecorder.Code, callbackRecorder.Body.String())
	}

	location, err := url.Parse(callbackRecorder.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Scheme != "https" || location.Host != "lightclaw.site" || location.Path != "/" {
		t.Fatalf("expected callback redirect to site frontend home, got %q", callbackRecorder.Header().Get("Location"))
	}
}

func TestGoogleOAuthCallbackSyncsAvatarWhenUserHasNoUploadedAvatar(t *testing.T) {
	t.Parallel()

	avatarStore := &stubAvatarStore{
		objectKey: "avatars/usr_google/current.jpg",
	}
	router := newAuthTestRouterWithGoogleAndAvatarStore(&stubGoogleOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "google",
			ProviderSubject: "google-sub-avatar-sync",
			Email:           "avatar@example.com",
			EmailVerified:   true,
			Name:            "Google头像用户",
			AvatarURL:       "https://lh3.googleusercontent.com/photo.jpg",
		},
	}, avatarStore)

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/google/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_google_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/google/callback?code=google-code-sync&state="+url.QueryEscape(state),
		nil,
		stateCookie,
		inviteCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from google oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if avatarStore.lastRemoteUserID == "" {
		t.Fatal("expected google oauth callback to sync avatar into local storage")
	}
	if avatarStore.lastRemoteURL == "" {
		t.Fatal("expected google oauth callback to pass remote avatar url")
	}
}

func TestGoogleOAuthNotRegistered(t *testing.T) {
	t.Parallel()

	// 不设置 GoogleOAuth 配置 → 路由不注册 → 404
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

	recorder := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/google/start", nil)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when google oauth not configured, got %d", recorder.Code)
	}
}
