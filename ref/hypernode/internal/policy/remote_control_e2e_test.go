package policy

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestRemoteControlPolicyBridgesClientIntoAppServer(t *testing.T) {
	connections := make(chan *websocket.Conn, 1)
	expectedInstallationID := ""
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/backend-api/wham/remote/control/server/enroll":
			if request.Header.Get("Chatgpt-Account-Id") != "account-test" ||
				request.Header.Get("X-Codex-Installation-Id") != expectedInstallationID {
				http.Error(writer, "missing auth headers", http.StatusUnauthorized)
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"server_id":"server-test","environment_id":"environment-test","remote_control_token":"remote-token","expires_at":"2099-01-01T00:00:00Z"}`))
		case "/backend-api/wham/remote/control/server/pair":
			if request.Header.Get("Authorization") != "Bearer remote-token" {
				http.Error(writer, "missing remote token", http.StatusUnauthorized)
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"server_id":"server-test","environment_id":"environment-test","pairing_code":"pair-test","manual_pairing_code":"MANUAL","expires_at":"2099-01-01T00:00:00Z"}`))
		case "/backend-api/wham/remote/control/server":
			if request.Header.Get("X-Codex-Protocol-Version") != "3" ||
				request.Header.Get("X-Codex-Server-Id") != "server-test" {
				http.Error(writer, "missing remote headers", http.StatusUnauthorized)
				return
			}
			connection, err := upgrader.Upgrade(writer, request, nil)
			if err == nil {
				connections <- connection
			}
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	root := t.TempDir()
	usersRoot := filepath.Join(root, "users")
	policyPath, err := filepath.Abs("../../policy/default.js")
	if err != nil {
		t.Fatal(err)
	}
	stateStore := newMemoryStore()
	if err := stateStore.Set("remoteControlPreference", "node:root:enabled", "true"); err != nil {
		t.Fatal(err)
	}
	engine, err := NewWithStoreConfig(policyPath, "", stateStore, RuntimeConfig{
		AuthenticationMode:   "debug",
		LocalhostRoot:        root,
		UsersRoot:            usersRoot,
		RemoteControlBaseURL: server.URL + "/backend-api",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	allowed, err := engine.AuthenticateNone(map[string]any{
		"connectionId": "remote-control-test", "username": "root", "remoteAddr": "127.0.0.1:1234",
	})
	if err != nil || !allowed {
		t.Fatalf("register test user: allowed=%v err=%v", allowed, err)
	}
	userCodexHome := filepath.Join(usersRoot, userHomeSegment("root"), ".codex")
	if err := os.WriteFile(filepath.Join(userCodexHome, "auth.json"), []byte(
		`{"auth_mode":"chatgpt","tokens":{"access_token":"access-test","account_id":"account-test"}}`,
	), 0o600); err != nil {
		t.Fatal(err)
	}
	installationBytes, err := os.ReadFile(filepath.Join(userCodexHome, "installation_id"))
	if err != nil {
		t.Fatal(err)
	}
	expectedInstallationID = strings.TrimSpace(string(installationBytes))
	stopTicks := make(chan struct{})
	defer close(stopTicks)
	go func() {
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopTicks:
				return
			case <-ticker.C:
				_ = engine.Tick()
			}
		}
	}()

	var connection *websocket.Conn
	deadline := time.Now().Add(2 * time.Second)
	for connection == nil && time.Now().Before(deadline) {
		select {
		case connection = <-connections:
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	if connection == nil {
		t.Fatal("timed out waiting for Remote websocket")
	}
	defer connection.Close()
	initialize := map[string]any{
		"type": "client_message", "client_id": "phone", "stream_id": "stream-1",
		"seq_id": 1, "cursor": "cursor-1",
		"message": map[string]any{
			"id": 0, "method": "initialize",
			"params": map[string]any{"clientInfo": map[string]any{"name": "remote-test", "version": "1"}},
		},
	}
	if err := connection.WriteJSON(initialize); err != nil {
		t.Fatal(err)
	}
	if err := engine.Tick(); err != nil {
		t.Fatal(err)
	}
	if err := connection.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Type     string `json:"type"`
		ClientID string `json:"client_id"`
		StreamID string `json:"stream_id"`
		SeqID    int    `json:"seq_id"`
		Message  struct {
			ID     int            `json:"id"`
			Result map[string]any `json:"result"`
		} `json:"message"`
	}
	if err := connection.ReadJSON(&envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Type != "server_message" || envelope.ClientID != "phone" ||
		envelope.StreamID != "stream-1" || envelope.SeqID != 1 || envelope.Message.ID != 0 {
		t.Fatalf("unexpected server envelope: %#v", envelope)
	}
	if envelope.Message.Result["platformFamily"] != "unix" {
		t.Fatalf("initialize response did not come from AppServerVService: %#v", envelope.Message.Result)
	}
	if err := connection.WriteJSON(map[string]any{
		"type": "client_message", "client_id": "phone", "stream_id": "stream-1", "seq_id": 2,
		"message": map[string]any{"id": 1, "method": "hypernode/device/read", "params": map[string]any{}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := engine.Tick(); err != nil {
		t.Fatal(err)
	}
	var deviceResult map[string]any
	for attempt := 0; attempt < 16 && deviceResult == nil; attempt++ {
		var candidate map[string]any
		if err := connection.ReadJSON(&candidate); err != nil {
			t.Fatal(err)
		}
		message, _ := candidate["message"].(map[string]any)
		if message["id"] == float64(1) {
			deviceResult, _ = message["result"].(map[string]any)
		}
	}
	if deviceResult["userId"] != "node:root" || deviceResult["installationId"] != expectedInstallationID {
		t.Fatalf("remote client lost tenant identity: %#v", deviceResult)
	}
	if err := connection.WriteJSON(map[string]any{
		"type": "client_message", "client_id": "phone", "stream_id": "stream-1", "seq_id": 3,
		"message": map[string]any{
			"id": 2, "method": "remoteControl/pairing/start", "params": map[string]any{"manualCode": true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := connection.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var pairingResult map[string]any
	for attempt := 0; attempt < 16 && pairingResult == nil; attempt++ {
		var candidate map[string]any
		if err := connection.ReadJSON(&candidate); err != nil {
			t.Fatal(err)
		}
		message, _ := candidate["message"].(map[string]any)
		if message["id"] == float64(2) {
			pairingResult, _ = message["result"].(map[string]any)
		}
	}
	if pairingResult["pairingCode"] != "pair-test" || pairingResult["manualPairingCode"] != "MANUAL" {
		t.Fatalf("remote pairing did not complete through deferred JS HTTP: %#v", pairingResult)
	}
}
