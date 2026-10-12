package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/transport"
)

type desktopResourceAPILogic struct {
	stubLogic
	response               *transport.DesktopResourceResponse
	err                    error
	method, instance, user string
}

func (s *desktopResourceAPILogic) EnsureDesktopResource(ctx pctx.Context, id string) (*transport.DesktopResourceResponse, error) {
	s.method, s.instance, s.user = http.MethodPost, id, ctx.GetUserID()
	return s.response, s.err
}

func (s *desktopResourceAPILogic) GetDesktopResource(ctx pctx.Context, id string) (*transport.DesktopResourceResponse, error) {
	s.method, s.instance, s.user = http.MethodGet, id, ctx.GetUserID()
	return s.response, s.err
}

func TestDesktopAPIRoleIsolation(t *testing.T) {
	for _, role := range []string{"", "api", "desktop", "invalid"} {
		t.Run(role, func(t *testing.T) {
			t.Setenv("CTL_API_ROLE", role)
			for _, path := range []string{"/health", "/v1/instances/ins-1/desktop/resource", "/v1/instances/ins-1/desktop/resource/", "/v1/instances/ins-1/desktop/viewer/att/claim", "/v1/instances/ins-1/tat/session", "/v1/instances/ins-1/debug/exec", "/v1/passes", "/internal/ctl/subscriptions/dianshi/grant"} {
				called := false
				handler := desktopRoleMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					called = true
					w.WriteHeader(http.StatusNoContent)
				}))
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, nil))
				desktopPath := strings.Contains(path, "/desktop/")
				want := role == "" || (role == "api" && !desktopPath) || (role == "desktop" && (desktopPath || path == "/health"))
				if called != want || (want && w.Code != http.StatusNoContent) || (!want && w.Code < 400) {
					t.Errorf("role=%q path=%s called=%v status=%d, want allowed=%v", role, path, called, w.Code, want)
				}
			}
			if got := desktopReaperEnabled(); got != (role == "" || role == "desktop") {
				t.Errorf("reaper for role=%q: %v", role, got)
			}
		})
	}
}

func TestDesktopResourceHTTP(t *testing.T) {
	for _, tc := range []struct {
		method, state, user string
		err                 error
		status              int
	}{
		{http.MethodPost, "preparing", "user-1", nil, http.StatusAccepted},
		{http.MethodPost, "prepared", "user-1", nil, http.StatusOK},
		{http.MethodGet, "preparing", "user-1", nil, http.StatusOK},
		{http.MethodGet, "unprepared", "user-1", nil, http.StatusOK},
		{http.MethodGet, "", "user-1", errcode.ErrInstanceNotFound, http.StatusNotFound},
		{http.MethodPost, "", "", nil, errcode.ErrInstanceMissingUserID.HTTPStatus},
	} {
		t.Run(tc.method+"/"+tc.state+"/"+tc.user, func(t *testing.T) {
			stub := &desktopResourceAPILogic{response: &transport.DesktopResourceResponse{ResourceID: "ins-1", GenerationID: "gen-1", State: tc.state}, err: tc.err}
			router := newRouter(&instanceHandler{logic: stub}, &bundleHandler{}, &passHandler{})
			req := httptest.NewRequest(tc.method, "/v1/instances/ins-1/desktop/resource", nil)
			if tc.user != "" {
				req.Header.Set("X-User-Id", tc.user)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
			}
			if tc.user == "" {
				if stub.method != "" {
					t.Fatal("called logic without identity")
				}
				return
			}
			if stub.method != tc.method || stub.instance != "ins-1" || stub.user != tc.user {
				t.Fatalf("identity/method lost: %+v", stub)
			}
			if tc.err == nil {
				var envelope struct {
					Data transport.DesktopResourceResponse `json:"data"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil || envelope.Data.State != tc.state {
					t.Fatalf("response %s: %v", rec.Body.String(), err)
				}
				if strings.Contains(rec.Body.String(), "password") || strings.Contains(rec.Body.String(), "ws_url") {
					t.Fatal("legacy credentials leaked")
				}
			}
		})
	}
	if path := normalizePath("/v1/instances/ins-1/desktop/resource"); path != "/v1/instances/{id}/desktop/resource" {
		t.Fatalf("metric cardinality: %s", path)
	}
}
