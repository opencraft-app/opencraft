package sandbox

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"go.uber.org/zap"
)

func TestApplyProcessHeadersIncludesAccessTokenWhenPresent(t *testing.T) {
	headers := make(http.Header)

	applyProcessHeaders(headers, "sbx-123", defaultProcessUser, "envd-token")

	if got := headers.Get("Host"); got != "49983-sbx-123-00000000.e2b.app" {
		t.Fatalf("unexpected host header: %s", got)
	}
	if got := headers.Get("Authorization"); got != "Basic YWdlbnR1c2VyOg==" {
		t.Fatalf("unexpected authorization header: %s", got)
	}
	if got := headers.Get("X-Access-Token"); got != "envd-token" {
		t.Fatalf("unexpected access token header: %s", got)
	}
}

func TestApplyProcessHeadersOmitsEmptyAccessToken(t *testing.T) {
	headers := make(http.Header)

	applyProcessHeaders(headers, "sbx-123", defaultProcessUser, "")

	if got := headers.Get("X-Access-Token"); got != "" {
		t.Fatalf("expected empty access token header, got %s", got)
	}
}

func TestCreateSandboxRequestJSONIncludesTemplateClassIDWhenPresent(t *testing.T) {
	body, err := json.Marshal(&CreateSandboxRequest{
		TemplateClassID: "openclaw-default",
		TemplateID:      "pool-c0",
	})
	if err != nil {
		t.Fatalf("marshal create request: %v", err)
	}
	if got := string(body); got != `{"template_class_id":"openclaw-default","templateID":"pool-c0"}` {
		t.Fatalf("unexpected create request json: %s", got)
	}
}

func TestCreateSandboxRequestJSONIncludesSKUIDWhenPresent(t *testing.T) {
	body, err := json.Marshal(&CreateSandboxRequest{
		TemplateClassID: "hermes",
		TemplateID:      "pool-c3",
		SKUID:           "sku-hermes-4c8g",
	})
	if err != nil {
		t.Fatalf("marshal create request: %v", err)
	}
	if got := string(body); got != `{"template_class_id":"hermes","templateID":"pool-c3","sku_id":"sku-hermes-4c8g"}` {
		t.Fatalf("unexpected create request json: %s", got)
	}
}

func TestCreateSandboxRequestJSONOmitsTemplateClassIDWhenEmpty(t *testing.T) {
	body, err := json.Marshal(&CreateSandboxRequest{
		TemplateID: "pool-c0",
	})
	if err != nil {
		t.Fatalf("marshal create request: %v", err)
	}
	if got := string(body); got != `{"templateID":"pool-c0"}` {
		t.Fatalf("unexpected create request json: %s", got)
	}
}

func TestStartTerminalSessionUsesSandboxTatSessionEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("unexpected method: %s", r.Method)
		}
		if r.URL.Path != "/sandboxes/sbx-123/tat/session" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("X-API-Key") != "test-api-key" {
			t.Fatalf("missing api key header")
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(TerminalSession{
			SandboxID:      "sbx-123",
			PoolID:         "pool-1",
			SessionID:      "sess-1",
			Region:         "ap-beijing",
			InstanceID:     "i-123",
			OwnerUin:       "10001",
			LoginUin:       "10002",
			AppID:          123,
			WsURL:          "wss://tat.example.test/ws",
			Cols:           120,
			Rows:           30,
			TimeoutSeconds: 3600,
			Username:       "agentuser",
			WorkingDir:     "/home/agentuser",
		})
	}))
	defer server.Close()

	adapter := NewSandboxAdapter(&config.SandboxConfig{
		BaseURL: server.URL,
		APIKey:  "test-api-key",
		Timeout: 1,
	}, zap.NewNop())
	session, err := adapter.StartTerminalSession(t.Context(), "sbx-123")
	if err != nil {
		t.Fatalf("start terminal session: %v", err)
	}
	if session.SessionID != "sess-1" || session.WsURL != "wss://tat.example.test/ws" {
		t.Fatalf("unexpected session: %+v", session)
	}
	if session.Username != "agentuser" || session.WorkingDir != "/home/agentuser" {
		t.Fatalf("unexpected terminal identity: %+v", session)
	}
}

func TestStartTerminalSessionForwardsUserSessionAuth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer user-session-token" {
			t.Fatalf("unexpected authorization header: %q", got)
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(TerminalSession{
			SandboxID: "sbx-123",
			SessionID: "sess-1",
			WsURL:     "wss://tat.example.test/ws",
		})
	}))
	defer server.Close()

	adapter := NewSandboxAdapter(&config.SandboxConfig{
		BaseURL: server.URL,
		APIKey:  "test-api-key",
		Timeout: 1,
	}, zap.NewNop())
	ctx := pctx.NewContext(t.Context()).WithSessionAuth("Bearer user-session-token", "")
	if _, err := adapter.StartTerminalSession(ctx, "sbx-123"); err != nil {
		t.Fatalf("start terminal session: %v", err)
	}
}

func TestStartTerminalSessionForwardsSessionCookieWhenBearerMissing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Cookie"); got != "lc_session=cookie-token" {
			t.Fatalf("unexpected cookie header: %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "" {
			t.Fatalf("expected empty authorization header, got %q", got)
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(TerminalSession{
			SandboxID: "sbx-123",
			SessionID: "sess-1",
			WsURL:     "wss://tat.example.test/ws",
		})
	}))
	defer server.Close()

	adapter := NewSandboxAdapter(&config.SandboxConfig{
		BaseURL: server.URL,
		APIKey:  "test-api-key",
		Timeout: 1,
	}, zap.NewNop())
	ctx := pctx.NewContext(t.Context()).WithSessionAuth("", "lc_session=cookie-token")
	if _, err := adapter.StartTerminalSession(ctx, "sbx-123"); err != nil {
		t.Fatalf("start terminal session: %v", err)
	}
}
