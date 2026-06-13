package router

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/store"
)

type fakeACP struct {
	mu            sync.Mutex
	newCalls      int
	loadCalls     int
	closeCalls    int
	promptCalls   int
	lastPrompt    string
	sessionID     string
	sessionIDs    []string
	ensureCalls   int
	ensureChanged bool
	ensureErr     error
	ensureErrs    []error
	reply         string
	loadErr       error
	promptErrs    []error
	newDelay      time.Duration
	newErr        error
	closeErr      error
	waitPrompt    bool
	workspaceKeys []string
}

func (f *fakeACP) NewSession(ctx context.Context, _, workspaceKey string) (string, error) {
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
	f.workspaceKeys = append(f.workspaceKeys, workspaceKey)
	if f.newErr != nil {
		return "", f.newErr
	}
	if len(f.sessionIDs) > 0 {
		sessionID := f.sessionIDs[0]
		f.sessionIDs = f.sessionIDs[1:]
		f.sessionID = sessionID
		return sessionID, nil
	}
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

func (f *fakeACP) CloseSession(context.Context, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeCalls++
	return f.closeErr
}

func (f *fakeACP) EnsureRuntimeReady(context.Context, string, string) (acp.RuntimeReadyResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ensureCalls++
	if len(f.ensureErrs) > 0 {
		err := f.ensureErrs[0]
		f.ensureErrs = f.ensureErrs[1:]
		return acp.RuntimeReadyResult{}, err
	}
	if f.ensureErr != nil {
		return acp.RuntimeReadyResult{}, f.ensureErr
	}
	return acp.RuntimeReadyResult{Changed: f.ensureChanged}, nil
}

func (f *fakeACP) Prompt(ctx context.Context, _ string, text string) (acp.PromptResult, error) {
	f.mu.Lock()
	f.promptCalls++
	f.lastPrompt = text
	waitPrompt := f.waitPrompt
	f.mu.Unlock()
	if waitPrompt {
		<-ctx.Done()
		return acp.PromptResult{}, ctx.Err()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.promptErrs) > 0 {
		err := f.promptErrs[0]
		f.promptErrs = f.promptErrs[1:]
		if err != nil {
			return acp.PromptResult{}, err
		}
	}
	return acp.PromptResult{StopReason: "end_turn", Text: f.reply}, nil
}

func (f *fakeACP) snapshot() (newCalls, loadCalls, promptCalls int, lastPrompt string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.newCalls, f.loadCalls, f.promptCalls, f.lastPrompt
}

func (f *fakeACP) ensureSnapshot() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ensureCalls
}

func (f *fakeACP) closeSnapshot() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closeCalls
}

type fakeReplySender struct {
	mu   sync.Mutex
	sent []channel.Reply
	err  error
}

func (s *fakeReplySender) Send(_ context.Context, reply channel.Reply) (channel.SendResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return channel.SendResult{}, s.err
	}
	s.sent = append(s.sent, reply)
	return channel.SendResult{}, nil
}

func (s *fakeReplySender) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sent)
}

func captureLogs(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	oldWriter := log.Writer()
	oldFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(oldWriter)
		log.SetFlags(oldFlags)
	}()
	fn()
	return buf.String()
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

func TestDispatcherEmitsBusinessTraceForSuccessfulInbound(t *testing.T) {
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
	sender := &fakeReplySender{}
	msg := channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-trace",
		ExternalConversationID: "chat-trace",
		ExternalUserID:         "user-trace",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   "hello",
		Raw:                    json.RawMessage(`{"ok":true}`),
	}
	logs := captureLogs(t, func() {
		if err := dispatcher.HandleInbound(ctx, msg); err != nil {
			t.Fatalf("handle inbound: %v", err)
		}
		if _, err := DrainOutbox(ctx, st, lease, sender, 10); err != nil {
			t.Fatalf("drain outbox: %v", err)
		}
	})
	if sender.count() != 1 {
		t.Fatalf("expected one sent reply, got %d", sender.count())
	}
	for _, want := range []string{
		"business_trace",
		"message_id=msg-trace",
		"external_conversation_id=chat-trace",
		"action=inbound_received",
		"action=acp_prompt_start",
		"action=acp_prompt_done",
		"action=outbox_queued",
		"action=inbound_done result=reply_queued",
		"action=outbox_send_start",
		"action=outbox_sent",
	} {
		if !strings.Contains(logs, want) {
			t.Fatalf("expected logs to contain %q, got:\n%s", want, logs)
		}
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

func TestDispatcherIgnoresUnsupportedNonTextMessage(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	lease, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	client := &fakeACP{reply: "answer"}
	dispatcher := NewDispatcher(st, store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}, client, "/workspace")
	msg := channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-file",
		ExternalConversationID: "chat-a",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageFile,
		Raw:                    json.RawMessage(`{"msgtype":"image"}`),
	}
	logs := captureLogs(t, func() {
		if err := dispatcher.HandleInbound(ctx, msg); err != nil {
			t.Fatalf("non-text inbound should be ignored without error: %v", err)
		}
	})
	if _, _, promptCalls, _ := client.snapshot(); promptCalls != 0 {
		t.Fatalf("non-text inbound must not call ACP, got prompt calls=%d", promptCalls)
	}
	items, err := st.ClaimPendingOutbox(ctx, lease, 10)
	if err != nil {
		t.Fatalf("claim outbox: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("non-text inbound must not enqueue fallback replies, got %#v", items)
	}
	if !strings.Contains(logs, "action=unsupported_message_ignored") {
		t.Fatalf("expected unsupported message log, got:\n%s", logs)
	}
}

func TestDispatcherReplyOutboxIsIdempotentForSameInboundMessage(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	lease, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	msg := channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-duplicate",
		ExternalConversationID: "chat-a",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   "hello",
		Raw:                    json.RawMessage(`{"ok":true}`),
	}
	dispatcher := NewDispatcher(st, store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}, &fakeACP{reply: "answer"}, "/workspace")
	if _, err := dispatcher.enqueueTextReply(ctx, msg, "session-a", "same answer"); err != nil {
		t.Fatalf("enqueue first reply: %v", err)
	}
	if _, err := dispatcher.enqueueTextReply(ctx, msg, "session-b", "same answer"); err != nil {
		t.Fatalf("enqueue duplicate reply: %v", err)
	}
	items, err := st.ClaimPendingOutbox(ctx, lease, 10)
	if err != nil {
		t.Fatalf("claim outbox: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("duplicate replies for one inbound message must collapse to one outbox item, got %#v", items)
	}
}

func TestDrainOutboxAbandonsRetryLimitWithoutSending(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	lease, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	if _, err := st.EnqueueOutbox(ctx, store.OutboxRecord{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-a",
		PayloadJSON:            `{"externalConversationID":"chat-a","externalMessageID":"msg-a","text":"retry me"}`,
		Status:                 "pending",
		RetryCount:             maxOutboxRetries,
		NextRetryAt:            time.Now().UTC(),
	}); err != nil {
		t.Fatalf("enqueue outbox: %v", err)
	}
	sender := &fakeReplySender{}
	n, err := DrainOutbox(ctx, st, lease, sender, 10)
	if err != nil {
		t.Fatalf("drain outbox: %v", err)
	}
	if n != 1 || sender.count() != 0 {
		t.Fatalf("retry-limited outbox should be abandoned without sending, drained=%d sent=%d", n, sender.count())
	}
	items, err := st.ClaimPendingOutbox(ctx, lease, 10)
	if err != nil {
		t.Fatalf("claim after abandon: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("abandoned outbox must not be pending again, got %#v", items)
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

func TestDispatcherEnqueuesFallbackWhenExistingSessionLoadFails(t *testing.T) {
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
	if err != nil {
		t.Fatalf("handle inbound should enqueue fallback: %v", err)
	}
	_, _, promptCalls, _ := client.snapshot()
	if promptCalls != 0 {
		t.Fatalf("prompt must not run after load failure, got %d", promptCalls)
	}
	reply := claimOneReply(t, ctx, st, lease)
	if !strings.Contains(reply.Text, runtimeRecoveryFailedReply) || !strings.Contains(reply.Text, "/reset") {
		t.Fatalf("expected recovery fallback reply, got %#v", reply)
	}
}

func TestDispatcherEnqueuesWakeupNoticeWhenExistingRuntimeIsRestored(t *testing.T) {
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
		ACPSessionID:           "session-existing",
		SessionKey:             sessionKey,
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	client := &fakeACP{ensureChanged: true, reply: "answer"}
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
		t.Fatalf("handle inbound: %v", err)
	}
	if got := client.ensureSnapshot(); got != 1 {
		t.Fatalf("expected one ensure_ready call, got %d", got)
	}
	items, err := st.ClaimPendingOutbox(ctx, lease, 10)
	if err != nil {
		t.Fatalf("claim outbox: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected wakeup notice and model reply, got %#v", items)
	}
	var wakeup, answer channel.Reply
	if err := json.Unmarshal([]byte(items[0].PayloadJSON), &wakeup); err != nil {
		t.Fatalf("decode wakeup: %v", err)
	}
	if err := json.Unmarshal([]byte(items[1].PayloadJSON), &answer); err != nil {
		t.Fatalf("decode answer: %v", err)
	}
	if wakeup.Text != sessionRestoredReply || answer.Text != "answer" {
		t.Fatalf("unexpected replies: wakeup=%#v answer=%#v", wakeup, answer)
	}
}

func TestDispatcherDoesNotEnqueueWakeupNoticeWhenRuntimeAlreadyReady(t *testing.T) {
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
		ACPSessionID:           "session-existing",
		SessionKey:             sessionKey,
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	client := &fakeACP{ensureChanged: false, reply: "answer"}
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
		t.Fatalf("handle inbound: %v", err)
	}
	if got := client.ensureSnapshot(); got != 1 {
		t.Fatalf("expected one ensure_ready call, got %d", got)
	}
	reply := claimOneReply(t, ctx, st, lease)
	if reply.Text != "answer" {
		t.Fatalf("expected only model reply, got %#v", reply)
	}
}

func TestDispatcherEnqueuesSleepNoticeWhenRuntimeStorageCompletes(t *testing.T) {
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
	sessionKey := "agent:main:wecom:dm:chat-a"
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
	dispatcher := NewDispatcher(st, account, &fakeACP{}, "/workspace")
	if err := dispatcher.HandleWorkspaceLifecycle(ctx, acp.WorkspaceLifecycleEvent{
		SessionID:   "session-existing",
		Operation:   "storage",
		Phase:       "cleanup",
		Status:      "done",
		LifecycleID: "storage:session-existing:cleanup",
	}); err != nil {
		t.Fatalf("handle workspace lifecycle: %v", err)
	}
	reply := claimOneReply(t, ctx, st, lease)
	if reply.Text != sessionStoredReply || reply.ExternalConversationID != "chat-a" || reply.ExternalMessageID != "storage:session-existing:cleanup" {
		t.Fatalf("unexpected storage reply: %#v", reply)
	}
}

func TestDispatcherSleepNoticeIsIdempotentPerLifecycleID(t *testing.T) {
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
	if _, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-a",
		ChatType:               string(channel.ChatDM),
		AgentID:                "main",
		ACPSessionID:           "session-existing",
		SessionKey:             "agent:main:wecom:dm:chat-a",
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	dispatcher := NewDispatcher(st, account, &fakeACP{}, "/workspace")
	events := []acp.WorkspaceLifecycleEvent{
		{SessionID: "session-existing", Operation: "storage", Phase: "cleanup", Status: "done", LifecycleID: "storage:session-existing:cleanup:1"},
		{SessionID: "session-existing", Operation: "storage", Phase: "cleanup", Status: "done", LifecycleID: "storage:session-existing:cleanup:1"},
		{SessionID: "session-existing", Operation: "storage", Phase: "cleanup", Status: "done", LifecycleID: "storage:session-existing:cleanup:2"},
	}
	for _, event := range events {
		if err := dispatcher.HandleWorkspaceLifecycle(ctx, event); err != nil {
			t.Fatalf("handle workspace lifecycle %#v: %v", event, err)
		}
	}
	items, err := st.ClaimPendingOutbox(ctx, lease, 10)
	if err != nil {
		t.Fatalf("claim outbox: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("same lifecycle id should dedupe while later sleeps still notify, got %#v", items)
	}
}

func TestDispatcherIgnoresNonTerminalStorageLifecycleForSleepNotice(t *testing.T) {
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
	if _, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-a",
		ChatType:               string(channel.ChatDM),
		AgentID:                "main",
		ACPSessionID:           "session-existing",
		SessionKey:             "agent:main:wecom:dm:chat-a",
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	dispatcher := NewDispatcher(st, account, &fakeACP{}, "/workspace")
	for _, event := range []acp.WorkspaceLifecycleEvent{
		{SessionID: "session-existing", Operation: "storage", Phase: "cleanup", Status: "running"},
		{SessionID: "session-existing", Operation: "storage", Phase: "cleanup", Status: "failed"},
		{SessionID: "session-existing", Operation: "restore", Phase: "runtime", Status: "done"},
	} {
		if err := dispatcher.HandleWorkspaceLifecycle(ctx, event); err != nil {
			t.Fatalf("handle workspace lifecycle %#v: %v", event, err)
		}
	}
	items, err := st.ClaimPendingOutbox(ctx, lease, 10)
	if err != nil {
		t.Fatalf("claim outbox: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("non-terminal storage lifecycle should not enqueue sleep notice: %#v", items)
	}
}

func TestDispatcherClosesIdleConversationOnce(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	account := store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}
	sessionKey := "agent:main:wecom:dm:chat-idle"
	if _, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-idle",
		ChatType:               string(channel.ChatDM),
		AgentID:                "main",
		ACPSessionID:           "session-idle",
		SessionKey:             sessionKey,
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	fake := &fakeACP{}
	dispatcher := NewDispatcher(st, account, fake, "/workspace")
	time.Sleep(time.Millisecond)
	closed, err := dispatcher.CloseIdleConversations(ctx, time.Nanosecond, 10)
	if err != nil {
		t.Fatalf("close idle conversations: %v", err)
	}
	if closed != 1 || fake.closeSnapshot() != 1 {
		t.Fatalf("expected one idle close, closed=%d closeCalls=%d", closed, fake.closeSnapshot())
	}
	closed, err = dispatcher.CloseIdleConversations(ctx, time.Nanosecond, 10)
	if err != nil {
		t.Fatalf("close idle conversations again: %v", err)
	}
	if closed != 0 || fake.closeSnapshot() != 1 {
		t.Fatalf("closed conversation should not be closed again, closed=%d closeCalls=%d", closed, fake.closeSnapshot())
	}
	conv, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-idle",
		ChatType:               string(channel.ChatDM),
		AgentID:                "main",
		ACPSessionID:           "session-idle",
		SessionKey:             sessionKey,
	})
	if err != nil {
		t.Fatalf("reactivate conversation: %v", err)
	}
	if conv.RuntimeClosedAt != "" {
		t.Fatalf("inbound activity should clear runtime closed marker: %#v", conv)
	}
}

func TestDispatcherMarksGhostSessionClosedDuringIdleClose(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	account := store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}
	sessionKey := "agent:main:wecom:group:chat-ghost"
	if _, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-ghost",
		ChatType:               string(channel.ChatGroup),
		AgentID:                "main",
		ACPSessionID:           "session-ghost",
		SessionKey:             sessionKey,
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	fake := &fakeACP{closeErr: errors.New("rpc error -32000: session not found")}
	dispatcher := NewDispatcher(st, account, fake, "/workspace")
	time.Sleep(time.Millisecond)
	closed, err := dispatcher.CloseIdleConversations(ctx, time.Nanosecond, 10)
	if err != nil {
		t.Fatalf("ghost session should not abort idle close batch: %v", err)
	}
	if closed != 1 || fake.closeSnapshot() != 1 {
		t.Fatalf("expected ghost session marked closed, closed=%d closeCalls=%d", closed, fake.closeSnapshot())
	}
	conv, ok, err := st.LoadConversationBySessionKey(ctx, "wecom-a", sessionKey)
	if err != nil || !ok {
		t.Fatalf("reload conversation: ok=%v err=%v", ok, err)
	}
	if conv.RuntimeClosedAt == "" {
		t.Fatalf("ghost session should be marked runtime closed: %#v", conv)
	}
}

func TestDispatcherRecreatesSessionWhenEnsureReadyReportsRuntimeUnavailableAtLoad(t *testing.T) {
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
		WorkspaceKey:           "workspace-stable",
		SessionKey:             sessionKey,
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	client := &fakeACP{
		ensureErrs: []error{errors.New("rpc error -32003: session runtime is unavailable")},
		reply:      "answer after load recreate",
		sessionID:  "session-new",
	}
	dispatcher := NewDispatcher(st, account, client, "/workspace")
	logs := captureLogs(t, func() {
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
	})
	if err != nil {
		t.Fatalf("handle inbound should recreate after load-phase runtime unavailable: %v", err)
	}
	newCalls, loadCalls, promptCalls, _ := client.snapshot()
	if newCalls != 1 || loadCalls != 1 || promptCalls != 1 {
		t.Fatalf("unexpected acp calls: new=%d load=%d prompt=%d", newCalls, loadCalls, promptCalls)
	}
	if !strings.Contains(logs, "action=session_recreate_same_workspace reason=runtime_unavailable") {
		t.Fatalf("expected load-phase runtime recovery logs, got:\n%s", logs)
	}
}

func TestDispatcherDoesNotCloseConversationWithActiveInbound(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	account := store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}
	sessionKey := "agent:main:wecom:dm:chat-active"
	if _, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-active",
		ChatType:               string(channel.ChatDM),
		AgentID:                "main",
		ACPSessionID:           "session-active",
		SessionKey:             sessionKey,
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	if _, err := st.InsertInboundMessage(ctx, store.MessageRecord{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalMessageID:      "msg-active",
		ExternalConversationID: "chat-active",
		ACPSessionID:           "session-active",
		Direction:              "inbound",
		Status:                 "processing",
		PayloadJSON:            "{}",
	}); err != nil {
		t.Fatalf("insert active inbound: %v", err)
	}
	fake := &fakeACP{}
	dispatcher := NewDispatcher(st, account, fake, "/workspace")
	time.Sleep(time.Millisecond)
	closed, err := dispatcher.CloseIdleConversations(ctx, time.Nanosecond, 10)
	if err != nil {
		t.Fatalf("close idle conversations: %v", err)
	}
	if closed != 0 || fake.closeSnapshot() != 0 {
		t.Fatalf("active inbound must block idle close, closed=%d closeCalls=%d", closed, fake.closeSnapshot())
	}
}

func TestDispatcherPreservesBindingWhenExistingACPSessionIsMissing(t *testing.T) {
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
		WorkspaceKey:           "workspace-stable",
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
		t.Fatalf("handle inbound should enqueue missing-session fallback: %v", err)
	}
	newCalls, loadCalls, promptCalls, lastPrompt := client.snapshot()
	if newCalls != 0 || loadCalls != 1 || promptCalls != 0 || lastPrompt != "" {
		t.Fatalf("unexpected acp calls: new=%d load=%d prompt=%d last=%q", newCalls, loadCalls, promptCalls, lastPrompt)
	}
	reply := claimOneReply(t, ctx, st, lease)
	if !strings.Contains(reply.Text, runtimeRecoveryFailedReply) || !strings.Contains(reply.Text, "/reset") {
		t.Fatalf("expected recovery fallback reply, got %#v", reply)
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
	if conversation.ACPSessionID != "session-stale" {
		t.Fatalf("missing ACP session must preserve existing session binding, got %#v", conversation)
	}
	if conversation.WorkspaceKey != "workspace-stable" || len(client.workspaceKeys) != 0 {
		t.Fatalf("missing ACP session must not rotate workspace key: conv=%#v workspace_keys=%#v", conversation, client.workspaceKeys)
	}
}

func TestDispatcherRecreatesAndRetriesWhenRuntimeUnavailable(t *testing.T) {
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
		WorkspaceKey:           "workspace-stable",
		SessionKey:             sessionKey,
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	client := &fakeACP{
		promptErrs: []error{errors.New("rpc error -32003: session runtime is unavailable")},
		reply:      "answer after recreate",
		sessionID:  "session-new",
	}
	dispatcher := NewDispatcher(st, account, client, "/workspace")
	logs := captureLogs(t, func() {
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
	})
	if err != nil {
		t.Fatalf("handle inbound should retry after runtime unavailable: %v", err)
	}
	newCalls, loadCalls, promptCalls, _ := client.snapshot()
	if newCalls != 1 || loadCalls != 1 || promptCalls != 2 {
		t.Fatalf("unexpected acp calls: new=%d load=%d prompt=%d", newCalls, loadCalls, promptCalls)
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
	if conversation.WorkspaceKey != "workspace-stable" || len(client.workspaceKeys) != 1 || client.workspaceKeys[0] != "workspace-stable" {
		t.Fatalf("runtime recovery must preserve workspace key: conv=%#v workspace_keys=%#v", conversation, client.workspaceKeys)
	}
	if !strings.Contains(logs, "action=session_recreate reason=runtime_unavailable") ||
		!strings.Contains(logs, "action=session_bound reason=runtime_recreated") {
		t.Fatalf("expected runtime recovery logs, got:\n%s", logs)
	}
	items, err := st.ClaimPendingOutbox(ctx, lease, 10)
	if err != nil {
		t.Fatalf("claim outbox: %v", err)
	}
	if len(items) != 1 || !strings.Contains(items[0].PayloadJSON, "answer after recreate") {
		t.Fatalf("expected model reply after recreate, got %#v", items)
	}
}

func TestDispatcherEnqueuesFallbackWhenPromptFails(t *testing.T) {
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
	client := &fakeACP{
		promptErrs: []error{errors.New("model failed")},
		sessionID:  "session-a",
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
		t.Fatalf("handle inbound should enqueue fallback: %v", err)
	}
	reply := claimOneReply(t, ctx, st, lease)
	if !strings.Contains(reply.Text, runtimeRecoveryFailedReply) || !strings.Contains(reply.Text, "/reset") {
		t.Fatalf("expected recovery fallback reply, got %#v", reply)
	}
}

func TestDispatcherRequestTimeoutEnqueuesFallback(t *testing.T) {
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
	client := &fakeACP{sessionID: "session-a", waitPrompt: true}
	dispatcher := NewDispatcherWithOptions(st, account, client, "/workspace",
		DispatcherOptions{RequestTimeout: 100 * time.Millisecond},
	)
	err = dispatcher.HandleInbound(ctx, channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-timeout",
		ExternalConversationID: "chat-a",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   "hello",
		Raw:                    json.RawMessage(`{"ok":true}`),
	})
	if err != nil {
		t.Fatalf("timeout should still enqueue fallback: %v", err)
	}
	reply := claimOneReply(t, context.Background(), st, lease)
	if !strings.Contains(reply.Text, runtimeRecoveryFailedReply) {
		t.Fatalf("expected timeout fallback reply, got %#v", reply)
	}
}

func TestDispatcherResetCreatesNewSessionAndDoesNotPrompt(t *testing.T) {
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
		ACPSessionID:           "session-old",
		WorkspaceKey:           "workspace-old",
		SessionKey:             sessionKey,
	}); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	client := &fakeACP{sessionIDs: []string{"session-new"}, reply: "answer"}
	dispatcher := NewDispatcher(st, account, client, "/workspace")
	err = dispatcher.HandleInbound(ctx, channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-reset",
		ExternalConversationID: "chat-a",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   "/reset",
		Raw:                    json.RawMessage(`{"ok":true}`),
	})
	if err != nil {
		t.Fatalf("reset inbound: %v", err)
	}
	newCalls, loadCalls, promptCalls, _ := client.snapshot()
	if newCalls != 1 || loadCalls != 0 || promptCalls != 0 {
		t.Fatalf("reset should only create new session: new=%d load=%d prompt=%d", newCalls, loadCalls, promptCalls)
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
		t.Fatalf("expected reset session binding, got %#v", conversation)
	}
	if len(client.workspaceKeys) != 1 || client.workspaceKeys[0] == "" || client.workspaceKeys[0] == "workspace-old" || conversation.WorkspaceKey != client.workspaceKeys[0] {
		t.Fatalf("reset should rotate workspace key: conv=%#v workspace_keys=%#v", conversation, client.workspaceKeys)
	}
	reply := claimOneReply(t, ctx, st, lease)
	if !strings.Contains(reply.Text, resetSessionReply) {
		t.Fatalf("expected reset reply, got %#v", reply)
	}
}

func claimOneReply(t *testing.T, ctx context.Context, st *store.Store, lease store.ChannelLease) channel.Reply {
	t.Helper()
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
	return reply
}
