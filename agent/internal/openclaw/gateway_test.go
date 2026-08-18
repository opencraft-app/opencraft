package openclaw

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"velachat/agent/internal/runtimeapi"
)

func TestDialGatewayUsesBackendLoopbackHandshake(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		connection, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()
		if err := connection.WriteJSON(map[string]any{
			"type":  "event",
			"event": "connect.challenge",
			"payload": map[string]any{
				"nonce": "challenge-test",
				"ts":    1787040600000,
			},
		}); err != nil {
			t.Error(err)
			return
		}
		_, raw, err := connection.ReadMessage()
		if err != nil {
			t.Error(err)
			return
		}
		var frame struct {
			Type   string `json:"type"`
			ID     string `json:"id"`
			Method string `json:"method"`
			Params struct {
				MinProtocol int `json:"minProtocol"`
				MaxProtocol int `json:"maxProtocol"`
				Client      struct {
					ID   string `json:"id"`
					Mode string `json:"mode"`
				} `json:"client"`
				Role   string   `json:"role"`
				Scopes []string `json:"scopes"`
				Auth   struct {
					Token string `json:"token"`
				} `json:"auth"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Error(err)
			return
		}
		if frame.Type != "req" || frame.Method != "connect" ||
			frame.Params.MinProtocol != 4 || frame.Params.MaxProtocol != 4 ||
			frame.Params.Client.ID != "gateway-client" ||
			frame.Params.Client.Mode != "backend" ||
			frame.Params.Role != "operator" ||
			strings.Join(frame.Params.Scopes, ",") !=
				"operator.read,operator.write" ||
			frame.Params.Auth.Token != "token-test" {
			t.Errorf("connect frame = %#v", frame)
			return
		}
		if err := connection.WriteJSON(map[string]any{
			"type": "res",
			"id":   frame.ID,
			"ok":   true,
			"payload": map[string]any{
				"type":     "hello-ok",
				"protocol": 4,
				"server":   map[string]any{"version": "2026.8.18", "connId": "c1"},
				"features": map[string]any{"methods": []string{"chat.send"}, "events": []string{"chat"}},
				"snapshot": map[string]any{},
				"auth":     map[string]any{"role": "operator", "scopes": frame.Params.Scopes},
				"policy":   map[string]any{"maxPayload": 1024, "maxBufferedBytes": 2048, "tickIntervalMs": 15000},
			},
		}); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()

	client, err := dialGateway(
		context.Background(),
		"ws"+strings.TrimPrefix(server.URL, "http"),
		"token-test",
		"v-test",
	)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
}

func TestSessionCompletesOnlyAfterFinalChatEvent(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		connection, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()
		_ = connection.WriteJSON(map[string]any{
			"type": "event", "event": "connect.challenge",
			"payload": map[string]any{"nonce": "n", "ts": 1787040600000},
		})
		var connect gatewayFrame
		if err := connection.ReadJSON(&connect); err != nil {
			t.Error(err)
			return
		}
		_ = connection.WriteJSON(map[string]any{
			"type": "res", "id": connect.ID, "ok": true,
			"payload": map[string]any{
				"type": "hello-ok", "protocol": 4,
				"server":   map[string]any{"version": "2026.8.18", "connId": "c1"},
				"features": map[string]any{"methods": []string{"chat.send"}, "events": []string{"chat"}},
				"snapshot": map[string]any{},
				"auth":     map[string]any{"role": "operator", "scopes": []string{"operator.read", "operator.write"}},
				"policy":   map[string]any{"maxPayload": 1024, "maxBufferedBytes": 2048, "tickIntervalMs": 15000},
			},
		})
		var send gatewayFrame
		if err := connection.ReadJSON(&send); err != nil {
			t.Error(err)
			return
		}
		if send.Method != "chat.send" {
			t.Errorf("method = %q", send.Method)
			return
		}
		var params struct {
			SessionKey     string `json:"sessionKey"`
			Message        string `json:"message"`
			Deliver        bool   `json:"deliver"`
			IdempotencyKey string `json:"idempotencyKey"`
		}
		if err := json.Unmarshal(send.Params, &params); err != nil {
			t.Error(err)
			return
		}
		if params.SessionKey != "agent:main:main" || params.Message != "hello" ||
			params.Deliver || params.IdempotencyKey == "" {
			t.Errorf("chat.send params = %#v", params)
			return
		}
		_ = connection.WriteJSON(map[string]any{
			"type": "res", "id": send.ID, "ok": true,
			"payload": map[string]any{"runId": "run-1", "status": "started"},
		})
		_ = connection.WriteJSON(map[string]any{
			"type": "event", "event": "chat",
			"payload": map[string]any{
				"runId": "run-1", "sessionKey": "agent:main:main", "state": "delta",
				"message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": "hel"}}},
			},
		})
		_ = connection.WriteJSON(map[string]any{
			"type": "event", "event": "chat",
			"payload": map[string]any{
				"runId": "run-1", "sessionKey": "agent:main:main", "state": "final",
				"message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": "hello"}}},
			},
		})
	}))
	defer server.Close()

	client, err := dialGateway(
		context.Background(),
		"ws"+strings.TrimPrefix(server.URL, "http"),
		"token-test",
		"v-test",
	)
	if err != nil {
		t.Fatal(err)
	}
	session := newRuntimeSession(client, "launch-1")
	defer session.Stop(context.Background())
	if err := session.Deliver(context.Background(), runtimeapi.Delivery{Text: "hello"}); err != nil {
		t.Fatal(err)
	}

	timeout := time.After(3 * time.Second)
	want := []runtimeapi.EventKind{
		runtimeapi.EventAssistantText,
		runtimeapi.EventTurnCompletion,
	}
	for index, kind := range want {
		select {
		case event := <-session.Events():
			if event.Kind != kind || event.LaunchID != "launch-1" {
				t.Fatalf("event[%d] = %#v", index, event)
			}
			if kind == runtimeapi.EventAssistantText && event.Text != "hello" {
				t.Fatalf("assistant text = %q", event.Text)
			}
		case <-timeout:
			t.Fatal("timed out waiting for OpenClaw completion")
		}
	}
}
