package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func authorizeConsoleTestRequest(req *http.Request) {
	req.AddCookie(&http.Cookie{Name: adminSessionCookieName, Value: "cluster-token"})
}

func TestConsoleProxyForwardsPrefixedRequestToSetRootPath(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/status" {
			t.Fatalf("upstream path = %s, want /api/status", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/_llmgateway_console/set-a/api/status", nil)
	authorizeConsoleTestRequest(req)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != `{"success":true}` {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestConsoleProxyInjectsEntryBridgeIntoHTML(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			t.Fatalf("upstream path = %s, want /", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><html><head></head><body><div id="root"></div></body></html>`))
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID:               "set-a",
		Name:             "Set A",
		BaseURL:          upstream.URL,
		Status:           gateway.SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminUsername:    "set-root",
		AdminRole:        100,
		AdminStatus:      1,
		AdminGroup:       "default",
		AdminAccessToken: "admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/_llmgateway_console/set-a/", nil)
	authorizeConsoleTestRequest(req)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `var setId = "set-a"`) || !strings.Contains(body, "window.__LLMGATEWAY_CONSOLE_SET__ = setId") {
		t.Fatalf("set marker missing: %s", body)
	}
	for _, want := range []string{
		"window.location.pathname.slice(consolePrefix.length)",
		"appURL.searchParams.set('llmgateway_console_set', setId)",
		"window.history.replaceState(window.history.state, '', appURL.pathname + appURL.search + appURL.hash)",
		"navigator.serviceWorker.register('/console-sw.js')",
		"controller.postMessage({ type: 'llmgateway-console-set', setId: setId })",
		"navigator.serviceWorker.addEventListener('controllerchange'",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("console entry bridge missing %q in:\n%s", want, body)
		}
	}
	for _, want := range []string{
		`localStorage.setItem('uid', '1')`,
		`localStorage.setItem('user'`,
		`"username":"set-root"`,
		`"role":100`,
		`"group":"default"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("console entry admin login state missing %q in:\n%s", want, body)
		}
	}
	if strings.Contains(body, "XMLHttpRequest.prototype.open") || strings.Contains(body, "window.fetch =") {
		t.Fatalf("console entry must not monkey patch fetch or XHR:\n%s", body)
	}
}

func TestRootRedirectsLegacySetConsoleEntryToCanonicalPathWithoutCookie(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/dashboard?llmgateway_console_set=set-a&tab=usage", nil)
	authorizeConsoleTestRequest(req)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if location := rec.Header().Get("Location"); location != "/_llmgateway_console/set-a/dashboard?tab=usage" {
		t.Fatalf("location = %q", location)
	}
	if cookies := rec.Result().Cookies(); len(cookies) != 0 {
		t.Fatalf("legacy entry must not set routing cookies: %+v", cookies)
	}
}

func TestConsoleFallbackRejectsCookieOnlyRouting(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		t.Fatalf("cookie-only request reached upstream: %s", r.URL.Path)
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID:               "set-a",
		BaseURL:          upstream.URL,
		Status:           gateway.SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	authorizeConsoleTestRequest(req)
	req.AddCookie(&http.Cookie{Name: "llmgateway_console_set", Value: "set-a"})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 0 {
		t.Fatalf("upstream calls = %d", upstreamCalls)
	}
}

func TestConsoleFallbackRefreshesInvalidAdminAccessToken(t *testing.T) {
	apiCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/user/":
			apiCalls++
			w.Header().Set("Content-Type", "application/json")
			switch apiCalls {
			case 1:
				if got := r.Header.Get("Authorization"); got != "Bearer stale-token" {
					t.Fatalf("first Authorization = %q, want stale token", got)
				}
				_, _ = w.Write([]byte(`{"success":false,"message":"无权进行此操作，access token 无效"}`))
			case 2:
				if got := r.Header.Get("Authorization"); got != "Bearer fresh-token" {
					t.Fatalf("retry Authorization = %q, want fresh token", got)
				}
				if got := r.Header.Get("New-Api-User"); got != "1" {
					t.Fatalf("retry New-Api-User = %q, want 1", got)
				}
				_, _ = w.Write([]byte(`{"success":true,"data":{"items":[],"total":0,"page":1,"page_size":10}}`))
			default:
				t.Fatalf("unexpected extra API call")
			}
		case "/api/setup":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"status":true,"root_init":true}}`))
		case "/api/user/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "root-session", Path: "/"})
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":1,"username":"set-root","role":100,"status":1,"group":"default"}}`))
		case "/api/option/payment_compliance":
			if got := r.Header.Get("Authorization"); got != "" {
				t.Fatalf("compliance Authorization = %q, want empty", got)
			}
			if got := r.Header.Get("New-Api-User"); got != "1" {
				t.Fatalf("compliance New-Api-User = %q, want 1", got)
			}
			if cookie, err := r.Cookie("session"); err != nil || cookie.Value != "root-session" {
				t.Fatalf("missing compliance session cookie: cookie=%v err=%v", cookie, err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"confirmed":true,"terms_version":"v1"}}`))
		case "/api/option/":
			if r.Method != http.MethodPut {
				t.Fatalf("option method = %s, want PUT", r.Method)
			}
			if got := r.Header.Get("Authorization"); got != "" {
				t.Fatalf("theme Authorization = %q, want empty", got)
			}
			if got := r.Header.Get("New-Api-User"); got != "1" {
				t.Fatalf("theme New-Api-User = %q, want 1", got)
			}
			if cookie, err := r.Cookie("session"); err != nil || cookie.Value != "root-session" {
				t.Fatalf("missing theme session cookie: cookie=%v err=%v", cookie, err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true}`))
		case "/api/user/2fa/setup":
			if got := r.Header.Get("New-Api-User"); got != "1" {
				t.Fatalf("2fa setup New-Api-User = %q, want 1", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"secret":"JBSWY3DPEHPK3PXP"}}`))
		case "/api/user/2fa/enable":
			if got := r.Header.Get("New-Api-User"); got != "1" {
				t.Fatalf("2fa enable New-Api-User = %q, want 1", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true}`))
		case "/api/user/token":
			if got := r.Header.Get("New-Api-User"); got != "1" {
				t.Fatalf("token New-Api-User = %q, want 1", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":"fresh-token"}`))
		default:
			t.Fatalf("unexpected upstream path %s", r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{RootPassword: "Qq373866172!"})
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID:               "set-a",
		BaseURL:          upstream.URL,
		Status:           gateway.SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "stale-token",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/user/?p=1&page_size=10", nil)
	authorizeConsoleTestRequest(req)
	req.Header.Set("X-LLMGateway-Set", "set-a")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if apiCalls != 2 {
		t.Fatalf("api calls = %d, want 2", apiCalls)
	}
	if !strings.Contains(rec.Body.String(), `"success":true`) {
		t.Fatalf("retry response not returned: %s", rec.Body.String())
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("stored set missing: ok=%v err=%v", ok, err)
	}
	if set.AdminAccessToken != "fresh-token" {
		t.Fatalf("stored token = %q, want fresh-token", set.AdminAccessToken)
	}
	if set.AdminTOTPSecret != "JBSWY3DPEHPK3PXP" {
		t.Fatalf("stored totp secret = %q", set.AdminTOTPSecret)
	}
}

func TestConsoleProxyReplaysSessionOnlyAPIWithManagedDashboardSession(t *testing.T) {
	var planCalls int
	var completed2FA bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/subscription/admin/plans":
			planCalls++
			if planCalls == 1 {
				if got := r.Header.Get("Authorization"); got != "Bearer admin-token" {
					t.Fatalf("first plan Authorization = %q, want access token", got)
				}
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"This operation requires dashboard session authentication. API access token is not allowed.","success":false}`))
				return
			}
			if got := r.Header.Get("Authorization"); got != "" {
				t.Fatalf("replayed plan Authorization = %q, want empty dashboard session auth", got)
			}
			if got := r.Header.Get("New-Api-User"); got != "1" {
				t.Fatalf("replayed plan New-Api-User = %q, want 1", got)
			}
			if cookie, err := r.Cookie("session"); err != nil || cookie.Value != "root-session" {
				t.Fatalf("missing replay dashboard session cookie: cookie=%v err=%v", cookie, err)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":17}}`))
		case "/api/user/login":
			_, _ = w.Write([]byte(`{"success":true,"data":{"require_2fa":true,"flow_token":"flow-123"}}`))
		case "/api/user/login/2fa":
			var req struct {
				Code      string `json:"code"`
				FlowToken string `json:"flow_token"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatal(err)
			}
			if req.FlowToken != "flow-123" || strings.TrimSpace(req.Code) == "" {
				t.Fatalf("unexpected 2FA login request: %+v", req)
			}
			completed2FA = true
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "root-session", Path: "/"})
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":1,"username":"set-root","role":100,"status":1,"group":"default"}}`))
		default:
			t.Fatalf("unexpected upstream path %s", r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{RootUsername: "set-root", RootPassword: "Qq373866172!"})
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID:               "set-a",
		BaseURL:          upstream.URL,
		Status:           gateway.SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminUsername:    "set-root",
		AdminRole:        100,
		AdminStatus:      1,
		AdminGroup:       "default",
		AdminAccessToken: "admin-token",
		AdminTOTPSecret:  "JBSWY3DPEHPK3PXP",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/_llmgateway_console/set-a/api/subscription/admin/plans", strings.NewReader(`{"plan":{"title":"pro"}}`))
	authorizeConsoleTestRequest(req)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if planCalls != 2 || !completed2FA {
		t.Fatalf("planCalls=%d completed2FA=%t", planCalls, completed2FA)
	}
	if !strings.Contains(rec.Body.String(), `"id":17`) {
		t.Fatalf("replayed response not returned: %s", rec.Body.String())
	}
}

func TestConsoleProxyBootstrapsManagedDashboardSessionForAuthRefresh(t *testing.T) {
	var refreshCalls int
	var completed2FA bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/user/login":
			_, _ = w.Write([]byte(`{"success":true,"data":{"require_2fa":true,"flow_token":"flow-123"}}`))
		case "/api/user/login/2fa":
			var req struct {
				Code      string `json:"code"`
				FlowToken string `json:"flow_token"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatal(err)
			}
			if req.FlowToken != "flow-123" || strings.TrimSpace(req.Code) == "" {
				t.Fatalf("unexpected 2FA login request: %+v", req)
			}
			completed2FA = true
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "root-session", Path: "/"})
			_, _ = w.Write([]byte(`{"success":true,"data":{"user":{"id":1,"username":"set-root","role":100,"status":1,"group":"default"}}}`))
		case "/api/user/auth/refresh":
			refreshCalls++
			if cookie, err := r.Cookie("session"); err != nil || cookie.Value != "root-session" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"success":false,"message":"unauthorized"}`))
				return
			}
			http.SetCookie(w, &http.Cookie{Name: "refresh_token", Value: "rotated-refresh", Path: "/", HttpOnly: true})
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"dashboard-access","token_type":"Bearer","access_expires_at":4102444800,"user":{"id":1,"username":"set-root","role":100,"status":1,"group":"default"},"session":{"sid":"root-session","current":true,"login_method":"password","ip":"","user_agent":"","created_at":1,"last_active_at":1,"expires_at":4102444800}}}`))
		default:
			t.Fatalf("unexpected upstream path %s", r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{RootUsername: "set-root", RootPassword: "root-password"})
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID:               "set-a",
		BaseURL:          upstream.URL,
		Status:           gateway.SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminUsername:    "set-root",
		AdminRole:        100,
		AdminStatus:      1,
		AdminGroup:       "default",
		AdminAccessToken: "admin-token",
		AdminTOTPSecret:  "JBSWY3DPEHPK3PXP",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/_llmgateway_console/set-a/api/user/auth/refresh", nil)
	authorizeConsoleTestRequest(req)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if refreshCalls != 1 || !completed2FA {
		t.Fatalf("refreshCalls=%d completed2FA=%t", refreshCalls, completed2FA)
	}
	if !strings.Contains(rec.Body.String(), `"access_token":"dashboard-access"`) {
		t.Fatalf("auth bundle not returned: %s", rec.Body.String())
	}
	if cookie := rec.Header().Get("Set-Cookie"); !strings.Contains(cookie, "refresh_token=rotated-refresh") {
		t.Fatalf("refresh cookie not forwarded: %q", cookie)
	}
}

func TestConsoleFallbackHandlesSessionOnlyPasskeyStatusForEmbeddedAdmin(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/user/passkey" {
			t.Fatalf("upstream path = %s, want /api/user/passkey", r.URL.Path)
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"未登录","success":false}`))
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID:               "set-a",
		BaseURL:          upstream.URL,
		Status:           gateway.SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/user/passkey", nil)
	authorizeConsoleTestRequest(req)
	req.Header.Set("X-LLMGateway-Set", "set-a")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	for _, want := range []string{`"success":true`, `"enabled":false`} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Fatalf("passkey status response missing %q: %s", want, rec.Body.String())
		}
	}
}

func TestConsoleFallbackRoutesRuntimeAPIByRefererInsteadOfLegacyCookie(t *testing.T) {
	setAUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/status" {
			t.Fatalf("upstream path = %s, want /api/status", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"source":"set-a"}`))
	}))
	defer setAUpstream.Close()
	setBCalls := 0
	setBUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setBCalls++
		t.Fatalf("legacy cookie routed request to set-b: %s", r.URL.Path)
	}))
	defer setBUpstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", BaseURL: setAUpstream.URL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-b", BaseURL: setBUpstream.URL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	authorizeConsoleTestRequest(req)
	req.AddCookie(&http.Cookie{Name: "llmgateway_console_set", Value: "set-b"})
	req.Header.Set("Referer", "http://llmgateway.local/_llmgateway_console/set-a/dashboard")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"source":"set-a"`) || setBCalls != 0 {
		t.Fatalf("request did not stay on set-a: body=%s setBCalls=%d", rec.Body.String(), setBCalls)
	}
}

func TestConsoleFallbackRejectsConflictingExplicitSetSignals(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	for _, setID := range []string{"set-a", "set-b"} {
		if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: setID, BaseURL: upstream.URL, Status: gateway.SetStatusActive}); err != nil {
			t.Fatal(err)
		}
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/channel/?llmgateway_console_set=set-b", strings.NewReader(`{}`))
	authorizeConsoleTestRequest(req)
	req.Header.Set("X-LLMGateway-Set", "set-a")
	req.Header.Set("Referer", "http://llmgateway.local/_llmgateway_console/set-b/channels")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 0 {
		t.Fatalf("conflicting request reached upstream %d times", upstreamCalls)
	}
}

func TestConsoleFallbackRejectsConflictingSetIdentitiesWithinReferer(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	for _, setID := range []string{"set-a", "set-b"} {
		if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: setID, BaseURL: upstream.URL, Status: gateway.SetStatusActive}); err != nil {
			t.Fatal(err)
		}
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	authorizeConsoleTestRequest(req)
	req.Header.Set("Referer", "http://llmgateway.local/_llmgateway_console/set-a/dashboard?llmgateway_console_set=set-b")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 0 {
		t.Fatalf("conflicting referer reached upstream %d times", upstreamCalls)
	}
}

func TestRootRejectsEmbeddedConsoleSPAPathByCookie(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/channels" {
			t.Fatalf("upstream path = %s, want /channels", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><html><head></head><body><div id="root"></div></body></html>`))
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/channels", nil)
	authorizeConsoleTestRequest(req)
	req.AddCookie(&http.Cookie{Name: "llmgateway_console_set", Value: "set-a"})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestConsoleProxyRewritesInitialAbsoluteAssets(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><html><head><link rel="icon" href="/logo.png"><script defer src="/static/js/index.js"></script><link href="/static/css/index.css" rel="stylesheet"></head><body><div id="root"></div></body></html>`))
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/_llmgateway_console/set-a/", nil)
	authorizeConsoleTestRequest(req)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		`href="/_llmgateway_console/set-a/logo.png"`,
		`src="/_llmgateway_console/set-a/static/js/index.js"`,
		`href="/_llmgateway_console/set-a/static/css/index.css"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("rewritten asset %q missing in:\n%s", want, body)
		}
	}
}

func TestConsoleServiceWorkerScriptUsesClientURLInsteadOfGlobalState(t *testing.T) {
	handler := NewServer(gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{}), Config{})

	req := httptest.NewRequest(http.MethodGet, "/console-sw.js", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		"clientSets.set(event.clientId, pathSet)",
		"clientSets.set(event.clientId, fromClient)",
		"clients.get(event.clientId)",
		"clientSets.get(event.clientId)",
		"self.addEventListener('message'",
		"event.source.id",
		"llmgateway_console_set",
		"parseSetId(referer)",
		"/_llmgateway_console/",
		"skipWaiting()",
		"clients.claim()",
		"request.clone().arrayBuffer()",
		"request.mode !== 'navigate'",
		"shouldRewrite(requestUrl.pathname, event.request.mode)",
		"mode === 'navigate'",
		"service worker could not infer set",
		"service worker fetch failed",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("service worker missing %q in:\n%s", want, body)
		}
	}
	if strings.Contains(body, "currentSet") {
		t.Fatalf("service worker must not keep global currentSet state")
	}
}
