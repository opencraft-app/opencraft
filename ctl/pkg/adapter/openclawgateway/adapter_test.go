package openclawgateway

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func TestAdapterCallCompletesGatewayHandshakeAndRequest(t *testing.T) {
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		if err := websocket.JSON.Send(conn, map[string]interface{}{
			"type":    "event",
			"event":   "connect.challenge",
			"payload": map[string]interface{}{"nonce": "nonce-1"},
		}); err != nil {
			t.Errorf("send challenge: %v", err)
			return
		}

		var connectReq requestFrame
		if err := websocket.JSON.Receive(conn, &connectReq); err != nil {
			t.Errorf("receive connect req: %v", err)
			return
		}
		if connectReq.Method != "connect" {
			t.Errorf("expected connect method, got %s", connectReq.Method)
			return
		}
		rawParams, _ := json.Marshal(connectReq.Params)
		if !strings.Contains(string(rawParams), `"token":"test-token"`) {
			t.Errorf("expected token in connect params, got %s", string(rawParams))
		}
		if !strings.Contains(string(rawParams), `"minProtocol":3`) || !strings.Contains(string(rawParams), `"maxProtocol":3`) {
			t.Errorf("expected protocol v3 in connect params, got %s", string(rawParams))
		}
		if err := websocket.JSON.Send(conn, map[string]interface{}{
			"type": "res",
			"id":   "connect",
			"ok":   true,
			"payload": map[string]interface{}{
				"type": "hello-ok",
			},
		}); err != nil {
			t.Errorf("send connect res: %v", err)
			return
		}

		var req requestFrame
		if err := websocket.JSON.Receive(conn, &req); err != nil {
			t.Errorf("receive method req: %v", err)
			return
		}
		if req.Method != "cron.list" {
			t.Errorf("expected cron.list method, got %s", req.Method)
			return
		}
		if err := websocket.JSON.Send(conn, map[string]interface{}{
			"type": "res",
			"id":   req.ID,
			"ok":   true,
			"payload": map[string]interface{}{
				"jobs":   []interface{}{},
				"total":  0,
				"limit":  50,
				"offset": 0,
			},
		}); err != nil {
			t.Errorf("send method res: %v", err)
		}
	}))
	defer server.Close()

	url := "ws" + strings.TrimPrefix(server.URL, "http")
	adapter := NewAdapter(&AdapterConfig{Timeout: 3 * time.Second}, nil)
	var payload struct {
		Total int `json:"total"`
	}
	if err := adapter.Call(context.Background(), url, "test-token", "cron.list", map[string]interface{}{"limit": 50}, &payload); err != nil {
		t.Fatalf("call adapter: %v", err)
	}
	if payload.Total != 0 {
		t.Fatalf("expected total 0, got %d", payload.Total)
	}
}

func TestAdapterCallFailsWithoutToken(t *testing.T) {
	adapter := NewAdapter(&AdapterConfig{Timeout: time.Second}, nil)
	if err := adapter.Call(context.Background(), "ws://127.0.0.1:18789", "", "cron.list", nil, nil); err == nil {
		t.Fatalf("expected missing token error")
	}
}
