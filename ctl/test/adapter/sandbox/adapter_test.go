//go:build integration

package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pcontext "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/resource"
	"go.uber.org/zap"
)

func testContext() context.Context {
	ctx := pcontext.NewContext(nil)
	ctx.SetRequestId("trace-test-123")
	return ctx
}

func newTestAdapter(baseURL string) *psandbox.SandboxAdapter {
	return psandbox.NewSandboxAdapter(&config.SandboxConfig{
		BaseURL:       baseURL,
		APIKey:        "test-api-key",
		Timeout:       1,
		MaxRetries:    2,
		RetryInterval: 10,
	}, resource.ZapLogger)
}

func init() {
	if resource.ZapLogger == nil {
		resource.ZapLogger = zap.NewNop()
	}
}

func TestCreateSandbox(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sandboxes" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("unexpected method: %s", r.Method)
		}
		if r.Header.Get("X-API-Key") != "test-api-key" {
			t.Fatalf("missing api key header")
		}
		if r.Header.Get("X-Trace-Id") != "trace-test-123" {
			t.Fatalf("missing trace header")
		}

		var req psandbox.CreateSandboxRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req.TemplateID != "tpl-1" {
			t.Fatalf("unexpected template id: %s", req.TemplateID)
		}

		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(psandbox.Sandbox{
			TemplateID:      "tpl-1",
			SandboxID:       "sbx-123",
			ClientID:        "client-1",
			EnvdVersion:     "1.0.0",
			EnvdAccessToken: "token",
		})
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	timeout := int32(60)
	resp, err := adapter.CreateSandbox(testContext(), &psandbox.CreateSandboxRequest{
		TemplateID: "tpl-1",
		Timeout:    &timeout,
	})
	if err != nil {
		t.Fatalf("CreateSandbox error: %v", err)
	}
	if resp.SandboxID != "sbx-123" {
		t.Fatalf("unexpected sandbox id: %s", resp.SandboxID)
	}
}

func TestGetSandbox(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sandboxes/sbx-123" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(psandbox.SandboxDetail{
			Sandbox: psandbox.Sandbox{
				TemplateID:      "tpl-1",
				SandboxID:       "sbx-123",
				ClientID:        "client-1",
				EnvdVersion:     "1.0.0",
				EnvdAccessToken: "token",
			},
			StartedAt:  time.Date(2026, 3, 19, 0, 0, 0, 0, time.UTC),
			EndAt:      time.Date(2026, 3, 19, 1, 0, 0, 0, time.UTC),
			CPUCount:   2,
			MemoryMB:   2048,
			DiskSizeMB: 10240,
			State:      "running",
		})
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	resp, err := adapter.GetSandbox(testContext(), "sbx-123")
	if err != nil {
		t.Fatalf("GetSandbox error: %v", err)
	}
	if resp.State != "running" {
		t.Fatalf("unexpected state: %s", resp.State)
	}
}

func TestListSandboxes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/sandboxes" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("metadata"); got != "user=abc" {
			t.Fatalf("unexpected metadata: %s", got)
		}
		if got := r.URL.Query().Get("state"); got != "running,paused" {
			t.Fatalf("unexpected state query: %s", got)
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode([]psandbox.ListedSandbox{
			{
				SandboxDetail: psandbox.SandboxDetail{
					Sandbox: psandbox.Sandbox{
						TemplateID:  "tpl-1",
						SandboxID:   "sbx-1",
						ClientID:    "client-1",
						EnvdVersion: "1.0.0",
					},
					State: "running",
				},
			},
		})
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	limit := int32(100)
	resp, err := adapter.ListSandboxes(testContext(), &psandbox.ListSandboxesRequest{
		Metadata: "user=abc",
		State:    []string{"running", "paused"},
		Limit:    &limit,
	})
	if err != nil {
		t.Fatalf("ListSandboxes error: %v", err)
	}
	if len(resp) != 1 {
		t.Fatalf("unexpected sandbox count: %d", len(resp))
	}
}

func TestDeleteSandbox(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Fatalf("unexpected method: %s", r.Method)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	if err := adapter.DeleteSandbox(testContext(), "sbx-123"); err != nil {
		t.Fatalf("DeleteSandbox error: %v", err)
	}
}

func TestListPoolsAndPoolInstances(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/pools":
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode([]psandbox.Pool{
				{ID: "pool-a", DesiredCapacity: 3, Status: "active"},
			})
		case "/internal/pools/pool-a/instances":
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode([]psandbox.PoolInstance{
				{ID: "inst-1", PoolID: "pool-a", State: "CLEAN"},
				{ID: "inst-2", PoolID: "pool-a", State: "DRY"},
			})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	pools, err := adapter.ListPools(testContext())
	if err != nil {
		t.Fatalf("ListPools error: %v", err)
	}
	if len(pools) != 1 || pools[0].ID != "pool-a" {
		t.Fatalf("unexpected pools: %+v", pools)
	}

	items, err := adapter.ListPoolInstances(testContext(), "pool-a")
	if err != nil {
		t.Fatalf("ListPoolInstances error: %v", err)
	}
	if len(items) != 2 || items[1].State != "DRY" {
		t.Fatalf("unexpected instances: %+v", items)
	}
}

func TestPauseSandbox(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sandboxes/sbx-123/pause" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	if err := adapter.PauseSandbox(testContext(), "sbx-123"); err != nil {
		t.Fatalf("PauseSandbox error: %v", err)
	}
}

func TestResumeSandbox(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sandboxes/sbx-123/resume" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var req psandbox.ResumeSandboxRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(psandbox.Sandbox{
			TemplateID:  "tpl-1",
			SandboxID:   "sbx-123",
			ClientID:    "client-1",
			EnvdVersion: "1.0.0",
		})
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	timeout := int32(60)
	resp, err := adapter.ResumeSandbox(testContext(), "sbx-123", &psandbox.ResumeSandboxRequest{Timeout: &timeout})
	if err != nil {
		t.Fatalf("ResumeSandbox error: %v", err)
	}
	if resp.SandboxID != "sbx-123" {
		t.Fatalf("unexpected sandbox id: %s", resp.SandboxID)
	}
}

func TestSetTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sandboxes/sbx-123/timeout" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var body map[string]int32
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body["timeout"] != 120 {
			t.Fatalf("unexpected timeout: %d", body["timeout"])
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	if err := adapter.SetTimeout(testContext(), "sbx-123", 120); err != nil {
		t.Fatalf("SetTimeout error: %v", err)
	}
}

func TestRefresh(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sandboxes/sbx-123/refreshes" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var body map[string]int32
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body["duration"] != 300 {
			t.Fatalf("unexpected duration: %d", body["duration"])
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	if err := adapter.Refresh(testContext(), "sbx-123", 300); err != nil {
		t.Fatalf("Refresh error: %v", err)
	}
}

func TestGetLogs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/logs") {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("limit"); got != "10" {
			t.Fatalf("unexpected limit: %s", got)
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(psandbox.SandboxLogs{
			Logs: []psandbox.SandboxLog{
				{
					Timestamp: time.Date(2026, 3, 19, 0, 0, 0, 0, time.UTC),
					Line:      "hello",
				},
			},
			LogEntries: []psandbox.SandboxLogEntry{
				{
					Timestamp: time.Date(2026, 3, 19, 0, 0, 1, 0, time.UTC),
					Level:     "info",
					Message:   "world",
					Fields:    map[string]string{"k": "v"},
				},
			},
		})
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	limit := int32(10)
	resp, err := adapter.GetLogs(testContext(), "sbx-123", &psandbox.GetLogsRequest{Limit: &limit})
	if err != nil {
		t.Fatalf("GetLogs error: %v", err)
	}
	if len(resp.LogEntries) != 1 {
		t.Fatalf("unexpected log entries: %d", len(resp.LogEntries))
	}
}

func TestMaxRetriesCanBeDisabled(t *testing.T) {
	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(psandbox.APIError{
			Code:    http.StatusBadGateway,
			Message: "temporary",
		})
	}))
	defer server.Close()

	adapter := psandbox.NewSandboxAdapter(&config.SandboxConfig{
		BaseURL:       server.URL,
		APIKey:        "test-api-key",
		Timeout:       1,
		MaxRetries:    0,
		RetryInterval: 10,
	}, resource.ZapLogger)

	_, err := adapter.CreateSandbox(testContext(), &psandbox.CreateSandboxRequest{TemplateID: "tpl-1"})
	if !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("expected 1 attempt when retry disabled, got %d", got)
	}
}

func TestRetryMechanism(t *testing.T) {
	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := atomic.AddInt32(&attempts, 1)
		if current < 3 {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"code":500,"message":"temporary"}`))
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(psandbox.Sandbox{
			TemplateID:  "tpl-1",
			SandboxID:   "sbx-123",
			ClientID:    "client-1",
			EnvdVersion: "1.0.0",
		})
	}))
	defer server.Close()

	adapter := newTestAdapter(server.URL)
	resp, err := adapter.CreateSandbox(testContext(), &psandbox.CreateSandboxRequest{TemplateID: "tpl-1"})
	if err != nil {
		t.Fatalf("CreateSandbox error: %v", err)
	}
	if resp.SandboxID != "sbx-123" {
		t.Fatalf("unexpected sandbox id: %s", resp.SandboxID)
	}
	if got := atomic.LoadInt32(&attempts); got != 3 {
		t.Fatalf("unexpected attempts: %d", got)
	}
}

func TestNetworkNonTimeoutMapsToServiceError(t *testing.T) {
	adapter := psandbox.NewSandboxAdapter(&config.SandboxConfig{
		BaseURL:       "http://127.0.0.1:1",
		APIKey:        "test-api-key",
		Timeout:       1,
		MaxRetries:    0,
		RetryInterval: 10,
	}, resource.ZapLogger)

	_, err := adapter.GetSandbox(testContext(), "sbx-123")
	if !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}
}

func TestEmptySandboxIDValidation(t *testing.T) {
	adapter := newTestAdapter("http://example.com")

	cases := []struct {
		name string
		run  func() error
	}{
		{name: "get", run: func() error { _, err := adapter.GetSandbox(testContext(), ""); return err }},
		{name: "delete", run: func() error { return adapter.DeleteSandbox(testContext(), "") }},
		{name: "pause", run: func() error { return adapter.PauseSandbox(testContext(), "") }},
		{name: "resume", run: func() error {
			_, err := adapter.ResumeSandbox(testContext(), "", &psandbox.ResumeSandboxRequest{})
			return err
		}},
		{name: "set-timeout", run: func() error { return adapter.SetTimeout(testContext(), "", 1) }},
		{name: "refresh", run: func() error { return adapter.Refresh(testContext(), "", 1) }},
		{name: "logs", run: func() error { _, err := adapter.GetLogs(testContext(), "", nil); return err }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.run(); !errors.Is(err, errcode.ErrSandboxInvalidParam) {
				t.Fatalf("expected invalid param, got %v", err)
			}
		})
	}
}

func TestNegativeTimeoutAndRefreshValidation(t *testing.T) {
	adapter := newTestAdapter("http://example.com")

	if err := adapter.SetTimeout(testContext(), "sbx-123", -1); !errors.Is(err, errcode.ErrSandboxInvalidParam) {
		t.Fatalf("expected invalid param for negative timeout, got %v", err)
	}
	if err := adapter.Refresh(testContext(), "sbx-123", -1); !errors.Is(err, errcode.ErrSandboxInvalidParam) {
		t.Fatalf("expected invalid param for negative duration, got %v", err)
	}
}

func TestErrorHandling(t *testing.T) {
	testCases := []struct {
		name       string
		statusCode int
		want       error
	}{
		{name: "bad request", statusCode: http.StatusBadRequest, want: errcode.ErrSandboxInvalidParam},
		{name: "unauthorized", statusCode: http.StatusUnauthorized, want: errcode.ErrSandboxAuthFailed},
		{name: "not found", statusCode: http.StatusNotFound, want: errcode.ErrSandboxNotFound},
		{name: "conflict", statusCode: http.StatusConflict, want: errcode.ErrSandboxStatusConflict},
		{name: "server error", statusCode: http.StatusInternalServerError, want: errcode.ErrSandboxServiceError},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.statusCode)
				_ = json.NewEncoder(w).Encode(psandbox.APIError{
					Code:    tc.statusCode,
					Message: "upstream error",
				})
			}))
			defer server.Close()

			adapter := newTestAdapter(server.URL)
			_, err := adapter.GetSandbox(testContext(), "sbx-123")
			if !errors.Is(err, tc.want) {
				t.Fatalf("expected %v, got %v", tc.want, err)
			}
		})
	}
}

func TestTimeoutNetworkErrorMapsToTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(50 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(psandbox.SandboxDetail{
			Sandbox: psandbox.Sandbox{
				TemplateID:  "tpl-1",
				SandboxID:   "sbx-123",
				ClientID:    "client-1",
				EnvdVersion: "1.0.0",
			},
			State: "running",
		})
	}))
	defer server.Close()

	adapter := psandbox.NewSandboxAdapter(&config.SandboxConfig{
		BaseURL:       server.URL,
		APIKey:        "test-api-key",
		Timeout:       1,
		MaxRetries:    0,
		RetryInterval: 10,
	}, resource.ZapLogger)
	adapterCtx, cancel := context.WithTimeout(testContext(), 5*time.Millisecond)
	defer cancel()

	_, err := adapter.GetSandbox(adapterCtx, "sbx-123")
	if !errors.Is(err, errcode.ErrSandboxTimeout) {
		t.Fatalf("expected sandbox timeout, got %v", err)
	}
}
