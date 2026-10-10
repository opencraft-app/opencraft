package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestVerifiedObserverNativeThroughTATWire(t *testing.T) {
	if os.Getenv("OPENCRAFT_DESKTOP_NATIVE_TEST") != "1" {
		t.Skip("explicit isolated native observation only")
	}
	// Never install or start a unit. Fixture replaces PID discovery and the
	// cloud edge only; process identity, root/non-root access, HMAC and RFB are real.
	path := filepath.Join("..", "..", "..", "ctl", "pkg", "instance", "desktop_observer_proxy_test.py")
	command := exec.Command("python3", "-B", path, "--bridge")
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var diagnostics bytes.Buffer
	command.Stderr = &diagnostics
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	t.Cleanup(func() {
		_ = input.Close()
		select {
		case err := <-finished:
			if err != nil {
				t.Errorf("native fixture: %v %s", err, diagnostics.String())
			}
		case <-time.After(5 * time.Second):
			_ = command.Process.Kill()
			<-finished
			t.Error("native fixture did not retire")
		}
	})
	ready := make(chan []byte, 1)
	go func() { line, _ := bufio.NewReader(output).ReadBytes('\n'); ready <- line }()
	var endpoint struct {
		Port int `json:"port"`
	}
	select {
	case line := <-ready:
		if json.Unmarshal(line, &endpoint) != nil || endpoint.Port < 1024 || endpoint.Port > 65535 {
			t.Fatal("native fixture unavailable")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("native fixture startup timed out")
	}
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		channel := observerTestHandshake(t, conn, "5902")
		upstream, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(endpoint.Port)), time.Second)
		if err != nil {
			t.Error("native upstream unavailable")
			return
		}
		defer upstream.Close()
		if observerTestFrame(conn, "PtyProxyReady", channel, nil) != nil {
			return
		}
		go func() {
			buffer := make([]byte, 64*1024)
			for {
				n, err := upstream.Read(buffer)
				if n > 0 && observerTestFrame(conn, "PtyProxyData", channel, buffer[:n]) != nil {
					break
				}
				if err != nil {
					break
				}
			}
			_ = conn.Close()
		}()
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var frame desktopProxyFrame
			if kind != websocket.BinaryMessage || bson.Unmarshal(data, &frame) != nil || frame.Type != "PtyProxyData" {
				t.Error("unexpected native proxy frame")
				return
			}
			if _, err := upstream.Write(frame.Data.Data.Data); err != nil {
				return
			}
		}
	})
	defer server.Close()
	p := desktopObserverTestProvider(server.URL)
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	p.desktopObserverCommands = &observerCommands{key: key}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runtime, err := p.InspectDesktopObserver(ctx, "ap-test", "ins-test")
	if err != nil || !observerHex(runtime.Incarnation) {
		t.Fatal("real native identity did not verify")
	}
	opening, cancelOpening := context.WithCancel(ctx)
	defer cancelOpening()
	stream, err := p.OpenVerifiedDesktopObserver(opening, ctx, "ap-test", "ins-test", runtime.Incarnation)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	cancelOpening()
	greeting := make([]byte, 12)
	if _, err := io.ReadFull(stream, greeting); err != nil || string(greeting) != "RFB 003.008\n" {
		t.Fatal("native media or handoff was corrupted")
	}
	if _, err := stream.Write(greeting); err != nil {
		t.Fatal("native media write failed")
	}
	security := make([]byte, 2)
	if _, err := io.ReadFull(stream, security); err != nil || !bytes.Equal(security, []byte{1, 1}) {
		t.Fatal("native RFB transport did not preserve data")
	}
}
