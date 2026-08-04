package humanim

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"velachat/agent/internal/vela/humanplatform"
	"velachat/agent/internal/vela/im"
)

type fakeIssuer struct{ session humanplatform.IMSession }

func (issuer fakeIssuer) IssueIMSession(context.Context) (humanplatform.IMSession, error) {
	return issuer.session, nil
}

type fakeTransport struct {
	started           im.Session
	events            chan im.Event
	history           im.HistoryPage
	conversations     im.ConversationSnapshot
	conversationErr   error
	conversationCalls int
	recalled          im.MessageRef
}

func (transport *fakeTransport) Start(_ context.Context, session im.Session) error {
	transport.started = session
	return nil
}
func (*fakeTransport) SendCustom(context.Context, im.SendCustomRequest) (im.SendReceipt, error) {
	return im.SendReceipt{}, nil
}
func (*fakeTransport) SendText(_ context.Context, _ im.SendTextRequest) (im.SendReceipt, error) {
	return im.SendReceipt{MessageID: "sent-1", TimestampMS: 1_800_000_000_000, Sequence: 9}, nil
}
func (transport *fakeTransport) Events() <-chan im.Event { return transport.events }
func (transport *fakeTransport) Close(context.Context) error {
	close(transport.events)
	return nil
}
func (transport *fakeTransport) History(context.Context, im.HistoryRequest) (im.HistoryPage, error) {
	return transport.history, nil
}
func (*fakeTransport) MarkRead(context.Context, im.Conversation) error { return nil }
func (*fakeTransport) UnreadConversations(context.Context) ([]im.UnreadConversation, error) {
	return nil, nil
}
func (transport *fakeTransport) Conversations(context.Context) (im.ConversationSnapshot, error) {
	transport.conversationCalls++
	return transport.conversations, transport.conversationErr
}
func (transport *fakeTransport) Recall(_ context.Context, reference im.MessageRef) error {
	transport.recalled = reference
	return nil
}

func allowTestScope(t *testing.T, adapter *Adapter, addresses ...Address) {
	t.Helper()
	if err := adapter.SetScope(context.Background(), ScopeInput{
		Generation:             1,
		AllowedConversations:   addresses,
		AllowedMemberIMUserIDs: []string{"human-2"},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestConnectKeepsUserSigInsideGoAndProjectsHistory(t *testing.T) {
	sig, _ := im.NewUserSig("top-secret-usersig")
	conversation, _ := im.NewGroupConversation("group-1")
	reference, _ := im.NewMessageRef(conversation, "m1", 7, 1_700_000_000_000)
	transport := &fakeTransport{
		events: make(chan im.Event),
		history: im.HistoryPage{Completed: true, Messages: []im.IncomingMessage{{
			Ref: reference, SenderUserID: "human-2",
			Elements: []im.Element{{Type: im.ElementText, Text: "你好"}},
		}}},
	}
	adapter := NewAdapter(Config{
		Issuer:       fakeIssuer{session: humanplatform.IMSession{SDKAppID: 123, UserID: "human-1", UserSig: sig}},
		NewTransport: func() (im.Transport, error) { return transport, nil },
	})
	if err := adapter.Connect(context.Background(), "launch-1"); err != nil {
		t.Fatal(err)
	}
	allowTestScope(t, adapter, Address{
		ChannelID: "channel-1", ConversationID: "GROUPgroup-1",
		TargetID: "group-1", IMGroupID: "group-1",
	})
	if transport.started.UserSig.Reveal() != "top-secret-usersig" {
		t.Fatal("UserSig did not stay in Go transport boundary")
	}
	page, err := adapter.LoadHistory(context.Background(), HistoryInput{Channel: Address{ConversationID: "GROUPgroup-1", TargetID: "group-1", IMGroupID: "group-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 1 || page.Messages[0].Text != "你好" || page.Messages[0].Direction != "incoming" {
		t.Fatalf("history = %#v", page)
	}
}

func TestRealtimeTopicProjectsMessagesInOrder(t *testing.T) {
	sig, _ := im.NewUserSig("sig")
	conversation, _ := im.NewC2CConversation("human-2")
	reference, _ := im.NewMessageRef(conversation, "m2", 8, time.Now().UnixMilli())
	transport := &fakeTransport{events: make(chan im.Event, 1)}
	adapter := NewAdapter(Config{
		Issuer:       fakeIssuer{session: humanplatform.IMSession{SDKAppID: 123, UserID: "human-1", UserSig: sig}},
		NewTransport: func() (im.Transport, error) { return transport, nil },
	})
	if err := adapter.Connect(context.Background(), "launch-1"); err != nil {
		t.Fatal(err)
	}
	allowTestScope(t, adapter)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan []Message, 1)
	go func() {
		_ = adapter.MessagesTopic(ctx, nil, func(value any) error {
			result <- value.([]Message)
			return nil
		})
	}()
	waitForSubscriber(t, adapter, "messages")
	transport.events <- im.Event{Type: im.EventMessage, Message: &im.IncomingMessage{
		Ref: reference, SenderUserID: "human-2", Elements: []im.Element{{Type: im.ElementText, Text: "实时"}},
	}}
	select {
	case messages := <-result:
		if len(messages) != 1 || messages[0].ID != "m2" {
			t.Fatalf("messages = %#v", messages)
		}
	case <-time.After(time.Second):
		t.Fatal("realtime message was not delivered")
	}
}

func TestConversationTopicProjectsTencentUpdates(t *testing.T) {
	sig, _ := im.NewUserSig("sig")
	direct, _ := im.NewC2CConversation("human-2")
	transport := &fakeTransport{events: make(chan im.Event, 1)}
	adapter := NewAdapter(Config{
		Issuer:       fakeIssuer{session: humanplatform.IMSession{SDKAppID: 123, UserID: "human-1", UserSig: sig}},
		NewTransport: func() (im.Transport, error) { return transport, nil },
	})
	if err := adapter.Connect(context.Background(), "launch-1"); err != nil {
		t.Fatal(err)
	}
	allowTestScope(t, adapter)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan []ConversationSummary, 1)
	go func() {
		_ = adapter.ConversationsTopic(ctx, nil, func(value any) error {
			result <- value.([]ConversationSummary)
			return nil
		})
	}()
	waitForSubscriber(t, adapter, "conversations")
	transport.events <- im.Event{
		Type: im.EventConversationUpdated,
		Conversations: []im.ConversationSummary{{
			Conversation: direct, UnreadCount: 2, Title: "李雷",
		}},
	}

	select {
	case conversations := <-result:
		if len(conversations) != 1 || conversations[0].ConversationID != "C2Chuman-2" ||
			conversations[0].Kind != "direct" || conversations[0].Title != "李雷" ||
			conversations[0].UnreadCount != 2 {
			t.Fatalf("conversations = %#v", conversations)
		}
	case <-time.After(time.Second):
		t.Fatal("conversation update was not delivered")
	}
}

func TestKickedOutMakesAdapterTerminalBeforeNextCommand(t *testing.T) {
	sig, _ := im.NewUserSig("sig")
	transport := &fakeTransport{events: make(chan im.Event, 1)}
	adapter := NewAdapter(Config{
		Issuer: fakeIssuer{session: humanplatform.IMSession{
			SDKAppID: 123, UserID: "human-1", UserSig: sig,
		}},
		NewTransport: func() (im.Transport, error) { return transport, nil },
	})
	if err := adapter.Connect(context.Background(), "launch-1"); err != nil {
		t.Fatal(err)
	}
	allowTestScope(t, adapter)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lifecycle := make(chan map[string]any, 1)
	go func() {
		_ = adapter.LifecycleTopic(ctx, nil, func(value any) error {
			lifecycle <- value.(map[string]any)
			return nil
		})
	}()
	waitForSubscriber(t, adapter, "lifecycle")
	transport.events <- im.Event{Type: im.EventKickedOut, Reason: "kicked_out_mult_account"}
	select {
	case event := <-lifecycle:
		if event["type"] != "kicked_out" {
			t.Fatalf("lifecycle = %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("kicked-out lifecycle was not delivered")
	}

	_, err := adapter.ListConversations(context.Background(), nil)
	if err == nil {
		t.Fatal("ListConversations() unexpectedly succeeded after kicked-out")
	}
	var coded interface{ NativeCode() string }
	if !errors.As(err, &coded) || coded.NativeCode() != "IM_KICKED_OUT" {
		t.Fatalf("ListConversations() error = %v, native code = %v", err, coded)
	}
	if transport.conversationCalls != 0 {
		t.Fatalf("conversation calls = %d, want 0 after terminal event", transport.conversationCalls)
	}
}

type safeCodeError struct{ code string }

func (e safeCodeError) Error() string    { return "safe SDK failure" }
func (e safeCodeError) SafeCode() string { return e.code }

func TestSDKNotLoggedInBecomesReconnectableIMState(t *testing.T) {
	sig, _ := im.NewUserSig("sig")
	transport := &fakeTransport{
		events:          make(chan im.Event, 1),
		conversationErr: safeCodeError{code: "sdk_2024"},
	}
	adapter := NewAdapter(Config{
		Issuer: fakeIssuer{session: humanplatform.IMSession{
			SDKAppID: 123, UserID: "human-1", UserSig: sig,
		}},
		NewTransport: func() (im.Transport, error) { return transport, nil },
	})
	if err := adapter.Connect(context.Background(), "launch-1"); err != nil {
		t.Fatal(err)
	}
	allowTestScope(t, adapter)

	_, err := adapter.ListConversations(context.Background(), nil)
	if err == nil {
		t.Fatal("ListConversations() unexpectedly succeeded")
	}
	var coded interface{ NativeCode() string }
	if !errors.As(err, &coded) || coded.NativeCode() != "IM_NOT_READY" {
		t.Fatalf("ListConversations() error = %v, native code = %v", err, coded)
	}
	if !errors.Is(err, ErrNotConnected) {
		t.Fatalf("ListConversations() error = %v, want ErrNotConnected", err)
	}
}

func TestServerScopeFiltersSnapshotsAndRejectsCrossServerOperations(t *testing.T) {
	sig, _ := im.NewUserSig("sig")
	allowedDirect, _ := im.NewC2CConversation("human-2")
	blockedDirect, _ := im.NewC2CConversation("other-human")
	allowedTopic, _ := im.NewTopicConversation("shared-group", "topic-allowed")
	transport := &fakeTransport{
		events: make(chan im.Event, 1),
		conversations: im.ConversationSnapshot{IsSyncCompleted: true, Items: []im.ConversationSummary{
			{Conversation: allowedDirect, Title: "李雷"},
			{Conversation: blockedDirect, Title: "其他 Server"},
			{Conversation: allowedTopic, Title: "当前 Topic"},
		}},
	}
	adapter := NewAdapter(Config{
		Issuer: fakeIssuer{session: humanplatform.IMSession{
			SDKAppID: 123, UserID: "human-1", UserSig: sig,
		}},
		NewTransport: func() (im.Transport, error) { return transport, nil },
	})
	if err := adapter.Connect(context.Background(), "launch-1"); err != nil {
		t.Fatal(err)
	}
	allowTestScope(t, adapter, Address{
		ChannelID: "channel-1", ConversationID: "GROUPtopic-allowed",
		TargetID: "topic-allowed", IMGroupID: "shared-group",
		IMTopicID: ptr("topic-allowed"),
	})

	snapshot, err := adapter.ListConversations(context.Background(), []string{"shared-group"})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Items) != 2 || snapshot.Items[0].ConversationID != "C2Chuman-2" ||
		snapshot.Items[1].ConversationID != "GROUPtopic-allowed" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if snapshot.Items[0].PeerUserID != "human-2" {
		t.Fatalf("direct peerUserId = %q, want human-2", snapshot.Items[0].PeerUserID)
	}
	blocked := Address{
		ConversationID: "C2Cother-human", DirectUserID: "other-human",
		TargetID: "other-human",
	}
	if _, err := adapter.LoadHistory(context.Background(), HistoryInput{Channel: blocked}); !errors.Is(err, ErrOutsideScope) {
		t.Fatalf("LoadHistory() error = %v, want ErrOutsideScope", err)
	}
	if _, err := adapter.SendText(context.Background(), SendTextInput{
		Channel: blocked, ClientRequestID: "blocked-1", Text: "不应发送",
	}); !errors.Is(err, ErrOutsideScope) {
		t.Fatalf("SendText() error = %v, want ErrOutsideScope", err)
	}
}

func TestRevokeReturnsNormalizedSystemMessage(t *testing.T) {
	sig, _ := im.NewUserSig("sig")
	conversation, _ := im.NewGroupConversation("group-1")
	reference, _ := im.NewMessageRef(conversation, "message-own", 7, 1_800_000_000_000)
	transport := &fakeTransport{
		events: make(chan im.Event),
		history: im.HistoryPage{Completed: true, Messages: []im.IncomingMessage{{
			Ref: reference, SenderUserID: "human-1",
			Elements: []im.Element{{Type: im.ElementText, Text: "待撤回"}},
		}}},
	}
	adapter := NewAdapter(Config{
		Issuer:       fakeIssuer{session: humanplatform.IMSession{SDKAppID: 123, UserID: "human-1", UserSig: sig}},
		NewTransport: func() (im.Transport, error) { return transport, nil },
	})
	if err := adapter.Connect(context.Background(), "launch-1"); err != nil {
		t.Fatal(err)
	}
	address := Address{ChannelID: "channel-1", ConversationID: "GROUPgroup-1", TargetID: "group-1", IMGroupID: "group-1"}
	allowTestScope(t, adapter, address)
	if _, err := adapter.LoadHistory(context.Background(), HistoryInput{Channel: address}); err != nil {
		t.Fatal(err)
	}

	message, err := adapter.Revoke(context.Background(), "message-own")
	if err != nil {
		t.Fatal(err)
	}
	if transport.recalled.MessageID() != "message-own" || message.ID != "message-own" ||
		message.Kind != "system" || message.RawType != "TIMRevokedElem" || message.Text != "[消息已撤回]" {
		t.Fatalf("message = %#v recalled = %#v", message, transport.recalled)
	}
}

func TestReadAttachmentRejectsOversizeBeforeAllocatingFileContents(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "large-attachment-*")
	if err != nil {
		t.Fatal(err)
	}
	name := file.Name()
	if err := file.Truncate(maxAttachmentBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := readAttachment(name); !errors.Is(err, im.ErrInvalidAttachment) {
		t.Fatalf("readAttachment() error = %v", err)
	}
}

func TestLocalPathAcceptsOnlyExplicitLocalAbsoluteFiles(t *testing.T) {
	if value, err := localPath("file:///tmp/你好.txt"); err != nil || value != "/tmp/你好.txt" {
		t.Fatalf("localPath(file) = %q, %v", value, err)
	}
	for _, value := range []string{"relative.txt", "https://example.test/a", "file://remote-host/tmp/a"} {
		if _, err := localPath(value); !errors.Is(err, im.ErrInvalidAttachment) {
			t.Fatalf("localPath(%q) error = %v", value, err)
		}
	}
}

func ptr(value string) *string { return &value }

func waitForSubscriber(t *testing.T, adapter *Adapter, topic string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		adapter.mu.Lock()
		count := len(adapter.subscribers[topic])
		adapter.mu.Unlock()
		if count > 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("%s subscriber was not registered", topic)
}
