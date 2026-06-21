package wecom

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"cloudagent/channelgateway/internal/channel"
)

type handlerFunc func(context.Context, channel.Message) error

func (fn handlerFunc) HandleInbound(ctx context.Context, msg channel.Message) error {
	return fn(ctx, msg)
}

func TestAdapterProtocolSendsReplyStreamWithCallbackReqID(t *testing.T) {
	ready := make(chan struct{})
	received := make(chan channel.Message, 1)
	replyDone := make(chan struct{})
	server := newWeComProtocolServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectSubscribe(t, conn)
		close(ready)
		writeWeComJSON(t, conn, map[string]any{
			"cmd":     "aibot_msg_callback",
			"headers": map[string]any{"req_id": "callback-1"},
			"body": map[string]any{
				"msgid":    "msg-1",
				"chatid":   "chat-1",
				"msgtype":  "text",
				"chattype": "group",
				"from":     map[string]any{"userid": "user-1"},
				"text":     map[string]any{"content": "hello"},
			},
		})
		frame := readFrame(t, conn)
		if frame.Cmd != cmdRespond || frame.Headers.ReqID != "callback-1" {
			t.Fatalf("expected reply stream correlated to callback req_id, got %#v", frame)
		}
		body := decodeBody(t, frame)
		stream := body["stream"].(map[string]any)
		if body["msgtype"] != "stream" || stream["finish"] != true || stream["content"] != "agent reply" {
			t.Fatalf("unexpected reply stream body: %#v", body)
		}
		writeWeComJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": "callback-1"}, "errcode": 0})
		close(replyDone)
	})
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	adapter := NewAdapter(Config{AccountID: "account-a", BotID: "bot", Secret: "secret", WebSocketURL: "ws" + server.URL[len("http"):]})
	startErr := make(chan error, 1)
	go func() {
		startErr <- adapter.Start(ctx, handlerFunc(func(ctx context.Context, msg channel.Message) error {
			received <- msg
			return nil
		}))
	}()
	waitClosed(t, ready, "subscribe")
	msg := waitMessage(t, received)
	if msg.ExternalMessageID != "msg-1" || msg.Text != "hello" || msg.ChatType != channel.ChatGroup {
		t.Fatalf("unexpected inbound message: %#v", msg)
	}
	if _, err := adapter.Send(ctx, channel.Reply{
		ExternalConversationID: "chat-1",
		ExternalMessageID:      "msg-1",
		Text:                   "agent reply",
	}); err != nil {
		t.Fatalf("send reply: %v", err)
	}
	waitClosed(t, replyDone, "reply")
	cancel()
	_ = <-startErr
}

func TestAdapterProtocolProactiveSendUsesMarkdownFrame(t *testing.T) {
	ready := make(chan struct{})
	sendDone := make(chan struct{})
	server := newWeComProtocolServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectSubscribe(t, conn)
		close(ready)
		frame := readFrame(t, conn)
		if frame.Cmd != cmdSend {
			t.Fatalf("expected proactive send command, got %#v", frame)
		}
		body := decodeBody(t, frame)
		markdown := body["markdown"].(map[string]any)
		if body["chatid"] != "chat-1" || body["msgtype"] != "markdown" || markdown["content"] != "hello markdown" {
			t.Fatalf("unexpected proactive markdown body: %#v", body)
		}
		writeWeComJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": frame.Headers.ReqID}, "errcode": 0})
		close(sendDone)
	})
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	adapter := NewAdapter(Config{AccountID: "account-a", BotID: "bot", Secret: "secret", WebSocketURL: "ws" + server.URL[len("http"):]})
	startErr := make(chan error, 1)
	go func() {
		startErr <- adapter.Start(ctx, handlerFunc(func(context.Context, channel.Message) error { return nil }))
	}()
	waitClosed(t, ready, "subscribe")
	if _, err := adapter.Send(ctx, channel.Reply{ExternalConversationID: "chat-1", Text: "hello markdown"}); err != nil {
		t.Fatalf("send proactive: %v", err)
	}
	waitClosed(t, sendDone, "proactive send")
	cancel()
	_ = <-startErr
}

func TestAdapterProtocolHandlerCanReplyInlineWithoutBlockingReadLoop(t *testing.T) {
	ready := make(chan struct{})
	replyDone := make(chan struct{})
	server := newWeComProtocolServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectSubscribe(t, conn)
		close(ready)
		writeWeComJSON(t, conn, map[string]any{
			"cmd":     "aibot_msg_callback",
			"headers": map[string]any{"req_id": "callback-inline"},
			"body": map[string]any{
				"msgid":   "msg-inline",
				"chatid":  "chat-inline",
				"msgtype": "text",
				"from":    map[string]any{"userid": "user-inline"},
				"text":    map[string]any{"content": "inline"},
			},
		})
		frame := readFrame(t, conn)
		if frame.Cmd != cmdRespond || frame.Headers.ReqID != "callback-inline" {
			t.Fatalf("expected inline reply to use callback req_id, got %#v", frame)
		}
		writeWeComJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": "callback-inline"}, "errcode": 0})
		close(replyDone)
	})
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	adapter := NewAdapter(Config{AccountID: "account-a", BotID: "bot", Secret: "secret", WebSocketURL: "ws" + server.URL[len("http"):]})
	startErr := make(chan error, 1)
	go func() {
		startErr <- adapter.Start(ctx, handlerFunc(func(ctx context.Context, msg channel.Message) error {
			sendCtx, sendCancel := context.WithTimeout(ctx, 2*time.Second)
			defer sendCancel()
			_, err := adapter.Send(sendCtx, channel.Reply{
				ExternalConversationID: msg.ExternalConversationID,
				ExternalMessageID:      msg.ExternalMessageID,
				Text:                   "inline reply",
			})
			return err
		}))
	}()
	waitClosed(t, ready, "subscribe")
	waitClosed(t, replyDone, "inline reply")
	cancel()
	_ = <-startErr
}

func TestAdapterPolicyCanDenyGroupMessages(t *testing.T) {
	ready := make(chan struct{})
	done := make(chan struct{})
	server := newWeComProtocolServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectSubscribe(t, conn)
		close(ready)
		writeWeComJSON(t, conn, map[string]any{
			"cmd":     "aibot_msg_callback",
			"headers": map[string]any{"req_id": "callback-deny-group"},
			"body": map[string]any{
				"msgid":    "msg-deny-group",
				"chatid":   "chat-deny-group",
				"msgtype":  "text",
				"chattype": "group",
				"from":     map[string]any{"userid": "user-deny"},
				"text":     map[string]any{"content": "blocked"},
			},
		})
		time.Sleep(100 * time.Millisecond)
		close(done)
	})
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var handled atomic.Int64
	adapter := NewAdapter(Config{
		AccountID:    "account-a",
		BotID:        "bot",
		Secret:       "secret",
		WebSocketURL: "ws" + server.URL[len("http"):],
		GroupPolicy:  "deny",
	})
	startErr := make(chan error, 1)
	go func() {
		startErr <- adapter.Start(ctx, handlerFunc(func(context.Context, channel.Message) error {
			handled.Add(1)
			return nil
		}))
	}()
	waitClosed(t, ready, "subscribe")
	waitClosed(t, done, "deny window")
	if got := handled.Load(); got != 0 {
		t.Fatalf("denied group message should not reach handler, got %d", got)
	}
	cancel()
	_ = <-startErr
}

func TestAdapterDispatchBlocksReadLoopAtHandler(t *testing.T) {
	ready := make(chan struct{})
	handledFirst := make(chan struct{})
	releaseHandler := make(chan struct{})
	done := make(chan struct{})
	server := newWeComProtocolServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectSubscribe(t, conn)
		close(ready)
		for i := 0; i < 2; i++ {
			writeWeComJSON(t, conn, map[string]any{
				"cmd":     "aibot_msg_callback",
				"headers": map[string]any{"req_id": "callback-sync-" + string(rune('0'+i))},
				"body": map[string]any{
					"msgid":   "msg-sync-" + string(rune('0'+i)),
					"chatid":  "chat-sync",
					"msgtype": "text",
					"from":    map[string]any{"userid": "user-sync"},
					"text":    map[string]any{"content": "sync"},
				},
			})
		}
		waitClosed(t, handledFirst, "first sync dispatch")
		time.Sleep(100 * time.Millisecond)
		close(done)
		<-releaseHandler
	})
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var handled atomic.Int64
	adapter := NewAdapter(Config{
		AccountID:    "account-a",
		BotID:        "bot",
		Secret:       "secret",
		WebSocketURL: "ws" + server.URL[len("http"):],
	})
	startErr := make(chan error, 1)
	go func() {
		startErr <- adapter.Start(ctx, handlerFunc(func(context.Context, channel.Message) error {
			if handled.Add(1) == 1 {
				close(handledFirst)
				<-releaseHandler
			}
			return nil
		}))
	}()
	waitClosed(t, ready, "subscribe")
	waitClosed(t, done, "sync blocked")
	if got := handled.Load(); got != 1 {
		t.Fatalf("sync dispatch should block the read loop at first handler call, got %d handled", got)
	}
	close(releaseHandler)
	cancel()
	_ = <-startErr
}

func TestAdapterSyncDispatchErrorStopsAdapter(t *testing.T) {
	ready := make(chan struct{})
	server := newWeComProtocolServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectSubscribe(t, conn)
		close(ready)
		writeWeComJSON(t, conn, map[string]any{
			"cmd":     "aibot_msg_callback",
			"headers": map[string]any{"req_id": "callback-sync-error"},
			"body": map[string]any{
				"msgid":   "msg-sync-error",
				"chatid":  "chat-sync-error",
				"msgtype": "text",
				"from":    map[string]any{"userid": "user-sync-error"},
				"text":    map[string]any{"content": "sync"},
			},
		})
	})
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	adapter := NewAdapter(Config{
		AccountID:    "account-a",
		BotID:        "bot",
		Secret:       "secret",
		WebSocketURL: "ws" + server.URL[len("http"):],
	})
	startErr := make(chan error, 1)
	go func() {
		startErr <- adapter.Start(ctx, handlerFunc(func(context.Context, channel.Message) error {
			return errors.New("publish failed")
		}))
	}()
	waitClosed(t, ready, "subscribe")
	select {
	case err := <-startErr:
		if err == nil || !strings.Contains(err.Error(), "publish failed") {
			t.Fatalf("expected sync dispatch error, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("adapter should stop after sync dispatch failure")
	}
}

func newWeComProtocolServer(t *testing.T, fn func(*testing.T, *websocket.Conn)) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		fn(t, conn)
	}))
}

func expectSubscribe(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	frame := readFrame(t, conn)
	if frame.Cmd != cmdSubscribe {
		t.Fatalf("expected subscribe frame, got %#v", frame)
	}
	body := decodeBody(t, frame)
	if body["bot_id"] != "bot" || body["secret"] != "secret" {
		t.Fatalf("unexpected subscribe body: %#v", body)
	}
	writeWeComJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": frame.Headers.ReqID}, "errcode": 0})
}

func readFrame(t *testing.T, conn *websocket.Conn) frame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var payload frame
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode frame: %v raw=%s", err, string(raw))
	}
	return payload
}

func decodeBody(t *testing.T, frame frame) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(frame.Body, &body); err != nil {
		t.Fatalf("decode frame body: %v", err)
	}
	return body
}

func waitMessage(t *testing.T, ch <-chan channel.Message) channel.Message {
	t.Helper()
	select {
	case msg := <-ch:
		return msg
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for inbound message")
		return channel.Message{}
	}
}

func waitClosed(t *testing.T, ch <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
	}
}

func writeWeComJSON(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	if err := conn.WriteJSON(value); err != nil {
		t.Fatalf("write json: %v", err)
	}
}
