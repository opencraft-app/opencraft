package httpapi

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/command"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/data"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/terminal"
)

func TestTerminalAutoAttachesShell(t *testing.T) {
	t.Parallel()

	runnerHeaders := make(chan http.Header, 1)
	runnerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade runner websocket: %v", err)
			return
		}
		defer conn.Close()

		runnerHeaders <- r.Header.Clone()
		if err := conn.WriteJSON(terminal.Frame{Type: "output", Data: "runner online\n"}); err != nil {
			t.Errorf("write runner frame: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}))
	defer runnerServer.Close()

	server := NewServer(Config{
		Username:         "admin",
		Password:         "secret",
		Registry:         command.NewRegistry(data.StaticProvider{}),
		RunnerWS:         "ws" + strings.TrimPrefix(runnerServer.URL, "http"),
		RunnerToken:      "runner-secret",
		ProxyTokenSecret: "proxy-secret",
		ProxyURL:         "http://127.0.0.1:8084/admin/api/commands/proxy",
	})

	adminServer := httptest.NewServer(server)
	defer adminServer.Close()

	headers := http.Header{}
	headers.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("admin:secret")))

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(adminServer.URL, "http")+"/admin/ws/terminal", headers)
	if err != nil {
		t.Fatalf("dial admin websocket: %v", err)
	}
	defer conn.Close()

	var ready terminal.Frame
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read ready frame: %v", err)
	}
	if ready.Type != "ready" || ready.Mode != "shell" {
		t.Fatalf("expected ready shell frame, got %+v", ready)
	}

	var output terminal.Frame
	if err := conn.ReadJSON(&output); err != nil {
		t.Fatalf("read output frame: %v", err)
	}
	if output.Type != "output" || !strings.Contains(output.Data, "runner online") {
		t.Fatalf("expected runner output frame, got %+v", output)
	}

	select {
	case received := <-runnerHeaders:
		if got := received.Get("Authorization"); got != "Bearer runner-secret" {
			t.Fatalf("expected runner auth header, got %q", got)
		}
		if got := received.Get("X-Nextgen-Proxy-URL"); got != "http://127.0.0.1:8084/admin/api/commands/proxy" {
			t.Fatalf("expected proxy url header, got %q", got)
		}
		if got := received.Get("X-Nextgen-Proxy-Username"); got != "admin" {
			t.Fatalf("expected proxy username header, got %q", got)
		}
		if strings.TrimSpace(received.Get("X-Nextgen-Proxy-Token")) == "" {
			t.Fatal("expected proxy token header")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runner did not receive websocket connection")
	}
}
