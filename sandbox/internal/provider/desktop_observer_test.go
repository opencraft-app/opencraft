package provider

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func desktopObserverTestProvider(url string) *TencentCloudProvider {
	return &TencentCloudProvider{cfg: TencentConfig{Region: "ap-test"},
		startTerminalSessionFunc: func(ctx context.Context, region, id string) (TerminalSession, error) {
			return TerminalSession{SessionID: "observer-test", OwnerUin: "test-owner", AppID: 1, InstanceID: id, Region: region}, nil
		}, tatForwardURLFunc: func(string) string { return websocketURL(url) }}
}

func observerTestFrame(conn *websocket.Conn, kind, channel string, data []byte) error {
	payload, err := bson.Marshal(map[string]any{"Type": kind, "Data": map[string]any{
		"SessionId": "observer-test", "ChannelId": channel, "Data": map[string]any{"ProxyId": channel, "Data": data},
	}})
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.BinaryMessage, payload)
}

func observerTestHandshake(t *testing.T, conn *websocket.Conn, ports ...string) string {
	t.Helper()
	port := "5901"
	if len(ports) != 0 {
		port = ports[0]
	}
	auth := readJSONFrame(t, conn)
	assertFrameData(t, auth, "SessionAuth", map[string]any{"InstanceId": "ins-test", "SessionId": "observer-test", "Uin": "test-owner", "AppId": float64(1)})
	kind, payload, err := conn.ReadMessage()
	if err != nil || kind != websocket.BinaryMessage {
		t.Fatalf("expected BSON proxy opening: %v", err)
	}
	// Tags below are necessary: BSON fields preserve protocol capitalization.
	var frame desktopProxyFrame
	if err := bson.Unmarshal(payload, &frame); err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Data struct {
			Data struct {
				IP   string `bson:"Ip"`
				Port string `bson:"Port"`
			} `bson:"Data"`
		} `bson:"Data"`
	}
	if err := bson.Unmarshal(payload, &envelope); err != nil {
		t.Fatal(err)
	}
	if frame.Type != "PtyProxyNew" || envelope.Data.Data.IP != "127.0.0.1" || envelope.Data.Data.Port != port || frame.Data.ChannelID == "" || frame.Data.Data.ProxyID != frame.Data.ChannelID {
		t.Fatalf("not a fixed observer endpoint: %s %s %s", frame.Type, envelope.Data.Data.IP, envelope.Data.Data.Port)
	}
	return frame.Data.ChannelID
}

func TestDesktopObserverBinaryStreamIsBoundedAndOrdered(t *testing.T) {
	data := bytes.Repeat([]byte{0, 255, 128, 1}, desktopObserverMaxFrame/4)
	returned := bytes.Repeat([]byte{200, 0, 255}, 50000)
	serverResult := make(chan error, 1)
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		channel := observerTestHandshake(t, conn)
		if err := observerTestFrame(conn, "PtyProxyReady", channel, nil); err != nil {
			serverResult <- err
			return
		}
		if err := observerTestFrame(conn, "PtyProxyData", channel, data); err != nil {
			serverResult <- err
			return
		}
		var got []byte
		for len(got) < len(returned) {
			kind, payload, err := conn.ReadMessage()
			if err != nil {
				serverResult <- err
				return
			}
			var frame desktopProxyFrame
			if kind != websocket.BinaryMessage || bson.Unmarshal(payload, &frame) != nil || frame.Type != "PtyProxyData" || frame.Data.ChannelID != channel || frame.Data.Data.ProxyID != channel || len(frame.Data.Data.Data) > 64*1024 {
				serverResult <- errors.New("invalid write frame")
				return
			}
			got = append(got, frame.Data.Data.Data...)
		}
		if !bytes.Equal(got, returned) {
			serverResult <- errors.New("binary write corrupted")
			return
		}
		serverResult <- observerTestFrame(conn, "PtyProxyClose", channel, nil)
	})
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := desktopObserverTestProvider(server.URL).OpenDesktopObserver(ctx, "ap-test", "ins-test")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got := make([]byte, len(data))
	if _, err := io.ReadFull(s, got); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("binary read: %v", err)
	}
	if n, err := s.Write(returned); err != nil || n != len(returned) {
		t.Fatalf("binary write: %d %v", n, err)
	}
	if err := <-serverResult; err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
		t.Fatalf("remote close: %v", err)
	}
}

func TestDesktopObserverRejectsWrongReadyOrChannel(t *testing.T) {
	for _, tc := range []struct {
		name, kind string
		wrong      bool
	}{
		{"wrong_ready_channel", "PtyProxyReady", true},
		{"input_before_ready", "PtyProxyData", false},
		{"remote_error", "Error", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			closed := make(chan struct{})
			server := newTATStreamServer(t, func(conn *websocket.Conn) {
				defer close(closed)
				channel := observerTestHandshake(t, conn)
				if tc.wrong {
					channel += "-other"
				}
				_ = observerTestFrame(conn, tc.kind, channel, nil)
				_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
				_, _, _ = conn.ReadMessage()
			})
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			s, err := desktopObserverTestProvider(server.URL).OpenDesktopObserver(ctx, "ap-test", "ins-test")
			if err == nil || s != nil {
				t.Fatal("accepted invalid readiness")
			}
			select {
			case <-closed:
			case <-ctx.Done():
				t.Fatal("failed opening leaked socket")
			}
		})
	}
}

func TestDesktopObserverCancelUnblocksBackpressureAndClosesOwnSocket(t *testing.T) {
	for _, phase := range []string{"opening", "unread_data", "read"} {
		t.Run(phase, func(t *testing.T) {
			ready := make(chan struct{})
			closed := make(chan struct{})
			server := newTATStreamServer(t, func(conn *websocket.Conn) {
				defer close(closed)
				channel := observerTestHandshake(t, conn)
				if phase != "opening" {
					_ = observerTestFrame(conn, "PtyProxyReady", channel, nil)
					if phase == "unread_data" {
						_ = observerTestFrame(conn, "PtyProxyData", channel, bytes.Repeat([]byte{42}, desktopObserverMaxFrame))
					}
				}
				close(ready)
				_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
				_, _, _ = conn.ReadMessage()
			})
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan io.ReadWriteCloser, 1)
			go func() {
				s, _ := desktopObserverTestProvider(server.URL).OpenDesktopObserver(ctx, "ap-test", "ins-test")
				result <- s
			}()
			<-ready
			if phase == "opening" {
				cancel()
				if s := <-result; s != nil {
					s.Close()
					t.Fatal("cancelled opening returned stream")
				}
			} else {
				s := <-result
				if s == nil {
					t.Fatal("opening failed")
				}
				cancel()
				_ = s.Close()
				_ = s.Close()
				if _, err := s.Write([]byte{1}); err == nil {
					t.Fatal("retired stream accepts write")
				}
				if _, err := s.Read(make([]byte, 1)); err == nil {
					t.Fatal("cancelled read did not unblock")
				}
			}
			select {
			case <-closed:
			case <-time.After(3 * time.Second):
				t.Fatal("socket not retired")
			}
		})
	}
}

func TestDesktopObserverRejectsMismatchedSessionWithoutDial(t *testing.T) {
	for _, field := range []string{"region", "instance", "credentials", "cancelled"} {
		t.Run(field, func(t *testing.T) {
			var dials atomic.Int32
			p := desktopObserverTestProvider("unused")
			p.startTerminalSessionFunc = func(ctx context.Context, region, id string) (TerminalSession, error) {
				s := TerminalSession{SessionID: "test", OwnerUin: "test-owner", AppID: 1, Region: region, InstanceID: id}
				switch field {
				case "region":
					s.Region = "ap-other"
				case "instance":
					s.InstanceID = "other"
				case "credentials":
					s.SessionID = ""
				}
				return s, nil
			}
			p.tatForwardURLFunc = func(string) string { dials.Add(1); return "ws://127.0.0.1:1" }
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if field == "cancelled" {
				cancel()
			}
			if s, err := p.OpenDesktopObserver(ctx, "ap-test", "ins-test"); err == nil || s != nil || dials.Load() != 0 {
				t.Fatal("unverified session reached transport")
			}
		})
	}
}

func TestDesktopObserverReceiveFailsClosed(t *testing.T) {
	for _, phase := range []string{"foreign_channel", "oversize", "unknown_type"} {
		t.Run(phase, func(t *testing.T) {
			server := newTATStreamServer(t, func(conn *websocket.Conn) {
				channel := observerTestHandshake(t, conn)
				_ = observerTestFrame(conn, "PtyProxyReady", channel, nil)
				kind := "PtyProxyData"
				data := []byte{1}
				switch phase {
				case "foreign_channel":
					channel += "-foreign"
				case "oversize":
					data = bytes.Repeat([]byte{1}, desktopObserverMaxFrame+1)
				case "unknown_type":
					kind = "PtyReady"
				}
				_ = observerTestFrame(conn, kind, channel, data)
				_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
				_, _, _ = conn.ReadMessage()
			})
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			s, err := desktopObserverTestProvider(server.URL).OpenDesktopObserver(ctx, "ap-test", "ins-test")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if _, err := s.Read(make([]byte, 1)); err == nil {
				t.Fatal("invalid input exposed")
			}
		})
	}
}

func TestDesktopObserverConnectionsHaveIndependentPhysicalLifetime(t *testing.T) {
	closed := make(chan string, 2)
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		channel := observerTestHandshake(t, conn)
		_ = observerTestFrame(conn, "PtyProxyReady", channel, nil)
		_ = conn.SetReadDeadline(time.Now().Add(4 * time.Second))
		for {
			kind, payload, err := conn.ReadMessage()
			if err != nil {
				closed <- channel
				return
			}
			var frame desktopProxyFrame
			if kind != websocket.BinaryMessage || bson.Unmarshal(payload, &frame) != nil {
				return
			}
			if err := observerTestFrame(conn, "PtyProxyData", channel, frame.Data.Data.Data); err != nil {
				return
			}
		}
	})
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	p := desktopObserverTestProvider(server.URL)
	first, err := p.OpenDesktopObserver(ctx, "ap-test", "ins-test")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := p.OpenDesktopObserver(ctx, "ap-test", "ins-test")
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	first.Close()
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("first physical socket stayed alive")
	}
	data := []byte{255, 0, 130}
	if _, err := second.Write(data); err != nil {
		t.Fatal("other viewer was retired")
	}
	got := make([]byte, len(data))
	if _, err := io.ReadFull(second, got); err != nil || !bytes.Equal(data, got) {
		t.Fatalf("other viewer cannot receive: %v", err)
	}
	select {
	case <-closed:
		t.Fatal("second socket was retired")
	default:
	}
}

func TestDesktopObserverOpeningDeadlineClosesSocket(t *testing.T) {
	closed := make(chan struct{})
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		defer close(closed)
		observerTestHandshake(t, conn)
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, _ = conn.ReadMessage() // Never sends readiness.
	})
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if s, err := desktopObserverTestProvider(server.URL).OpenDesktopObserver(ctx, "ap-test", "ins-test"); s != nil || err == nil {
		t.Fatal("unready observer exceeded deadline")
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("timed-out opening leaked socket")
	}
}
