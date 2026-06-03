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
	sessionID, err := client.NewSession(ctx, "/workspace")
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
	sessionID, err := client.NewSession(ctx, "/workspace")
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
	sessionID, err := client.NewSession(ctx, "/workspace")
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
	sessionID, err := client.NewSession(ctx, "/workspace")
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

func writeJSON(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	if err := conn.WriteJSON(value); err != nil {
		t.Fatalf("write json: %v", err)
	}
}
