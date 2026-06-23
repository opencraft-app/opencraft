package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCloudAgentClientInitializeRejectsSelfCheckWithoutRunProtocol(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities" {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/v1/selfcheck" {
			writeTestJSON(t, w, map[string]any{
				"object": "cloudagent.selfcheck",
				"ok":     true,
				"summary": map[string]any{
					"worker_kind": "agent_sidecar",
				},
				"checks": []any{
					map[string]any{"name": "agent.sidecar_source", "status": "pass"},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	err := client.Initialize(context.Background())
	if err == nil {
		t.Fatal("expected old gateway selfcheck to be rejected")
	}
	if !IsCloudAgentProtocolUnavailable(err) {
		t.Fatalf("expected CloudAgentProtocolUnavailableError, got %T %v", err, err)
	}
	if !strings.Contains(err.Error(), "session_event_protocol") {
		t.Fatalf("error should identify missing session-event protocol, got %v", err)
	}
}

func TestCloudAgentClientInitializePrefersCapabilities(t *testing.T) {
	var selfCheckCalled atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities":
			writeTestJSON(t, w, map[string]any{
				"object":                 "cloudagent.capabilities",
				"protocol":               "cloudagent.session_events",
				"version":                "v1",
				"session_event_protocol": true,
				"features":               []string{"session_event_submit"},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/selfcheck":
			selfCheckCalled.Store(true)
			http.Error(w, "selfcheck should not be needed", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	if err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize with capabilities: %v", err)
	}
	if selfCheckCalled.Load() {
		t.Fatal("capabilities endpoint should make selfcheck fallback unnecessary")
	}
}

func TestCloudAgentClientInitializeRejectsLegacyRunCapabilities(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities" {
			writeTestJSON(t, w, map[string]any{
				"object":       "cloudagent.capabilities",
				"protocol":     "cloudagent.run",
				"version":      "v1",
				"run_protocol": true,
				"features":     []string{"run_submit"},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	err := client.Initialize(context.Background())
	if err == nil {
		t.Fatal("expected legacy run capabilities to be rejected")
	}
	if !IsCloudAgentProtocolUnavailable(err) {
		t.Fatalf("expected CloudAgentProtocolUnavailableError, got %T %v", err, err)
	}
}

func TestCloudAgentClientDoesNotSendWorkspaceKeyWithoutCapability(t *testing.T) {
	var sawWorkspaceKey atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities":
			writeTestJSON(t, w, map[string]any{
				"object":                 "cloudagent.capabilities",
				"protocol":               "cloudagent.session_events",
				"version":                "v1",
				"session_event_protocol": true,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions":
			var req map[string]any
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode session create: %v", err)
			}
			if _, ok := req["workspace_key"]; ok {
				sawWorkspaceKey.Store(true)
			}
			writeTestJSON(t, w, map[string]any{"session_id": "session-http", "state": "ready"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	if err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if _, err := client.NewSession(context.Background(), "/workspace", "workspace-stable"); err != nil {
		t.Fatalf("new session: %v", err)
	}
	if sawWorkspaceKey.Load() {
		t.Fatal("workspace_key must not be sent unless capabilities explicitly advertise workspace reuse")
	}
}

func TestCloudAgentClientSendsWorkspaceKeyWhenCapabilityAdvertised(t *testing.T) {
	var seenWorkspaceKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities":
			writeTestJSON(t, w, map[string]any{
				"object":                 "cloudagent.capabilities",
				"protocol":               "cloudagent.session_events",
				"version":                "v1",
				"session_event_protocol": true,
				"features":               []string{"workspace_reuse"},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions":
			var req struct {
				WorkspaceKey string `json:"workspace_key"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode session create: %v", err)
			}
			seenWorkspaceKey = req.WorkspaceKey
			writeTestJSON(t, w, map[string]any{"session_id": "session-http", "state": "ready"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	if err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if _, err := client.NewSession(context.Background(), "/workspace", "workspace-stable"); err != nil {
		t.Fatalf("new session: %v", err)
	}
	if seenWorkspaceKey != "workspace-stable" {
		t.Fatalf("expected advertised workspace key to be sent, got %q", seenWorkspaceKey)
	}
}

func TestCloudAgentClientCloseSessionRequiresAdvertisedCapability(t *testing.T) {
	var closeCalled atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities":
			writeTestJSON(t, w, map[string]any{
				"object":                 "cloudagent.capabilities",
				"protocol":               "cloudagent.session_events",
				"version":                "v1",
				"session_event_protocol": true,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/close":
			closeCalled.Store(true)
			writeTestJSON(t, w, map[string]any{"ok": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	if err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	err := client.CloseSession(context.Background(), "session-http")
	if !IsCloudAgentSessionCloseUnsupported(err) {
		t.Fatalf("expected unsupported close error, got %T %v", err, err)
	}
	if closeCalled.Load() {
		t.Fatal("close endpoint must not be called when capabilities do not advertise it")
	}
}

func TestCloudAgentClientCloseSessionUsesAdvertisedEndpoint(t *testing.T) {
	var closeCalled atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities":
			writeTestJSON(t, w, map[string]any{
				"object":                 "cloudagent.capabilities",
				"protocol":               "cloudagent.session_events",
				"version":                "v1",
				"session_event_protocol": true,
				"endpoints":              []string{"POST /v1/cloudagent/sessions/{session_id}/close"},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/close":
			closeCalled.Store(true)
			writeTestJSON(t, w, map[string]any{"ok": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	if err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if err := client.CloseSession(context.Background(), "session-http"); err != nil {
		t.Fatalf("close session: %v", err)
	}
	if !closeCalled.Load() {
		t.Fatal("expected advertised close endpoint to be called")
	}
}

func TestCloudAgentClientUsesContextForTimeout(t *testing.T) {
	client := NewCloudAgentClient("http://127.0.0.1:1", nil)
	if client.client.Timeout != 0 {
		t.Fatalf("cloudagent client must not impose a hard HTTP timeout; got %s", client.client.Timeout)
	}
}

func TestCloudAgentClientInitializeRejectsBadCapabilities(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities" {
			writeTestJSON(t, w, map[string]any{
				"object":                 "cloudagent.capabilities",
				"protocol":               "cloudagent.session_events",
				"version":                "v1",
				"session_event_protocol": false,
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	err := client.Initialize(context.Background())
	if err == nil {
		t.Fatal("expected capabilities without session_event_protocol to fail")
	}
	if !IsCloudAgentProtocolUnavailable(err) {
		t.Fatalf("expected CloudAgentProtocolUnavailableError, got %T %v", err, err)
	}
}

func TestCloudAgentClientInitializeRejectsSelfCheckOnlyRunProtocol(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities" {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/v1/selfcheck" {
			w.WriteHeader(http.StatusServiceUnavailable)
			writeTestJSON(t, w, map[string]any{
				"object": "cloudagent.selfcheck",
				"ok":     false,
				"summary": map[string]any{
					"worker_kind":                 "agent_sidecar",
					"cloudagent_run_protocol":     true,
					"tokenhub_api_key_configured": false,
				},
				"checks": []any{
					map[string]any{"name": "cloudagent.run_protocol", "status": "pass"},
					map[string]any{"name": "agent.tokenhub_api_key", "status": "fail"},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	err := client.Initialize(context.Background())
	if err == nil {
		t.Fatal("expected selfcheck-only run protocol to be rejected")
	}
	if !IsCloudAgentProtocolUnavailable(err) {
		t.Fatalf("expected CloudAgentProtocolUnavailableError, got %T %v", err, err)
	}
}

func TestCloudAgentClientInitializeRejectsMissingCapabilities(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	err := client.Initialize(context.Background())
	if err == nil {
		t.Fatal("expected missing capabilities to be rejected")
	}
	if !IsCloudAgentProtocolUnavailable(err) {
		t.Fatalf("expected CloudAgentProtocolUnavailableError, got %T %v", err, err)
	}
}

func TestCloudAgentClientPromptUsesRunReplayAndResult(t *testing.T) {
	var sawAfterSeq bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities":
			writeTestJSON(t, w, map[string]any{
				"object":                 "cloudagent.capabilities",
				"protocol":               "cloudagent.session_events",
				"version":                "v1",
				"session_event_protocol": true,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions":
			writeTestJSON(t, w, map[string]any{"session_id": "session-http", "state": "ready"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/sessions/session-http":
			writeTestJSON(t, w, map[string]any{"session_id": "session-http", "state": "ready"})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			var req struct {
				Text string `json:"text"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode run submit: %v", err)
			}
			idempotencyKey := r.Header.Get("Idempotency-Key")
			if idempotencyKey == "" || req.Text != "hello" {
				t.Errorf("run submit should include Idempotency-Key and text, got key=%q req=%#v", idempotencyKey, req)
			}
			writeTestJSON(t, w, map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
			if afterSeq > 0 {
				sawAfterSeq = true
				writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
					"id": "evt_session-http_2", "seq": 2, "type": "session.status_idle", "run_id": "job-http", "session_id": "session-http",
					"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
				})
				return
			}
			writeCloudAgentTestSSE(t, w, "agent.message", map[string]any{
				"id": "evt_job-http_1", "seq": 1, "type": "agent.message", "run_id": "job-http", "session_id": "session-http",
				"content": []any{map[string]any{"type": "text", "text": "final"}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	ctx := context.Background()
	if err := client.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	sessionID, err := client.NewSession(ctx, "/workspace", "")
	if err != nil {
		t.Fatal(err)
	}
	if sessionID != "session-http" {
		t.Fatalf("session id=%q", sessionID)
	}
	if err := client.LoadSession(ctx, sessionID, "/workspace"); err != nil {
		t.Fatal(err)
	}
	result, err := client.Prompt(ctx, sessionID, "hello")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "final" || result.StopReason != "end_turn" {
		t.Fatalf("unexpected prompt result: %#v", result)
	}
	if !sawAfterSeq {
		t.Fatal("client did not advance after_seq while following run events")
	}
}

func TestCloudAgentClientStartsRunStreamAtZeroAfterSubmittedSessionSeq(t *testing.T) {
	var afterSeqs []int64
	var sessionStreamCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			writeTestJSON(t, w, map[string]any{
				"run_id":     "job-new",
				"session_id": "session-http",
				"status":     "running",
				"events": []map[string]any{{
					"id":         "evt_session-http_4",
					"seq":        4,
					"type":       "user.message",
					"run_id":     "job-new",
					"session_id": "session-http",
					"content":    "new prompt",
				}},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/sessions/session-http/events/stream":
			sessionStreamCalls.Add(1)
			writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
				"id": "evt_session-http_3", "seq": 3, "type": "session.status_idle", "run_id": "job-old", "session_id": "session-http",
				"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
			})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
			afterSeqs = append(afterSeqs, afterSeq)
			if afterSeq != 0 {
				t.Errorf("run events must start from run-local after_seq=0, got %d", afterSeq)
				http.Error(w, "bad after_seq", http.StatusBadRequest)
				return
			}
			writeCloudAgentTestSSE(t, w, "agent.message", map[string]any{
				"id": "evt_job-new_1", "seq": 1, "type": "agent.message", "run_id": "job-new", "session_id": "session-http",
				"content": []any{map[string]any{"type": "text", "text": "new reply"}},
			})
			writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
				"id": "evt_job-new_2", "seq": 2, "type": "session.status_idle", "run_id": "job-new", "session_id": "session-http",
				"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	result, err := client.PromptWithRunID(context.Background(), "session-http", "new prompt", "job-new")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "new reply" {
		t.Fatalf("client must not replay old session messages, got %#v", result)
	}
	if len(afterSeqs) != 1 || afterSeqs[0] != 0 {
		t.Fatalf("client should follow run-local events from zero, got %v", afterSeqs)
	}
	if sessionStreamCalls.Load() != 0 {
		t.Fatalf("client must not observe a single run through session stream, calls=%d", sessionStreamCalls.Load())
	}
}

func TestCloudAgentClientIgnoresTerminalEventsFromOtherRuns(t *testing.T) {
	var streamCalls int
	var afterSeqs []int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			writeTestJSON(t, w, map[string]any{
				"run_id":     "job-new",
				"session_id": "session-http",
				"status":     "running",
				"events": []map[string]any{{
					"id": "evt_session-http_1", "seq": 1, "type": "user.message", "run_id": "job-new", "session_id": "session-http",
				}},
			})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			streamCalls++
			afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
			afterSeqs = append(afterSeqs, afterSeq)
			if streamCalls == 1 {
				writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
					"id": "evt_session-http_2", "seq": 2, "type": "session.status_idle", "run_id": "job-old", "session_id": "session-http",
					"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
				})
				return
			}
			writeCloudAgentTestSSE(t, w, "agent.message", map[string]any{
				"id": "evt_session-http_3", "seq": 3, "type": "agent.message", "run_id": "job-new", "session_id": "session-http",
				"content": []any{map[string]any{"type": "text", "text": "new final"}},
			})
			writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
				"id": "evt_session-http_4", "seq": 4, "type": "session.status_idle", "run_id": "job-new", "session_id": "session-http",
				"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	result, err := client.PromptWithRunID(context.Background(), "session-http", "new prompt", "job-new")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "new final" {
		t.Fatalf("client must ignore terminal events from other runs, got %#v", result)
	}
	if streamCalls < 2 {
		t.Fatalf("client should continue after unrelated terminal event, stream_calls=%d", streamCalls)
	}
	if len(afterSeqs) < 2 || afterSeqs[0] != 0 || afterSeqs[1] != 2 {
		t.Fatalf("unrelated terminal event should still advance replay cursor, got %v", afterSeqs)
	}
}

func TestCloudAgentClientFallbackOutputIgnoresUserReplayChunks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			writeTestJSON(t, w, map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			writeCloudAgentTestSSE(t, w, "user.message", map[string]any{
				"id": "evt_job-http_1", "seq": 1, "type": "user.message", "run_id": "job-http", "session_id": "session-http", "content": "user text",
			})
			writeCloudAgentTestSSE(t, w, "agent.message", map[string]any{
				"id": "evt_job-http_2", "seq": 2, "type": "agent.message", "run_id": "job-http", "session_id": "session-http",
				"content": []any{map[string]any{"type": "text", "text": "assistant text"}},
			})
			writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
				"id": "evt_job-http_3", "seq": 3, "type": "session.status_idle", "run_id": "job-http", "session_id": "session-http",
				"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	result, err := client.Prompt(context.Background(), "session-http", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "assistant text" {
		t.Fatalf("fallback output must ignore user replay chunks, got %q", result.Text)
	}
}

func TestCloudAgentClientPreservesSubmittedRunWhenContextEnds(t *testing.T) {
	var completed atomic.Bool
	cancelled := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			writeTestJSON(t, w, map[string]any{"run_id": "job-cancel-me", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			if completed.Load() {
				writeCloudAgentTestSSE(t, w, "agent.message", cloudAgentTestMessageEvent("job-cancel-me", "session-http", 1, "still running after observer timeout"))
				writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
					"id": "evt_job-cancel-me_2", "seq": 2, "type": "session.status_idle", "run_id": "job-cancel-me", "session_id": "session-http",
					"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
				})
				return
			}
			writeCloudAgentTestSSE(t, w, "heartbeat", map[string]any{"type": "heartbeat", "after_seq": 0})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-cancel-me/result":
			if completed.Load() {
				writeTestJSON(t, w, map[string]any{"run_id": "job-cancel-me", "session_id": "session-http", "status": "completed", "stop_reason": "end_turn", "output_text": "still running after observer timeout"})
				return
			}
			writeTestJSON(t, w, map[string]any{"run_id": "job-cancel-me", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/runs/job-cancel-me/cancel":
			select {
			case cancelled <- struct{}{}:
			default:
			}
			writeTestJSON(t, w, map[string]any{"run_id": "job-cancel-me", "status": "cancel_requested"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	_, err := client.PromptWithRunID(ctx, "session-http", "hello", "job-cancel-me")
	if err == nil {
		t.Fatal("expected canceled prompt to fail")
	}
	var interrupted RunObservationInterruptedError
	if !errors.As(err, &interrupted) || interrupted.RunID != "job-cancel-me" {
		t.Fatalf("observer timeout should return run observation interruption with run_id, got %T %v", err, err)
	}
	select {
	case <-cancelled:
		t.Fatal("observer context timeout must not cancel durable cloudagent run")
	case <-time.After(200 * time.Millisecond):
	}
	completed.Store(true)
	result, err := client.PromptWithRunID(context.Background(), "session-http", "hello", "job-cancel-me")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "still running after observer timeout" || result.StopReason != "end_turn" {
		t.Fatalf("same idempotency key should be resumable after observer timeout, got %#v", result)
	}
}

func TestCloudAgentClientTreatsSubmitTimeoutAsReplayable(t *testing.T) {
	var submitCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			submitCalls.Add(1)
			if submitCalls.Load() == 1 {
				time.Sleep(120 * time.Millisecond)
				writeTestJSON(t, w, map[string]any{"run_id": "job-submit-timeout", "session_id": "session-http", "status": "running"})
				return
			}
			writeTestJSON(t, w, map[string]any{"run_id": "job-submit-timeout", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			writeCloudAgentTestSSE(t, w, "agent.message", cloudAgentTestMessageEvent("job-submit-timeout", "session-http", 1, "submit recovered"))
			writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
				"id": "evt_job-submit-timeout_2", "seq": 2, "type": "session.status_idle", "run_id": "job-submit-timeout", "session_id": "session-http",
				"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := client.PromptWithRunID(ctx, "session-http", "hello", "job-submit-timeout")
	if err == nil {
		t.Fatal("expected submit timeout")
	}
	var interrupted RunObservationInterruptedError
	if !errors.As(err, &interrupted) || interrupted.RunID != "job-submit-timeout" {
		t.Fatalf("submit timeout should be replayable with run_id, got %T %v", err, err)
	}
	result, err := client.PromptWithRunID(context.Background(), "session-http", "hello", "job-submit-timeout")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "submit recovered" {
		t.Fatalf("unexpected recovered result: %#v", result)
	}
}

func TestCloudAgentClientRegeneratesRunIDOnCrossSessionConflict(t *testing.T) {
	var submittedKeys []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			idempotencyKey := r.Header.Get("Idempotency-Key")
			submittedKeys = append(submittedKeys, idempotencyKey)
			if len(submittedKeys) == 1 {
				w.WriteHeader(http.StatusConflict)
				writeTestJSON(t, w, map[string]any{"error": map[string]any{"message": "run id belongs to another session"}})
				return
			}
			if idempotencyKey == "" || idempotencyKey == "job-stale-session" {
				t.Fatalf("cross-session conflict retry must use a fresh idempotency key, got %q", idempotencyKey)
			}
			writeTestJSON(t, w, map[string]any{"run_id": "run-server-retry", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			runID := "run-server-retry"
			writeCloudAgentTestSSE(t, w, "agent.message", cloudAgentTestMessageEvent(runID, "session-http", 1, "recovered"))
			writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
				"id": "evt_run-server-retry_2", "seq": 2, "type": "session.status_idle", "run_id": runID, "session_id": "session-http",
				"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	result, err := client.PromptWithRunID(context.Background(), "session-http", "hello", "job-stale-session")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "recovered" {
		t.Fatalf("unexpected conflict retry result: %#v", result)
	}
	if len(submittedKeys) != 2 {
		t.Fatalf("expected one conflict retry, got submitted idempotency keys %#v", submittedKeys)
	}
	if submittedKeys[0] != "job-stale-session" || submittedKeys[1] == submittedKeys[0] {
		t.Fatalf("idempotency key was not regenerated after cross-session conflict: %#v", submittedKeys)
	}
}

func TestCloudAgentClientDoesNotHideSubmitCallerErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events" {
			http.Error(w, "bad run id", http.StatusBadRequest)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	_, err := client.PromptWithRunID(context.Background(), "session-http", "hello", "bad/run")
	if err == nil {
		t.Fatal("expected submit caller error")
	}
	if IsRunObservationInterrupted(err) {
		t.Fatalf("4xx submit errors must not be hidden as replayable observer interruption: %v", err)
	}
}

func TestCloudAgentClientPreservesCancelledStopReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			writeTestJSON(t, w, map[string]any{"run_id": "job-cancelled", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
				"id": "evt_job-cancelled_1", "seq": 1, "type": "session.status_idle", "run_id": "job-cancelled", "session_id": "session-http",
				"status": "idle", "stop_reason": map[string]any{"type": "cancelled"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	result, err := client.PromptWithRunID(context.Background(), "session-http", "hello", "job-cancelled")
	if err != nil {
		t.Fatal(err)
	}
	if result.StopReason != "cancelled" {
		t.Fatalf("cancelled run should keep cancelled stop reason, got %#v", result)
	}
}

func TestCloudAgentClientRetriesFollowFailuresAndDedupesReplay(t *testing.T) {
	var eventCalls int
	var resultCalls int
	var afterSeqs []int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			writeTestJSON(t, w, map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			eventCalls++
			afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
			afterSeqs = append(afterSeqs, afterSeq)
			switch eventCalls {
			case 1:
				writeCloudAgentTestSSE(t, w, "agent.message", cloudAgentTestMessageEvent("job-http", "session-http", 1, "hello "))
			case 2:
				http.Error(w, "temporary gateway restart", http.StatusBadGateway)
			default:
				writeCloudAgentTestSSE(t, w, "agent.message", cloudAgentTestMessageEvent("job-http", "session-http", 2, "world"))
				writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
					"id":         "evt_job-http_terminal",
					"type":       "session.status_idle",
					"run_id":     "job-http",
					"session_id": "session-http",
					"status":     "idle",
					"stop_reason": map[string]any{
						"type": "end_turn",
					},
				})
			}
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-http/result":
			resultCalls++
			if resultCalls == 1 {
				http.Error(w, "temporary result outage", http.StatusBadGateway)
				return
			}
			writeTestJSON(t, w, map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "running"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := client.Prompt(ctx, "session-http", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "hello world" || result.StopReason != "end_turn" {
		t.Fatalf("unexpected prompt result after transient failures: %#v", result)
	}
	if len(afterSeqs) < 3 || afterSeqs[0] != 0 || afterSeqs[1] != 1 || afterSeqs[2] != 1 {
		t.Fatalf("client should retry from last committed after_seq, got %v", afterSeqs)
	}
}

func TestCloudAgentClientStreamDropsThenReplaysFromLastSeq(t *testing.T) {
	var eventCalls int
	var afterSeqs []int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			writeTestJSON(t, w, map[string]any{"run_id": "job-stream", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			eventCalls++
			afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
			afterSeqs = append(afterSeqs, afterSeq)
			switch eventCalls {
			case 1:
				writeCloudAgentTestSSE(t, w, "agent.message", map[string]any{
					"id": "evt_job-stream_1", "seq": 1, "type": "agent.message", "run_id": "job-stream", "session_id": "session-http",
					"content": []any{map[string]any{"type": "text", "text": "hello "}},
				})
				return
			default:
				if afterSeq != 1 {
					t.Fatalf("stream replay should resume from after_seq=1, got %d", afterSeq)
				}
				writeCloudAgentTestSSE(t, w, "agent.message", map[string]any{
					"id": "evt_job-stream_2", "seq": 2, "type": "agent.message", "run_id": "job-stream", "session_id": "session-http",
					"content": []any{map[string]any{"type": "text", "text": "world"}},
				})
				writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
					"id": "evt_job-stream_terminal", "type": "session.status_idle", "run_id": "job-stream", "session_id": "session-http",
					"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
				})
			}
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-stream/result":
			writeTestJSON(t, w, map[string]any{"run_id": "job-stream", "session_id": "session-http", "status": "running"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	result, err := client.PromptWithRunID(context.Background(), "session-http", "hello", "job-stream")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "hello world" || result.StopReason != "end_turn" {
		t.Fatalf("unexpected stream replay result: %#v", result)
	}
	if len(afterSeqs) != 2 || afterSeqs[0] != 0 || afterSeqs[1] != 1 {
		t.Fatalf("client should replay stream from last committed seq, got %v", afterSeqs)
	}
}

func TestCloudAgentClientStreamMalformedAfterEventCommitsSeqBeforeReplay(t *testing.T) {
	var streamCalls int
	var afterSeqs []int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			writeTestJSON(t, w, map[string]any{"run_id": "job-malformed-stream", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			streamCalls++
			afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
			afterSeqs = append(afterSeqs, afterSeq)
			if streamCalls == 1 {
				writeCloudAgentTestSSE(t, w, "agent.message", cloudAgentTestMessageEvent("job-malformed-stream", "session-http", 1, "first "))
				_, _ = w.Write([]byte("event: agent.message\n"))
				_, _ = w.Write([]byte("data: {not-json\n\n"))
				return
			}
			if afterSeq != 1 {
				t.Fatalf("client must replay after the committed seq, got after_seq=%d", afterSeq)
			}
			writeCloudAgentTestSSE(t, w, "agent.message", cloudAgentTestMessageEvent("job-malformed-stream", "session-http", 2, "second"))
			writeCloudAgentTestSSE(t, w, "session.status_idle", map[string]any{
				"id": "evt_job-malformed-stream_terminal", "type": "session.status_idle", "run_id": "job-malformed-stream", "session_id": "session-http",
				"status": "idle", "stop_reason": map[string]any{"type": "end_turn"},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-malformed-stream/result":
			writeTestJSON(t, w, map[string]any{"run_id": "job-malformed-stream", "session_id": "session-http", "status": "running"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	result, err := client.PromptWithRunID(context.Background(), "session-http", "hello", "job-malformed-stream")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "first second" || result.StopReason != "end_turn" {
		t.Fatalf("unexpected malformed stream replay result: %#v", result)
	}
	if len(afterSeqs) != 2 || afterSeqs[0] != 0 || afterSeqs[1] != 1 {
		t.Fatalf("client should commit seq before malformed stream replay, got %v", afterSeqs)
	}
}

func TestCloudAgentClientStreamSessionErrorReturnsRunFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/events":
			writeTestJSON(t, w, map[string]any{"run_id": "job-stream-error", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/cloudagent/runs/") && strings.HasSuffix(r.URL.Path, "/events"):
			writeCloudAgentTestSSE(t, w, "session.error", map[string]any{
				"id":         "evt_job-stream-error_error",
				"type":       "session.error",
				"run_id":     "job-stream-error",
				"session_id": "session-http",
				"error":      map[string]any{"message": "runtime failed"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	_, err := client.PromptWithRunID(context.Background(), "session-http", "hello", "job-stream-error")
	if err == nil || !strings.Contains(err.Error(), "runtime failed") {
		t.Fatalf("expected structured session.error failure, got %v", err)
	}
}

func cloudAgentTestMessageEvent(runID, sessionID string, seq int64, text string) map[string]any {
	return map[string]any{
		"id":         fmt.Sprintf("evt_%s_%d", runID, seq),
		"seq":        seq,
		"type":       "agent.message",
		"run_id":     runID,
		"session_id": sessionID,
		"content":    []any{map[string]any{"type": "text", "text": text}},
	}
}

func writeCloudAgentTestSSE(t *testing.T, w http.ResponseWriter, eventType string, payload any) {
	t.Helper()
	w.Header().Set("Content-Type", "text/event-stream")
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if item, ok := payload.(map[string]any); ok {
		if id, _ := item["id"].(string); id != "" {
			_, _ = fmt.Fprintf(w, "id: %s\n", id)
		}
	}
	_, _ = fmt.Fprintf(w, "event: %s\n", eventType)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func writeTestJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatal(err)
	}
}
