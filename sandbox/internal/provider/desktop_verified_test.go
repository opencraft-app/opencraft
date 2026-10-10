package provider

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// Only cloud command + WS peers are substituted. Key is synthetic; no cloud
// call or installed root key is read. Native process proof is tested in CTL.
type observerCommands struct {
	calls  atomic.Int32
	mutate func(*CommandResult)
	fail   bool
	key    []byte
}

func (c *observerCommands) RunCommand(_ context.Context, region, id, script string) (CommandInvocation, error) {
	c.calls.Add(1)
	if script != desktopObserverKeyCommand || c.fail {
		return CommandInvocation{}, errors.New("unavailable")
	}
	return CommandInvocation{InvocationID: "key-command", Region: region, InstanceID: id}, nil
}
func observerTestKey() []byte { return bytes.Repeat([]byte{7}, 32) }
func (c *observerCommands) GetCommandInvocation(_ context.Context, region, inv, id string) (CommandResult, error) {
	key := c.key
	if key == nil {
		key = observerTestKey()
	}
	output, _ := json.Marshal(map[string]any{"version": 1, "key": hex.EncodeToString(key)})
	result := CommandResult{CommandInvocation: CommandInvocation{InvocationID: inv, Region: region, InstanceID: id, Status: "SUCCESS"}, Output: string(output)}
	if c.mutate != nil {
		c.mutate(&result)
	}
	return result, nil
}
func observerProof(t *testing.T, conn *websocket.Conn, channel string) map[string]any {
	t.Helper()
	kind, data, err := conn.ReadMessage()
	if err != nil || kind != websocket.BinaryMessage {
		t.Fatalf("challenge unavailable: %v", err)
	}
	var frame desktopProxyFrame
	if bson.Unmarshal(data, &frame) != nil || frame.Type != "PtyProxyData" || frame.Data.Data.ProxyID != channel {
		t.Fatal("not an observer challenge")
	}
	var request struct {
		Nonce string `json:"nonce"`
	}
	if json.Unmarshal(frame.Data.Data.Data, &request) != nil || !observerHex(request.Nonce) {
		t.Fatal("bad challenge")
	}
	incarnation := strings.Repeat("a", 64)
	mac := hmac.New(sha256.New, observerTestKey())
	_, _ = mac.Write([]byte("opencraft-desktop-observer/v1\x00" + request.Nonce + "\x00" + incarnation))
	return map[string]any{"protocol": "opencraft-desktop-observer", "version": 1, "readOnly": true,
		"incarnation": incarnation, "nonce": request.Nonce, "mac": hex.EncodeToString(mac.Sum(nil))}
}

func TestVerifiedObserverPreservesBufferedMediaAndLifetimes(t *testing.T) {
	closed := make(chan struct{})
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		defer close(closed)
		channel := observerTestHandshake(t, conn, "5902")
		_ = observerTestFrame(conn, "PtyProxyReady", channel, nil)
		proof := observerProof(t, conn, channel)
		header, _ := json.Marshal(proof)
		_ = observerTestFrame(conn, "PtyProxyData", channel, append(append(header, '\n'), []byte("RFB 003.008\n")...))
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	defer server.Close()
	p := desktopObserverTestProvider(server.URL)
	commands := &observerCommands{}
	p.desktopObserverCommands = commands
	opening, cancelOpening := context.WithTimeout(context.Background(), 3*time.Second)
	lifetime, cancelLifetime := context.WithCancel(context.Background())
	defer cancelOpening()
	defer cancelLifetime()
	stream, err := p.OpenVerifiedDesktopObserver(opening, lifetime, "ap-test", "ins-test", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	cancelOpening()
	data := make([]byte, 12)
	if _, err := io.ReadFull(stream, data); err != nil || string(data) != "RFB 003.008\n" {
		t.Fatalf("buffered media lost: %v", err)
	}
	select {
	case <-closed:
		t.Fatal("handshake context retired a live viewer")
	default:
	}
	if commands.calls.Load() != 1 {
		t.Fatal("unexpected command replay")
	}
	cancelLifetime()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("lifetime did not close socket")
	}
}

func TestVerifiedObserverRejectsForgedOrStaleProof(t *testing.T) {
	for _, tc := range []struct {
		name     string
		mutate   func(map[string]any)
		expected string
	}{
		{"wrong_mac", func(p map[string]any) { p["mac"] = strings.Repeat("0", 64) }, ""},
		{"replayed_nonce", func(p map[string]any) { p["nonce"] = strings.Repeat("1", 64) }, ""},
		{"control_stream", func(p map[string]any) { p["readOnly"] = false }, ""},
		{"unknown_field", func(p map[string]any) { p["target"] = "other" }, ""},
		{"unknown_version", func(p map[string]any) { p["version"] = 2 }, ""},
		{"oversized", func(p map[string]any) { p["extra"] = strings.Repeat("x", 2048) }, ""},
		{"replaced_incarnation", nil, strings.Repeat("b", 64)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			closed := make(chan struct{})
			server := newTATStreamServer(t, func(conn *websocket.Conn) {
				defer close(closed)
				channel := observerTestHandshake(t, conn, "5902")
				_ = observerTestFrame(conn, "PtyProxyReady", channel, nil)
				proof := observerProof(t, conn, channel)
				if tc.mutate != nil {
					tc.mutate(proof)
				}
				header, _ := json.Marshal(proof)
				_ = observerTestFrame(conn, "PtyProxyData", channel, append(header, '\n'))
				for {
					if _, _, err := conn.ReadMessage(); err != nil {
						return
					}
				}
			})
			defer server.Close()
			p := desktopObserverTestProvider(server.URL)
			p.desktopObserverCommands = &observerCommands{}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			stream, runtime, err := p.openVerifiedDesktopObserver(ctx, ctx, "ap-test", "ins-test", tc.expected)
			if stream != nil || runtime.Incarnation != "" || err != errVerifiedObserver {
				t.Fatal("untrusted stream escaped")
			}
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("failed stream leaked")
			}
		})
	}
}

func TestVerifiedObserverKeyBoundaryRejectsUnknownResultsWithoutReplay(t *testing.T) {
	for _, mutate := range []func(*CommandResult){
		func(r *CommandResult) { r.Status = "FAILED" },
		func(r *CommandResult) { r.InstanceID = "other" },
		func(r *CommandResult) { r.Region = "other" },
		func(r *CommandResult) { r.InvocationID = "other" },
		func(r *CommandResult) { r.ExitCode = 1 },
		func(r *CommandResult) { r.Dropped = 1 },
		func(r *CommandResult) { r.Output = `{"version":1,"key":"invalid"}` },
		func(r *CommandResult) { r.Output += "{}" },
		func(r *CommandResult) { r.Output = strings.Repeat("x", 257) },
	} {
		p := desktopObserverTestProvider("unused")
		commands := &observerCommands{mutate: mutate}
		p.desktopObserverCommands = commands
		if _, err := p.InspectDesktopObserver(context.Background(), "ap-test", "ins-test"); err != errVerifiedObserver {
			t.Fatal("invalid key result accepted")
		}
		if commands.calls.Load() != 1 {
			t.Fatal("unknown result retried")
		}
	}
	commands := &observerCommands{fail: true}
	p := desktopObserverTestProvider("unused")
	p.desktopObserverCommands = commands
	if _, err := p.InspectDesktopObserver(context.Background(), "ap-test", "ins-test"); err != errVerifiedObserver {
		t.Fatal("failed command accepted")
	}
	if commands.calls.Load() != 1 {
		t.Fatal("failed command retried")
	}
}

func TestVerifiedObserverOpeningCancellationInterruptsHeaderRead(t *testing.T) {
	entered, closed := make(chan struct{}), make(chan struct{})
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		defer close(closed)
		channel := observerTestHandshake(t, conn, "5902")
		_ = observerTestFrame(conn, "PtyProxyReady", channel, nil)
		observerProof(t, conn, channel)
		close(entered)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	defer server.Close()
	p := desktopObserverTestProvider(server.URL)
	p.desktopObserverCommands = &observerCommands{}
	opening, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := p.OpenVerifiedDesktopObserver(opening, context.Background(), "ap-test", "ins-test", strings.Repeat("a", 64))
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("opening did not progress")
	}
	cancel()
	select {
	case err := <-result:
		if err != errVerifiedObserver {
			t.Fatal("cancel escaped")
		}
	case <-time.After(time.Second):
		t.Fatal("opening stuck")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("cancel leaked socket")
	}
}

func TestVerifiedObserverInspectReturnsOnlyIdentityAndClosesItsSocket(t *testing.T) {
	closed := make(chan struct{})
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		defer close(closed)
		channel := observerTestHandshake(t, conn, "5902")
		_ = observerTestFrame(conn, "PtyProxyReady", channel, nil)
		proof := observerProof(t, conn, channel)
		header, _ := json.Marshal(proof)
		_ = observerTestFrame(conn, "PtyProxyData", channel, append(header, '\n'))
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	defer server.Close()
	p := desktopObserverTestProvider(server.URL)
	p.desktopObserverCommands = &observerCommands{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	runtime, err := p.InspectDesktopObserver(ctx, "ap-test", "ins-test")
	if err != nil || runtime.Incarnation != strings.Repeat("a", 64) {
		t.Fatal("inspection did not verify physical identity")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("inspection retained a viewer")
	}
}

func TestObserverSeparateOpeningCancellationInterruptsProxyReadiness(t *testing.T) {
	entered, closed := make(chan struct{}), make(chan struct{})
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		defer close(closed)
		observerTestHandshake(t, conn, "5902")
		close(entered)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	defer server.Close()
	p := desktopObserverTestProvider(server.URL)
	opening, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		stream, err := p.openDesktopObserver(opening, context.Background(), "ap-test", "ins-test", "5902")
		if stream != nil {
			_ = stream.Close()
		}
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("proxy readiness did not progress")
	}
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("cancel escaped")
		}
	case <-time.After(time.Second):
		t.Fatal("readiness ignored cancel")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("cancel leaked socket")
	}
}

func TestObserverInternalEndpointCannotSelectLegacyOrArbitraryPort(t *testing.T) {
	p := desktopObserverTestProvider("unused")
	p.startTerminalSessionFunc = func(context.Context, string, string) (TerminalSession, error) {
		t.Fatal("invalid endpoint reached cloud execution")
		return TerminalSession{}, nil
	}
	for _, port := range []string{"5900", "22", "6080", "", "example:5902"} {
		stream, err := p.openDesktopObserver(context.Background(), context.Background(), "ap-test", "ins-test", port)
		if err == nil || stream != nil {
			t.Fatal("arbitrary endpoint escaped")
		}
	}
}
