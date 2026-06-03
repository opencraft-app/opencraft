package router

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/store"
)

type fakeACP struct {
	newCalls    int
	loadCalls   int
	promptCalls int
	lastPrompt  string
	sessionID   string
	reply       string
	loadErr     error
}

func (f *fakeACP) NewSession(context.Context, string) (string, error) {
	f.newCalls++
	if f.sessionID == "" {
		f.sessionID = "session-a"
	}
	return f.sessionID, nil
}

func (f *fakeACP) LoadSession(context.Context, string, string) error {
	f.loadCalls++
	return f.loadErr
}

func (f *fakeACP) Prompt(_ context.Context, _ string, text string) (acp.PromptResult, error) {
	f.promptCalls++
	f.lastPrompt = text
	return acp.PromptResult{StopReason: "end_turn", Text: f.reply}, nil
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
	if client.newCalls != 1 || client.promptCalls != 1 || client.lastPrompt != "hello" {
		t.Fatalf("unexpected acp calls: %#v", client)
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
	if client.promptCalls != 1 {
		t.Fatalf("duplicate inbound should not prompt again: calls=%d", client.promptCalls)
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
	if client.promptCalls != 0 {
		t.Fatalf("prompt must not run after load failure, got %d", client.promptCalls)
	}
}
