package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/gin-gonic/gin"
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

func nativeTestParams() url.Values {
	return url.Values{"redirect_uri": {nativeRedirectURI}, "state": {strings.Repeat("s", 43)}, "code_challenge": {oidc.S256Challenge(strings.Repeat("v", 43))}, "code_challenge_method": {"S256"}}
}

func TestNativeLoginRoundTripAcrossHandlers(t *testing.T) {
	store := service.NewMemoryStore(service.StoreOptions{SeedDefaultInvites: true})
	svc := service.NewWithStore(store, service.Options{SessionTTL: time.Hour})
	codes := oidc.NewMemoryCodeStore(time.Now)
	config := ServerConfig{SessionTTL: time.Hour, NativeLoginCodes: codes, GoogleOAuth: &GoogleOAuthConfig{
		ClientID: "test-client", ClientSecret: "test-secret", RedirectURI: "https://api.lightvela.ai/auth/oauth/google/callback",
		FrontendBaseURL: "https://lightvela.ai", Client: &stubGoogleOAuthClient{},
	}}
	router := NewRouter(svc, config)
	start := performJSONRequest(t, router, "GET", "/auth/native/start?"+nativeTestParams().Encode(), nil)
	if start.Code != 307 {
		t.Fatalf("start status %d", start.Code)
	}
	provider, _ := url.Parse(start.Header().Get("Location"))
	callback := performJSONRequest(t, router, "GET", "/auth/oauth/google/callback?code=test&state="+url.QueryEscape(provider.Query().Get("state")), nil, start.Result().Cookies()...)
	if callback.Code != 307 {
		t.Fatalf("callback status %d", callback.Code)
	}
	target, _ := url.Parse(callback.Header().Get("Location"))
	if target.Scheme != "opencraft" || target.Host != "auth" || target.Path != "/lightvela" || target.Fragment != "" || len(target.Query()) != 2 || target.Query().Get("state") != nativeTestParams().Get("state") || len(target.Query().Get("code")) != 64 {
		t.Fatal("callback must carry only a native code and correlated state")
	}
	// A new handler/replica sees the same authoritative code store.
	other := NewRouter(svc, config)
	body := map[string]any{"code": target.Query().Get("code"), "code_verifier": strings.Repeat("x", 43), "redirect_uri": nativeRedirectURI}
	wrong := performJSONRequest(t, other, "POST", "/auth/native/token", body)
	if wrong.Code != 400 {
		t.Fatalf("wrong verifier status %d", wrong.Code)
	}
	body["code_verifier"] = strings.Repeat("v", 43)
	var success atomic.Int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := performJSONRequest(t, other, "POST", "/auth/native/token", body)
			if r.Code == 200 {
				success.Add(1)
				var result struct {
					Token string `json:"session_token"`
				}
				if json.Unmarshal(r.Body.Bytes(), &result) != nil || result.Token == "" {
					t.Error("missing exchanged session")
				}
				if _, err := svc.CurrentSession(context.Background(), result.Token); err != nil {
					t.Error("exchanged session is not usable")
				}
				if r.Header().Get("Cache-Control") != "no-store" {
					t.Error("credential response must not be cached")
				}
			} else if r.Code != 400 {
				t.Errorf("exchange status %d", r.Code)
			}
		}()
	}
	wg.Wait()
	if success.Load() != 1 {
		t.Fatalf("successful exchanges %d", success.Load())
	}
	// Provider failures must also return to the native owner, not strand a browser.
	badStart := performJSONRequest(t, router, "GET", "/auth/native/start?"+nativeTestParams().Encode(), nil)
	failed := performJSONRequest(t, router, "GET", "/auth/oauth/google/callback?error=access_denied", nil, badStart.Result().Cookies()...)
	errorTarget, _ := url.Parse(failed.Header().Get("Location"))
	if errorTarget.Scheme != "opencraft" || errorTarget.Query().Get("error") != "login_failed" || errorTarget.Query().Get("state") != nativeTestParams().Get("state") {
		t.Fatal("provider failure must return a correlated native error")
	}
}

func TestNativeLoginRejectsUnsafeTargets(t *testing.T) {
	params := nativeTestParams()
	params.Del("redirect_uri")
	valid := nativeRedirectURI + "?" + params.Encode()
	if _, ok := nativeLoginTarget(valid); !ok {
		t.Fatal("valid target rejected")
	}
	for _, raw := range []string{
		strings.Replace(valid, "opencraft:", "evil:", 1), strings.Replace(valid, "//auth/", "//auth.evil/", 1),
		strings.Replace(valid, "//auth/", "//user@auth/", 1), strings.Replace(valid, "/lightvela?", "/lightvela/../other?", 1),
		valid + "&state=other", valid + "&session_token=bad", valid + "#fragment", strings.Replace(valid, "S256", "plain", 1),
		nativeRedirectURI, strings.Replace(valid, "/lightvela?", "/%6cightvela?", 1),
	} {
		if _, ok := nativeLoginTarget(raw); ok {
			t.Fatal("unsafe native callback accepted")
		}
	}
	if validatedReturnToURL(valid) != "" {
		t.Fatal("native target leaked into generic session-token redirect allowlist")
	}
}

func TestNativeLoginExpiryNamespaceAndDisabled(t *testing.T) {
	codes := oidc.NewMemoryCodeStore(time.Now)
	router := NewRouter(nil, ServerConfig{NativeLoginCodes: codes})
	for _, tc := range []struct {
		name, client string
		expiry       time.Time
	}{
		{"expired", nativeClientID, time.Now().Add(-time.Second)},
		{"oidc", "site-gateway", time.Now().Add(time.Minute)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code := strings.Repeat("a", 64)
			_ = codes.CreateAuthorizationCode(context.Background(), oidc.CreateAuthorizationCodeInput{
				Code: code, ClientID: tc.client, UserID: "user", RedirectURI: nativeRedirectURI,
				CodeChallenge: oidc.S256Challenge(strings.Repeat("v", 43)), Scope: "native:session", ExpiresAt: tc.expiry,
			})
			r := performJSONRequest(t, router, "POST", "/auth/native/token", map[string]any{"code": code, "code_verifier": strings.Repeat("v", 43), "redirect_uri": nativeRedirectURI})
			if r.Code != 400 {
				t.Fatalf("status %d", r.Code)
			}
		})
	}
	disabled := NewRouter(nil, ServerConfig{})
	for _, methodPath := range [][2]string{{"GET", "/auth/native/start"}, {"POST", "/auth/native/token"}} {
		r := httptest.NewRecorder()
		req := httptest.NewRequest(methodPath[0], methodPath[1], nil)
		disabled.ServeHTTP(r, req)
		if r.Code != http.StatusServiceUnavailable {
			t.Fatalf("disabled status %d", r.Code)
		}
	}
	// Start validates before invoking the provider.
	h := &Handler{nativeCodes: codes, googleOAuth: &googleOAuth{}}
	r := gin.New()
	r.GET("/auth/native/start", h.StartNativeLogin)
	p := nativeTestParams()
	p.Set("redirect_uri", "evil://auth/lightvela")
	if out := performJSONRequest(t, r, "GET", "/auth/native/start?"+p.Encode(), nil); out.Code != 400 {
		t.Fatal("unsafe redirect accepted")
	}
}
