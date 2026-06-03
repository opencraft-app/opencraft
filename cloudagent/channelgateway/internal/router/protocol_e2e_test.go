package router

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/channel/wecom"
	"cloudagent/channelgateway/internal/store"
)

func TestProtocolE2EWeComCallbackToACPReplyStream(t *testing.T) {
	acpServer := newFakeACPServer(t, "session-e2e", "agent says hi")
	defer acpServer.Close()
	st, err := store.Open(context.Background(), t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	lease, err := st.AcquireChannelLease(context.Background(), "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}

	wecomReady := make(chan struct{})
	replyDone := make(chan struct{})
	wecomServer := newRouterWeComServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectRouterSubscribe(t, conn)
		close(wecomReady)
		writeRouterJSON(t, conn, map[string]any{
			"cmd":     "aibot_msg_callback",
			"headers": map[string]any{"req_id": "callback-e2e"},
			"body": map[string]any{
				"msgid":   "msg-e2e",
				"chatid":  "chat-e2e",
				"msgtype": "text",
				"from":    map[string]any{"userid": "user-e2e"},
				"text":    map[string]any{"content": "ping"},
			},
		})
		frame := readRouterFrame(t, conn)
		if frame.Cmd != "aibot_respond_msg" || frame.Headers.ReqID != "callback-e2e" {
			t.Fatalf("expected callback-correlated respond frame, got %#v", frame)
		}
		body := decodeRouterBody(t, frame)
		stream := body["stream"].(map[string]any)
		if stream["content"] != "agent says hi" {
			t.Fatalf("unexpected stream reply body: %#v", body)
		}
		writeRouterJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": "callback-e2e"}, "errcode": 0})
		close(replyDone)
	})
	defer wecomServer.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	acpClient := acp.NewClient("ws"+acpServer.URL[len("http"):], nil)
	defer acpClient.Close()
	if err := acpClient.Initialize(ctx); err != nil {
		t.Fatalf("initialize acp: %v", err)
	}
	adapter := wecom.NewAdapter(wecom.Config{AccountID: "wecom-a", BotID: "bot", Secret: "secret", WebSocketURL: "ws" + wecomServer.URL[len("http"):]})
	dispatcher := NewDispatcher(st, store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}, acpClient, "/workspace")
	startErr := make(chan error, 1)
	go func() { startErr <- adapter.Start(ctx, dispatcher) }()
	waitRouterClosed(t, wecomReady, "wecom subscribe")
	drainUntil(t, ctx, st, lease, adapter, 1)
	waitRouterClosed(t, replyDone, "wecom reply")
	cancel()
	_ = <-startErr
}

func TestProtocolE2EDuplicateWeComMessagePromptsOnlyOnce(t *testing.T) {
	var promptCalls atomic.Int64
	acpServer := newFakeACPServerWithPromptCounter(t, "session-e2e", "agent says hi", &promptCalls)
	defer acpServer.Close()
	st, err := store.Open(context.Background(), t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	lease, err := st.AcquireChannelLease(context.Background(), "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}

	wecomReady := make(chan struct{})
	replyDone := make(chan struct{})
	wecomServer := newRouterWeComServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectRouterSubscribe(t, conn)
		close(wecomReady)
		callback := map[string]any{
			"cmd":     "aibot_msg_callback",
			"headers": map[string]any{"req_id": "callback-dedupe"},
			"body": map[string]any{
				"msgid":   "msg-dedupe",
				"chatid":  "chat-dedupe",
				"msgtype": "text",
				"from":    map[string]any{"userid": "user-e2e"},
				"text":    map[string]any{"content": "ping"},
			},
		}
		writeRouterJSON(t, conn, callback)
		writeRouterJSON(t, conn, callback)
		frame := readRouterFrame(t, conn)
		if frame.Cmd != "aibot_respond_msg" {
			t.Fatalf("expected one respond frame, got %#v", frame)
		}
		writeRouterJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": "callback-dedupe"}, "errcode": 0})
		close(replyDone)
		_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		if _, _, err := conn.ReadMessage(); err == nil {
			t.Fatal("duplicate callback produced a second outbound frame")
		}
	})
	defer wecomServer.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	acpClient := acp.NewClient("ws"+acpServer.URL[len("http"):], nil)
	defer acpClient.Close()
	if err := acpClient.Initialize(ctx); err != nil {
		t.Fatalf("initialize acp: %v", err)
	}
	adapter := wecom.NewAdapter(wecom.Config{AccountID: "wecom-a", BotID: "bot", Secret: "secret", WebSocketURL: "ws" + wecomServer.URL[len("http"):]})
	dispatcher := NewDispatcher(st, store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}, acpClient, "/workspace")
	startErr := make(chan error, 1)
	go func() { startErr <- adapter.Start(ctx, dispatcher) }()
	waitRouterClosed(t, wecomReady, "wecom subscribe")
	drainUntil(t, ctx, st, lease, adapter, 1)
	waitRouterClosed(t, replyDone, "wecom reply")
	if got := promptCalls.Load(); got != 1 {
		t.Fatalf("duplicate callback should prompt once, got %d", got)
	}
	cancel()
	_ = <-startErr
}

func TestProtocolE2EConversationReusesACPSessionOnSecondMessage(t *testing.T) {
	var sessionNewCalls atomic.Int64
	var sessionLoadCalls atomic.Int64
	var promptCalls atomic.Int64
	acpServer := newStatefulFakeACPServer(t, "session-reuse", &sessionNewCalls, &sessionLoadCalls, &promptCalls, nil)
	defer acpServer.Close()
	st, err := store.Open(context.Background(), t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	lease, err := st.AcquireChannelLease(context.Background(), "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}

	wecomReady := make(chan struct{})
	repliesDone := make(chan struct{})
	wecomServer := newRouterWeComServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectRouterSubscribe(t, conn)
		close(wecomReady)
		for i, reqID := range []string{"callback-reuse-1", "callback-reuse-2"} {
			writeRouterJSON(t, conn, map[string]any{
				"cmd":     "aibot_msg_callback",
				"headers": map[string]any{"req_id": reqID},
				"body": map[string]any{
					"msgid":   "msg-reuse-" + string(rune('1'+i)),
					"chatid":  "chat-reuse",
					"msgtype": "text",
					"from":    map[string]any{"userid": "user-e2e"},
					"text":    map[string]any{"content": "ping"},
				},
			})
			frame := readRouterFrame(t, conn)
			if frame.Cmd != "aibot_respond_msg" || frame.Headers.ReqID != reqID {
				t.Fatalf("expected response correlated to %s, got %#v", reqID, frame)
			}
			writeRouterJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": reqID}, "errcode": 0})
		}
		close(repliesDone)
	})
	defer wecomServer.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	acpClient := acp.NewClient("ws"+acpServer.URL[len("http"):], nil)
	defer acpClient.Close()
	if err := acpClient.Initialize(ctx); err != nil {
		t.Fatalf("initialize acp: %v", err)
	}
	adapter := wecom.NewAdapter(wecom.Config{AccountID: "wecom-a", BotID: "bot", Secret: "secret", WebSocketURL: "ws" + wecomServer.URL[len("http"):]})
	dispatcher := NewDispatcher(st, store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}, acpClient, "/workspace")
	startErr := make(chan error, 1)
	go func() { startErr <- adapter.Start(ctx, dispatcher) }()
	waitRouterClosed(t, wecomReady, "wecom subscribe")
	drainUntil(t, ctx, st, lease, adapter, 2)
	waitRouterClosed(t, repliesDone, "two replies")
	if got := sessionNewCalls.Load(); got != 1 {
		t.Fatalf("same conversation should create one ACP session, got %d", got)
	}
	if got := sessionLoadCalls.Load(); got != 1 {
		t.Fatalf("second message should load existing ACP session once, got %d", got)
	}
	if got := promptCalls.Load(); got != 2 {
		t.Fatalf("expected two prompts, got %d", got)
	}
	cancel()
	_ = <-startErr
}

func TestProtocolE2EACPErrorDoesNotSendWeComReply(t *testing.T) {
	promptSeen := make(chan struct{})
	var promptCalls atomic.Int64
	acpServer := newStatefulFakeACPServer(t, "session-error", nil, nil, &promptCalls, func(conn *websocket.Conn, id int64) {
		close(promptSeen)
		writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32000, "message": "model failed"}})
	})
	defer acpServer.Close()
	st, err := store.Open(context.Background(), t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	wecomReady := make(chan struct{})
	noReplyDone := make(chan struct{})
	wecomServer := newRouterWeComServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectRouterSubscribe(t, conn)
		close(wecomReady)
		writeRouterJSON(t, conn, map[string]any{
			"cmd":     "aibot_msg_callback",
			"headers": map[string]any{"req_id": "callback-error"},
			"body": map[string]any{
				"msgid":   "msg-error",
				"chatid":  "chat-error",
				"msgtype": "text",
				"from":    map[string]any{"userid": "user-e2e"},
				"text":    map[string]any{"content": "ping"},
			},
		})
		waitRouterClosed(t, promptSeen, "ACP prompt")
		_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		if _, _, err := conn.ReadMessage(); err == nil {
			t.Fatal("ACP prompt error must not produce a WeCom reply frame")
		}
		close(noReplyDone)
	})
	defer wecomServer.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	acpClient := acp.NewClient("ws"+acpServer.URL[len("http"):], nil)
	defer acpClient.Close()
	if err := acpClient.Initialize(ctx); err != nil {
		t.Fatalf("initialize acp: %v", err)
	}
	adapter := wecom.NewAdapter(wecom.Config{AccountID: "wecom-a", BotID: "bot", Secret: "secret", WebSocketURL: "ws" + wecomServer.URL[len("http"):]})
	dispatcher := NewDispatcher(st, store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}, acpClient, "/workspace")
	startErr := make(chan error, 1)
	go func() { startErr <- adapter.Start(ctx, dispatcher) }()
	waitRouterClosed(t, wecomReady, "wecom subscribe")
	waitRouterClosed(t, noReplyDone, "no reply")
	if got := promptCalls.Load(); got != 1 {
		t.Fatalf("expected one failed prompt, got %d", got)
	}
	cancel()
	_ = <-startErr
}

func TestProtocolE2EWeComSendErrorLeavesOutboxPendingForRetry(t *testing.T) {
	st, err := store.Open(context.Background(), t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	lease, err := st.AcquireChannelLease(context.Background(), "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	if _, err := st.EnqueueOutbox(context.Background(), store.OutboxRecord{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-retry",
		PayloadJSON:            `{"channel_account_id":"wecom-a","external_conversation_id":"chat-retry","text":"retry me"}`,
		Status:                 "pending",
	}); err != nil {
		t.Fatalf("enqueue outbox: %v", err)
	}
	wecomReady := make(chan struct{})
	sendAttempted := make(chan struct{})
	wecomServer := newRouterWeComServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectRouterSubscribe(t, conn)
		close(wecomReady)
		frame := readRouterFrame(t, conn)
		if frame.Cmd != "aibot_send_msg" {
			t.Fatalf("expected send frame, got %#v", frame)
		}
		writeRouterJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": frame.Headers.ReqID}, "errcode": 93000, "errmsg": "busy"})
		close(sendAttempted)
	})
	defer wecomServer.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	adapter := wecom.NewAdapter(wecom.Config{AccountID: "wecom-a", BotID: "bot", Secret: "secret", WebSocketURL: "ws" + wecomServer.URL[len("http"):]})
	startErr := make(chan error, 1)
	go func() { startErr <- adapter.Start(ctx, noopInboundHandler{}) }()
	waitRouterClosed(t, wecomReady, "wecom subscribe")
	n, err := DrainOutbox(ctx, st, lease, adapter, 1)
	if err != nil {
		t.Fatalf("drain outbox: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected one claimed outbox, got %d", n)
	}
	waitRouterClosed(t, sendAttempted, "send attempt")
	claimed, err := st.ClaimPendingOutbox(ctx, lease, 1)
	if err != nil {
		t.Fatalf("claim after failed send: %v", err)
	}
	if len(claimed) != 0 {
		t.Fatalf("failed send should be pending with future retry, got immediate claim: %#v", claimed)
	}
	cancel()
	_ = <-startErr
}

func TestProtocolE2ETwoWeComAccountsUseSeparateSocketsAndOutboxes(t *testing.T) {
	acpA := newFakeACPServer(t, "session-a", "reply-a")
	defer acpA.Close()
	acpB := newFakeACPServer(t, "session-b", "reply-b")
	defer acpB.Close()
	st, err := store.Open(context.Background(), t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	leaseA, err := st.AcquireChannelLease(context.Background(), "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease a: %v", err)
	}
	leaseB, err := st.AcquireChannelLease(context.Background(), "wecom-b", "owner-b", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease b: %v", err)
	}
	readyA := make(chan struct{})
	readyB := make(chan struct{})
	replyA := make(chan struct{})
	replyB := make(chan struct{})
	serverA := newRouterWeComServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectRouterSubscribeWith(t, conn, "bot-a", "secret-a")
		close(readyA)
		writeRouterJSON(t, conn, map[string]any{
			"cmd":     "aibot_msg_callback",
			"headers": map[string]any{"req_id": "callback-a"},
			"body": map[string]any{
				"msgid":   "msg-a",
				"chatid":  "chat-a",
				"msgtype": "text",
				"from":    map[string]any{"userid": "user-a"},
				"text":    map[string]any{"content": "ping"},
			},
		})
		frame := readRouterFrame(t, conn)
		body := decodeRouterBody(t, frame)
		stream := body["stream"].(map[string]any)
		if frame.Headers.ReqID != "callback-a" || stream["content"] != "reply-a" {
			t.Fatalf("account a got wrong reply frame=%#v body=%#v", frame, body)
		}
		writeRouterJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": "callback-a"}, "errcode": 0})
		close(replyA)
	})
	defer serverA.Close()
	serverB := newRouterWeComServer(t, func(t *testing.T, conn *websocket.Conn) {
		expectRouterSubscribeWith(t, conn, "bot-b", "secret-b")
		close(readyB)
		writeRouterJSON(t, conn, map[string]any{
			"cmd":     "aibot_msg_callback",
			"headers": map[string]any{"req_id": "callback-b"},
			"body": map[string]any{
				"msgid":   "msg-b",
				"chatid":  "chat-b",
				"msgtype": "text",
				"from":    map[string]any{"userid": "user-b"},
				"text":    map[string]any{"content": "ping"},
			},
		})
		frame := readRouterFrame(t, conn)
		body := decodeRouterBody(t, frame)
		stream := body["stream"].(map[string]any)
		if frame.Headers.ReqID != "callback-b" || stream["content"] != "reply-b" {
			t.Fatalf("account b got wrong reply frame=%#v body=%#v", frame, body)
		}
		writeRouterJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": "callback-b"}, "errcode": 0})
		close(replyB)
	})
	defer serverB.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	clientA := acp.NewClient("ws"+acpA.URL[len("http"):], nil)
	defer clientA.Close()
	if err := clientA.Initialize(ctx); err != nil {
		t.Fatalf("initialize acp a: %v", err)
	}
	clientB := acp.NewClient("ws"+acpB.URL[len("http"):], nil)
	defer clientB.Close()
	if err := clientB.Initialize(ctx); err != nil {
		t.Fatalf("initialize acp b: %v", err)
	}
	adapterA := wecom.NewAdapter(wecom.Config{AccountID: "wecom-a", BotID: "bot-a", Secret: "secret-a", WebSocketURL: "ws" + serverA.URL[len("http"):]})
	adapterB := wecom.NewAdapter(wecom.Config{AccountID: "wecom-b", BotID: "bot-b", Secret: "secret-b", WebSocketURL: "ws" + serverB.URL[len("http"):]})
	dispatcherA := NewDispatcher(st, store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main-a"}, clientA, "/workspace")
	dispatcherB := NewDispatcher(st, store.ChannelAccount{ChannelAccountID: "wecom-b", ChannelType: "wecom", AgentID: "main-b"}, clientB, "/workspace")
	startErrA := make(chan error, 1)
	startErrB := make(chan error, 1)
	go func() { startErrA <- adapterA.Start(ctx, dispatcherA) }()
	go func() { startErrB <- adapterB.Start(ctx, dispatcherB) }()
	waitRouterClosed(t, readyA, "wecom a subscribe")
	waitRouterClosed(t, readyB, "wecom b subscribe")
	drainUntil(t, ctx, st, leaseA, adapterA, 1)
	drainUntil(t, ctx, st, leaseB, adapterB, 1)
	waitRouterClosed(t, replyA, "account a reply")
	waitRouterClosed(t, replyB, "account b reply")
	cancel()
	_ = <-startErrA
	_ = <-startErrB
}

type noopInboundHandler struct{}

func (noopInboundHandler) HandleInbound(context.Context, channel.Message) error {
	return nil
}

func newFakeACPServer(t *testing.T, sessionID, reply string) *httptest.Server {
	t.Helper()
	var promptCalls atomic.Int64
	return newFakeACPServerWithPromptCounter(t, sessionID, reply, &promptCalls)
}

func newStatefulFakeACPServer(t *testing.T, sessionID string, sessionNewCalls, sessionLoadCalls, promptCalls *atomic.Int64, promptOverride func(*websocket.Conn, int64)) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade acp: %v", err)
			return
		}
		defer conn.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64           `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Errorf("decode acp request: %v", err)
				return
			}
			switch req.Method {
			case "initialize":
				writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/new":
				if sessionNewCalls != nil {
					sessionNewCalls.Add(1)
				}
				writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": sessionID}})
			case "session/load":
				if sessionLoadCalls != nil {
					sessionLoadCalls.Add(1)
				}
				writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/prompt":
				if promptCalls != nil {
					promptCalls.Add(1)
				}
				if promptOverride != nil {
					promptOverride(conn, req.ID)
					continue
				}
				writeRouterJSON(t, conn, map[string]any{
					"jsonrpc": "2.0",
					"method":  "session/update",
					"params": map[string]any{
						"sessionId": sessionID,
						"update": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content":       map[string]any{"text": "agent reply"},
						},
					},
				})
				writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
			default:
				writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}))
}

func newFakeACPServerWithPromptCounter(t *testing.T, sessionID, reply string, promptCalls *atomic.Int64) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade acp: %v", err)
			return
		}
		defer conn.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64           `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Errorf("decode acp request: %v", err)
				return
			}
			switch req.Method {
			case "initialize":
				writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/new":
				writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": sessionID}})
			case "session/load":
				writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			case "session/prompt":
				promptCalls.Add(1)
				var params struct {
					SessionID string `json:"sessionId"`
					Prompt    []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"prompt"`
				}
				if err := json.Unmarshal(req.Params, &params); err != nil {
					t.Errorf("decode prompt params: %v", err)
					return
				}
				if params.SessionID != sessionID || len(params.Prompt) != 1 || params.Prompt[0].Type != "text" || params.Prompt[0].Text != "ping" {
					t.Errorf("unexpected prompt params: %#v", params)
					return
				}
				writeRouterJSON(t, conn, map[string]any{
					"jsonrpc": "2.0",
					"method":  "session/update",
					"params": map[string]any{
						"sessionId": sessionID,
						"update": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content":       map[string]any{"text": reply},
						},
					},
				})
				writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
			default:
				writeRouterJSON(t, conn, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}))
}

func drainUntil(t *testing.T, ctx context.Context, st *store.Store, lease store.ChannelLease, sender OutboxSender, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	total := 0
	for time.Now().Before(deadline) {
		n, err := DrainOutbox(ctx, st, lease, sender, 16)
		if err != nil {
			t.Fatalf("drain outbox: %v", err)
		}
		total += n
		if total >= want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out draining outbox, got %d want %d", total, want)
}

func newRouterWeComServer(t *testing.T, fn func(*testing.T, *websocket.Conn)) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade wecom: %v", err)
			return
		}
		defer conn.Close()
		fn(t, conn)
	}))
}

type routerWeComFrame struct {
	Cmd     string `json:"cmd,omitempty"`
	Headers struct {
		ReqID string `json:"req_id,omitempty"`
	} `json:"headers,omitempty"`
	Body json.RawMessage `json:"body,omitempty"`
}

func expectRouterSubscribe(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	expectRouterSubscribeWith(t, conn, "bot", "secret")
}

func expectRouterSubscribeWith(t *testing.T, conn *websocket.Conn, botID, secret string) {
	t.Helper()
	frame := readRouterFrame(t, conn)
	if frame.Cmd != "aibot_subscribe" {
		t.Fatalf("expected subscribe frame, got %#v", frame)
	}
	body := decodeRouterBody(t, frame)
	if body["bot_id"] != botID || body["secret"] != secret {
		t.Fatalf("unexpected subscribe body: %#v", body)
	}
	writeRouterJSON(t, conn, map[string]any{"headers": map[string]any{"req_id": frame.Headers.ReqID}, "errcode": 0})
}

func readRouterFrame(t *testing.T, conn *websocket.Conn) routerWeComFrame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var frame routerWeComFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatalf("decode frame: %v raw=%s", err, string(raw))
	}
	return frame
}

func decodeRouterBody(t *testing.T, frame routerWeComFrame) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(frame.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return body
}

func writeRouterJSON(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	if err := conn.WriteJSON(value); err != nil {
		t.Fatalf("write json: %v", err)
	}
}

func waitRouterClosed(t *testing.T, ch <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
	}
}
