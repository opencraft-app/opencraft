package gateway

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
)

// CTL source readiness is not deployment readiness. Five environments reject
// the new path; JP/KR still allow the instance prefix and reach authentication.
// Do not deploy CTL there assuming an absent exact allow rule blocks this API.
func TestDesktopResourceDeploymentPolicyPendingAlignment(t *testing.T) {
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
			for _, method := range []string{http.MethodGet, http.MethodPost} {
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, httptest.NewRequest(method, "/v1/instances/ins-test/desktop/resource", nil))
				want := http.StatusNotFound
				if filepath.Base(filepath.Dir(file)) == "sandbox-jp-1" || filepath.Base(filepath.Dir(file)) == "sandbox-kr-1" {
					if route.PathPolicy == PathPolicyAllowlist {
						t.Fatal("JP/KR policy changed: update the rollout assessment")
					}
					want = http.StatusUnauthorized
				} else if route.PathPolicy != PathPolicyAllowlist {
					t.Fatal("expected exact instance path policy")
				}
				if w.Code != want {
					t.Fatalf("unpublished %s reached route: %d", method, w.Code)
				}
			}
		})
	}
}

// Synthetic future route, not an edit to any deploy-facing allowlist. Verify
// exact method/path policy, authenticated identity forwarding and CTL statuses.
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
