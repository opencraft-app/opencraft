package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestTencentTerminalCommandStreamUsesPtyExecCmdStreamAndOrdersChunks(t *testing.T) {
	t.Parallel()

	var (
		mu       sync.Mutex
		received []string
	)
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		auth := readJSONFrame(t, conn)
		assertFrameData(t, auth, "SessionAuth", map[string]any{
			"Uin":        "10001",
			"AppId":      float64(1250000000),
			"InstanceId": "ins-test-1",
			"SessionId":  "session-1",
		})

		start := readJSONFrame(t, conn)
		assertFrameData(t, start, "PtyStart", map[string]any{
			"SessionId":   "session-1",
			"UserName":    terminalCommandUsername,
			"NoShell":     true,
			"MaxIdleTime": float64(30),
		})
		channelID, ok := start.Data["ChannelId"].(string)
		if !ok || strings.TrimSpace(channelID) == "" {
			t.Fatalf("expected non-empty PtyStart.ChannelId, got %#v", start.Data["ChannelId"])
		}
		writeJSONFrame(t, conn, map[string]any{"Type": "PtyReady"})

		exec := readBSONFrame(t, conn)
		if exec.Type != "PtyExecCmdStream" {
			t.Fatalf("expected PtyExecCmdStream, got %q", exec.Type)
		}
		if exec.Data.SessionID != "session-1" {
			t.Fatalf("expected session-1, got %q", exec.Data.SessionID)
		}
		if exec.Data.ChannelID != channelID {
			t.Fatalf("expected exec ChannelId %q, got %q", channelID, exec.Data.ChannelID)
		}
		if exec.Data.CustomData == "" {
			t.Fatal("expected non-empty CustomData")
		}
		if exec.Data.Data.Cmd != "printf hello" || exec.Data.Data.Timeout != 30 {
			t.Fatalf("unexpected exec request: %+v", exec.Data.Data)
		}

		writeBSONChunk(t, conn, channelID, exec.Data.CustomData, 2, []byte{0xbd, 0xa0, '\n'}, true, 7)
		writeBSONChunk(t, conn, channelID, exec.Data.CustomData, 0, []byte("hello "), false, 0)
		writeBSONChunk(t, conn, channelID, exec.Data.CustomData, 1, []byte{0xe4}, false, 0)

		stop := readJSONFrame(t, conn)
		assertFrameData(t, stop, "PtyStop", map[string]any{
			"SessionId": "session-1",
			"ChannelId": channelID,
		})
	})
	defer server.Close()

	p := &TencentCloudProvider{
		cfg: TencentConfig{Region: "ap-test"},
		startTerminalSessionFunc: func(context.Context, string, string) (TerminalSession, error) {
			return TerminalSession{
				SessionID:  "session-1",
				OwnerUin:   "10001",
				AppID:      1250000000,
				InstanceID: "ins-test-1",
				Region:     "ap-test",
			}, nil
		},
		tatForwardURLFunc: func(string) string { return websocketURL(server.URL) },
	}

	var executionID string
	result, err := p.StreamTerminalCommand(context.Background(), TerminalCommandStreamRequest{
		Region:           "ap-test",
		InstanceID:       "ins-test-1",
		Command:          "printf hello",
		Username:         terminalCommandUsername,
		WorkingDirectory: terminalCommandWorkingDirectory,
		TimeoutSeconds:   30,
	}, func(event TerminalCommandStreamEvent) error {
		mu.Lock()
		defer mu.Unlock()
		if event.Type == TerminalCommandEventStarted {
			executionID = event.ExecutionID
		}
		if event.Type == TerminalCommandEventOutput {
			received = append(received, event.Chunk)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("stream terminal command: %v", err)
	}
	if !strings.HasPrefix(executionID, "pty:") || result.ExecutionID != executionID {
		t.Fatalf("unexpected execution ids event=%q result=%q", executionID, result.ExecutionID)
	}
	if result.ExitCode != 7 {
		t.Fatalf("expected exit code 7, got %d", result.ExitCode)
	}
	if got := strings.Join(received, ""); got != "hello 你\n" {
		t.Fatalf("expected ordered output, got %q", got)
	}
}

func TestTencentTerminalCommandStreamStartsPtyWithoutFixedAuthDelay(t *testing.T) {
	t.Parallel()

	authToStart := make(chan time.Duration, 1)
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		_ = readJSONFrame(t, conn)
		authReceivedAt := time.Now()
		start := readJSONFrame(t, conn)
		authToStart <- time.Since(authReceivedAt)

		channelID, _ := start.Data["ChannelId"].(string)
		writeJSONFrame(t, conn, map[string]any{"Type": "PtyReady"})
		exec := readBSONFrame(t, conn)
		writeBSONChunk(t, conn, channelID, exec.Data.CustomData, 0, nil, true, 0)
		_ = readJSONFrame(t, conn)
	})
	defer server.Close()

	p := &TencentCloudProvider{
		cfg: TencentConfig{Region: "ap-test"},
		startTerminalSessionFunc: func(context.Context, string, string) (TerminalSession, error) {
			return TerminalSession{
				SessionID:  "session-1",
				OwnerUin:   "10001",
				AppID:      1250000000,
				InstanceID: "ins-test-1",
				Region:     "ap-test",
			}, nil
		},
		tatForwardURLFunc: func(string) string { return websocketURL(server.URL) },
	}

	_, err := p.StreamTerminalCommand(context.Background(), TerminalCommandStreamRequest{
		Region:           "ap-test",
		InstanceID:       "ins-test-1",
		Command:          "true",
		Username:         terminalCommandUsername,
		WorkingDirectory: terminalCommandWorkingDirectory,
		TimeoutSeconds:   30,
	}, func(TerminalCommandStreamEvent) error { return nil })
	if err != nil {
		t.Fatalf("stream terminal command: %v", err)
	}
	if delay := <-authToStart; delay >= 250*time.Millisecond {
		t.Fatalf("expected PtyStart without fixed auth delay, got %s", delay)
	}
}

func TestTencentTerminalCommandStreamRetriesHandshakeBeforeSendingCommand(t *testing.T) {
	t.Parallel()

	var connections atomic.Int32
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		attempt := connections.Add(1)
		_ = readJSONFrame(t, conn)
		start := readJSONFrame(t, conn)
		if attempt == 1 {
			writeJSONFrame(t, conn, map[string]any{
				"Type": "PtyError",
				"Data": map[string]any{"Message": "session authentication is not ready"},
			})
			return
		}

		channelID, _ := start.Data["ChannelId"].(string)
		writeJSONFrame(t, conn, map[string]any{"Type": "PtyReady"})
		exec := readBSONFrame(t, conn)
		writeBSONChunk(t, conn, channelID, exec.Data.CustomData, 0, nil, true, 0)
		_ = readJSONFrame(t, conn)
	})
	defer server.Close()

	var sessions atomic.Int32
	p := &TencentCloudProvider{
		cfg: TencentConfig{Region: "ap-test"},
		startTerminalSessionFunc: func(context.Context, string, string) (TerminalSession, error) {
			sessions.Add(1)
			return TerminalSession{
				SessionID:  "session-1",
				OwnerUin:   "10001",
				AppID:      1250000000,
				InstanceID: "ins-test-1",
				Region:     "ap-test",
			}, nil
		},
		tatForwardURLFunc: func(string) string { return websocketURL(server.URL) },
	}

	result, err := p.StreamTerminalCommand(context.Background(), TerminalCommandStreamRequest{
		Region:           "ap-test",
		InstanceID:       "ins-test-1",
		Command:          "true",
		Username:         terminalCommandUsername,
		WorkingDirectory: terminalCommandWorkingDirectory,
		TimeoutSeconds:   30,
	}, func(TerminalCommandStreamEvent) error { return nil })
	if err != nil {
		t.Fatalf("stream terminal command: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", result.ExitCode)
	}
	if got := connections.Load(); got != 2 {
		t.Fatalf("expected 2 websocket attempts, got %d", got)
	}
	if got := sessions.Load(); got != 2 {
		t.Fatalf("expected 2 terminal sessions, got %d", got)
	}
}

func TestTencentTerminalCommandStreamDoesNotRetryAfterSendingCommand(t *testing.T) {
	t.Parallel()

	var connections atomic.Int32
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		connections.Add(1)
		_ = readJSONFrame(t, conn)
		start := readJSONFrame(t, conn)
		channelID, _ := start.Data["ChannelId"].(string)
		writeJSONFrame(t, conn, map[string]any{"Type": "PtyReady"})
		exec := readBSONFrame(t, conn)
		writeBSONError(t, conn, channelID, exec.Data.CustomData, "command failed")
		_ = readJSONFrame(t, conn)
	})
	defer server.Close()

	var sessions atomic.Int32
	p := &TencentCloudProvider{
		cfg: TencentConfig{Region: "ap-test"},
		startTerminalSessionFunc: func(context.Context, string, string) (TerminalSession, error) {
			sessions.Add(1)
			return TerminalSession{
				SessionID:  "session-1",
				OwnerUin:   "10001",
				AppID:      1250000000,
				InstanceID: "ins-test-1",
				Region:     "ap-test",
			}, nil
		},
		tatForwardURLFunc: func(string) string { return websocketURL(server.URL) },
	}

	_, err := p.StreamTerminalCommand(context.Background(), TerminalCommandStreamRequest{
		Region:           "ap-test",
		InstanceID:       "ins-test-1",
		Command:          "touch /tmp/side-effect",
		Username:         terminalCommandUsername,
		WorkingDirectory: terminalCommandWorkingDirectory,
		TimeoutSeconds:   30,
	}, func(TerminalCommandStreamEvent) error { return nil })
	if err == nil {
		t.Fatal("expected command stream error")
	}
	if got := connections.Load(); got != 1 {
		t.Fatalf("expected 1 websocket attempt after command send, got %d", got)
	}
	if got := sessions.Load(); got != 1 {
		t.Fatalf("expected 1 terminal session after command send, got %d", got)
	}
}

func TestTencentTerminalCommandStreamTimeoutStopsSession(t *testing.T) {
	t.Parallel()

	stopped := make(chan struct{})
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		_ = readJSONFrame(t, conn)
		_ = readJSONFrame(t, conn)
		writeJSONFrame(t, conn, map[string]any{"Type": "PtyReady"})
		_ = readBSONFrame(t, conn)
		stop := readJSONFrame(t, conn)
		if stop.Type == "PtyStop" {
			close(stopped)
		}
	})
	defer server.Close()

	p := &TencentCloudProvider{
		cfg: TencentConfig{Region: "ap-test"},
		startTerminalSessionFunc: func(context.Context, string, string) (TerminalSession, error) {
			return TerminalSession{
				SessionID:  "session-1",
				OwnerUin:   "10001",
				AppID:      1250000000,
				InstanceID: "ins-test-1",
				Region:     "ap-test",
			}, nil
		},
		tatForwardURLFunc: func(string) string { return websocketURL(server.URL) },
	}

	_, err := p.StreamTerminalCommand(context.Background(), TerminalCommandStreamRequest{
		Region:           "ap-test",
		InstanceID:       "ins-test-1",
		Command:          "sleep 60",
		Username:         terminalCommandUsername,
		WorkingDirectory: terminalCommandWorkingDirectory,
		TimeoutSeconds:   1,
	}, func(TerminalCommandStreamEvent) error { return nil })
	var streamErr *TerminalCommandStreamError
	if !errors.As(err, &streamErr) || streamErr.Code != TerminalCommandErrorTimeout {
		t.Fatalf("expected TIMEOUT, got %v", err)
	}
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("expected PtyStop on timeout")
	}
}

func TestTencentTerminalCommandStreamCancellationStopsAndCloses(t *testing.T) {
	t.Parallel()

	stopped := make(chan struct{})
	execReceived := make(chan struct{})
	server := newTATStreamServer(t, func(conn *websocket.Conn) {
		_ = readJSONFrame(t, conn)
		_ = readJSONFrame(t, conn)
		writeJSONFrame(t, conn, map[string]any{"Type": "PtyReady"})
		_ = readBSONFrame(t, conn)
		close(execReceived)

		stop := readJSONFrame(t, conn)
		if stop.Type == "PtyStop" {
			close(stopped)
		}
	})
	defer server.Close()

	p := &TencentCloudProvider{
		cfg: TencentConfig{Region: "ap-test"},
		startTerminalSessionFunc: func(context.Context, string, string) (TerminalSession, error) {
			return TerminalSession{
				SessionID:  "session-1",
				OwnerUin:   "10001",
				AppID:      1250000000,
				InstanceID: "ins-test-1",
				Region:     "ap-test",
			}, nil
		},
		tatForwardURLFunc: func(string) string { return websocketURL(server.URL) },
	}

	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := p.StreamTerminalCommand(ctx, TerminalCommandStreamRequest{
			Region:           "ap-test",
			InstanceID:       "ins-test-1",
			Command:          "sleep 60",
			Username:         terminalCommandUsername,
			WorkingDirectory: terminalCommandWorkingDirectory,
			TimeoutSeconds:   30,
		}, func(event TerminalCommandStreamEvent) error {
			if event.Type == TerminalCommandEventStarted {
				close(started)
			}
			return nil
		})
		done <- err
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not start")
	}
	select {
	case <-execReceived:
	case <-time.After(2 * time.Second):
		t.Fatal("command request was not received")
	}
	cancel()

	select {
	case err := <-done:
		var streamErr *TerminalCommandStreamError
		if !errors.As(err, &streamErr) || streamErr.Code != TerminalCommandErrorCanceled {
			t.Fatalf("expected CANCELED, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not stop after cancellation")
	}
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("expected PtyStop on cancellation")
	}
}

type tatTestExecFrame struct {
	Type string `bson:"Type"`
	Data struct {
		SessionID  string `bson:"SessionId"`
		ChannelID  string `bson:"ChannelId"`
		CustomData string `bson:"CustomData"`
		Data       struct {
			Cmd     string `bson:"Cmd"`
			Timeout int    `bson:"Timeout"`
		} `bson:"Data"`
	} `bson:"Data"`
}

type tatTestJSONFrame struct {
	Type string         `json:"Type"`
	Data map[string]any `json:"Data"`
}

func newTATStreamServer(t *testing.T, handle func(*websocket.Conn)) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade websocket: %v", err)
			return
		}
		defer conn.Close()
		handle(conn)
	}))
}

func websocketURL(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http")
}

func readJSONFrame(t *testing.T, conn *websocket.Conn) tatTestJSONFrame {
	t.Helper()
	messageType, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read json frame: %v", err)
	}
	if messageType != websocket.TextMessage {
		t.Fatalf("expected text frame, got %d", messageType)
	}
	var frame tatTestJSONFrame
	if err := json.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("decode json frame: %v", err)
	}
	return frame
}

func readBSONFrame(t *testing.T, conn *websocket.Conn) tatTestExecFrame {
	t.Helper()
	messageType, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read bson frame: %v", err)
	}
	if messageType != websocket.BinaryMessage {
		t.Fatalf("expected binary frame, got %d", messageType)
	}
	var frame tatTestExecFrame
	if err := bson.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("decode bson frame: %v", err)
	}
	return frame
}

func writeJSONFrame(t *testing.T, conn *websocket.Conn, frame any) {
	t.Helper()
	if err := conn.WriteJSON(frame); err != nil {
		t.Fatalf("write json frame: %v", err)
	}
}

func writeBSONChunk(t *testing.T, conn *websocket.Conn, channelID, customData string, index int, data []byte, isLast bool, exitCode int) {
	t.Helper()
	payload, err := bson.Marshal(map[string]any{
		"Type": "PtyExecCmdStream",
		"Data": map[string]any{
			"SessionId":  "session-1",
			"ChannelId":  channelID,
			"CustomData": customData,
			"Data": map[string]any{
				"Index":    index,
				"Data":     data,
				"IsLast":   isLast,
				"ExitCode": exitCode,
			},
		},
	})
	if err != nil {
		t.Fatalf("encode bson chunk: %v", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
		t.Fatalf("write bson chunk: %v", err)
	}
}

func writeBSONError(t *testing.T, conn *websocket.Conn, channelID, customData, message string) {
	t.Helper()
	payload, err := bson.Marshal(map[string]any{
		"Type": "PtyExecCmdStream",
		"Data": map[string]any{
			"SessionId":  "session-1",
			"ChannelId":  channelID,
			"CustomData": customData,
			"Data": map[string]any{
				"Error": message,
			},
		},
	})
	if err != nil {
		t.Fatalf("encode bson error: %v", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
		t.Fatalf("write bson error: %v", err)
	}
}

func assertFrameData(t *testing.T, frame tatTestJSONFrame, wantType string, wantData map[string]any) {
	t.Helper()
	if frame.Type != wantType {
		t.Fatalf("expected frame %s, got %s", wantType, frame.Type)
	}
	for key, want := range wantData {
		if got := frame.Data[key]; got != want {
			t.Fatalf("%s.%s: expected %#v, got %#v", wantType, key, want, got)
		}
	}
}
