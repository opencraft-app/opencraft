package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSGProdNativeLoginDeploymentPolicy(t *testing.T) {
	cfg, err := LoadConfigFile("../../../argocd/services/service-gateway/sgprod/config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer auth.Close()
	var route *Route
	for i := range cfg.Routes {
		if cfg.Routes[i].Name == "auth" {
			route = &cfg.Routes[i]
		}
	}
	if route == nil || route.Access != AccessAuthenticated {
		t.Fatal("auth route must stay authenticated")
	}
	route.Upstream = upstream.URL
	handler, err := NewHandler(Config{AuthServiceURL: auth.URL, Routes: []Route{*route}})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path string
		allowed      bool
	}{
		{"POST", "/auth/native/token", true},
		{"GET", "/auth/native/token", false},
		{"POST", "/auth/native/token/extra", false},
		{"POST", "/auth/native/start", false},
		{"GET", "/auth/session", false},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			before := calls
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
			if tc.allowed {
				if w.Code != http.StatusNoContent || calls != before+1 {
					t.Fatalf("token exchange was not forwarded: %d", w.Code)
				}
			} else if w.Code != http.StatusUnauthorized || calls != before {
				t.Fatalf("protected route not rejected before upstream: %d", w.Code)
			}
		})
	}
}
