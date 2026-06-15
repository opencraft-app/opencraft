package acp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestClientCapturesPromptAgentMessageChunks(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64           `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Errorf("decode request: %v", err)
				return
			}
			switch req.Method {
			case "initialize":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/new":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": "session-a"}})
			case "session/prompt":
				writeJSON(t, conn, map[string]any{
					"jsonrpc": "2.0",
					"method":  "session/update",
					"params": map[string]any{
						"sessionId": "session-a",
						"update": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content":       map[string]any{"text": "hello"},
						},
					},
				})
				writeJSON(t, conn, map[string]any{
					"jsonrpc": "2.0",
					"method":  "session/update",
					"params": map[string]any{
						"sessionId": "session-a",
						"update": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content":       map[string]any{"text": " world"},
						},
					},
				})
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
			default:
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}))
	defer server.Close()
	client := NewClient("ws"+server.URL[len("http"):], nil)
	defer client.Close()
	ctx := context.Background()
	if err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	sessionID, err := client.NewSession(ctx, "/workspace", "")
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	result, err := client.Prompt(ctx, sessionID, "hi")
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if result.StopReason != "end_turn" || result.Text != "hello world" {
		t.Fatalf("unexpected prompt result: %#v", result)
	}
}

func TestClientUsesCloudAgentRunPromptWhenAvailable(t *testing.T) {
	var runCreateCalls atomic.Int64
	var runWaitCalls atomic.Int64
	var legacyPromptCalls atomic.Int64
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64           `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Errorf("decode request: %v", err)
				return
			}
			switch req.Method {
			case "initialize":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/new":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": "session-a"}})
			case "_cloudagent.run.create":
				runCreateCalls.Add(1)
				var params struct {
					SessionID string `json:"session_id"`
					Prompt    []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"prompt"`
				}
				if err := json.Unmarshal(req.Params, &params); err != nil {
					t.Errorf("decode run.create params: %v", err)
					return
				}
				if params.SessionID != "session-a" || len(params.Prompt) != 1 || params.Prompt[0].Text != "hi" {
					t.Errorf("unexpected run.create params: %#v", params)
					return
				}
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"run": map[string]any{"run_id": "run-a", "session_id": "session-a", "status": "running"}}})
			case "_cloudagent.run.wait":
				runWaitCalls.Add(1)
				writeJSON(t, conn, map[string]any{
					"jsonrpc": "2.0",
					"method":  "session/update",
					"params": map[string]any{
						"sessionId": "session-a",
						"update": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content":       map[string]any{"text": "streamed"},
						},
					},
				})
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"run": map[string]any{"run_id": "run-a", "session_id": "session-a", "status": "completed", "stop_reason": "end_turn", "output_text": "final text"}}})
			case "session/prompt":
				legacyPromptCalls.Add(1)
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "legacy disabled"}})
			default:
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}))
	defer server.Close()
	client := NewClient("ws"+server.URL[len("http"):], nil)
	defer client.Close()
	ctx := context.Background()
	if err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	sessionID, err := client.NewSession(ctx, "/workspace", "")
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	result, err := client.Prompt(ctx, sessionID, "hi")
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if result.StopReason != "end_turn" || result.Text != "final text" {
		t.Fatalf("unexpected prompt result: %#v", result)
	}
	if runCreateCalls.Load() != 1 || runWaitCalls.Load() != 1 || legacyPromptCalls.Load() != 0 {
		t.Fatalf("unexpected method calls: create=%d wait=%d legacy=%d", runCreateCalls.Load(), runWaitCalls.Load(), legacyPromptCalls.Load())
	}
}

func TestClientCapturesPromptAgentMessageChunksWithArrayContent(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64  `json:"id"`
				Method string `json:"method"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Errorf("decode request: %v", err)
				return
			}
			switch req.Method {
			case "initialize":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/new":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": "session-a"}})
			case "session/prompt":
				writeJSON(t, conn, map[string]any{
					"jsonrpc": "2.0",
					"method":  "session/update",
					"params": map[string]any{
						"sessionId": "session-a",
						"update": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content": []map[string]any{
								{"type": "text", "text": "hello"},
								{"type": "text", "text": " world"},
							},
						},
					},
				})
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
			default:
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}))
	defer server.Close()
	client := NewClient("ws"+server.URL[len("http"):], nil)
	defer client.Close()
	ctx := context.Background()
	if err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	sessionID, err := client.NewSession(ctx, "/workspace", "")
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	result, err := client.Prompt(ctx, sessionID, "hi")
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if result.StopReason != "end_turn" || result.Text != "hello world" {
		t.Fatalf("unexpected prompt result: %#v", result)
	}
}

func TestClientInitializeUsesNumericACPProtocolVersion(t *testing.T) {
	seenParams := make(chan map[string]any, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("read initialize: %v", err)
			return
		}
		var req struct {
			ID     int64          `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if req.Method != "initialize" {
			t.Errorf("first request method = %q", req.Method)
			return
		}
		seenParams <- req.Params
		writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
	}))
	defer server.Close()
	client := NewClient("ws"+server.URL[len("http"):], nil)
	defer client.Close()
	if err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	select {
	case params := <-seenParams:
		if params["protocolVersion"] != float64(1) {
			t.Fatalf("protocolVersion should be numeric ACP v1, got %#v", params["protocolVersion"])
		}
		if _, ok := params["clientCapabilities"].(map[string]any); !ok {
			t.Fatalf("missing clientCapabilities object: %#v", params)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not receive initialize params")
	}
}

func TestClientDispatchesWorkspaceLifecycleNotifications(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("read initialize: %v", err)
			return
		}
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if req.Method != "initialize" {
			t.Errorf("first request method = %q", req.Method)
			return
		}
		writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
		writeJSON(t, conn, map[string]any{
			"jsonrpc": "2.0",
			"method":  "_cloudagent.workspace.lifecycle",
			"params": map[string]any{
				"session_id":   "session-a",
				"generation":   2,
				"operation":    "storage",
				"phase":        "cleanup",
				"status":       "done",
				"label":        "Workspace stored",
				"elapsed_ms":   123,
				"lifecycle_id": "storage:session-a:cleanup",
				"timestamp":    "2026-06-04T00:00:00Z",
			},
		})
		<-r.Context().Done()
	}))
	defer server.Close()
	client := NewClient("ws"+server.URL[len("http"):], nil)
	defer client.Close()
	events := make(chan WorkspaceLifecycleEvent, 1)
	client.SetWorkspaceLifecycleHandler(func(event WorkspaceLifecycleEvent) {
		events <- event
	})
	if err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	select {
	case event := <-events:
		if event.SessionID != "session-a" || event.Generation != 2 || event.Operation != "storage" || event.Status != "done" || event.LifecycleID != "storage:session-a:cleanup" {
			t.Fatalf("unexpected lifecycle event: %#v", event)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for lifecycle event")
	}
}

func TestClientCloseSessionCallsStandardACPMethod(t *testing.T) {
	seen := make(chan map[string]any, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64          `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Errorf("decode request: %v", err)
				return
			}
			switch req.Method {
			case "initialize":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/close":
				seen <- req.Params
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			default:
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}))
	defer server.Close()
	client := NewClient("ws"+server.URL[len("http"):], nil)
	defer client.Close()
	ctx := context.Background()
	if err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if err := client.CloseSession(ctx, "session-close"); err != nil {
		t.Fatalf("close session: %v", err)
	}
	select {
	case params := <-seen:
		if params["sessionId"] != "session-close" {
			t.Fatalf("unexpected close params: %#v", params)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not receive session/close")
	}
}

func TestClientSendsWorkspaceKeyAsCloudAgentSessionMeta(t *testing.T) {
	var seenWorkspaceKey string
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64           `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Errorf("decode request: %v", err)
				return
			}
			switch req.Method {
			case "initialize":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/new":
				var params struct {
					Meta struct {
						CloudAgent struct {
							WorkspaceKey string `json:"workspace_key"`
						} `json:"cloudagent"`
					} `json:"_meta"`
				}
				if err := json.Unmarshal(req.Params, &params); err != nil {
					t.Errorf("decode session/new params: %v", err)
					return
				}
				seenWorkspaceKey = params.Meta.CloudAgent.WorkspaceKey
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": "session-a"}})
			default:
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}))
	defer server.Close()
	client := NewClient("ws"+server.URL[len("http"):], nil)
	defer client.Close()
	ctx := context.Background()
	if _, err := client.NewSession(ctx, "/workspace", "workspace-stable-a"); err != nil {
		t.Fatalf("new session: %v", err)
	}
	if seenWorkspaceKey != "workspace-stable-a" {
		t.Fatalf("session/new did not include workspace key, got %q", seenWorkspaceKey)
	}
}

func TestClientSerializesConcurrentPrompts(t *testing.T) {
	var activePrompts atomic.Int64
	var maxActivePrompts atomic.Int64
	var promptCalls atomic.Int64
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64           `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Errorf("decode request: %v", err)
				return
			}
			switch req.Method {
			case "initialize":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/new":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": "session-a"}})
			case "session/prompt":
				promptCalls.Add(1)
				active := activePrompts.Add(1)
				for {
					max := maxActivePrompts.Load()
					if active <= max || maxActivePrompts.CompareAndSwap(max, active) {
						break
					}
				}
				time.Sleep(50 * time.Millisecond)
				writeJSON(t, conn, map[string]any{
					"jsonrpc": "2.0",
					"method":  "session/update",
					"params": map[string]any{
						"sessionId": "session-a",
						"update": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content":       map[string]any{"text": "ok"},
						},
					},
				})
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
				activePrompts.Add(-1)
			default:
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}))
	defer server.Close()
	client := NewClient("ws"+server.URL[len("http"):], nil)
	defer client.Close()
	ctx := context.Background()
	if err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	sessionID, err := client.NewSession(ctx, "/workspace", "")
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := client.Prompt(ctx, sessionID, "hi")
			if err != nil {
				errs <- err
				return
			}
			if result.Text != "ok" {
				errs <- context.Canceled
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent prompt failed: %v", err)
	}
	if promptCalls.Load() != 2 {
		t.Fatalf("expected two prompt calls, got %d", promptCalls.Load())
	}
	if maxActivePrompts.Load() != 1 {
		t.Fatalf("ACP prompts must be serialized, max active=%d", maxActivePrompts.Load())
	}
}

func TestClientDropsConnectionAfterRPCError(t *testing.T) {
	var connections atomic.Int64
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connID := connections.Add(1)
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64  `json:"id"`
				Method string `json:"method"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Errorf("decode request: %v", err)
				return
			}
			switch req.Method {
			case "initialize":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/load":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": "load failed"}})
			case "session/new":
				if connID == 1 {
					t.Fatal("session/new reused failed connection")
				}
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": "session-new"}})
			default:
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}))
	defer server.Close()
	client := NewClient("ws"+server.URL[len("http"):], nil)
	defer client.Close()
	ctx := context.Background()
	if err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if err := client.LoadSession(ctx, "session-bad", "/workspace"); err == nil {
		t.Fatal("expected load failure")
	}
	sessionID, err := client.NewSession(ctx, "/workspace", "")
	if err != nil {
		t.Fatalf("new session after load failure: %v", err)
	}
	if sessionID != "session-new" {
		t.Fatalf("unexpected new session id: %s", sessionID)
	}
	if got := connections.Load(); got != 2 {
		t.Fatalf("expected reconnect after RPC error, got %d connections", got)
	}
}

func TestClientRetriesLoadSessionAfterTransportClose(t *testing.T) {
	var connections atomic.Int64
	var loadCalls atomic.Int64
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connID := connections.Add(1)
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64  `json:"id"`
				Method string `json:"method"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Errorf("decode request: %v", err)
				return
			}
			switch req.Method {
			case "initialize":
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/load":
				loadCalls.Add(1)
				if connID == 1 {
					_ = conn.Close()
					return
				}
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			default:
				writeJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}))
	defer server.Close()
	client := NewClient("ws"+server.URL[len("http"):], nil)
	defer client.Close()
	ctx := context.Background()
	if err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if err := client.LoadSession(ctx, "session-stale", "/workspace"); err != nil {
		t.Fatalf("load session should retry after stale transport close: %v", err)
	}
	if got := connections.Load(); got != 2 {
		t.Fatalf("expected one reconnect after stale transport close, got %d connections", got)
	}
	if got := loadCalls.Load(); got != 2 {
		t.Fatalf("expected load retry on fresh connection, got %d calls", got)
	}
}

func writeJSON(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	if err := conn.WriteJSON(value); err != nil {
		t.Fatalf("write json: %v", err)
	}
}
