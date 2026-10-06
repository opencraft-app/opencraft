package gateway

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestProductionDevCloudCORSPreflightAndExchange(t *testing.T) {
	for _, env := range []string{"shprod", "sgprod"} {
		t.Run(env, func(t *testing.T) {
			upstreamCalls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				upstreamCalls++
				if r.Method != http.MethodPost || r.URL.Path != "/auth/session/exchange" {
					t.Errorf("unexpected upstream request: %s %s", r.Method, r.URL.Path)
				}
				w.WriteHeader(http.StatusBadRequest) // Even auth errors must be readable by the browser.
			}))
			defer upstream.Close()
			cfg, err := LoadConfigFile(filepath.Join("..", "..", "..", "argocd", "services", "service-gateway", env, "config.yaml"))
			if err != nil {
				t.Fatal(err)
			}
			cfg.AuthServiceURL = upstream.URL
			cfg.WorkerActions.Enabled = false
			for i := range cfg.Routes {
				cfg.Routes[i].Upstream = upstream.URL
			}
			handler, err := NewHandler(cfg, WithAdminBasicAuth("test-admin", "test-only"))
			if err != nil {
				t.Fatal(err)
			}
			for _, origin := range []string{"https://join.devcloud.woa.com", "https://preview-42.team.devcloud.woa.com"} {
				for _, path := range []string{"/auth/session/exchange", "/v1/instances"} {
					req := httptest.NewRequest(http.MethodOptions, path, nil)
					req.Header.Set("Origin", origin)
					req.Header.Set("Access-Control-Request-Method", http.MethodPost)
					req.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
					rec := httptest.NewRecorder()
					handler.ServeHTTP(rec, req)
					if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != origin || !strings.Contains(rec.Header().Get("Vary"), "Origin") {
						t.Fatalf("preflight %s %s: %d %v", origin, path, rec.Code, rec.Header())
					}
					if !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Authorization") || !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Content-Type") {
						t.Fatal("missing request headers in CORS response")
					}
				}
				if upstreamCalls != 0 {
					t.Fatal("preflight reached upstream")
				}
			}
			for _, origin := range []string{
				"http://join.devcloud.woa.com", "https://devcloud.woa.com", "https://join.devcloud.woa.com.evil.example", "https://evildevcloud.woa.com",
				"https://join.devcloud.woa.com:8443", "https://join.devcloud.woa.com:443", "https://user@join.devcloud.woa.com", "https://join.devcloud.woa.com/", "https://join.devcloud.woa.com?", "https://join.devcloud.woa.com#",
				"https://*.devcloud.woa.com", "https://join..devcloud.woa.com", "https://-join.devcloud.woa.com", "https://join_.devcloud.woa.com", "https://join.devcloud.woa.com.",
			} {
				req := httptest.NewRequest(http.MethodOptions, "/auth/session/exchange", nil)
				req.Header.Set("Origin", origin)
				req.Header.Set("Access-Control-Request-Method", http.MethodPost)
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)
				if rec.Header().Get("Access-Control-Allow-Origin") != "" {
					t.Errorf("unsafe CORS origin reflected: %s", origin)
				}
			}
			req := httptest.NewRequest(http.MethodPost, "/auth/session/exchange", strings.NewReader(`{}`))
			req.Header.Set("Origin", "https://join.devcloud.woa.com")
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest || upstreamCalls != 1 || rec.Header().Get("Access-Control-Allow-Origin") != "https://join.devcloud.woa.com" {
				t.Fatalf("exchange error not exposed to browser: %d %v calls=%d", rec.Code, rec.Header(), upstreamCalls)
			}
		})
	}
}
