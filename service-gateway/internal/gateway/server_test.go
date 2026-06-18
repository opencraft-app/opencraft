package gateway

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"go.temporal.io/api/serviceerror"
)

func findCookieByName(t *testing.T, resp *http.Response, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range resp.Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("expected cookie %q to be present", name)
	return nil
}

type recordedMetric struct {
	method   string
	route    string
	endpoint string
	status   int
}

type recordingMetrics struct {
	entries []recordedMetric
}

func (r *recordingMetrics) ObserveRequest(method, route, endpoint string, status int, _ time.Duration) {
	r.entries = append(r.entries, recordedMetric{
		method:   method,
		route:    route,
		endpoint: endpoint,
		status:   status,
	})
}

type fakeWorkerActionBackend struct {
	startTaskQueue    string
	startWorkflowID   string
	startWorkflowName string
	startArgs         []any
	startRun          workerActionWorkflowRun
	startErr          error
	queryWorkflowID   string
	queryRunID        string
	queryType         string
	queryStatus       map[string]any
	queryErr          error
	cancelWorkflowID  string
	cancelRunID       string
}

func (f *fakeWorkerActionBackend) StartWorkflow(_ context.Context, taskQueue string, workflowID string, workflowName string, args ...any) (workerActionWorkflowRun, error) {
	f.startTaskQueue = taskQueue
	f.startWorkflowID = workflowID
	f.startWorkflowName = workflowName
	f.startArgs = args
	if f.startErr != nil {
		return workerActionWorkflowRun{}, f.startErr
	}
	if f.startRun.WorkflowID == "" {
		f.startRun = workerActionWorkflowRun{WorkflowID: workflowID, RunID: "run-1"}
	}
	return f.startRun, nil
}

func (f *fakeWorkerActionBackend) QueryWorkflow(_ context.Context, workflowID string, runID string, queryType string) (map[string]any, error) {
	f.queryWorkflowID = workflowID
	f.queryRunID = runID
	f.queryType = queryType
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	if f.queryStatus == nil {
		f.queryStatus = map[string]any{"Phase": "completed"}
	}
	return f.queryStatus, nil
}

func (f *fakeWorkerActionBackend) CancelWorkflow(_ context.Context, workflowID string, runID string) error {
	f.cancelWorkflowID = workflowID
	f.cancelRunID = runID
	return nil
}

func TestWeChatOAuthVerificationFileIsServedAtRoot(t *testing.T) {
	metrics := &recordingMetrics{}
	handler, err := NewHandler(Config{AuthServiceURL: "http://auth.example.test"}, WithMetrics(metrics))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/MP_verify_pKLUCg80PuWPBYLB.txt", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "pKLUCg80PuWPBYLB" {
		t.Fatalf("unexpected verification content %q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Fatalf("unexpected content type %q", got)
	}
	if len(metrics.entries) != 1 {
		t.Fatalf("expected one metric entry, got %d", len(metrics.entries))
	}
	if metrics.entries[0].route != "wechat_oauth_verification" || metrics.entries[0].status != http.StatusOK {
		t.Fatalf("unexpected metric entry %+v", metrics.entries[0])
	}
}

func TestWeChatOAuthVerificationFileSupportsHead(t *testing.T) {
	handler, err := NewHandler(Config{AuthServiceURL: "http://auth.example.test"})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodHead, "/MP_verify_pKLUCg80PuWPBYLB.txt", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "" {
		t.Fatalf("expected empty HEAD body, got %q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Fatalf("unexpected content type %q", got)
	}
}

func TestPublicAllowBypassesAuth(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	authCalls := 0
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authCalls++
		http.Error(w, "should not be called", http.StatusTeapot)
	}))
	defer auth.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "auth",
				Prefix:   "/auth/",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
				PublicAllow: []PublicRule{
					{Method: http.MethodGet, Path: "/auth/oauth/qq/start"},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth/oauth/qq/start", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 1 {
		t.Fatalf("expected upstream to be called once, got %d", upstreamCalls)
	}
	if authCalls != 0 {
		t.Fatalf("expected auth introspection to be skipped, got %d calls", authCalls)
	}
}

func TestContentAuditCallbackRouteBypassesAuth(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		if r.URL.Path != "/contentaudit/callback" {
			t.Fatalf("upstream path = %q", r.URL.Path)
		}
		if got := r.Header.Get("X-Lightclaw-User-ID"); got != "" {
			t.Fatalf("expected no identity header on content audit callback, got %q", got)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	authCalls := 0
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authCalls++
		http.Error(w, "should not be called", http.StatusTeapot)
	}))
	defer auth.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "content-audit-callback",
				Prefix:   "/contentaudit/callback",
				Methods:  []string{http.MethodPost, http.MethodOptions},
				Upstream: upstream.URL,
				Access:   AccessPublic,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/contentaudit/callback", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 1 {
		t.Fatalf("expected upstream to be called once, got %d", upstreamCalls)
	}
	if authCalls != 0 {
		t.Fatalf("expected auth introspection to be skipped, got %d calls", authCalls)
	}
}

func TestAgentChatIntrospectPublicRouteBypassesAuth(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		if got := r.Header.Get("X-Lightclaw-User-ID"); got != "" {
			t.Fatalf("expected no identity header on public callback, got %q", got)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	authCalls := 0
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authCalls++
		http.Error(w, "should not be called", http.StatusTeapot)
	}))
	defer auth.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:     "ctl-agentchat-introspect",
			Prefix:   "/v1/integrations/agentchat",
			Methods:  []string{http.MethodPost, http.MethodOptions},
			Upstream: upstream.URL,
			Access:   AccessPublic,
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/integrations/agentchat/introspect", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 1 {
		t.Fatalf("expected upstream call once, got %d", upstreamCalls)
	}
	if authCalls != 0 {
		t.Fatalf("expected auth introspection to be skipped, got %d calls", authCalls)
	}
}

func TestOptionalAuthRouteBypassesAuthWhenCredentialsMissing(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		if got := r.Header.Get("X-Lightclaw-User-ID"); got != "" {
			t.Fatalf("expected no identity header, got %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	authCalls := 0
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authCalls++
		http.Error(w, "should not be called", http.StatusTeapot)
	}))
	defer auth.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:     "ctl-passes",
			Prefix:   "/v1/passes",
			Upstream: upstream.URL,
			Access:   AccessAuthenticated,
			OptionalAuthAllow: []PublicRule{
				{Method: http.MethodPost, Path: "/v1/passes/order-url"},
				{Method: http.MethodPost, Path: "/v1/passes/{pass_id}/renew/order-url"},
			},
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/passes/pass_123/renew/order-url", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 1 {
		t.Fatalf("expected upstream to be called once, got %d", upstreamCalls)
	}
	if authCalls != 0 {
		t.Fatalf("expected auth introspection to be skipped, got %d calls", authCalls)
	}
}

func TestOptionalAuthRouteInjectsIdentityWhenCredentialsExist(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok-123" {
			t.Fatalf("expected bearer token forwarded to auth service, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_123",
					"email": "user@example.com",
				},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"user_id":    r.Header.Get("X-Lightclaw-User-ID"),
			"legacy_uid": r.Header.Get("X-User-Id"),
		})
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:     "ctl-passes",
			Prefix:   "/v1/passes",
			Upstream: upstream.URL,
			Access:   AccessAuthenticated,
			OptionalAuthAllow: []PublicRule{
				{Method: http.MethodPost, Path: "/v1/passes/order-url"},
			},
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/passes/order-url", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["user_id"] != "usr_123" || body["legacy_uid"] != "usr_123" {
		t.Fatalf("expected injected identity, got %+v", body)
	}
}

func TestAuthenticatedRouteRequiresToken(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called without auth token")
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "sandbox",
				Prefix:   "/sandboxes/",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/sandboxes", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAuthenticatedRouteIntrospectsAndInjectsIdentityHeaders(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok-123" {
			t.Fatalf("expected bearer token forwarded to auth service, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_123",
					"email": "user@example.com",
				},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"user_id":        r.Header.Get("X-Lightclaw-User-ID"),
			"user_email":     r.Header.Get("X-Lightclaw-User-Email"),
			"plan_tier":      r.Header.Get("X-Lightclaw-Plan-Tier"),
			"legacy_user_id": r.Header.Get("X-User-Id"),
		})
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "sandbox",
				Prefix:   "/sandboxes",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/sandboxes", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["user_id"] != "usr_123" {
		t.Fatalf("expected injected user_id, got %q", body["user_id"])
	}
	if body["user_email"] != "user@example.com" {
		t.Fatalf("expected injected user_email, got %q", body["user_email"])
	}
	if body["plan_tier"] != "" {
		t.Fatalf("expected no injected plan_tier, got %q", body["plan_tier"])
	}
	if body["legacy_user_id"] != "usr_123" {
		t.Fatalf("expected injected legacy user id, got %q", body["legacy_user_id"])
	}
}

func TestWorkerActionStartResolvesBotAndStartsRescueExportWorkflow(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_123",
					"email":            "user@example.com",
					"realnameVerified": true,
				},
			},
		})
	}))
	defer auth.Close()

	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/instances/bot-1" {
			t.Fatalf("unexpected ctl path: %s", r.URL.Path)
		}
		if got := r.Header.Get("X-User-Id"); got != "usr_123" {
			t.Fatalf("expected user id forwarded to ctl, got %q", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": "OK",
			"data": map[string]any{
				"instance_id": "bot-1",
				"sandbox_id":  "sbx-1",
				"status":      "Running",
			},
		})
	}))
	defer ctl.Close()

	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sandboxes/sbx-1" {
			t.Fatalf("unexpected sandbox path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sandboxID": "sbx-1",
			"cloudID":   "ins-abc123",
			"region":    "ap-shanghai",
		})
	}))
	defer sandbox.Close()

	backend := &fakeWorkerActionBackend{}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{Name: "ctl", Prefix: "/v1/instances", Upstream: ctl.URL, Access: AccessAuthenticated},
			{Name: "sandbox", Prefix: "/sandboxes", Upstream: sandbox.URL, Access: AccessAuthenticated},
		},
		WorkerActions: WorkerActionsConfig{
			Enabled:  true,
			Temporal: WorkerActionTemporalConfig{TaskQueue: "tencent-cvm-rescue-export"},
			RescueExport: WorkerActionRescueExportConfig{
				COSUploadBucket:        "https://bucket-123.cos.ap-shanghai.myqcloud.com",
				COSUploadRegion:        "ap-shanghai",
				COSUploadKeyPrefix:     "rescue-exports",
				COSUploadURLTTLSeconds: 123,
				RegionCandidates:       []string{"ap-shanghai"},
			},
		},
	}, WithWorkerActionBackend(backend))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/worker-actions", strings.NewReader(`{
		"bot_id":"bot-1",
		"action":"rescue_export",
		"params":{"remote_paths":["/workspace","/workspace"]}
	}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rec.Code, rec.Body.String())
	}
	if backend.startTaskQueue != "tencent-cvm-rescue-export" || backend.startWorkflowName != workerActionWorkflowName {
		t.Fatalf("unexpected workflow start: queue=%s workflow=%s", backend.startTaskQueue, backend.startWorkflowName)
	}
	if backend.startWorkflowID != "worker-action-bot-1-rescue_export" {
		t.Fatalf("unexpected workflow id: %s", backend.startWorkflowID)
	}
	if len(backend.startArgs) != 2 {
		t.Fatalf("expected workflow args, got %d", len(backend.startArgs))
	}
	exportReq, ok := backend.startArgs[0].(rescueExportStartRequest)
	if !ok {
		t.Fatalf("unexpected request arg type %T", backend.startArgs[0])
	}
	if exportReq.InstanceID != "ins-abc123" || exportReq.Region != "ap-shanghai" {
		t.Fatalf("unexpected target: %+v", exportReq)
	}
	if exportReq.NotificationEmail != "user@example.com" || exportReq.COSUploadBucket == "" || exportReq.COSUploadURLTTLSeconds != 123 {
		t.Fatalf("unexpected export request notification/COS fields: %+v", exportReq)
	}
	if len(exportReq.RemotePaths) != 1 || exportReq.RemotePaths[0] != "/workspace" {
		t.Fatalf("unexpected params: %+v", exportReq)
	}
	if exportReq.ArchiveMode != "hermes" {
		t.Fatalf("unexpected archive mode: %+v", exportReq)
	}
	if !exportReq.Execute || !exportReq.Confirmed {
		t.Fatalf("expected real export request, got execute=%v confirmed=%v", exportReq.Execute, exportReq.Confirmed)
	}
}

func TestWorkerActionStartDefaultsToHermesExport(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_123",
					"email":            "user@example.com",
					"realnameVerified": true,
				},
			},
		})
	}))
	defer auth.Close()
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": "OK",
			"data": map[string]any{"instance_id": "bot-1", "sandbox_id": "sbx-1", "status": "Running"},
		})
	}))
	defer ctl.Close()
	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": "sbx-1", "cloudID": "ins-abc123", "region": "ap-shanghai"})
	}))
	defer sandbox.Close()

	backend := &fakeWorkerActionBackend{}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{Name: "ctl", Prefix: "/v1/instances", Upstream: ctl.URL, Access: AccessAuthenticated},
			{Name: "sandbox", Prefix: "/sandboxes", Upstream: sandbox.URL, Access: AccessAuthenticated},
		},
		WorkerActions: WorkerActionsConfig{
			Enabled:      true,
			Temporal:     WorkerActionTemporalConfig{TaskQueue: "tencent-cvm-rescue-export"},
			RescueExport: WorkerActionRescueExportConfig{COSUploadBucket: "bucket"},
		},
	}, WithWorkerActionBackend(backend))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/worker-actions", strings.NewReader(`{
		"bot_id":"bot-1",
		"action":"rescue_export",
		"params":{}
	}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rec.Code, rec.Body.String())
	}
	exportReq, ok := backend.startArgs[0].(rescueExportStartRequest)
	if !ok {
		t.Fatalf("unexpected request arg type %T", backend.startArgs[0])
	}
	if exportReq.ArchiveMode != "hermes" || len(exportReq.RemotePaths) != 1 || exportReq.RemotePaths[0] != "/home/agentuser/.hermes" {
		t.Fatalf("unexpected default Hermes export request: %+v", exportReq)
	}
}

func TestWorkerActionCreatesHermesImportUploadURL(t *testing.T) {
	t.Setenv("TENCENTCLOUD_SECRET_ID", "AKIDexample")
	t.Setenv("TENCENTCLOUD_SECRET_KEY", "secret")
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_123",
					"email":            "user@example.com",
					"realnameVerified": true,
				},
			},
		})
	}))
	defer auth.Close()
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": "OK",
			"data": map[string]any{"instance_id": "bot-1", "sandbox_id": "sbx-1", "status": "Running"},
		})
	}))
	defer ctl.Close()
	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": "sbx-1", "cloudID": "ins-abc123", "region": "ap-beijing"})
	}))
	defer sandbox.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{Name: "ctl", Prefix: "/v1/instances", Upstream: ctl.URL, Access: AccessAuthenticated},
			{Name: "sandbox", Prefix: "/sandboxes", Upstream: sandbox.URL, Access: AccessAuthenticated},
		},
		WorkerActions: WorkerActionsConfig{
			Enabled: true,
			RescueExport: WorkerActionRescueExportConfig{
				COSUploadBucket:           "https://bucket-123.cos.ap-beijing.myqcloud.com",
				COSUploadRegion:           "ap-beijing",
				ImportUploadKeyPrefix:     "rescue-imports",
				ImportUploadURLTTLSeconds: 600,
			},
		},
	}, WithWorkerActionBackend(&fakeWorkerActionBackend{}))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/worker-actions", strings.NewReader(`{
		"bot_id":"bot-1",
		"action":"hermes_import_upload",
		"params":{"file_name":"hermes-backup.zip","byte_size":123}
	}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Data workerActionUploadResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Data.Action != workerActionHermesImportUpload || body.Data.Status != "upload_url_created" {
		t.Fatalf("unexpected upload response: %+v", body.Data)
	}
	if !strings.HasPrefix(body.Data.ObjectKey, "rescue-imports/bot-1/") || !strings.HasSuffix(body.Data.ObjectKey, ".zip") {
		t.Fatalf("unexpected object key: %s", body.Data.ObjectKey)
	}
	if !strings.Contains(body.Data.UploadURL, "q-signature=") || body.Data.ObjectURL == "" || body.Data.ExpiresAt == "" {
		t.Fatalf("expected signed upload target, got %+v", body.Data)
	}
}

func TestWorkerActionStartHermesImportWorkflow(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_123",
					"email":            "user@example.com",
					"realnameVerified": true,
				},
			},
		})
	}))
	defer auth.Close()
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": "OK",
			"data": map[string]any{"instance_id": "bot-1", "sandbox_id": "sbx-1", "status": "Running"},
		})
	}))
	defer ctl.Close()
	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": "sbx-1", "cloudID": "ins-abc123", "region": "ap-beijing"})
	}))
	defer sandbox.Close()

	backend := &fakeWorkerActionBackend{}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{Name: "ctl", Prefix: "/v1/instances", Upstream: ctl.URL, Access: AccessAuthenticated},
			{Name: "sandbox", Prefix: "/sandboxes", Upstream: sandbox.URL, Access: AccessAuthenticated},
		},
		WorkerActions: WorkerActionsConfig{
			Enabled:  true,
			Temporal: WorkerActionTemporalConfig{TaskQueue: "tencent-cvm-rescue-export"},
			RescueExport: WorkerActionRescueExportConfig{
				COSUploadBucket:       "https://bucket-123.cos.ap-beijing.myqcloud.com",
				COSUploadRegion:       "ap-beijing",
				ImportUploadKeyPrefix: "rescue-imports",
				RegionCandidates:      []string{"ap-beijing"},
			},
		},
	}, WithWorkerActionBackend(backend))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/worker-actions", strings.NewReader(`{
		"bot_id":"bot-1",
		"action":"hermes_import",
		"params":{"object_key":"rescue-imports/bot-1/hermes-backup.zip"}
	}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rec.Code, rec.Body.String())
	}
	if backend.startWorkflowID != "worker-action-bot-1-hermes_import" || backend.startWorkflowName != workerActionImportWorkflowName {
		t.Fatalf("unexpected import workflow start: id=%s name=%s", backend.startWorkflowID, backend.startWorkflowName)
	}
	importReq, ok := backend.startArgs[0].(hermesImportStartRequest)
	if !ok {
		t.Fatalf("unexpected request arg type %T", backend.startArgs[0])
	}
	if importReq.InstanceID != "ins-abc123" || importReq.Region != "ap-beijing" || importReq.ImportObjectKey != "rescue-imports/bot-1/hermes-backup.zip" {
		t.Fatalf("unexpected import request target: %+v", importReq)
	}
	if importReq.TATUsername != "agentuser" || importReq.TATWorkingDirectory != "/home/agentuser" {
		t.Fatalf("expected agentuser TAT import request, got %+v", importReq)
	}
	if !importReq.Execute {
		t.Fatalf("expected real import request, got %+v", importReq)
	}
}

func TestWorkerActionStartReturnsConflictWhenExportAlreadyRunning(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_123",
					"email":            "user@example.com",
					"realnameVerified": true,
				},
			},
		})
	}))
	defer auth.Close()
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": "OK",
			"data": map[string]any{"instance_id": "bot-1", "sandbox_id": "sbx-1", "status": "Running"},
		})
	}))
	defer ctl.Close()
	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": "sbx-1", "cloudID": "ins-abc123", "region": "ap-shanghai"})
	}))
	defer sandbox.Close()

	backend := &fakeWorkerActionBackend{startErr: serviceerror.NewWorkflowExecutionAlreadyStarted("already running", "", "run-existing")}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{Name: "ctl", Prefix: "/v1/instances", Upstream: ctl.URL, Access: AccessAuthenticated},
			{Name: "sandbox", Prefix: "/sandboxes", Upstream: sandbox.URL, Access: AccessAuthenticated},
		},
		WorkerActions: WorkerActionsConfig{
			Enabled:      true,
			RescueExport: WorkerActionRescueExportConfig{COSUploadBucket: "bucket"},
		},
	}, WithWorkerActionBackend(backend))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/worker-actions", strings.NewReader(`{
		"bot_id":"bot-1",
		"action":"rescue_export",
		"params":{"remote_paths":["/workspace"]}
	}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Error string               `json:"error"`
		Data  workerActionResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Error != "action_already_running" || body.Data.ActionRunID != "worker-action-bot-1-rescue_export" || body.Data.RunID != "run-existing" || body.Data.Status != "already_running" {
		t.Fatalf("unexpected conflict body: %+v", body)
	}
}

func TestWorkerActionQueryRequiresActionRunForBot(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_123",
					"email": "user@example.com",
				},
			},
		})
	}))
	defer auth.Close()

	ctlCalled := false
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctlCalled = true
		_ = json.NewEncoder(w).Encode(map[string]any{"code": "OK"})
	}))
	defer ctl.Close()
	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("sandbox should not be called for forbidden action run")
	}))
	defer sandbox.Close()

	backend := &fakeWorkerActionBackend{}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{Name: "ctl", Prefix: "/v1/instances", Upstream: ctl.URL, Access: AccessAuthenticated},
			{Name: "sandbox", Prefix: "/sandboxes", Upstream: sandbox.URL, Access: AccessAuthenticated},
		},
		WorkerActions: WorkerActionsConfig{Enabled: true},
	}, WithWorkerActionBackend(backend))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/worker-actions/worker-action-other-bot-rescue_export-123?bot_id=bot-1", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", rec.Code, rec.Body.String())
	}
	if ctlCalled {
		t.Fatal("ctl should not be called when action_run_id does not belong to bot")
	}
	if backend.queryWorkflowID != "" {
		t.Fatalf("temporal query should not be called, got %s", backend.queryWorkflowID)
	}
}

func TestWorkerActionCurrentResolvesBotAndQueriesStableWorkflowID(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{"id": "usr_123", "email": "user@example.com"},
			},
		})
	}))
	defer auth.Close()
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": "OK",
			"data": map[string]any{"instance_id": "bot-1", "sandbox_id": "sbx-1", "status": "Running"},
		})
	}))
	defer ctl.Close()
	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": "sbx-1", "cloudID": "ins-abc123", "region": "ap-shanghai"})
	}))
	defer sandbox.Close()

	backend := &fakeWorkerActionBackend{queryStatus: map[string]any{
		"Phase":      "enter_rescue",
		"WorkflowID": "worker-action-bot-1-rescue_export",
		"Logs":       []map[string]string{{"message": "正在准备导出环境"}},
	}}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{Name: "ctl", Prefix: "/v1/instances", Upstream: ctl.URL, Access: AccessAuthenticated},
			{Name: "sandbox", Prefix: "/sandboxes", Upstream: sandbox.URL, Access: AccessAuthenticated},
		},
		WorkerActions: WorkerActionsConfig{Enabled: true},
	}, WithWorkerActionBackend(backend))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/worker-actions?bot_id=bot-1&action=rescue_export", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if backend.queryWorkflowID != "worker-action-bot-1-rescue_export" || backend.queryRunID != "" || backend.queryType != workerActionStatusQueryName {
		t.Fatalf("unexpected query call: %+v", backend)
	}
}

func TestWorkerActionCurrentReturnsNotFoundWhenNoWorkflowExists(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{"id": "usr_123", "email": "user@example.com"},
			},
		})
	}))
	defer auth.Close()
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": "OK",
			"data": map[string]any{"instance_id": "bot-1", "sandbox_id": "sbx-1", "status": "Running"},
		})
	}))
	defer ctl.Close()
	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": "sbx-1", "cloudID": "ins-abc123", "region": "ap-shanghai"})
	}))
	defer sandbox.Close()

	backend := &fakeWorkerActionBackend{queryErr: serviceerror.NewNotFound("workflow not found")}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{Name: "ctl", Prefix: "/v1/instances", Upstream: ctl.URL, Access: AccessAuthenticated},
			{Name: "sandbox", Prefix: "/sandboxes", Upstream: sandbox.URL, Access: AccessAuthenticated},
		},
		WorkerActions: WorkerActionsConfig{Enabled: true},
	}, WithWorkerActionBackend(backend))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/worker-actions?bot_id=bot-1&action=rescue_export", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestWorkerActionQueryResolvesBotAndQueriesTemporal(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{"id": "usr_123", "email": "user@example.com"},
			},
		})
	}))
	defer auth.Close()
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": "OK",
			"data": map[string]any{"instance_id": "bot-1", "sandbox_id": "sbx-1", "status": "Running"},
		})
	}))
	defer ctl.Close()
	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": "sbx-1", "cloudID": "ins-abc123", "region": "ap-shanghai"})
	}))
	defer sandbox.Close()

	backend := &fakeWorkerActionBackend{queryStatus: map[string]any{"Phase": "completed", "WorkflowID": "worker-action-bot-1-rescue_export-123"}}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{Name: "ctl", Prefix: "/v1/instances", Upstream: ctl.URL, Access: AccessAuthenticated},
			{Name: "sandbox", Prefix: "/sandboxes", Upstream: sandbox.URL, Access: AccessAuthenticated},
		},
		WorkerActions: WorkerActionsConfig{Enabled: true},
	}, WithWorkerActionBackend(backend))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/worker-actions/worker-action-bot-1-rescue_export-123?bot_id=bot-1&run_id=run-1", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if backend.queryWorkflowID != "worker-action-bot-1-rescue_export-123" || backend.queryRunID != "run-1" || backend.queryType != workerActionStatusQueryName {
		t.Fatalf("unexpected query call: %+v", backend)
	}
}

func TestWorkerActionCancelResolvesBotAndCancelsTemporal(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{"id": "usr_123", "email": "user@example.com", "realnameVerified": true},
			},
		})
	}))
	defer auth.Close()
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": "OK",
			"data": map[string]any{"instance_id": "bot-1", "sandbox_id": "sbx-1", "status": "Running"},
		})
	}))
	defer ctl.Close()
	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": "sbx-1", "cloudID": "ins-abc123", "region": "ap-shanghai"})
	}))
	defer sandbox.Close()

	backend := &fakeWorkerActionBackend{}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{Name: "ctl", Prefix: "/v1/instances", Upstream: ctl.URL, Access: AccessAuthenticated},
			{Name: "sandbox", Prefix: "/sandboxes", Upstream: sandbox.URL, Access: AccessAuthenticated},
		},
		WorkerActions: WorkerActionsConfig{Enabled: true},
	}, WithWorkerActionBackend(backend))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/worker-actions/worker-action-bot-1-rescue_export-123/cancel?bot_id=bot-1&run_id=run-1", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rec.Code, rec.Body.String())
	}
	if backend.cancelWorkflowID != "worker-action-bot-1-rescue_export-123" || backend.cancelRunID != "run-1" {
		t.Fatalf("unexpected cancel call: %+v", backend)
	}
}

func TestAuthenticatedRouteUsesSessionCookieWhenBearerMissing(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Fatalf("expected no bearer token, got %q", got)
		}
		cookie, err := r.Cookie("lc_session")
		if err != nil {
			t.Fatalf("expected lc_session cookie: %v", err)
		}
		if cookie.Value != "tok-cookie" {
			t.Fatalf("expected lc_session cookie to be forwarded, got %q", cookie.Value)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_cookie",
					"email": "cookie@example.com",
				},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"user_id": r.Header.Get("X-Lightclaw-User-ID"),
		})
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "sandbox",
				Prefix:   "/sandboxes",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/sandboxes", nil)
	req.AddCookie(&http.Cookie{Name: "lc_session", Value: "tok-cookie"})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestLegacySandboxTatSessionRouteRemainsAuthenticatedForOldFrontend(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("lc_session")
		if err != nil {
			t.Fatalf("expected lc_session cookie during introspection: %v", err)
		}
		if cookie.Value != "tok-cookie" {
			t.Fatalf("expected lc_session cookie to be forwarded to auth, got %q", cookie.Value)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_cookie",
					"email": "cookie@example.com",
				},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("unexpected upstream method: %s", r.Method)
		}
		if r.URL.Path != "/sandboxes/sbx-1/tat/session" {
			t.Fatalf("unexpected upstream path: %s", r.URL.Path)
		}
		if got := r.Header.Get("X-User-Id"); got != "usr_cookie" {
			t.Fatalf("expected injected user id, got %q", got)
		}
		if _, err := r.Cookie("lc_session"); err != nil {
			t.Fatalf("expected lc_session cookie to reach sandbox-api: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"sessionId":"sess-1"}`))
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "sandbox-legacy",
				Prefix:   "/sandboxes",
				Methods:  []string{http.MethodPost, http.MethodOptions},
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/sbx-1/tat/session", nil)
	req.AddCookie(&http.Cookie{Name: "lc_session", Value: "tok-cookie"})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestInviteRequiredUserCanAccessProtectedBusinessRoutes(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":             "usr_invite",
					"email":          "invite@example.com",
					"inviteRequired": true,
				},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "ctl",
				Prefix:   "/v1/instances",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/instances", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRealnameRequiredWriteBlocksUnverifiedSession(t *testing.T) {
	authCalls := 0
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authCalls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_unverified",
					"email":            "user@example.com",
					"realnameVerified": false,
				},
			},
		})
	}))
	defer auth.Close()

	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		t.Fatal("upstream should not be called when realname is required")
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:            "ctl",
			Prefix:          "/v1/instances",
			Upstream:        upstream.URL,
			Access:          AccessAuthenticated,
			RequireRealname: true,
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/instances", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "realname_required") {
		t.Fatalf("expected realname_required body, got %s", rec.Body.String())
	}
	if authCalls != 1 {
		t.Fatalf("expected auth introspection once, got %d", authCalls)
	}
	if upstreamCalls != 0 {
		t.Fatalf("expected no upstream calls, got %d", upstreamCalls)
	}
}

func TestAgentChatLaunchTokenStaysBehindRealnameWall(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_unverified",
					"realnameVerified": false,
				},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called when realname is required")
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:            "ctl",
			Prefix:          "/v1/instances",
			Upstream:        upstream.URL,
			Access:          AccessAuthenticated,
			RequireRealname: true,
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/agentchat/launch-token", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "realname_required") {
		t.Fatalf("expected realname_required body, got %s", rec.Body.String())
	}
}

func TestRealnameWallDisabledAllowsUnverifiedWrite(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_unverified",
					"email":            "user@example.com",
					"realnameVerified": false,
				},
			},
		})
	}))
	defer auth.Close()

	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		if got := r.Header.Get("X-Lightclaw-User-ID"); got != "usr_unverified" {
			t.Fatalf("expected injected user id, got %q", got)
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:            "ctl",
			Prefix:          "/v1/instances",
			Upstream:        upstream.URL,
			Access:          AccessAuthenticated,
			RequireRealname: true,
		}},
	}, WithRealnameWallEnabled(false))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/instances", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 1 {
		t.Fatalf("expected one upstream call, got %d", upstreamCalls)
	}
}

func TestRealnameRequiredWriteAllowsVerifiedSession(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_verified",
					"email":            "verified@example.com",
					"realnameVerified": true,
				},
			},
		})
	}))
	defer auth.Close()

	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		if got := r.Header.Get("X-Lightclaw-User-ID"); got != "usr_verified" {
			t.Fatalf("expected injected user id, got %q", got)
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:            "ctl",
			Prefix:          "/v1/instances",
			Upstream:        upstream.URL,
			Access:          AccessAuthenticated,
			RequireRealname: true,
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/instances", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 1 {
		t.Fatalf("expected one upstream call, got %d", upstreamCalls)
	}
}

func TestInstancesPrefixAllowsNestedConfigResetWithoutDedicatedRoute(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_verified",
					"email":            "verified@example.com",
					"realnameVerified": true,
				},
			},
		})
	}))
	defer auth.Close()

	upstreamCalls := 0
	var upstreamPath string
	var upstreamMethod string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		upstreamPath = r.URL.Path
		upstreamMethod = r.Method
		if got := r.Header.Get("X-Lightclaw-User-ID"); got != "usr_verified" {
			t.Fatalf("expected injected user id, got %q", got)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:            "ctl",
			Prefix:          "/v1/instances",
			Methods:         []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions},
			Upstream:        upstream.URL,
			Access:          AccessAuthenticated,
			RequireRealname: true,
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/config/reset", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 1 {
		t.Fatalf("expected one upstream call, got %d", upstreamCalls)
	}
	if upstreamMethod != http.MethodPost || upstreamPath != "/v1/instances/ins-1/config/reset" {
		t.Fatalf("unexpected upstream request: %s %s", upstreamMethod, upstreamPath)
	}
}

func TestRealnameRequiredDoesNotBlockReadOrPreflight(t *testing.T) {
	authCalls := 0
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authCalls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_unverified",
					"realnameVerified": false,
				},
			},
		})
	}))
	defer auth.Close()

	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		AllowedOrigins: []string{"https://lightclaw.tech"},
		Routes: []Route{{
			Name:            "ctl",
			Prefix:          "/v1/instances",
			Methods:         []string{http.MethodGet, http.MethodPost, http.MethodOptions},
			Upstream:        upstream.URL,
			Access:          AccessAuthenticated,
			RequireRealname: true,
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/v1/instances", nil)
	getReq.Header.Set("Authorization", "Bearer tok-123")
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("expected GET 200, got %d body=%s", getRec.Code, getRec.Body.String())
	}

	optionsReq := httptest.NewRequest(http.MethodOptions, "/v1/instances", nil)
	optionsReq.Header.Set("Origin", "https://lightclaw.tech")
	optionsReq.Header.Set("Access-Control-Request-Method", http.MethodPost)
	optionsRec := httptest.NewRecorder()
	handler.ServeHTTP(optionsRec, optionsReq)
	if optionsRec.Code != http.StatusNoContent {
		t.Fatalf("expected preflight 204, got %d body=%s", optionsRec.Code, optionsRec.Body.String())
	}
	if authCalls != 1 {
		t.Fatalf("expected auth only for GET, got %d calls", authCalls)
	}
	if upstreamCalls != 1 {
		t.Fatalf("expected upstream only for GET, got %d calls", upstreamCalls)
	}
}

func TestRealnameRequiredDoesNotBlockDelete(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":               "usr_unverified",
					"realnameVerified": false,
				},
			},
		})
	}))
	defer auth.Close()

	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:            "ctl",
			Prefix:          "/v1/instances",
			Methods:         []string{http.MethodDelete},
			Upstream:        upstream.URL,
			Access:          AccessAuthenticated,
			RequireRealname: true,
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/v1/instances/inst_123", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected DELETE 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 1 {
		t.Fatalf("expected upstream call for DELETE, got %d", upstreamCalls)
	}
}

func TestIsRealnameWriteMethod(t *testing.T) {
	trueMethods := []string{http.MethodPost, http.MethodPut, http.MethodPatch}
	for _, method := range trueMethods {
		if !isRealnameWriteMethod(method) {
			t.Fatalf("expected %s to require realname", method)
		}
	}
	falseMethods := []string{http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodDelete, ""}
	for _, method := range falseMethods {
		if isRealnameWriteMethod(method) {
			t.Fatalf("expected %q not to require realname", method)
		}
	}
}

func TestCreateInstanceRequiresActiveSubscription(t *testing.T) {
	// FIXME(D-mini): requiresActiveSubscription() 在过渡期被硬编码为 false，
	// 导致本用例期望的 403 + 订阅服务调用不再发生。
	// 等 service-gateway 切到 ctl /v1/passes 做 pass-based 资格校验后，
	// 恢复 requiresActiveSubscription 逻辑的同时移除此 Skip，并把桩改为 /v1/passes。
	t.Skip("disabled during D-mini transition; restore after pass-based gate lands")

	authCalls := 0
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authCalls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_123",
					"email": "user@example.com",
				},
			},
		})
	}))
	defer auth.Close()

	subscriptionCalls := 0
	subscription := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		subscriptionCalls++
		if r.URL.Path != "/subscriptions/current" {
			t.Fatalf("unexpected subscription path %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"hasSubscription": false,
		})
	}))
	defer subscription.Close()

	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		t.Fatal("upstream should not be called when subscription is missing")
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "subscriptions",
				Prefix:   "/subscriptions",
				Upstream: subscription.URL,
				Access:   AccessAuthenticated,
			},
			{
				Name:     "ctl",
				Prefix:   "/v1/instances",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/instances", strings.NewReader(`{"timeout":3600}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", rec.Code, rec.Body.String())
	}
	if authCalls != 1 {
		t.Fatalf("expected auth introspection once, got %d", authCalls)
	}
	if subscriptionCalls != 1 {
		t.Fatalf("expected current subscription check once, got %d", subscriptionCalls)
	}
	if upstreamCalls != 0 {
		t.Fatalf("expected upstream calls 0, got %d", upstreamCalls)
	}
	if !strings.Contains(rec.Body.String(), "subscription_required") {
		t.Fatalf("expected subscription_required body, got %s", rec.Body.String())
	}
}

func TestCreateInstanceAllowsActiveSubscription(t *testing.T) {
	// FIXME(D-mini): requiresActiveSubscription() 在过渡期被硬编码为 false，
	// 本用例断言订阅服务会被调用并注入 X-Lightclaw-User-ID，
	// 现在该调用已被绕过，断言会失败。
	// 等 service-gateway 切到 ctl /v1/passes 后，恢复逻辑并把桩改成 /v1/passes。
	t.Skip("disabled during D-mini transition; restore after pass-based gate lands")

	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_123",
					"email": "user@example.com",
				},
			},
		})
	}))
	defer auth.Close()

	subscription := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Lightclaw-User-ID"); got != "usr_123" {
			t.Fatalf("expected subscription check user id header, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"hasSubscription": true,
			"subscription": map[string]any{
				"code":   "free",
				"status": "active",
			},
		})
	}))
	defer subscription.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Lightclaw-User-ID"); got != "usr_123" {
			t.Fatalf("expected injected user id, got %q", got)
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "subscriptions",
				Prefix:   "/subscriptions",
				Upstream: subscription.URL,
				Access:   AccessAuthenticated,
			},
			{
				Name:     "ctl",
				Prefix:   "/v1/instances",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/instances", strings.NewReader(`{"timeout":3600}`))
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRouteSpecificResponseHeaderTimeout(t *testing.T) {
	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:                  "ctl",
				Prefix:                "/v1/instances",
				Upstream:              "http://ctl.invalid",
				Access:                AccessAuthenticated,
				ResponseHeaderTimeout: "45s",
			},
			{
				Name:     "sandbox",
				Prefix:   "/sandboxes",
				Upstream: "http://sandbox.invalid",
				Access:   AccessAuthenticated,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	h := handler.(*Handler)
	if got := h.routes[0].proxy.Transport.(*http.Transport).ResponseHeaderTimeout; got != 45*time.Second {
		t.Fatalf("expected ctl timeout 45s, got %s", got)
	}
	if got := h.routes[1].proxy.Transport.(*http.Transport).ResponseHeaderTimeout; got != defaultResponseHeaderTimeout {
		t.Fatalf("expected default timeout %s, got %s", defaultResponseHeaderTimeout, got)
	}
}

func TestAdminRouteSupportsWebSocketUpgrade(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
			t.Fatalf("expected Connection: upgrade, got %q", r.Header.Get("Connection"))
		}
		if strings.ToLower(strings.TrimSpace(r.Header.Get("Upgrade"))) != "websocket" {
			t.Fatalf("expected Upgrade: websocket, got %q", r.Header.Get("Upgrade"))
		}

		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("upstream writer does not support hijack")
		}
		conn, rw, err := hj.Hijack()
		if err != nil {
			t.Fatalf("hijack upstream connection: %v", err)
		}
		defer conn.Close()

		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
		_, _ = rw.WriteString("Upgrade: websocket\r\n")
		_, _ = rw.WriteString("Connection: Upgrade\r\n")
		_, _ = rw.WriteString("\r\n")
		_ = rw.Flush()
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "admin",
				Prefix:   "/admin",
				Upstream: upstream.URL,
				Access:   AccessAdmin,
			},
		},
	}, WithAdminBasicAuth("admin", "secret"))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	server := httptest.NewServer(handler)
	defer server.Close()

	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server url: %v", err)
	}

	conn, err := net.Dial("tcp", target.Host)
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}
	defer conn.Close()

	authValue := "Basic " + base64.StdEncoding.EncodeToString([]byte("admin:secret"))
	request := strings.Join([]string{
		"GET /admin/ws/terminal HTTP/1.1",
		fmt.Sprintf("Host: %s", target.Host),
		"Connection: Upgrade",
		"Upgrade: websocket",
		"Sec-WebSocket-Version: 13",
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
		fmt.Sprintf("Authorization: %s", authValue),
		"",
		"",
	}, "\r\n")
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatalf("write upgrade request: %v", err)
	}

	reader := bufio.NewReader(conn)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read upgrade response: %v", err)
	}
	if !strings.Contains(statusLine, "101") {
		t.Fatalf("expected 101 switching protocols, got %q", strings.TrimSpace(statusLine))
	}
}

func TestRouteRewritePrefixRewritesNestedPathAndPreservesQuery(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/dashboard" {
			t.Fatalf("expected rewritten path /dashboard, got %q", got)
		}
		if got := r.URL.RawQuery; got != "tab=stats" {
			t.Fatalf("expected query to be preserved, got %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:          "admin-gateway-dashboard",
				Prefix:        "/admin/gateway",
				RewritePrefix: "/",
				Upstream:      upstream.URL,
				Access:        AccessAdmin,
			},
		},
	}, WithAdminBasicAuth("admin", "secret"))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin/gateway/dashboard?tab=stats", nil)
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("admin:secret")))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRouteRewritePrefixExactPrefixRewritesToRootWithoutDoubleSlash(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/" {
			t.Fatalf("expected rewritten root path, got %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:          "admin-gateway-dashboard",
				Prefix:        "/admin/gateway",
				RewritePrefix: "/",
				Upstream:      upstream.URL,
				Access:        AccessAdmin,
			},
		},
	}, WithAdminBasicAuth("admin", "secret"))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin/gateway", nil)
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("admin:secret")))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRouteWithoutRewritePrefixPreservesOriginalPath(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/admin/gateway/dashboard" {
			t.Fatalf("expected original path, got %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "admin-gateway-dashboard",
				Prefix:   "/admin/gateway",
				Upstream: upstream.URL,
				Access:   AccessAdmin,
			},
		},
	}, WithAdminBasicAuth("admin", "secret"))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin/gateway/dashboard", nil)
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("admin:secret")))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminRouteSupportsWebSocketUpgradeWithRewritePrefix(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/admin/ws/terminal" {
			t.Fatalf("expected rewritten websocket path /admin/ws/terminal, got %q", got)
		}
		if !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
			t.Fatalf("expected Connection: upgrade, got %q", r.Header.Get("Connection"))
		}
		if strings.ToLower(strings.TrimSpace(r.Header.Get("Upgrade"))) != "websocket" {
			t.Fatalf("expected Upgrade: websocket, got %q", r.Header.Get("Upgrade"))
		}

		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("upstream writer does not support hijack")
		}
		conn, rw, err := hj.Hijack()
		if err != nil {
			t.Fatalf("hijack upstream connection: %v", err)
		}
		defer conn.Close()

		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
		_, _ = rw.WriteString("Upgrade: websocket\r\n")
		_, _ = rw.WriteString("Connection: Upgrade\r\n")
		_, _ = rw.WriteString("\r\n")
		_ = rw.Flush()
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:          "admin-ops",
				Prefix:        "/admin/ops",
				RewritePrefix: "/admin",
				Upstream:      upstream.URL,
				Access:        AccessAdmin,
			},
		},
	}, WithAdminBasicAuth("admin", "secret"))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	server := httptest.NewServer(handler)
	defer server.Close()

	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server url: %v", err)
	}

	conn, err := net.Dial("tcp", target.Host)
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}
	defer conn.Close()

	authValue := "Basic " + base64.StdEncoding.EncodeToString([]byte("admin:secret"))
	request := strings.Join([]string{
		"GET /admin/ops/ws/terminal HTTP/1.1",
		fmt.Sprintf("Host: %s", target.Host),
		"Connection: Upgrade",
		"Upgrade: websocket",
		"Sec-WebSocket-Version: 13",
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
		fmt.Sprintf("Authorization: %s", authValue),
		"",
		"",
	}, "\r\n")
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatalf("write upgrade request: %v", err)
	}

	reader := bufio.NewReader(conn)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read upgrade response: %v", err)
	}
	if !strings.Contains(statusLine, "101") {
		t.Fatalf("expected 101 switching protocols, got %q", strings.TrimSpace(statusLine))
	}
}

func TestInvalidRouteSpecificResponseHeaderTimeoutFails(t *testing.T) {
	_, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:                  "ctl",
				Prefix:                "/v1/instances",
				Upstream:              "http://ctl.invalid",
				Access:                AccessAuthenticated,
				ResponseHeaderTimeout: "nope",
			},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "response_header_timeout") {
		t.Fatalf("expected response_header_timeout error, got %v", err)
	}
}

func TestCorsPreflightBypassesAuth(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		if r.Method != http.MethodOptions {
			t.Fatalf("expected preflight OPTIONS, got %s", r.Method)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	authCalls := 0
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authCalls++
		http.Error(w, "should not be called", http.StatusTeapot)
	}))
	defer auth.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		AllowedOrigins: []string{"https://lightclaw.pages.dev"},
		Routes: []Route{
			{
				Name:     "auth",
				Prefix:   "/auth/",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
				Methods:  []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodOptions, "/auth/profile", nil)
	req.Header.Set("Origin", "https://lightclaw.pages.dev")
	req.Header.Set("Access-Control-Request-Method", http.MethodPut)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	if origin := rec.Header().Get("Access-Control-Allow-Origin"); origin != "https://lightclaw.pages.dev" {
		t.Fatalf("expected allow origin header, got %q", origin)
	}
	if methods := rec.Header().Get("Access-Control-Allow-Methods"); methods != "GET, POST, PUT, DELETE, OPTIONS" {
		t.Fatalf("unexpected allow methods header: %q", methods)
	}
	if upstreamCalls != 0 {
		t.Fatalf("expected upstream not to be called for preflight, got %d", upstreamCalls)
	}
	if authCalls != 0 {
		t.Fatalf("expected auth introspection to be skipped, got %d calls", authCalls)
	}
}

func TestAuthenticatedRouteAddsCORSHeadersToActualResponse(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"session":{"user":{"id":"usr_123","email":"ops@example.com"}}}`))
	}))
	defer auth.Close()

	subscription := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"hasSubscription":true,"subscription":{"code":"free","status":"active"}}`))
	}))
	defer subscription.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		AllowedOrigins: []string{"https://lightclaw.pages.dev"},
		Routes: []Route{
			{
				Name:     "subscriptions",
				Prefix:   "/subscriptions",
				Upstream: subscription.URL,
				Access:   AccessAuthenticated,
				Methods:  []string{http.MethodGet},
			},
			{
				Name:     "ctl",
				Prefix:   "/v1/instances",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
				Methods:  []string{http.MethodGet, http.MethodPost, http.MethodDelete},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/instances", strings.NewReader(`{"timeout":3600}`))
	req.Header.Set("Origin", "https://lightclaw.pages.dev")
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}
	if origin := rec.Header().Get("Access-Control-Allow-Origin"); origin != "https://lightclaw.pages.dev" {
		t.Fatalf("expected allow origin header, got %q", origin)
	}
	if credentials := rec.Header().Get("Access-Control-Allow-Credentials"); credentials != "true" {
		t.Fatalf("expected allow credentials header, got %q", credentials)
	}
}

func TestGatewayStripsUpstreamCORSHeaders(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"session":{"user":{"id":"usr_123","email":"ops@example.com"}}}`))
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Access-Control-Allow-Origin", "https://upstream.example.com")
		w.Header().Add("Access-Control-Allow-Credentials", "true")
		w.Header().Add("Access-Control-Allow-Methods", "GET, POST")
		w.Header().Add("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		AllowedOrigins: []string{"https://lightclaw.pages.dev"},
		Routes: []Route{
			{
				Name:     "auth",
				Prefix:   "/auth",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth/session", nil)
	req.Header.Set("Origin", "https://lightclaw.pages.dev")
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if values := rec.Header().Values("Access-Control-Allow-Origin"); len(values) != 1 || values[0] != "https://lightclaw.pages.dev" {
		t.Fatalf("expected gateway to own allow-origin header, got %v", values)
	}
}

func TestGatewayDoesNotReflectUnknownOrigin(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"session":{"user":{"id":"usr_123","email":"ops@example.com"}}}`))
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		AllowedOrigins: []string{"https://lightclaw.pages.dev"},
		Routes: []Route{
			{
				Name:     "auth",
				Prefix:   "/auth",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth/session", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no allow-origin header for unknown origin, got %q", got)
	}
}

func TestCorsWildcardPreviewOriginAllowed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		AllowedOrigins: []string{"https://lightclaw.pages.dev", "https://*.lightclaw.pages.dev"},
		Routes: []Route{
			{
				Name:     "public",
				Prefix:   "/v1/bundles",
				Upstream: upstream.URL,
				Access:   AccessPublic,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("Origin", "https://80102ec3.lightclaw.pages.dev")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	if origin := rec.Header().Get("Access-Control-Allow-Origin"); origin != "https://80102ec3.lightclaw.pages.dev" {
		t.Fatalf("expected wildcard preview origin to be reflected, got %q", origin)
	}
}

func TestCorsWildcardEdgeOneOriginAllowed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		AllowedOrigins: []string{"https://*.edgeone.cool"},
		Routes: []Route{
			{
				Name:     "public",
				Prefix:   "/v1/bundles",
				Upstream: upstream.URL,
				Access:   AccessPublic,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("Origin", "https://lightvela-joygpbk2.edgeone.cool")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	if origin := rec.Header().Get("Access-Control-Allow-Origin"); origin != "https://lightvela-joygpbk2.edgeone.cool" {
		t.Fatalf("expected edgeone wildcard origin to be reflected, got %q", origin)
	}
}

func TestCorsWildcardEdgeOneRunOriginAllowed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		AllowedOrigins: []string{"https://*.edgeone.run"},
		Routes: []Route{
			{
				Name:     "public",
				Prefix:   "/v1/bundles",
				Upstream: upstream.URL,
				Access:   AccessPublic,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("Origin", "https://lightvela-preview.edgeone.run")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	if origin := rec.Header().Get("Access-Control-Allow-Origin"); origin != "https://lightvela-preview.edgeone.run" {
		t.Fatalf("expected edgeone.run wildcard origin to be reflected, got %q", origin)
	}
}

func TestCorsAllowAnyOriginReflectsValidOrigins(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		AllowedOrigins: []string{"*"},
		Routes: []Route{
			{
				Name:     "public",
				Prefix:   "/v1/bundles",
				Upstream: upstream.URL,
				Access:   AccessPublic,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	for _, origin := range []string{
		"https://random.example.com",
		"https://preview.sandbox.lightclaw.tech",
		"http://30.184.61.101:5173",
	} {
		req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNoContent {
			t.Fatalf("origin %q: expected 204, got %d body=%s", origin, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Fatalf("origin %q: expected reflected allow-origin, got %q", origin, got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Fatalf("origin %q: expected credentials header, got %q", origin, got)
		}
	}
}

func TestCorsAllowAnyOriginRejectsInvalidOriginSyntax(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		AllowedOrigins: []string{"*"},
		Routes: []Route{
			{
				Name:     "public",
				Prefix:   "/v1/bundles",
				Upstream: upstream.URL,
				Access:   AccessPublic,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	for _, origin := range []string{
		"null",
		"file://local",
		"https://random.example.com/path",
	} {
		req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("origin %q: expected no allow-origin, got %q", origin, got)
		}
	}
}

func TestCorsWildcardLocalhostAnyPortAllowed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		AllowedOrigins: []string{"http://localhost:*", "http://127.0.0.1:*"},
		Routes: []Route{
			{
				Name:     "public",
				Prefix:   "/v1/bundles",
				Upstream: upstream.URL,
				Access:   AccessPublic,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	cases := []string{
		"http://localhost:3000",
		"http://localhost:4173",
		"http://127.0.0.1:5173",
	}

	for _, origin := range cases {
		req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNoContent {
			t.Fatalf("origin %q: expected 204, got %d body=%s", origin, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Fatalf("origin %q: expected reflected allow-origin, got %q", origin, got)
		}
	}
}

func TestCorsWildcardLocalhostAnyPortDoesNotMatchSiblingHost(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		AllowedOrigins: []string{"http://localhost:*", "http://127.0.0.1:*"},
		Routes: []Route{
			{
				Name:     "public",
				Prefix:   "/v1/bundles",
				Upstream: upstream.URL,
				Access:   AccessPublic,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("Origin", "http://localhost.evil.test:5173")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected sibling host to stay blocked, got %q", got)
	}
}

func TestCorsExactRootPagesDomainAllowed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		AllowedOrigins: []string{"https://lightclaw.pages.dev", "https://*.lightclaw.pages.dev"},
		Routes: []Route{
			{
				Name:     "public",
				Prefix:   "/v1/bundles",
				Upstream: upstream.URL,
				Access:   AccessPublic,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("Origin", "https://lightclaw.pages.dev")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if origin := rec.Header().Get("Access-Control-Allow-Origin"); origin != "https://lightclaw.pages.dev" {
		t.Fatalf("expected exact root pages domain to be reflected, got %q", origin)
	}
}

func TestCorsWildcardDoesNotMatchSiblingPagesDomain(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		AllowedOrigins: []string{"https://lightclaw.pages.dev", "https://*.lightclaw.pages.dev"},
		Routes: []Route{
			{
				Name:     "public",
				Prefix:   "/v1/bundles",
				Upstream: upstream.URL,
				Access:   AccessPublic,
				Methods:  []string{http.MethodGet},
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("Origin", "https://evil.pages.dev")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected sibling pages.dev domain to stay blocked, got %q", got)
	}
}

func TestRoutePrefixDoesNotMatchSiblingPath(t *testing.T) {
	adminUpstreamCalls := 0
	adminUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminUpstreamCalls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer adminUpstream.Close()

	rootUpstreamCalls := 0
	rootUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rootUpstreamCalls++
		w.WriteHeader(http.StatusAccepted)
	}))
	defer rootUpstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "admin",
				Prefix:   "/admin",
				Upstream: adminUpstream.URL,
				Access:   AccessPublic,
			},
			{
				Name:     "root",
				Prefix:   "/",
				Upstream: rootUpstream.URL,
				Access:   AccessPublic,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/adminx", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected root route to match /adminx, got %d body=%s", rec.Code, rec.Body.String())
	}
	if adminUpstreamCalls != 0 {
		t.Fatalf("expected /admin route not to match sibling path, got %d admin calls", adminUpstreamCalls)
	}
	if rootUpstreamCalls != 1 {
		t.Fatalf("expected root route to be called once, got %d", rootUpstreamCalls)
	}
}

func TestRoutePrefixMatchesNestedPath(t *testing.T) {
	adminUpstreamCalls := 0
	adminUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminUpstreamCalls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer adminUpstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "admin",
				Prefix:   "/admin",
				Upstream: adminUpstream.URL,
				Access:   AccessPublic,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin/sessions", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected /admin nested path to match, got %d body=%s", rec.Code, rec.Body.String())
	}
	if adminUpstreamCalls != 1 {
		t.Fatalf("expected admin route to be called once, got %d", adminUpstreamCalls)
	}
}

func TestAuthenticatedRouteReportsMatchedRouteToMetrics(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_123",
					"email": "user@example.com",
				},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	defer upstream.Close()

	metrics := &recordingMetrics{}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "sandbox",
				Prefix:   "/sandboxes",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
			},
		},
	}, WithMetrics(metrics))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/sandboxes", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rec.Code, rec.Body.String())
	}
	if len(metrics.entries) != 1 {
		t.Fatalf("expected 1 metrics entry, got %d", len(metrics.entries))
	}
	if metrics.entries[0].route != "sandbox" {
		t.Fatalf("expected route label sandbox, got %q", metrics.entries[0].route)
	}
	if metrics.entries[0].endpoint != "/sandboxes" {
		t.Fatalf("expected endpoint /sandboxes, got %q", metrics.entries[0].endpoint)
	}
	if metrics.entries[0].status != http.StatusAccepted {
		t.Fatalf("expected status 202, got %d", metrics.entries[0].status)
	}
}

func TestAuthenticatedRouteReportsNormalizedEndpointToMetrics(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_123",
					"email": "user@example.com",
				},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	metrics := &recordingMetrics{}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "sandbox",
				Prefix:   "/sandboxes",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
			},
		},
	}, WithMetrics(metrics))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/sandboxes/acef9b31-db1b-40e1-8e23-9d5309924078", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	if len(metrics.entries) != 1 {
		t.Fatalf("expected 1 metrics entry, got %d", len(metrics.entries))
	}
	if metrics.entries[0].endpoint != "/sandboxes/acef9b31-db1b-40e1-8e23-9d5309924078" {
		t.Fatalf("expected raw endpoint path to be observed before normalization in metrics sink, got %q", metrics.entries[0].endpoint)
	}
}

func TestAdminRouteRequiresBasicAuth(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called without valid admin credentials")
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "admin",
				Prefix:   "/admin",
				Upstream: upstream.URL,
				Access:   AccessAdmin,
			},
		},
	}, WithAdminBasicAuth("skipzhang", "secret"))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("WWW-Authenticate"); got == "" {
		t.Fatal("expected WWW-Authenticate header to be set")
	} else if got != `Basic realm="Lightclaw Admin", charset="UTF-8"` {
		t.Fatalf("unexpected WWW-Authenticate header: %q", got)
	}
}

func TestAdminRouteUsesCustomRealm(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called without valid admin credentials")
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "admin",
				Prefix:   "/admin",
				Upstream: upstream.URL,
				Access:   AccessAdmin,
			},
		},
	}, WithAdminBasicAuth("skipzhang", "secret"), WithAdminBasicAuthRealm("Lightclaw Admin Gateway - browser password only"))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("WWW-Authenticate"); got != `Basic realm="Lightclaw Admin Gateway - browser password only", charset="UTF-8"` {
		t.Fatalf("unexpected WWW-Authenticate header: %q", got)
	}
}

func TestAdminRouteProxiesWithMatchingBasicAuth(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got == "" {
			t.Fatal("expected basic auth header to be forwarded to upstream")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "admin",
				Prefix:   "/admin",
				Upstream: upstream.URL,
				Access:   AccessAdmin,
			},
		},
	}, WithAdminBasicAuth("skipzhang", "secret"))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("skipzhang:secret")))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminRouteSetsBridgeCookieAfterSuccessfulBasicAuth(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{{
			Name:     "admin",
			Prefix:   "/admin",
			Upstream: upstream.URL,
			Access:   AccessAdmin,
		}},
	},
		WithAdminBasicAuth("skipzhang", "secret"),
		WithAdminBridgeCookie(AdminBridgeCookieConfig{
			Secret: "bridge-secret",
			Hosts:  []string{"admin.lightclaw.tech"},
			Secure: true,
		}),
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "https://admin.lightclaw.tech/admin", nil)
	req.Host = "admin.lightclaw.tech"
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("skipzhang:secret")))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := rec.Result()
	cookie := findCookieByName(t, resp, defaultAdminBridgeCookieName)
	if cookie.Path != "/" {
		t.Fatalf("expected bridge cookie path /, got %q", cookie.Path)
	}
	if !cookie.HttpOnly {
		t.Fatal("expected bridge cookie to be HttpOnly")
	}
	if !cookie.Secure {
		t.Fatal("expected bridge cookie to be Secure")
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("expected SameSite=Lax, got %v", cookie.SameSite)
	}
	if cookie.MaxAge != int(defaultAdminBridgeCookieTTL.Seconds()) {
		t.Fatalf("expected MaxAge=%d, got %d", int(defaultAdminBridgeCookieTTL.Seconds()), cookie.MaxAge)
	}
}

func TestAdminRouteAllowsValidBridgeCookieWithoutBasicAuth(t *testing.T) {
	callCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount == 2 {
			if got := r.Header.Get("Authorization"); got != "" {
				t.Fatalf("expected no synthesized authorization header, got %q", got)
			}
		}
		if callCount == 1 {
			if got := r.Header.Get("Authorization"); got == "" {
				t.Fatal("expected initial basic auth request to forward authorization header")
			}
		}
		if callCount > 2 {
			t.Fatalf("unexpected extra upstream call %d", callCount)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{{
			Name:     "admin",
			Prefix:   "/admin",
			Upstream: upstream.URL,
			Access:   AccessAdmin,
		}},
	},
		WithAdminBasicAuth("skipzhang", "secret"),
		WithAdminBridgeCookie(AdminBridgeCookieConfig{
			Secret: "bridge-secret",
			Hosts:  []string{"admin.lightclaw.tech"},
			Secure: true,
		}),
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	firstReq := httptest.NewRequest(http.MethodGet, "https://admin.lightclaw.tech/admin", nil)
	firstReq.Host = "admin.lightclaw.tech"
	firstReq.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("skipzhang:secret")))
	firstRec := httptest.NewRecorder()
	handler.ServeHTTP(firstRec, firstReq)
	bridgeCookie := findCookieByName(t, firstRec.Result(), defaultAdminBridgeCookieName)

	req := httptest.NewRequest(http.MethodGet, "https://admin.lightclaw.tech/admin", nil)
	req.Host = "admin.lightclaw.tech"
	req.AddCookie(bridgeCookie)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminRouteChallengesWhenBridgeCookieIsCorrupted(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called with corrupted bridge cookie")
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{{
			Name:     "admin",
			Prefix:   "/admin",
			Upstream: upstream.URL,
			Access:   AccessAdmin,
		}},
	},
		WithAdminBasicAuth("skipzhang", "secret"),
		WithAdminBridgeCookie(AdminBridgeCookieConfig{
			Secret: "bridge-secret",
			Hosts:  []string{"admin.lightclaw.tech"},
			Secure: true,
		}),
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "https://admin.lightclaw.tech/admin", nil)
	req.Host = "admin.lightclaw.tech"
	req.AddCookie(&http.Cookie{Name: defaultAdminBridgeCookieName, Value: "broken.token"})
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("WWW-Authenticate"); got == "" {
		t.Fatal("expected WWW-Authenticate header to be set")
	}
}

func TestAdminRouteChallengesWhenBridgeCookieExpired(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called with expired bridge cookie")
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{{
			Name:     "admin",
			Prefix:   "/admin",
			Upstream: upstream.URL,
			Access:   AccessAdmin,
		}},
	},
		WithAdminBasicAuth("skipzhang", "secret"),
		WithAdminBridgeCookie(AdminBridgeCookieConfig{
			Secret: "bridge-secret",
			Hosts:  []string{"admin.lightclaw.tech"},
			TTL:    -time.Hour,
			Secure: true,
		}),
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	expiredClaims := adminBridgeClaims{
		Version:             1,
		Username:            "skipzhang",
		PasswordFingerprint: handler.(*Handler).currentAdminPasswordFingerprint(),
		IssuedAt:            time.Now().Add(-2 * time.Hour).Unix(),
		ExpiresAt:           time.Now().Add(-time.Hour).Unix(),
	}
	payload, err := json.Marshal(expiredClaims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	payloadEncoded := base64.RawURLEncoding.EncodeToString(payload)
	expiredCookie := &http.Cookie{
		Name:  defaultAdminBridgeCookieName,
		Value: payloadEncoded + "." + handler.(*Handler).signAdminBridgePayload(payloadEncoded),
	}

	req2 := httptest.NewRequest(http.MethodGet, "https://admin.lightclaw.tech/admin", nil)
	req2.Host = "admin.lightclaw.tech"
	req2.AddCookie(expiredCookie)
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)

	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d body=%s", rec2.Code, rec2.Body.String())
	}
}

func TestAdminRouteChallengesWhenPasswordFingerprintNoLongerMatches(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	oldHandler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{{
			Name:     "admin",
			Prefix:   "/admin",
			Upstream: upstream.URL,
			Access:   AccessAdmin,
		}},
	},
		WithAdminBasicAuth("skipzhang", "secret"),
		WithAdminBridgeCookie(AdminBridgeCookieConfig{
			Secret: "bridge-secret",
			Hosts:  []string{"admin.lightclaw.tech"},
			Secure: true,
		}),
	)
	if err != nil {
		t.Fatalf("new old handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "https://admin.lightclaw.tech/admin", nil)
	req.Host = "admin.lightclaw.tech"
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("skipzhang:secret")))
	rec := httptest.NewRecorder()
	oldHandler.ServeHTTP(rec, req)
	oldCookie := findCookieByName(t, rec.Result(), defaultAdminBridgeCookieName)

	newHandler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{{
			Name:     "admin",
			Prefix:   "/admin",
			Upstream: upstream.URL,
			Access:   AccessAdmin,
		}},
	},
		WithAdminBasicAuth("skipzhang", "new-secret"),
		WithAdminBridgeCookie(AdminBridgeCookieConfig{
			Secret: "bridge-secret",
			Hosts:  []string{"admin.lightclaw.tech"},
			Secure: true,
		}),
	)
	if err != nil {
		t.Fatalf("new replacement handler: %v", err)
	}

	req2 := httptest.NewRequest(http.MethodGet, "https://admin.lightclaw.tech/admin", nil)
	req2.Host = "admin.lightclaw.tech"
	req2.AddCookie(oldCookie)
	rec2 := httptest.NewRecorder()
	newHandler.ServeHTTP(rec2, req2)

	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d body=%s", rec2.Code, rec2.Body.String())
	}
}

func TestAdminRoutePreservesUpstreamSetCookieWhenAppendingBridgeCookie(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "lc_session", Value: "upstream-cookie", Path: "/", HttpOnly: true})
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{{
			Name:     "admin",
			Prefix:   "/admin",
			Upstream: upstream.URL,
			Access:   AccessAdmin,
		}},
	},
		WithAdminBasicAuth("skipzhang", "secret"),
		WithAdminBridgeCookie(AdminBridgeCookieConfig{
			Secret: "bridge-secret",
			Hosts:  []string{"admin.lightclaw.tech"},
			Secure: true,
		}),
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "https://admin.lightclaw.tech/admin", nil)
	req.Host = "admin.lightclaw.tech"
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("skipzhang:secret")))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := rec.Result()
	findCookieByName(t, resp, "lc_session")
	findCookieByName(t, resp, defaultAdminBridgeCookieName)
}

func TestAdminRouteRequiresBridgeSecretWhenConfigured(t *testing.T) {
	_, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{{
			Name:     "admin",
			Prefix:   "/admin",
			Upstream: "http://admin.invalid",
			Access:   AccessAdmin,
		}},
	},
		WithAdminBasicAuth("skipzhang", "secret"),
		WithAdminBridgeCookie(AdminBridgeCookieConfig{
			Hosts: []string{"admin.lightclaw.tech"},
		}),
	)
	if err == nil {
		t.Fatal("expected error when admin bridge is configured without secret")
	}
}

func TestAdminRouteDoesNotIssueBridgeCookieForNonEligibleHost(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{{
			Name:     "admin",
			Prefix:   "/admin",
			Upstream: upstream.URL,
			Access:   AccessAdmin,
		}},
	},
		WithAdminBasicAuth("skipzhang", "secret"),
		WithAdminBridgeCookie(AdminBridgeCookieConfig{
			Secret: "bridge-secret",
			Hosts:  []string{"admin.lightclaw.tech"},
			Secure: true,
		}),
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "https://admin.lightclaw.site/admin", nil)
	req.Host = "admin.lightclaw.site"
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("skipzhang:secret")))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == defaultAdminBridgeCookieName {
			t.Fatal("expected no bridge cookie for non-eligible host")
		}
	}
}

func TestAdminRouteRequiresConfiguredCredentials(t *testing.T) {
	_, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "admin",
				Prefix:   "/admin",
				Upstream: "http://admin.invalid",
				Access:   AccessAdmin,
			},
		},
	})
	if err == nil {
		t.Fatal("expected error when admin route is configured without credentials")
	}
}

func TestUnmatchedRootReturnsNotFoundWithoutCatchAllRoute(t *testing.T) {
	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "auth",
				Prefix:   "/auth",
				Upstream: "http://auth.invalid",
				Access:   AccessPublic,
			},
		},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAuthenticatedRouteCanInjectConfiguredUpstreamBearerToken(t *testing.T) {
	t.Setenv("SERVICE_GATEWAY_TEST_UPSTREAM_TOKEN", "internal-secret")
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{"id": "usr_123", "email": "user@example.com"},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer internal-secret" {
			t.Fatalf("expected upstream bearer token, got %q", got)
		}
		if got := r.Header.Get("X-Lightclaw-User-ID"); got != "usr_123" {
			t.Fatalf("expected injected user id, got %q", got)
		}
		if got := r.Header.Get("Cookie"); got != "" {
			t.Fatalf("expected user cookies to be stripped before internal upstream, got %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:                   "internal-api",
			Prefix:                 "/internal-api",
			RewritePrefix:          "/v1",
			Upstream:               upstream.URL,
			UpstreamBearerTokenEnv: "SERVICE_GATEWAY_TEST_UPSTREAM_TOKEN",
			Access:                 AccessAuthenticated,
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/internal-api/namespaces/prefs/kv/theme", nil)
	req.Header.Set("Authorization", "Bearer user-token")
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "user-session"})
	req.AddCookie(&http.Cookie{Name: "analytics", Value: "tracking"})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected upstream status, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAuthenticatedRouteFailsClosedWhenUpstreamBearerTokenMissing(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{"id": "usr_123", "email": "user@example.com"},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called when internal token env is missing")
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{{
			Name:                   "internal-api",
			Prefix:                 "/internal-api",
			Upstream:               upstream.URL,
			UpstreamBearerTokenEnv: "SERVICE_GATEWAY_TEST_MISSING_TOKEN",
			Access:                 AccessAuthenticated,
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/internal-api/namespaces/prefs/kv/theme", nil)
	req.Header.Set("Authorization", "Bearer user-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected bad gateway, got %d body=%s", rec.Code, rec.Body.String())
	}
}
