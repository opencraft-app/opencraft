package acp

import (
	"context"
	"encoding/json"
	"errors"
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
	if !strings.Contains(err.Error(), "/v1/cloudagent/*") {
		t.Fatalf("error should identify missing run protocol routes, got %v", err)
	}
}

func TestCloudAgentClientInitializePrefersCapabilities(t *testing.T) {
	var selfCheckCalled atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/capabilities":
			writeTestJSON(t, w, map[string]any{
				"object":       "cloudagent.capabilities",
				"protocol":     "cloudagent.run",
				"version":      "v1",
				"run_protocol": true,
				"features":     []string{"after_seq_replay"},
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
				"object":       "cloudagent.capabilities",
				"protocol":     "cloudagent.run",
				"version":      "v1",
				"run_protocol": false,
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	err := client.Initialize(context.Background())
	if err == nil {
		t.Fatal("expected capabilities without run_protocol to fail")
	}
	if !IsCloudAgentProtocolUnavailable(err) {
		t.Fatalf("expected CloudAgentProtocolUnavailableError, got %T %v", err, err)
	}
}

func TestCloudAgentClientInitializeAcceptsSelfCheck503WhenRunProtocolIsAdvertised(t *testing.T) {
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
	if err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("selfcheck 503 must not hide advertised run protocol capability: %v", err)
	}
}

func TestCloudAgentClientInitializeAllowsMissingSelfCheckForCompatibility(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	if err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("missing selfcheck should be left to concrete run route validation: %v", err)
	}
}

func TestCloudAgentClientPromptUsesRunReplayAndResult(t *testing.T) {
	var sawAfterSeq bool
	var resultCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions":
			writeTestJSON(t, w, map[string]any{"session_id": "session-http", "state": "ready"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/sessions/session-http":
			writeTestJSON(t, w, map[string]any{"session_id": "session-http", "state": "ready"})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/runs":
			var req struct {
				RunID string `json:"run_id"`
				Text  string `json:"text"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode run submit: %v", err)
			}
			if req.RunID == "" || req.Text != "hello" {
				t.Errorf("run submit should include idempotency run_id and text, got %#v", req)
			}
			writeTestJSON(t, w, map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-http/events":
			afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
			if afterSeq > 0 {
				sawAfterSeq = true
				writeTestJSON(t, w, map[string]any{"events": []any{}})
				return
			}
			writeTestJSON(t, w, map[string]any{"events": []any{
				map[string]any{"seq": 1, "event": map[string]any{"content": map[string]any{"text": "partial"}}},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-http/result":
			resultCalls++
			if resultCalls == 1 {
				writeTestJSON(t, w, map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "running"})
				return
			}
			writeTestJSON(t, w, map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "completed", "stop_reason": "end_turn", "output_text": "final"})
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

func TestCloudAgentClientFallbackOutputIgnoresUserReplayChunks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/runs":
			writeTestJSON(t, w, map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-http/events":
			writeTestJSON(t, w, map[string]any{"events": []any{
				map[string]any{"seq": 1, "kind": "user_message", "event": map[string]any{"sessionUpdate": "user_message_chunk", "content": map[string]any{"text": "user text"}}},
				map[string]any{"seq": 2, "kind": "assistant_text", "event": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"text": "assistant text"}}},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-http/result":
			writeTestJSON(t, w, map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "completed", "stop_reason": "end_turn"})
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
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/runs":
			writeTestJSON(t, w, map[string]any{"run_id": "job-cancel-me", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-cancel-me/events":
			if completed.Load() {
				writeTestJSON(t, w, map[string]any{
					"run": map[string]any{"run_id": "job-cancel-me", "session_id": "session-http", "status": "completed", "stop_reason": "end_turn"},
					"events": []any{
						map[string]any{"seq": 1, "kind": "assistant_text", "event": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"text": "still running after observer timeout"}}},
					},
				})
				return
			}
			writeTestJSON(t, w, map[string]any{"run": map[string]any{"run_id": "job-cancel-me", "session_id": "session-http", "status": "running"}, "events": []any{}})
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
		t.Fatalf("same run_id should be resumable after observer timeout, got %#v", result)
	}
}

func TestCloudAgentClientTreatsSubmitTimeoutAsReplayable(t *testing.T) {
	var submitCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/runs":
			submitCalls.Add(1)
			if submitCalls.Load() == 1 {
				time.Sleep(120 * time.Millisecond)
				writeTestJSON(t, w, map[string]any{"run_id": "job-submit-timeout", "session_id": "session-http", "status": "running"})
				return
			}
			writeTestJSON(t, w, map[string]any{"run_id": "job-submit-timeout", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-submit-timeout/events":
			writeTestJSON(t, w, map[string]any{
				"run": map[string]any{"run_id": "job-submit-timeout", "session_id": "session-http", "status": "completed", "stop_reason": "end_turn"},
				"events": []any{
					map[string]any{"seq": 1, "kind": "assistant_text", "event": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"text": "submit recovered"}}},
				},
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

func TestCloudAgentClientDoesNotHideSubmitCallerErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/runs" {
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
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/runs":
			writeTestJSON(t, w, map[string]any{"run_id": "job-cancelled", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-cancelled/events":
			writeTestJSON(t, w, map[string]any{
				"run":    map[string]any{"run_id": "job-cancelled", "session_id": "session-http", "status": "cancelled"},
				"events": []any{},
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
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/runs":
			writeTestJSON(t, w, map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-http/events":
			eventCalls++
			afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
			afterSeqs = append(afterSeqs, afterSeq)
			switch eventCalls {
			case 1:
				writeTestJSON(t, w, map[string]any{"events": []any{
					map[string]any{"seq": 1, "kind": "assistant_text", "event": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"text": "hello "}}},
				}})
			case 2:
				http.Error(w, "temporary gateway restart", http.StatusBadGateway)
			default:
				writeTestJSON(t, w, map[string]any{
					"run": map[string]any{"run_id": "job-http", "session_id": "session-http", "status": "completed", "stop_reason": "end_turn"},
					"events": []any{
						map[string]any{"seq": 1, "kind": "assistant_text", "event": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"text": "hello "}}},
						map[string]any{"seq": 2, "kind": "assistant_text", "event": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"text": "world"}}},
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
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/runs":
			writeTestJSON(t, w, map[string]any{"run_id": "job-stream", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-stream/events":
			if r.URL.Query().Get("stream") != "true" {
				t.Fatalf("client should use cloudagent event stream before polling fallback, query=%s", r.URL.RawQuery)
			}
			eventCalls++
			afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
			afterSeqs = append(afterSeqs, afterSeq)
			w.Header().Set("Content-Type", "application/x-ndjson")
			encoder := json.NewEncoder(w)
			switch eventCalls {
			case 1:
				_ = encoder.Encode(map[string]any{
					"type": "event",
					"event": map[string]any{
						"seq":  1,
						"kind": "assistant_text",
						"event": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content":       map[string]any{"text": "hello "},
						},
					},
				})
				if flusher, ok := w.(http.Flusher); ok {
					flusher.Flush()
				}
				return
			default:
				if afterSeq != 1 {
					t.Fatalf("stream replay should resume from after_seq=1, got %d", afterSeq)
				}
				_ = encoder.Encode(map[string]any{
					"type": "event",
					"event": map[string]any{
						"seq":  2,
						"kind": "assistant_text",
						"event": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content":       map[string]any{"text": "world"},
						},
					},
				})
				_ = encoder.Encode(map[string]any{
					"type": "run",
					"run": map[string]any{
						"run_id":      "job-stream",
						"session_id":  "session-http",
						"status":      "completed",
						"stop_reason": "end_turn",
					},
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
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/runs":
			writeTestJSON(t, w, map[string]any{"run_id": "job-malformed-stream", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-malformed-stream/events":
			if r.URL.Query().Get("stream") != "true" {
				t.Fatalf("malformed stream test should stay on stream path, query=%s", r.URL.RawQuery)
			}
			streamCalls++
			afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
			afterSeqs = append(afterSeqs, afterSeq)
			w.Header().Set("Content-Type", "application/x-ndjson")
			if streamCalls == 1 {
				_, _ = w.Write([]byte(`{"type":"event","event":{"seq":1,"kind":"assistant_text","event":{"sessionUpdate":"agent_message_chunk","content":{"text":"first "}}}}` + "\n"))
				_, _ = w.Write([]byte(`{not-json` + "\n"))
				return
			}
			if afterSeq != 1 {
				t.Fatalf("client must replay after the committed seq, got after_seq=%d", afterSeq)
			}
			encoder := json.NewEncoder(w)
			_ = encoder.Encode(map[string]any{
				"type": "event",
				"event": map[string]any{
					"seq":  2,
					"kind": "assistant_text",
					"event": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content":       map[string]any{"text": "second"},
					},
				},
			})
			_ = encoder.Encode(map[string]any{
				"type": "run",
				"run": map[string]any{
					"run_id":      "job-malformed-stream",
					"session_id":  "session-http",
					"status":      "completed",
					"stop_reason": "end_turn",
				},
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

func TestCloudAgentClientStreamInitialErrorFallsBackToJSONEvents(t *testing.T) {
	var jsonEventsCalled atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cloudagent/sessions/session-http/runs":
			writeTestJSON(t, w, map[string]any{"run_id": "job-stream-error", "session_id": "session-http", "status": "running"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cloudagent/runs/job-stream-error/events":
			if r.URL.Query().Get("stream") == "true" {
				w.Header().Set("Content-Type", "application/x-ndjson")
				_ = json.NewEncoder(w).Encode(map[string]any{"type": "error", "error": "stream temporarily unavailable"})
				return
			}
			jsonEventsCalled.Store(true)
			writeTestJSON(t, w, map[string]any{
				"run": map[string]any{"run_id": "job-stream-error", "session_id": "session-http", "status": "completed", "stop_reason": "end_turn"},
				"events": []any{
					map[string]any{"seq": 1, "kind": "assistant_text", "event": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"text": "json fallback"}}},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewCloudAgentClient(server.URL, nil)
	result, err := client.PromptWithRunID(context.Background(), "session-http", "hello", "job-stream-error")
	if err != nil {
		t.Fatal(err)
	}
	if !jsonEventsCalled.Load() {
		t.Fatal("initial stream error should fall back to non-stream events endpoint")
	}
	if result.Text != "json fallback" || result.StopReason != "end_turn" {
		t.Fatalf("unexpected stream error fallback result: %#v", result)
	}
}

func writeTestJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatal(err)
	}
}
