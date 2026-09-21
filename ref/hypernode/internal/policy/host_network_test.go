package policy

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestHostNetworkTCPDrainAndHalfClose(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		payload, _ := io.ReadAll(connection)
		_, _ = connection.Write(append([]byte("echo:"), payload...))
	}()

	wake := make(chan struct{}, 1)
	network := newHostNetwork(func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	})
	defer network.closeAll()
	address := listener.Addr().(*net.TCPAddr)
	if _, err := network.connectTCP("forward", map[string]any{
		"hostname": "127.0.0.1", "port": int64(address.Port),
	}, map[string]any{"secureTransport": "off", "allowHalfOpen": true}); err != nil {
		t.Fatal(err)
	}
	if written, err := network.writeTCP("forward", []byte("sentinel")); err != nil || written != len("sentinel") {
		t.Fatal(err)
	}
	if err := network.closeTCPWrite("forward"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	var received []byte
	for time.Now().Before(deadline) {
		select {
		case <-wake:
		case <-time.After(time.Until(deadline)):
			t.Fatal("timed out waiting for tcp wake notification")
		}
		drained, drainErr := network.drainTCP("forward")
		if drainErr != nil {
			t.Fatal(drainErr)
		}
		received = append(received, drained["dataBytes"].([]byte)...)
		if drained["closed"].(bool) {
			if !bytes.Equal(received, []byte("echo:sentinel")) {
				t.Fatalf("unexpected tcp payload: %q", received)
			}
			return
		}
	}
	t.Fatal("timed out waiting for tcp close")
}

func TestHostNetworkRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Test") != "sentinel" {
			http.Error(writer, "missing header", http.StatusBadRequest)
			return
		}
		writer.Header().Set("X-Reply", "ok")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"created":true}`))
	}))
	defer server.Close()

	network := newHostNetwork()
	response, err := network.request(map[string]any{
		"method":  "POST",
		"url":     server.URL,
		"headers": map[string]any{"X-Test": "sentinel"},
		"body":    `{}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if response["status"] != http.StatusCreated || response["body"] != `{"created":true}` {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestHostNetworkWebSocketDrain(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Codex-Protocol-Version") != "3" {
			http.Error(writer, "missing protocol", http.StatusBadRequest)
			return
		}
		connection, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		_, payload, err := connection.ReadMessage()
		if err == nil {
			_ = connection.WriteMessage(websocket.TextMessage, append([]byte("echo:"), payload...))
		}
	}))
	defer server.Close()

	wake := make(chan struct{}, 1)
	network := newHostNetwork(func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	})
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	if err := network.openWebSocket("remote", url, map[string]any{"X-Codex-Protocol-Version": "3"}); err != nil {
		t.Fatal(err)
	}
	defer network.closeAll()
	if err := network.sendWebSocket("remote", "sentinel"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-wake:
		case <-time.After(time.Until(deadline)):
			t.Fatal("timed out waiting for websocket wake notification")
		}
		drained, err := network.drainWebSocket("remote")
		if err != nil {
			t.Fatal(err)
		}
		messages := drained["messages"].([]string)
		if len(messages) > 0 {
			if messages[0] != "echo:sentinel" {
				t.Fatalf("unexpected websocket payload: %q", messages[0])
			}
			return
		}
	}
	t.Fatal("timed out waiting for websocket frame")
}
