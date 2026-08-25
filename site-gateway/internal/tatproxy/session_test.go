package tatproxy

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type fixedStarter struct {
	wsURL string
	calls atomic.Int32
}

type blockingStarter struct {
	started chan struct{}
}

func (s *blockingStarter) Start(ctx context.Context, _ Target) (Bootstrap, error) {
	close(s.started)
	<-ctx.Done()
	return Bootstrap{}, ctx.Err()
}

func (s *fixedStarter) Start(_ context.Context, _ Target) (Bootstrap, error) {
	s.calls.Add(1)
	return Bootstrap{SessionID: "session-1", Region: "ap-beijing", InstanceID: "ins-test123", OwnerUIN: "10001", AppID: 1250000000, WSURL: s.wsURL}, nil
}

func TestManagerMultiplexesTATProxyConnections(t *testing.T) {
	var (
		wsConnections atomic.Int32
		mu            sync.Mutex
		proxyIDs      = make(map[string]bool)
		handlerDone   = make(chan struct{})
	)
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		defer close(handlerDone)
		wsConnections.Add(1)
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
		for {
			messageType, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if messageType != websocket.BinaryMessage {
				continue
			}
			var request frame
			if err := bson.Unmarshal(raw, &request); err != nil {
				t.Errorf("decode frame: %v", err)
				return
			}
			data := request.Data.Data
			switch request.Type {
			case "PtyProxyNew":
				if data.IP != remoteIP || data.Port != remotePort || data.ProxyID == "" {
					t.Errorf("new frame = %+v", data)
					return
				}
				mu.Lock()
				proxyIDs[data.ProxyID] = true
				mu.Unlock()
				writeTestFrame(t, conn, "PtyProxyReady", data.ProxyID, nil)
			case "PtyProxyData":
				writeTestFrame(t, conn, "PtyProxyData", data.ProxyID, data.Data)
			case "PtyProxyClose":
				writeTestFrame(t, conn, "PtyProxyClose", data.ProxyID, nil)
			}
		}
	}))
	defer server.Close()

	starter := &fixedStarter{wsURL: "ws" + strings.TrimPrefix(server.URL, "http")}
	manager, err := NewManager(ManagerOptions{
		Starter: starter, StartTimeout: time.Second, OpenTimeout: time.Second,
		IdleTimeout: time.Minute, MaxTargets: 4, MaxConnectionsPerTarget: 2, QueueDepth: 4,
		MaxFrameBytes: 1024, MaxBufferedBytesPerConn: 2048,
		MaxBufferedBytesPerTarget: 4096, MaxBufferedBytesTotal: 16384,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	target := Target{BotID: "bot-1", DelegatedSession: "delegated-1"}
	conn1, err := manager.DialContext(context.Background(), target)
	if err != nil {
		t.Fatalf("dial first: %v", err)
	}
	defer conn1.Close()
	conn2, err := manager.DialContext(context.Background(), target)
	if err != nil {
		t.Fatalf("dial second: %v", err)
	}
	defer conn2.Close()
	if _, err := manager.DialContext(context.Background(), target); !errors.Is(err, ErrConnectionLimit) {
		t.Fatalf("third dial error = %v, want connection limit", err)
	}
	manager.mu.Lock()
	sharedSession := manager.sessions[target.Key()].session
	manager.mu.Unlock()
	_ = sharedSession.ws.SetWriteDeadline(time.Now().Add(-time.Second))
	for i, conn := range []io.ReadWriteCloser{conn1, conn2} {
		message := []byte{byte('a' + i)}
		if _, err := conn.Write(message); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		got := make([]byte, 1)
		if _, err := io.ReadFull(conn, got); err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		if got[0] != message[0] {
			t.Fatalf("echo %d = %q", i, got)
		}
	}
	if starter.calls.Load() != 1 || wsConnections.Load() != 1 {
		t.Fatalf("starter/websocket calls = %d/%d, want 1/1", starter.calls.Load(), wsConnections.Load())
	}
	mu.Lock()
	if len(proxyIDs) != 2 {
		t.Fatalf("proxy ids = %v", proxyIDs)
	}
	mu.Unlock()
	_ = conn1.Close()
	_ = conn2.Close()
	manager.CloseTarget(target)
	manager.mu.Lock()
	_, cached := manager.sessions[target.Key()]
	manager.mu.Unlock()
	if cached {
		t.Fatal("target session remained cached after CloseTarget")
	}
	_ = manager.Close()
	select {
	case <-handlerDone:
	case <-time.After(time.Second):
		t.Fatal("TAT test server did not stop")
	}
}

func TestCloseTargetCancelsPendingSessionCreation(t *testing.T) {
	starter := &blockingStarter{started: make(chan struct{})}
	manager, err := NewManager(ManagerOptions{
		Starter: starter, StartTimeout: time.Minute, OpenTimeout: time.Second,
		IdleTimeout: time.Minute, MaxTargets: 1, MaxConnectionsPerTarget: 1, QueueDepth: 1,
		MaxFrameBytes: 1024, MaxBufferedBytesPerConn: 2048,
		MaxBufferedBytesPerTarget: 4096, MaxBufferedBytesTotal: 8192,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	target := Target{BotID: "bot-1", DelegatedSession: "delegated-1"}
	result := make(chan error, 1)
	go func() {
		_, err := manager.DialContext(context.Background(), target)
		result <- err
	}()
	select {
	case <-starter.started:
	case <-time.After(time.Second):
		t.Fatal("session creation did not start")
	}
	manager.CloseTarget(target)
	select {
	case err := <-result:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("dial error = %v, want closed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("pending session creation was not canceled")
	}
	manager.mu.Lock()
	_, cached := manager.sessions[target.Key()]
	manager.mu.Unlock()
	if cached {
		t.Fatal("canceled target remained cached")
	}
}

func TestTatConnReadDeadlineUnblocks(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, _, _ = conn.ReadMessage()
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var request frame
		_ = bson.Unmarshal(raw, &request)
		writeTestFrame(t, conn, "PtyProxyReady", request.Data.Data.ProxyID, nil)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	manager, _ := NewManager(ManagerOptions{
		Starter:      &fixedStarter{wsURL: "ws" + strings.TrimPrefix(server.URL, "http")},
		StartTimeout: time.Second, OpenTimeout: time.Second, IdleTimeout: time.Minute,
		MaxTargets: 1, MaxConnectionsPerTarget: 1, QueueDepth: 1,
		MaxFrameBytes: 1024, MaxBufferedBytesPerConn: 2048,
		MaxBufferedBytesPerTarget: 4096, MaxBufferedBytesTotal: 8192,
	})
	defer manager.Close()
	conn, err := manager.DialContext(context.Background(), Target{BotID: "bot-1", DelegatedSession: "delegated-1"})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Millisecond))
	if _, err := conn.Read(make([]byte, 1)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("read error = %v, want deadline exceeded", err)
	}
}

func TestManagerReconnectsAfterImmediateSessionClose(t *testing.T) {
	var connections atomic.Int32
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		attempt := connections.Add(1)
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
		if attempt == 1 {
			return
		}
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var request frame
		if err := bson.Unmarshal(raw, &request); err != nil {
			return
		}
		writeTestFrame(t, conn, "PtyProxyReady", request.Data.Data.ProxyID, nil)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	manager, err := NewManager(testManagerOptions(&fixedStarter{wsURL: "ws" + strings.TrimPrefix(server.URL, "http")}))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	target := Target{BotID: "bot-1", DelegatedSession: "delegated-1"}
	firstCtx, cancelFirst := context.WithTimeout(context.Background(), time.Second)
	defer cancelFirst()
	if conn, err := manager.DialContext(firstCtx, target); err == nil {
		_ = conn.Close()
		t.Fatal("first dial unexpectedly survived immediate websocket close")
	}
	secondCtx, cancelSecond := context.WithTimeout(context.Background(), time.Second)
	defer cancelSecond()
	conn, err := manager.DialContext(secondCtx, target)
	if err != nil {
		t.Fatalf("second dial did not reconnect: %v", err)
	}
	_ = conn.Close()
}

func TestManagerDropsSessionOnGlobalErrorFrame(t *testing.T) {
	var connections atomic.Int32
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		attempt := connections.Add(1)
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
		if attempt == 1 {
			_ = conn.WriteJSON(map[string]any{
				"Type": "Error",
				"Data": map[string]any{"Message": "denied"},
			})
			return
		}
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var request frame
		if err := bson.Unmarshal(raw, &request); err != nil {
			return
		}
		writeTestFrame(t, conn, "PtyProxyReady", request.Data.Data.ProxyID, nil)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	manager, err := NewManager(testManagerOptions(&fixedStarter{wsURL: "ws" + strings.TrimPrefix(server.URL, "http")}))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	target := Target{BotID: "bot-1", DelegatedSession: "delegated-1"}
	if conn, err := manager.DialContext(context.Background(), target); err == nil {
		_ = conn.Close()
		t.Fatal("dial unexpectedly survived global TAT error")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, err := manager.DialContext(ctx, target)
	if err != nil {
		t.Fatalf("dial after global error did not restart session: %v", err)
	}
	_ = conn.Close()
}

func TestBufferedByteBudgetsAreHierarchical(t *testing.T) {
	manager := &Manager{opts: ManagerOptions{
		MaxBufferedBytesPerConn: 4, MaxBufferedBytesPerTarget: 6, MaxBufferedBytesTotal: 8,
	}}
	session := &session{manager: manager}
	connA := &TatConn{}
	connB := &TatConn{}
	if !session.reserveBufferedBytes(connA, 4) {
		t.Fatal("first reservation failed")
	}
	if session.reserveBufferedBytes(connA, 1) {
		t.Fatal("per-connection budget was exceeded")
	}
	if session.reserveBufferedBytes(connB, 3) {
		t.Fatal("per-target budget was exceeded")
	}
	session.releaseBufferedBytes(connA, 4)
	if manager.bufferedBytes.Load() != 0 || session.bufferedBytes.Load() != 0 || connA.bufferedBytes.Load() != 0 {
		t.Fatalf("byte budgets leaked: total=%d target=%d conn=%d", manager.bufferedBytes.Load(), session.bufferedBytes.Load(), connA.bufferedBytes.Load())
	}
}

func TestTatConnReleasesConsumedBufferStorage(t *testing.T) {
	manager := &Manager{opts: ManagerOptions{
		MaxBufferedBytesPerConn: 2048, MaxBufferedBytesPerTarget: 4096, MaxBufferedBytesTotal: 8192,
	}}
	session := &session{manager: manager}
	conn := newTatConn(session, "proxy-1", 1)
	conn.deliver(make([]byte, 1024))
	got := make([]byte, 1024)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatal(err)
	}
	conn.mu.Lock()
	bufferLen, bufferCap := len(conn.buffer), cap(conn.buffer)
	conn.mu.Unlock()
	if bufferLen != 0 || bufferCap != 0 {
		t.Fatalf("consumed buffer retained storage: len=%d cap=%d", bufferLen, bufferCap)
	}
	if manager.bufferedBytes.Load() != 0 || session.bufferedBytes.Load() != 0 || conn.bufferedBytes.Load() != 0 {
		t.Fatalf("byte budgets leaked: total=%d target=%d conn=%d", manager.bufferedBytes.Load(), session.bufferedBytes.Load(), conn.bufferedBytes.Load())
	}
}

func TestTatConnWriteDeadlineIncludesWriterWait(t *testing.T) {
	session := &session{writeGate: make(chan struct{}, 1), done: make(chan struct{})}
	conn := newTatConn(session, "proxy-1", 1)
	result := make(chan error, 1)
	go func() {
		_, err := conn.Write([]byte("blocked"))
		result <- err
	}()
	_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Millisecond))
	select {
	case err := <-result:
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("write error = %v, want deadline exceeded", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("pending write ignored updated deadline")
	}
}

func TestTatConnCloseCancelsPendingWrite(t *testing.T) {
	session := &session{writeGate: make(chan struct{}, 1), done: make(chan struct{})}
	conn := newTatConn(session, "proxy-1", 1)
	result := make(chan error, 1)
	go func() {
		_, err := conn.Write([]byte("blocked"))
		result <- err
	}()
	_ = conn.Close()
	close(session.done)
	select {
	case err := <-result:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("write error = %v, want closed", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("pending write was not canceled by Close")
	}
}

func TestNewManagerRejectsUnsafeTransientMemoryLimits(t *testing.T) {
	opts := testManagerOptions(&fixedStarter{})
	opts.MaxTargets = 3
	opts.MaxFrameBytes = 1024
	opts.MaxBufferedBytesTotal = 8192
	if _, err := NewManager(opts); err == nil {
		t.Fatal("unsafe target/frame combination unexpectedly succeeded")
	}
}

func TestCurrentWriteStateRejectsExpiredDeadline(t *testing.T) {
	session := &session{writeGate: make(chan struct{}, 1), done: make(chan struct{})}
	conn := newTatConn(session, "proxy-1", 1)
	_ = conn.SetWriteDeadline(time.Now().Add(-time.Millisecond))
	if _, _, err := conn.currentWriteState(time.Now().Add(time.Second)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("write error = %v, want deadline exceeded", err)
	}
}

func testManagerOptions(starter Starter) ManagerOptions {
	return ManagerOptions{
		Starter: starter, StartTimeout: time.Second, OpenTimeout: time.Second,
		IdleTimeout: time.Minute, MaxTargets: 2, MaxConnectionsPerTarget: 2, QueueDepth: 4,
		MaxFrameBytes: 1024, MaxBufferedBytesPerConn: 2048,
		MaxBufferedBytesPerTarget: 4096, MaxBufferedBytesTotal: 8192,
	}
}

func writeTestFrame(t *testing.T, conn *websocket.Conn, typ, proxyID string, data []byte) {
	t.Helper()
	raw, err := bson.Marshal(frame{Type: typ, Data: envelope{Data: payload{ProxyID: proxyID, Data: data}}})
	if err != nil {
		t.Errorf("marshal frame: %v", err)
		return
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, raw); err != nil {
		return
	}
}
