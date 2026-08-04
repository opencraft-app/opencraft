package gojaim

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
)

func TestTransportImplementsEmbeddedLoginSendAndHistory(t *testing.T) {
	fake := &fakeCommandEngine{
		events: [][]RuntimeEvent{{
			{Type: "ready"},
		}},
		responses: map[string]any{
			"login": map[string]any{},
			"sendText": map[string]any{
				"message_id":   "message-1",
				"timestamp_ms": int64(1_700_000_000_000),
				"sequence":     int64(8),
			},
			"sendAttachment": map[string]any{
				"message_id":   "attachment-message-1",
				"timestamp_ms": int64(1_700_000_001_000),
				"sequence":     int64(9),
				"attachment": map[string]any{
					"id":         "file-uuid-1",
					"filename":   "说明.txt",
					"mime_type":  "text/plain",
					"size_bytes": int64(6),
					"url":        "https://cos.ap-shanghai.myqcloud.com/file-uuid-1",
				},
			},
			"listUnread": map[string]any{
				"isSyncCompleted": true,
				"conversationList": []any{
					map[string]any{
						"conversationID": "C2Chuman-1",
						"unreadCount":    int64(2),
					},
				},
			},
			"history": map[string]any{
				"data": map[string]any{
					"isCompleted":      true,
					"nextReqMessageID": "",
					"messageList": []any{
						map[string]any{
							"ID":               "incoming-1",
							"from":             "human-1",
							"to":               "im-agent",
							"conversationType": "C2C",
							"sequence":         int64(7),
							"time":             int64(1_700_000_000),
							"type":             "TIMTextElem",
							"payload": map[string]any{
								"text": "hello",
							},
							"cloudCustomData": `{"type":"raft.thread-reply/v1","threadId":"thread-1"}`,
						},
					},
				},
			},
			"markRead": map[string]any{},
			"logout":   map[string]any{},
		},
	}
	transport, err := NewTransport(TransportConfig{
		StartTimeout:   time.Second,
		RequestTimeout: time.Second,
		PollInterval:   time.Millisecond,
		newEngine: func(int, Host) (commandEngine, error) {
			return fake, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	userSig, err := im.NewUserSig("short-usersig")
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Start(context.Background(), im.Session{
		SDKAppID: 1_600_000_000,
		UserID:   "im-agent",
		UserSig:  userSig,
		LaunchID: "launch-1",
	}); err != nil {
		t.Fatal(err)
	}
	conversation, err := im.NewC2CConversation("human-1")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := transport.SendText(
		context.Background(),
		im.SendTextRequest{
			Conversation:    conversation,
			Text:            "reply",
			CloudCustomData: `{"type":"raft.thread-reply/v1","threadId":"thread-1"}`,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.MessageID != "message-1" ||
		receipt.TimestampMS != 1_700_000_000_000 || receipt.Sequence != 8 {
		t.Fatalf("receipt = %#v", receipt)
	}
	if got := fake.requests[1]["cloud_custom_data"]; got != `{"type":"raft.thread-reply/v1","threadId":"thread-1"}` {
		t.Fatalf("cloud_custom_data = %#v", got)
	}
	attachmentReceipt, err := transport.SendAttachment(
		context.Background(),
		im.SendAttachmentRequest{
			Conversation:    conversation,
			Filename:        "说明.txt",
			MIMEType:        "text/plain",
			Data:            []byte("你好"),
			CloudCustomData: `{"type":"raft.thread-reply/v1","threadId":"thread-1"}`,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if attachmentReceipt.MessageID != "attachment-message-1" ||
		attachmentReceipt.Sequence != 9 ||
		attachmentReceipt.Attachment.ID != "file-uuid-1" ||
		attachmentReceipt.Attachment.Filename != "说明.txt" {
		t.Fatalf("attachment receipt = %#v", attachmentReceipt)
	}
	if got := fake.requests[2]["filename"]; got != "说明.txt" {
		t.Fatalf("attachment filename = %#v", got)
	}
	if got, ok := fake.requests[2]["data"].([]byte); !ok || string(got) != "你好" {
		t.Fatalf("attachment data = %#v", fake.requests[2]["data"])
	}
	if _, err := transport.SendText(
		context.Background(),
		im.SendTextRequest{
			Conversation:   conversation,
			Text:           "invalid duplicate mention",
			MentionUserIDs: []string{"agent-2", "agent-2"},
		},
	); err == nil {
		t.Fatal("duplicate mention IDs were accepted")
	}
	unread, err := transport.UnreadConversations(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(unread) != 1 || unread[0].UnreadCount != 2 {
		t.Fatalf("unread = %#v", unread)
	}
	page, err := transport.History(
		context.Background(),
		im.HistoryRequest{
			Conversation:      conversation,
			AroundTimestampMS: 1_700_000_000_000,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 1 ||
		page.Messages[0].Ref.MessageID() != "incoming-1" ||
		page.Messages[0].SenderUserID != "human-1" ||
		page.Messages[0].CloudCustomData != `{"type":"raft.thread-reply/v1","threadId":"thread-1"}` ||
		len(page.Messages[0].Elements) != 1 ||
		page.Messages[0].Elements[0].Text != "hello" {
		t.Fatalf("page = %#v", page)
	}
	lastRequest := fake.requests[len(fake.requests)-1]
	if lastRequest["around_time_ms"] != int64(1_700_000_000_000) ||
		lastRequest["around_sequence"] != int64(0) {
		t.Fatalf("history request = %#v", lastRequest)
	}
	if err := transport.MarkRead(
		context.Background(),
		conversation,
	); err != nil {
		t.Fatal(err)
	}
	if err := transport.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !fake.closed {
		t.Fatal("embedded Engine was not closed")
	}
}

func TestProjectRuntimeEventPreservesSafeKickedOutReason(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  any
		want string
	}{
		{
			name: "multi account",
			raw:  map[string]any{"type": "KICKED_OUT_MULT_ACCOUNT"},
			want: "kicked_out_mult_account",
		},
		{
			name: "multi device SDK value",
			raw:  map[string]any{"type": "multipleDevice"},
			want: "kicked_out_mult_device",
		},
		{
			name: "expired signature",
			raw:  map[string]any{"type": "userSigExpired"},
			want: "kicked_out_usersig_expired",
		},
		{
			name: "REST API",
			raw:  map[string]any{"type": "KICKED_OUT_REST_API"},
			want: "kicked_out_rest_api",
		},
		{
			name: "unknown does not leak raw detail",
			raw: map[string]any{
				"type": "Bearer secret\nhttps://private.example/path",
			},
			want: "kicked_out_unknown",
		},
	}

	transport := &Transport{}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			events := transport.projectRuntimeEvent(
				RuntimeEvent{Type: "kicked_out", Data: test.raw},
				im.Session{LaunchID: "launch-1"},
			)
			if len(events) != 1 || events[0].Type != im.EventKickedOut ||
				events[0].Reason != test.want {
				t.Fatalf("events = %#v, want reason %q", events, test.want)
			}
		})
	}
}

func TestTransportAcceptsFunctionalReadinessWhenSDKReadyIsMissing(t *testing.T) {
	fake := &fakeCommandEngine{responses: map[string]any{
		"login": map[string]any{},
		"loginState": map[string]any{
			"userID": "im-agent",
			"ready":  false,
		},
		"logout": map[string]any{},
	}}
	transport, err := NewTransport(TransportConfig{
		StartTimeout:   time.Second,
		RequestTimeout: time.Second,
		PollInterval:   time.Millisecond,
		newEngine: func(int, Host) (commandEngine, error) {
			return fake, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	userSig, err := im.NewUserSig("short-usersig")
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Start(context.Background(), im.Session{
		SDKAppID: 1_600_000_000,
		UserID:   "im-agent",
		UserSig:  userSig,
		LaunchID: "launch-functional-ready",
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if len(fake.requests) < 2 || fake.requests[1]["op"] != "loginState" {
		t.Fatalf("requests = %#v, want functional readiness probe", fake.requests)
	}
	if err := transport.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestTransportCanProbeReadinessWhileLoginPromiseIsPending(t *testing.T) {
	engine := &pendingLoginEngine{}
	transport, err := NewTransport(TransportConfig{
		StartTimeout:   50 * time.Millisecond,
		RequestTimeout: time.Second,
		PollInterval:   time.Millisecond,
		newEngine: func(int, Host) (commandEngine, error) {
			return engine, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	userSig, err := im.NewUserSig("short-usersig")
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Start(context.Background(), im.Session{
		SDKAppID: 1_600_000_000,
		UserID:   "im-agent",
		UserSig:  userSig,
		LaunchID: "launch-pending-login",
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if err := transport.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRecallUsesStableMessageReference(t *testing.T) {
	conversation, _ := im.NewGroupConversation("group-1")
	reference, _ := im.NewMessageRef(conversation, "message-1", 42, 1_800_000_000_000)
	fake := &fakeCommandEngine{responses: map[string]any{"revoke": map[string]any{"ok": true}}}
	transport := &Transport{
		config: TransportConfig{RequestTimeout: time.Second},
		engine: fake,
		events: make(chan im.Event, 1),
	}

	if err := transport.Recall(context.Background(), reference); err != nil {
		t.Fatal(err)
	}
	request := fake.requests[len(fake.requests)-1]
	if request["op"] != "revoke" || request["message_id"] != "message-1" || request["sequence"] != int64(42) {
		t.Fatalf("request = %#v", request)
	}
}

func TestTransportRejectsMalformedFunctionalReadiness(t *testing.T) {
	fake := &fakeCommandEngine{responses: map[string]any{
		"login":      map[string]any{},
		"loginState": map[string]any{"ready": false},
	}}
	transport, err := NewTransport(TransportConfig{
		StartTimeout:   20 * time.Millisecond,
		RequestTimeout: time.Second,
		PollInterval:   time.Millisecond,
		newEngine: func(int, Host) (commandEngine, error) {
			return fake, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	userSig, err := im.NewUserSig("short-usersig")
	if err != nil {
		t.Fatal(err)
	}
	err = transport.Start(context.Background(), im.Session{
		SDKAppID: 1_600_000_000,
		UserID:   "im-agent",
		UserSig:  userSig,
		LaunchID: "launch-not-ready",
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Start() error = %v, want deadline exceeded", err)
	}
}

func TestUnreadConversationsUsesBestEffortSnapshotBeforeFullSync(t *testing.T) {
	fake := &fakeCommandEngine{
		responses: map[string]any{
			"listUnread": map[string]any{
				"isSyncCompleted": false,
				"conversationList": []any{
					map[string]any{
						"conversationID": "C2Chuman-1",
						"unreadCount":    int64(1),
					},
				},
			},
		},
	}
	transport := &Transport{
		config: TransportConfig{
			RequestTimeout: time.Second,
			PollInterval:   time.Millisecond,
		},
		engine: fake,
		events: make(chan im.Event, 1),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	unread, err := transport.UnreadConversations(ctx)
	if err != nil {
		t.Fatalf("UnreadConversations() error = %v", err)
	}
	if len(unread) != 1 || unread[0].UnreadCount != 1 {
		t.Fatalf("unread = %#v", unread)
	}
}

func TestTransportSearchesCloudAndMutatesReaction(t *testing.T) {
	t.Parallel()
	conversation, err := im.NewGroupConversation("group-1")
	if err != nil {
		t.Fatal(err)
	}
	reference, err := im.NewMessageRef(
		conversation,
		"message-search-1",
		17,
		1_700_000_000_000,
	)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeCommandEngine{responses: map[string]any{
		"search": map[string]any{
			"data": map[string]any{
				"cursor":     "cursor-2",
				"totalCount": int64(1),
				"searchResultList": []any{map[string]any{
					"messageList": []any{sdkTextMessage(
						"message-search-1", "human-1", "group-1", 17, "协议命中",
					)},
				}},
			},
		},
		"setReaction": map[string]any{"ok": true},
	}}
	transport := &Transport{
		config:  TransportConfig{RequestTimeout: time.Second},
		engine:  fake,
		session: im.Session{UserID: "agent-1"},
		events:  make(chan im.Event, 1),
	}
	page, err := transport.Search(context.Background(), im.SearchRequest{
		Conversation: &conversation,
		Query:        "协议",
		Cursor:       "cursor-1",
		Limit:        20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 1 ||
		page.Messages[0].Ref.MessageID() != "message-search-1" ||
		page.NextCursor != "cursor-2" || page.Completed || page.TotalCount != 1 {
		t.Fatalf("search page = %#v", page)
	}
	if err := transport.SetReaction(
		context.Background(),
		reference,
		"👍",
		true,
	); err != nil {
		t.Fatal(err)
	}
	if len(fake.requests) != 2 || fake.requests[0]["op"] != "search" ||
		fake.requests[1]["op"] != "setReaction" ||
		fake.requests[1]["active"] != true {
		t.Fatalf("requests = %#v", fake.requests)
	}
}

func TestProjectSDKFileMessageProducesTypedAttachment(t *testing.T) {
	t.Parallel()
	message := sdkTextMessage(
		"message-file-1", "human-1", "group-1", 21, "",
	)
	message["type"] = "TIMFileElem"
	message["payload"] = map[string]any{
		"uuid":     "file-uuid-1",
		"fileName": "需求.pdf",
		"fileSize": int64(2048),
		"fileUrl":  "https://cos.ap-shanghai.myqcloud.com/file-uuid-1",
	}
	projected, err := projectSDKMessage(message, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(projected.Elements) != 1 ||
		projected.Elements[0].Attachment == nil ||
		projected.Elements[0].Attachment.ID != "file-uuid-1" ||
		projected.Elements[0].Attachment.Filename != "需求.pdf" ||
		projected.Elements[0].Attachment.SizeBytes != 2048 {
		t.Fatalf("projected elements = %#v", projected.Elements)
	}
}

func sdkTextMessage(
	id string,
	from string,
	to string,
	sequence int64,
	text string,
) map[string]any {
	return map[string]any{
		"ID": id, "from": from, "to": to,
		"conversationType": "GROUP", "conversationID": "GROUP" + to,
		"sequence": sequence, "time": int64(1_700_000_000),
		"type": "TIMTextElem", "payload": map[string]any{"text": text},
	}
}

type fakeCommandEngine struct {
	responses map[string]any
	events    [][]RuntimeEvent
	requests  []map[string]any
	closed    bool
}

type pendingLoginEngine struct {
	closed bool
}

func (*pendingLoginEngine) BeginCommand(
	map[string]any,
) (<-chan commandResult, error) {
	return make(chan commandResult), nil
}

func (e *pendingLoginEngine) Command(
	ctx context.Context,
	request map[string]any,
) (any, error) {
	if request["op"] == "login" {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if request["op"] == "loginState" {
		return map[string]any{"userID": "im-agent", "ready": false}, nil
	}
	return map[string]any{}, nil
}

func (*pendingLoginEngine) DrainEvents(context.Context) ([]RuntimeEvent, error) {
	return nil, nil
}

func (e *pendingLoginEngine) Close(context.Context) error {
	e.closed = true
	return nil
}

func (f *fakeCommandEngine) Command(
	_ context.Context,
	request map[string]any,
) (any, error) {
	f.requests = append(f.requests, request)
	return f.responses[request["op"].(string)], nil
}

func (f *fakeCommandEngine) BeginCommand(
	request map[string]any,
) (<-chan commandResult, error) {
	value, err := f.Command(context.Background(), request)
	result := make(chan commandResult, 1)
	result <- commandResult{value: value, err: err}
	return result, nil
}

func (f *fakeCommandEngine) DrainEvents(
	context.Context,
) ([]RuntimeEvent, error) {
	if len(f.events) == 0 {
		return nil, nil
	}
	events := f.events[0]
	f.events = f.events[1:]
	return events, nil
}

func (f *fakeCommandEngine) Close(context.Context) error {
	f.closed = true
	return nil
}
