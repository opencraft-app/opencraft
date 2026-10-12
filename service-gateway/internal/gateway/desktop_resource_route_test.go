package gateway

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"gopkg.in/yaml.v3"
)

func desktopDeploymentRequests() []PublicRule {
	return []PublicRule{
		{Method: http.MethodGet, Path: "/v1/instances/ins-test/desktop/session"},
		{Method: http.MethodPost, Path: "/v1/instances/ins-test/desktop/session"},
		{Method: http.MethodGet, Path: "/v1/instances/ins-test/desktop/resource"},
		{Method: http.MethodPost, Path: "/v1/instances/ins-test/desktop/resource"},
		{Method: http.MethodPost, Path: "/v1/instances/ins-test/desktop/viewer"},
		{Method: http.MethodDelete, Path: "/v1/instances/ins-test/desktop/viewer/attachment-test"},
		{Method: http.MethodPost, Path: "/v1/instances/ins-test/desktop/viewer/attachment-test/claim"},
	}
}

// Desktop endpoints require authentication in every deployment. JP/KR retain
// their existing prefix policy; the other five environments use exact rules.
func TestDesktopDeploymentRoutePolicy(t *testing.T) {
	for _, file := range deployConfigPaths(t, "../../..") {
		t.Run(filepath.Base(filepath.Dir(file)), func(t *testing.T) {
			cfg, err := LoadConfigFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var route Route
			for _, r := range cfg.Routes {
				if r.Prefix == "/v1/instances" {
					route = r
				}
			}
			route.Upstream = "http://127.0.0.1:1" // No real upstream calls.
			if route.Access != AccessAuthenticated || !route.RequireRealname {
				t.Fatal("instance route lost identity protection")
			}
			handler, err := NewHandler(Config{AuthServiceURL: "http://127.0.0.1:1", Routes: []Route{route}})
			if err != nil {
				t.Fatal(err)
			}
			env := filepath.Base(filepath.Dir(file))
			if env == "sandbox-jp-1" || env == "sandbox-kr-1" {
				if route.PathPolicy == PathPolicyAllowlist {
					t.Fatal("JP/KR policy changed: update the rollout assessment")
				}
			} else if route.PathPolicy != PathPolicyAllowlist {
				t.Fatal("expected exact instance path policy")
			}
			for _, req := range desktopDeploymentRequests() {
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, httptest.NewRequest(req.Method, req.Path, nil))
				if w.Code != http.StatusUnauthorized {
					t.Errorf("%s %s: status = %d, want 401", req.Method, req.Path, w.Code)
				}
			}
			if route.PathPolicy == PathPolicyAllowlist {
				for _, req := range []PublicRule{
					{Method: http.MethodDelete, Path: "/v1/instances/ins-test/desktop/resource"},
					{Method: http.MethodGet, Path: "/v1/instances/ins-test/desktop/viewer"},
					{Method: http.MethodPost, Path: "/v1/instances/ins-test/desktop/viewer/attachment-test"},
					{Method: http.MethodGet, Path: "/v1/instances/ins-test/desktop/viewer/attachment-test/claim"},
					{Method: http.MethodPost, Path: "/v1/instances/ins-test/desktop/viewer/attachment-test/claim/extra"},
					{Method: http.MethodPost, Path: "/v1/instances/ins-test/desktop/unknown"},
				} {
					w := httptest.NewRecorder()
					handler.ServeHTTP(w, httptest.NewRequest(req.Method, req.Path, nil))
					if w.Code != http.StatusNotFound {
						t.Errorf("%s %s bypassed exact policy: status = %d", req.Method, req.Path, w.Code)
					}
				}
			}
		})
	}
}

func TestDesktopDeploymentAuthenticatedForwarding(t *testing.T) {
	for _, file := range deployConfigPaths(t, "../../..") {
		t.Run(filepath.Base(filepath.Dir(file)), func(t *testing.T) {
			cfg, err := LoadConfigFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var route Route
			for _, r := range cfg.Routes {
				if r.Prefix == "/v1/instances" {
					route = r
				}
			}
			for _, tc := range []struct {
				name           string
				authStatus     int
				realname       bool
				upstreamStatus int
				wantStatus     int
				wantCalls      int32
			}{
				{"invalid-session", http.StatusUnauthorized, true, http.StatusOK, http.StatusUnauthorized, 0},
				{"unverified-user", http.StatusOK, false, http.StatusOK, http.StatusForbidden, 0},
				{"verified-user", http.StatusOK, true, http.StatusOK, http.StatusOK, 1},
				{"upstream-forbidden", http.StatusOK, true, http.StatusForbidden, http.StatusForbidden, 1},
			} {
				t.Run(tc.name, func(t *testing.T) {
					auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
						w.WriteHeader(tc.authStatus)
						if tc.realname {
							_, _ = w.Write([]byte(`{"session":{"user":{"id":"verified-user","realnameVerified":true}}}`))
						} else {
							_, _ = w.Write([]byte(`{"session":{"user":{"id":"verified-user","realnameVerified":false}}}`))
						}
					}))
					defer auth.Close()
					var calls atomic.Int32
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						calls.Add(1)
						if r.Header.Get("X-User-ID") != "verified-user" {
							t.Error("caller-supplied identity reached CTL")
						}
						w.WriteHeader(tc.upstreamStatus)
						_, _ = w.Write([]byte(r.Method + " " + r.URL.Path))
					}))
					defer upstream.Close()
					ordinary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
						t.Error("desktop request reached ordinary CTL upstream")
						w.WriteHeader(http.StatusTeapot)
					}))
					defer ordinary.Close()
					route.Upstream = ordinary.URL
					route.DesktopUpstream = upstream.URL
					handler, err := NewHandler(Config{AuthServiceURL: auth.URL, Routes: []Route{route}})
					if err != nil {
						t.Fatal(err)
					}
					for _, req := range desktopDeploymentRequests() {
						r := httptest.NewRequest(req.Method, req.Path, nil)
						r.Header.Set("Authorization", "Bearer test-only")
						r.Header.Set("X-User-ID", "forged-user")
						before := calls.Load()
						w := httptest.NewRecorder()
						handler.ServeHTTP(w, r)
						wantStatus, wantCalls := tc.wantStatus, tc.wantCalls
						// The existing realname wall exempts reads and cleanup DELETEs.
						if tc.authStatus == http.StatusOK && !tc.realname && (req.Method == http.MethodGet || req.Method == http.MethodDelete) {
							wantStatus, wantCalls = tc.upstreamStatus, 1
						}
						if w.Code != wantStatus || calls.Load()-before != wantCalls {
							t.Errorf("%s %s: status=%d calls=%d, want status=%d calls=%d",
								req.Method, req.Path, w.Code, calls.Load()-before, wantStatus, wantCalls)
						}
						if wantCalls > 0 && w.Body.String() != req.Method+" "+req.Path {
							t.Errorf("method/path or upstream response rewritten: %q", w.Body.String())
						}
						for _, suffix := range []string{"/", "//", "%2f"} {
							before := calls.Load()
							r := httptest.NewRequest(req.Method, req.Path+suffix, nil)
							r.Header.Set("Authorization", "Bearer test-only")
							w := httptest.NewRecorder()
							handler.ServeHTTP(w, r)
							if w.Code != http.StatusNotFound || calls.Load() != before {
								t.Errorf("desktop alias %s %s escaped isolation: status=%d", req.Method, req.Path+suffix, w.Code)
							}
						}
					}
				})
			}
		})
	}
}

func TestDesktopUpstreamIsolation(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"session":{"user":{"id":"verified-user","realnameVerified":true}}}`))
	}))
	defer auth.Close()
	var desktopCalls atomic.Int32
	desktop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		desktopCalls.Add(1)
		if r.Header.Get("X-User-ID") != "verified-user" {
			t.Error("desktop received unauthenticated identity")
		}
		_, _ = w.Write([]byte("desktop " + r.Method + " " + r.URL.RequestURI()))
	}))
	defer desktop.Close()
	ordinary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ordinary"))
	}))
	defer ordinary.Close()
	for _, enabled := range []bool{false, true} {
		route := Route{Name: "ctl", Prefix: "/v1/instances", Upstream: ordinary.URL, Access: AccessAuthenticated}
		if enabled {
			if err := yaml.Unmarshal([]byte("desktop_upstream: "+desktop.URL), &route); err != nil {
				t.Fatal(err)
			}
		}
		handler, err := NewHandler(Config{AuthServiceURL: auth.URL, Routes: []Route{route}})
		if err != nil {
			t.Fatal(err)
		}
		for _, req := range desktopDeploymentRequests() {
			r := httptest.NewRequest(req.Method, req.Path+"?mode=control", nil)
			r.Header.Set("Authorization", "Bearer test-only")
			r.Header.Set("X-User-ID", "forged-user")
			r.Header.Set("X-Desktop-Upstream", "http://127.0.0.1:1")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			want := "ordinary"
			if enabled {
				want = "desktop " + req.Method + " " + req.Path + "?mode=control"
			}
			if w.Code != http.StatusOK || w.Body.String() != want {
				t.Errorf("enabled=%v %s %s: status=%d body=%q, want %q", enabled, req.Method, req.Path, w.Code, w.Body.String(), want)
			}
			before := desktopCalls.Load()
			w = httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(req.Method, req.Path, nil))
			if w.Code != http.StatusUnauthorized || desktopCalls.Load() != before {
				t.Fatal("unauthenticated desktop request reached upstream")
			}
			preflight := httptest.NewRequest(http.MethodOptions, req.Path, nil)
			preflight.Header.Set("Origin", "https://example.com")
			preflight.Header.Set("Access-Control-Request-Method", req.Method)
			w = httptest.NewRecorder()
			handler.ServeHTTP(w, preflight)
			if w.Code != http.StatusNoContent || desktopCalls.Load() != before {
				t.Fatal("desktop preflight changed existing CORS behavior")
			}
		}
		for _, req := range []PublicRule{
			{Method: "GET", Path: "/v1/instances"},
			{Method: "GET", Path: "/v1/instances/ins-test"},
			{Method: "POST", Path: "/v1/instances/ins-test/terminal"},
			{Method: "POST", Path: "/v1/instances/ins-test/chat"},
			{Method: "GET", Path: "/v1/instances/ins-test/desktop-metadata"},
			{Method: "GET", Path: "/v1/instances/ins-test/desktop"},
			{Method: "POST", Path: "/v1/instances//ins-test/desktop/resource/"},
			{Method: "POST", Path: "/v1/instances/ins-test/desktop/resource%2f"},
			{Method: "DELETE", Path: "/v1/instances/ins-test/desktop/session"},
			{Method: "DELETE", Path: "/v1/instances/ins-test/desktop/resource"},
			{Method: "GET", Path: "/v1/instances/ins-test/desktop/viewer"},
			{Method: "POST", Path: "/v1/instances/ins-test/desktop/viewer/attachment-test"},
			{Method: "GET", Path: "/v1/instances/ins-test/desktop/viewer/attachment-test/claim"},
			{Method: "POST", Path: "/v1/instances/ins-test/desktop/viewer/attachment-test/claim/extra"},
			{Method: "POST", Path: "/v1/instances/ins-test/desktop/resource/"},
			{Method: "POST", Path: "/v1/instances//desktop/resource"},
			{Method: "POST", Path: "/v1/instances/../desktop/resource"},
			{Method: "POST", Path: "/v1/instances/./desktop/resource"},
			{Method: "POST", Path: "/v1/instances/ins-test/desktop/viewer/../claim"},
			{Method: "POST", Path: "/v1/instances/ins-test/desktop/resource/extra"},
			{Method: "POST", Path: "/v1/instances/ins-test/desktop/unknown"},
		} {
			r := httptest.NewRequest(req.Method, req.Path, nil)
			r.Header.Set("Authorization", "Bearer test-only")
			w := httptest.NewRecorder()
			before := desktopCalls.Load()
			handler.ServeHTTP(w, r)
			if enabled && (strings.Contains(req.Path, "/desktop/") || strings.HasSuffix(req.Path, "/desktop")) {
				if w.Code != http.StatusNotFound || desktopCalls.Load() != before {
					t.Errorf("noncanonical desktop %s %s escaped isolation: %d %q", req.Method, req.Path, w.Code, w.Body.String())
				}
			} else if w.Code != http.StatusOK || w.Body.String() != "ordinary" {
				t.Errorf("ordinary %s %s changed: %d %q", req.Method, req.Path, w.Code, w.Body.String())
			}
		}
	}
	desktop.Close()
	route := Route{Name: "ctl", Prefix: "/v1/instances", Upstream: ordinary.URL, Access: AccessAuthenticated}
	if err := yaml.Unmarshal([]byte("desktop_upstream: "+desktop.URL), &route); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(Config{AuthServiceURL: auth.URL, Routes: []Route{route}})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/instances/ins-test/desktop/resource", "/v1/instances/ins-test"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer test-only")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		want := http.StatusOK
		if path == "/v1/instances/ins-test/desktop/resource" {
			want = http.StatusBadGateway
		}
		if w.Code != want {
			t.Errorf("unavailable desktop %s: status=%d, want %d", path, w.Code, want)
		}
	}
}

func TestDesktopUpstreamConfigValidation(t *testing.T) {
	for _, upstream := range []string{"/relative", "ftp://example.com", "http:///missing-host", "http://user:pass@example.com", "http://example.com/path", "http://example.com?query=1", "http://example.com#fragment", "http://%"} {
		route := Route{Name: "ctl", Prefix: "/v1/instances", Upstream: "http://127.0.0.1:1", Access: AccessAuthenticated}
		if err := yaml.Unmarshal([]byte("desktop_upstream: "+upstream), &route); err != nil {
			t.Fatal(err)
		}
		if _, err := NewHandler(Config{AuthServiceURL: "http://127.0.0.1:1", Routes: []Route{route}}); err == nil {
			t.Errorf("accepted invalid desktop upstream %q", upstream)
		}
	}
	for _, prefix := range []string{"/v1", "/v1/instances/", "/v1/chat"} {
		route := Route{Name: "ctl", Prefix: prefix, Upstream: "http://127.0.0.1:1", Access: AccessAuthenticated}
		if err := yaml.Unmarshal([]byte("desktop_upstream: http://127.0.0.1:2"), &route); err != nil {
			t.Fatal(err)
		}
		if _, err := NewHandler(Config{AuthServiceURL: "http://127.0.0.1:1", Routes: []Route{route}}); err == nil {
			t.Errorf("accepted desktop upstream on arbitrary prefix %q", prefix)
		}
	}
}

// Verify resource preparation statuses independently of deployment policy.
func TestDesktopResourceAuthenticatedRouteContract(t *testing.T) {
	var calls atomic.Int32
	var authenticated atomic.Bool
	authenticated.Store(true)
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if !authenticated.Load() {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"session":{"user":{"id":"verified-user","realnameVerified":true}}}`))
	}))
	defer auth.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("X-User-ID") != "verified-user" {
			t.Error("caller-supplied identity reached CTL")
		}
		if r.URL.Path != "/v1/instances/ins-test/desktop/resource" {
			t.Errorf("path rewritten: %s", r.URL.Path)
		}
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusAccepted)
		}
		_, _ = w.Write([]byte(`{"data":{"state":"preparing"}}`))
	}))
	defer upstream.Close()
	handler, err := NewHandler(Config{AuthServiceURL: auth.URL, Routes: []Route{{
		Name: "ctl-desktop-resource-test", Prefix: "/v1/instances", Upstream: upstream.URL, Access: AccessAuthenticated,
		PathPolicy: "allowlist", RequireRealname: true,
		PathAllow: []PublicRule{
			{Method: http.MethodGet, Path: "/v1/instances/{instance_id}/desktop/resource"},
			{Method: http.MethodPost, Path: "/v1/instances/{instance_id}/desktop/resource"},
		},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		r := httptest.NewRequest(method, "/v1/instances/ins-test/desktop/resource", nil)
		r.Header.Set("Authorization", "Bearer test-only")
		r.Header.Set("X-User-ID", "forged-user")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		want := http.StatusOK
		if method == http.MethodPost {
			want = http.StatusAccepted
		}
		if w.Code != want {
			t.Fatalf("upstream status: %d, want %d", w.Code, want)
		}
	}
	before := calls.Load()
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/v1/instances/ins-test/desktop/resource", nil))
	if w.Code != http.StatusNotFound || calls.Load() != before {
		t.Fatal("adjacent method bypassed allowlist")
	}
	authenticated.Store(false)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/instances/ins-test/desktop/resource", nil))
	if w.Code != http.StatusUnauthorized || calls.Load() != before {
		t.Fatal("unauthenticated preparation forwarded")
	}
}
