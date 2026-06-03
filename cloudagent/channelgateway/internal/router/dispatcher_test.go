package router

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/store"
)

type fakeACP struct {
	mu          sync.Mutex
	newCalls    int
	loadCalls   int
	promptCalls int
	lastPrompt  string
	sessionID   string
	reply       string
	loadErr     error
	newDelay    time.Duration
}

func (f *fakeACP) NewSession(ctx context.Context, _ string) (string, error) {
	if f.newDelay > 0 {
		select {
		case <-time.After(f.newDelay):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.newCalls++
	if f.sessionID == "" {
		f.sessionID = "session-a"
	}
	return f.sessionID, nil
}

func (f *fakeACP) LoadSession(context.Context, string, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loadCalls++
	return f.loadErr
}

func (f *fakeACP) Prompt(_ context.Context, _ string, text string) (acp.PromptResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.promptCalls++
	f.lastPrompt = text
	return acp.PromptResult{StopReason: "end_turn", Text: f.reply}, nil
}

func (f *fakeACP) snapshot() (newCalls, loadCalls, promptCalls int, lastPrompt string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.newCalls, f.loadCalls, f.promptCalls, f.lastPrompt
}

func TestDispatcherCreatesSessionPromptsAndEnqueuesReply(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	account := store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}
	lease, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	client := &fakeACP{reply: "answer"}
	dispatcher := NewDispatcher(st, account, client, "/workspace")
	msg := channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-a",
		ExternalConversationID: "chat-a",
		ExternalUserID:         "user-a",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   "hello",
		Raw:                    json.RawMessage(`{"ok":true}`),
	}
	if err := dispatcher.HandleInbound(ctx, msg); err != nil {
		t.Fatalf("handle inbound: %v", err)
	}
	newCalls, _, promptCalls, lastPrompt := client.snapshot()
	if newCalls != 1 || promptCalls != 1 || lastPrompt != "hello" {
		t.Fatalf("unexpected acp calls: new=%d prompt=%d last=%q", newCalls, promptCalls, lastPrompt)
	}
	items, err := st.ClaimPendingOutbox(ctx, lease, 10)
	if err != nil {
		t.Fatalf("claim outbox: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected one outbox reply, got %#v", items)
	}
	var reply channel.Reply
	if err := json.Unmarshal([]byte(items[0].PayloadJSON), &reply); err != nil {
		t.Fatalf("decode reply: %v", err)
	}
	if reply.Text != "answer" || reply.ExternalConversationID != "chat-a" {
		t.Fatalf("unexpected reply: %#v", reply)
	}
}

func TestDispatcherDedupsInboundMessage(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	client := &fakeACP{reply: "answer"}
	dispatcher := NewDispatcher(st, store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}, client, "/workspace")
	msg := channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-a",
		ExternalConversationID: "chat-a",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   "hello",
		Raw:                    json.RawMessage(`{"ok":true}`),
	}
	if err := dispatcher.HandleInbound(ctx, msg); err != nil {
		t.Fatalf("first inbound: %v", err)
	}
	if err := dispatcher.HandleInbound(ctx, msg); err != nil {
		t.Fatalf("duplicate inbound: %v", err)
	}
	_, _, promptCalls, _ := client.snapshot()
	if promptCalls != 1 {
		t.Fatalf("duplicate inbound should not prompt again: calls=%d", promptCalls)
	}
}

func TestDispatcherSerializesSessionCreationForSameConversation(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	client := &fakeACP{reply: "answer", sessionID: "session-a", newDelay: 50 * time.Millisecond}
	dispatcher := NewDispatcher(st, store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}, client, "/workspace")
	base := channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalConversationID: "chat-a",
		ExternalUserID:         "user-a",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Raw:                    json.RawMessage(`{"ok":true}`),
	}
	first := base
	first.ExternalMessageID = "msg-a"
	first.Text = "hello"
	second := base
	second.ExternalMessageID = "msg-b"
	second.Text = "again"

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, msg := range []channel.Message{first, second} {
		msg := msg
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- dispatcher.HandleInbound(ctx, msg)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("handle inbound: %v", err)
		}
	}
	newCalls, loadCalls, promptCalls, _ := client.snapshot()
	if newCalls != 1 || loadCalls != 1 || promptCalls != 2 {
		t.Fatalf("same conversation should create once then load: new=%d load=%d prompt=%d", newCalls, loadCalls, promptCalls)
	}
	sessionKey := channel.BuildSessionKey("main", first, true, false)
	conversation, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-a",
		ExternalUserID:         "user-a",
		ChatType:               string(channel.ChatDM),
		AgentID:                "main",
		SessionKey:             sessionKey,
	})
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	if conversation.ACPSessionID != "session-a" {
		t.Fatalf("unexpected bound session: %#v", conversation)
	}
}

func TestDispatcherStopsWhenExistingSessionLoadFails(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	account := store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}
	sessionKey := channel.BuildSessionKey("main", channel.Message{
		ChannelType:            channel.TypeWeCom,
		ChatType:               channel.ChatDM,
		ExternalConversationID: "chat-a",
	}, true, false)
	if _, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-a",
		ChatType:               string(channel.ChatDM),
		AgentID:                "main",
		ACPSessionID:           "session-existing",
		SessionKey:             sessionKey,
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	client := &fakeACP{loadErr: errors.New("load failed"), reply: "answer"}
	dispatcher := NewDispatcher(st, account, client, "/workspace")
	err = dispatcher.HandleInbound(ctx, channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-a",
		ExternalConversationID: "chat-a",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   "hello",
		Raw:                    json.RawMessage(`{"ok":true}`),
	})
	if err == nil {
		t.Fatal("expected load failure")
	}
	_, _, promptCalls, _ := client.snapshot()
	if promptCalls != 0 {
		t.Fatalf("prompt must not run after load failure, got %d", promptCalls)
	}
}

func TestDispatcherRecreatesSessionWhenExistingACPSessionIsMissing(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	account := store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}
	seedMsg := channel.Message{
		ChannelType:            channel.TypeWeCom,
		ChatType:               channel.ChatDM,
		ExternalConversationID: "chat-a",
	}
	sessionKey := channel.BuildSessionKey("main", seedMsg, true, false)
	if _, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-a",
		ChatType:               string(channel.ChatDM),
		AgentID:                "main",
		ACPSessionID:           "session-stale",
		SessionKey:             sessionKey,
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	client := &fakeACP{
		loadErr:   errors.New("rpc error -32000: session not found"),
		reply:     "answer",
		sessionID: "session-new",
	}
	dispatcher := NewDispatcher(st, account, client, "/workspace")
	err = dispatcher.HandleInbound(ctx, channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-a",
		ExternalConversationID: "chat-a",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   "hello",
		Raw:                    json.RawMessage(`{"ok":true}`),
	})
	if err != nil {
		t.Fatalf("handle inbound should recreate missing session: %v", err)
	}
	newCalls, loadCalls, promptCalls, lastPrompt := client.snapshot()
	if newCalls != 1 || loadCalls != 1 || promptCalls != 1 || lastPrompt != "hello" {
		t.Fatalf("unexpected acp calls: new=%d load=%d prompt=%d last=%q", newCalls, loadCalls, promptCalls, lastPrompt)
	}
	conversation, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-a",
		ChatType:               string(channel.ChatDM),
		AgentID:                "main",
		SessionKey:             sessionKey,
	})
	if err != nil {
		t.Fatalf("reload conversation: %v", err)
	}
	if conversation.ACPSessionID != "session-new" {
		t.Fatalf("expected recreated session binding, got %#v", conversation)
	}
}
