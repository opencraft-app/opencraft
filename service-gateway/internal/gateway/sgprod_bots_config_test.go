package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSGProdBotManagementDeploymentPolicy(t *testing.T) {
	cfg, err := LoadConfigFile("../../../argocd/services/service-gateway/sgprod/config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var route Route
	for _, candidate := range cfg.Routes {
		if candidate.Prefix == "/v1/instances" {
			route = candidate
		}
	}
	if route.Access != AccessAuthenticated || route.PathPolicy != "allowlist" || !route.RequireRealname {
		t.Fatal("instance authentication, realname and exact-path policy must be preserved")
	}
	upstreamCalls := 0
	upstreamStatus := http.StatusOK
	var gotMethod, gotPath, gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		gotMethod, gotPath = r.Method, r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		if r.Header.Get("X-User-ID") != "usr_test" {
			t.Error("authenticated user identity must reach CTL")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(upstreamStatus)
		if upstreamStatus == http.StatusForbidden {
			_, _ = w.Write([]byte(`{"code":"INSTANCE_FORBIDDEN"}`))
		} else {
			_, _ = w.Write([]byte(`{"data":{"ok":true}}`))
		}
	}))
	defer upstream.Close()
	authenticated, realname := true, true
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authenticated {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		value := "true"
		if !realname {
			value = "false"
		}
		_, _ = w.Write([]byte(`{"session":{"user":{"id":"usr_test","realnameVerified":` + value + `}}}`))
	}))
	defer auth.Close()
	route.Upstream = upstream.URL
	handler, err := NewHandler(Config{AuthServiceURL: auth.URL, Routes: []Route{route}})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/v1/instances/ins_test/bots", ""},
		{http.MethodPost, "/v1/instances/ins_test/bots", `{"name":"New","create_mode":"blank"}`},
		{http.MethodPost, "/v1/instances/ins_test/bots", `{"name":"Copy","create_mode":"clone","source_bot_id":"source"}`},
		{http.MethodPut, "/v1/instances/ins_test/bots/profile_test", `{"name":"Renamed"}`},
		{http.MethodDelete, "/v1/instances/ins_test/bots/profile_test", ""},
		{http.MethodPost, "/v1/instances/ins_test/bots/profile_test/retry", ""},
		{http.MethodPut, "/v1/instances/ins_test/bots/profile_test/channel-bindings/weixin", ""},
		{http.MethodPost, "/v1/instances/ins_test/bots/profile_test/channel-bindings/weixin", ""},
		{http.MethodDelete, "/v1/instances/ins_test/bots/profile_test/channel-bindings/weixin", ""},
	} {
		t.Run(tc.method+tc.path+tc.body, func(t *testing.T) {
			before := upstreamCalls
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Authorization", "Bearer test-only")
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if upstreamCalls != before+1 || gotMethod != tc.method || gotPath != tc.path || gotBody != tc.body {
				t.Fatalf("request did not reach CTL unchanged: status=%d calls=%d", w.Code, upstreamCalls-before)
			}
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"ok":true`) {
				t.Fatalf("CTL result must propagate: status=%d", w.Code)
			}
		})
	}
	upstreamStatus = http.StatusForbidden
	denied := httptest.NewRecorder()
	deniedRequest := httptest.NewRequest(http.MethodGet, "/v1/instances/other_owner/bots", nil)
	deniedRequest.Header.Set("Authorization", "Bearer test-only")
	handler.ServeHTTP(denied, deniedRequest)
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "INSTANCE_FORBIDDEN") {
		t.Fatalf("CTL ownership failure must propagate: status=%d", denied.Code)
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodDelete, "/v1/instances/ins_test/bots"},
		{http.MethodPost, "/v1/instances/ins_test/bots/profile_test"},
		{http.MethodGet, "/v1/instances/ins_test/bots/profile_test/channel-bindings/weixin"},
		{http.MethodPost, "/v1/instances/ins_test/bots/profile_test/exec"},
	} {
		before := upstreamCalls
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != http.StatusNotFound || upstreamCalls != before {
			t.Fatalf("adjacent route escaped allowlist: %s %s status=%d", tc.method, tc.path, w.Code)
		}
	}
	authenticated = false
	before := upstreamCalls
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/instances/ins_test/bots", nil))
	if w.Code != http.StatusUnauthorized || upstreamCalls != before {
		t.Fatalf("unauthenticated Bot access must fail before CTL: %d", w.Code)
	}
	authenticated, realname = true, false
	w = httptest.NewRecorder()
	unverified := httptest.NewRequest(http.MethodPost, "/v1/instances/ins_test/bots", strings.NewReader(`{"name":"Bot","create_mode":"blank"}`))
	unverified.Header.Set("Authorization", "Bearer unverified-test-only")
	handler.ServeHTTP(w, unverified)
	if w.Code != http.StatusForbidden || upstreamCalls != before {
		t.Fatalf("existing realname policy must reject writes before CTL: %d", w.Code)
	}
}
