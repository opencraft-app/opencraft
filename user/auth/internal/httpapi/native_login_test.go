package httpapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/oidc"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

func TestNativeLoginOpenAPIContract(t *testing.T) {
	spec, err := openapi3.NewLoader().LoadFromFile("../../api/native-login.openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestProviderFailurePreservesOnlyValidatedOIDCPage(t *testing.T) {
	h := NewHandler(nil, true, http.SameSiteLaxMode, time.Hour, nil, nil, nil, nil, "", nil)
	fallback := "https://lightvela.com/?oauth_error=login_failed"
	target := "https://lightvela.com/auth/federation/authorize?response_type=code&state=app-state&code_challenge=challenge"
	for _, name := range []string{googleOAuthReturnToCookieName, githubOAuthReturnToCookieName, qqOAuthReturnToCookieName, wechatOAuthReturnToCookieName} {
		request := httptest.NewRequest("GET", "https://api.lightvela.com/callback", nil)
		request.AddCookie(&http.Cookie{Name: name, Value: target})
		result, _ := url.Parse(h.oauthFailureURL(request, name, fallback))
		if result.Path != "/auth/federation/authorize" || result.Query().Get("state") != "app-state" || result.Query().Get("code_challenge") != "challenge" || result.Query().Get("oauth_error") != "login_failed" {
			t.Fatal("lost OIDC transaction")
		}
		for _, bad := range []string{oidc.NativeRedirectURI, "https://evil.example/auth/federation/authorize?response_type=code"} {
			req := httptest.NewRequest("GET", "https://api.lightvela.com/callback", nil)
			req.AddCookie(&http.Cookie{Name: name, Value: bad})
			if got := h.oauthFailureURL(req, name, fallback); got != fallback {
				t.Fatal("unsafe failure redirect")
			}
		}
	}
}

func TestNativeOIDCUsesUnifiedAuthorizationAndSessionAdapter(t *testing.T) {
	now := time.Now().UTC()
	registry, err := oidc.NewRegistry([]oidc.Client{
		{ID: oidc.NativeClientID, DisplayName: "Vela", RedirectURIs: []string{oidc.NativeRedirectURI}},
		{ID: "web", DisplayName: "Web", RedirectURIs: []string{"https://web.example/callback"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	provider := oidc.NewProvider(oidc.ProviderConfig{
		Issuer: "https://auth.example", Registry: registry,
		CodeStore:    oidc.NewMemoryCodeStore(func() time.Time { return now }),
		SigningKeyID: "test", SigningKey: ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, 32)),
		Now: func() time.Time { return now }, CodeTTL: 5 * time.Second,
	})
	svc := service.NewWithStore(service.NewMemoryStore(service.StoreOptions{SeedDefaultInvites: true}), service.Options{SessionTTL: time.Hour})
	config := ServerConfig{FrontendBaseURL: "https://lightvela.ai", SessionTTL: time.Hour, OIDC: &OIDCConfig{Provider: provider}}
	router, other := NewRouter(svc, config), NewRouter(svc, config)
	// No Google/provider configuration: any existing authenticated web session works.
	signUp := performJSONRequest(t, router, "POST", "/auth/password/sign-up", map[string]any{
		"name": "Native", "email": "native@example.com", "password": "password123", "inviteCode": "VALID2026",
	})
	cookie := sessionCookieFromRecorder(t, signUp)
	params := url.Values{
		"client_id": {oidc.NativeClientID}, "redirect_uri": {oidc.NativeRedirectURI},
		"response_type": {"code"}, "scope": {"openid profile"}, "state": {"test-state"}, "nonce": {"test-nonce"},
		"code_challenge": {oidc.S256Challenge(strings.Repeat("v", 43))}, "code_challenge_method": {"S256"},
	}
	start := performJSONRequest(t, router, "GET", "/oauth2/authorize?"+params.Encode(), nil)
	if start.Code != 302 {
		t.Fatalf("start: %d", start.Code)
	}
	target, _ := url.Parse(start.Header().Get("Location"))
	if target.Host != "lightvela.ai" || target.Path != "/auth/federation/authorize" || target.Query().Encode() != params.Encode() {
		t.Fatal("must reuse unified OIDC page")
	}
	request := map[string]any{}
	for k, v := range params {
		request[k] = v[0]
	}
	denied := performJSONRequest(t, router, "POST", "/oauth2/authorize", request)
	if denied.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated grant: %d", denied.Code)
	}
	issue := func() string {
		result := performJSONRequest(t, router, "POST", "/oauth2/authorize", request, cookie)
		if result.Code != 200 {
			t.Fatalf("authorize: %d", result.Code)
		}
		var body struct {
			RedirectURL string `json:"redirect_url"`
		}
		decodeJSONResponse(t, result, &body)
		callback, _ := url.Parse(body.RedirectURL)
		if callback.Scheme != "opencraft" || callback.Query().Get("state") != "test-state" || len(callback.Query()) != 2 {
			t.Fatal("invalid callback")
		}
		return callback.Query().Get("code")
	}
	code := issue()
	input := map[string]any{"code": code, "code_verifier": strings.Repeat("x", 43), "redirect_uri": oidc.NativeRedirectURI}
	if result := performJSONRequest(t, other, "POST", "/auth/native/token", input); result.Code != 400 {
		t.Fatal("wrong verifier accepted")
	}
	// Native code cannot also mint site/OIDC JWTs.
	jwt := performFormRequest(t, other, "POST", "/oauth2/token", url.Values{
		"grant_type": {"authorization_code"}, "client_id": {oidc.NativeClientID}, "redirect_uri": {oidc.NativeRedirectURI},
		"code": {code}, "code_verifier": {strings.Repeat("v", 43)},
	})
	if jwt.Code != 400 {
		t.Fatal("native JWT redemption accepted")
	}
	input["code_verifier"] = strings.Repeat("v", 43)
	now = now.Add(10 * time.Second) // Must survive mobile cold-start delay, unlike sites' five-second TTL.
	var successes atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result := performJSONRequest(t, other, "POST", "/auth/native/token", input)
			if result.Code == 200 {
				successes.Add(1)
				if result.Header().Get("Cache-Control") != "no-store" || len(result.Result().Cookies()) != 0 {
					t.Error("unsafe credential response")
				}
				var body struct {
					Token string `json:"session_token"`
				}
				decodeJSONResponse(t, result, &body)
				if _, err := svc.CurrentSession(context.Background(), body.Token); err != nil {
					t.Error("invalid session")
				}
			} else if result.Code != 400 {
				t.Errorf("exchange: %d", result.Code)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatal("grant must be consumed once across handlers")
	}
	input["code"] = issue()
	now = now.Add(121 * time.Second)
	if result := performJSONRequest(t, other, "POST", "/auth/native/token", input); result.Code != 400 {
		t.Fatal("expired code accepted")
	}
	webSession, err := svc.CurrentSession(context.Background(), cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	webCode, err := provider.CreateAuthorizationCode(context.Background(), webSession.User.ID, oidc.AuthorizeRequest{
		ClientID: "web", RedirectURI: "https://web.example/callback", ResponseType: "code",
		Scope: "openid", State: "web-state", Nonce: "web-nonce",
		CodeChallenge: oidc.S256Challenge(strings.Repeat("v", 43)), CodeChallengeMethod: "S256",
	})
	if err != nil {
		t.Fatal(err)
	}
	input["code"] = webCode.Code
	if result := performJSONRequest(t, other, "POST", "/auth/native/token", input); result.Code != 400 {
		t.Fatal("web grant minted native session")
	}
	if _, err := provider.ConsumeAuthorizationCode(context.Background(), oidc.TokenRequest{
		GrantType: "authorization_code", ClientID: "web", RedirectURI: "https://web.example/callback",
		Code: webCode.Code, CodeVerifier: strings.Repeat("v", 43),
	}); err != nil {
		t.Fatal("wrong client attempt burned the web grant")
	}
	if result := performJSONRequest(t, router, "GET", "/auth/native/start", nil); result.Code != 404 {
		t.Fatal("legacy Google entry still exposed")
	}
	if got := NewHandler(svc, true, http.SameSiteLaxMode, time.Hour, nil, nil, nil, nil, "", nil).validatedReturnToURL(oidc.NativeRedirectURI); got != "" {
		t.Fatal("web allowlist widened")
	}
}

func TestNativeSessionExchangeFailsClosedWithoutOIDC(t *testing.T) {
	router, _ := newOIDCHTTPTestRouter(t) // Contains only site-gateway, not the native client.
	result := performJSONRequest(t, router, "POST", "/auth/native/token", map[string]any{
		"code": strings.Repeat("a", 43), "code_verifier": strings.Repeat("v", 43), "redirect_uri": oidc.NativeRedirectURI,
	})
	if result.Code != 400 {
		t.Fatalf("unregistered client: %d", result.Code)
	}
	disabled := NewRouter(nil, ServerConfig{})
	if result := performJSONRequest(t, disabled, "POST", "/auth/native/token", nil); result.Code != 503 {
		t.Fatal("disabled OIDC did not fail closed")
	}
}
