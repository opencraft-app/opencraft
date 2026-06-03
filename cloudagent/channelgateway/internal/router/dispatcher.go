package router

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/store"
)

type Dispatcher struct {
	store        SessionStore
	account      store.ChannelAccount
	acp          ACPClient
	cwd          string
	callbacks    ChannelCallbacks
	timeout      time.Duration
	sessionLocks sync.Map
}

type DispatcherOptions struct {
	Callbacks      ChannelCallbacks
	RequestTimeout time.Duration
}

type SessionStore interface {
	InsertInboundMessage(ctx context.Context, rec store.MessageRecord) (bool, error)
	GetOrCreateConversation(ctx context.Context, conv store.Conversation) (store.Conversation, error)
	BindACPSession(ctx context.Context, channelAccountID, sessionKey, acpSessionID string) error
	EnqueueOutbox(ctx context.Context, rec store.OutboxRecord) (store.OutboxRecord, error)
}

type OutboxStore interface {
	ClaimPendingOutbox(ctx context.Context, lease store.ChannelLease, limit int) ([]store.OutboxRecord, error)
	MarkOutboxFailed(ctx context.Context, lease store.ChannelLease, outboxID, detail string, retryAt time.Time) error
	MarkOutboxSent(ctx context.Context, lease store.ChannelLease, outboxID string) error
}

type ACPClient interface {
	NewSession(ctx context.Context, cwd string) (string, error)
	LoadSession(ctx context.Context, sessionID, cwd string) error
	Prompt(ctx context.Context, sessionID, text string) (acp.PromptResult, error)
}

func NewDispatcher(st SessionStore, account store.ChannelAccount, client ACPClient, cwd string) *Dispatcher {
	return NewDispatcherWithOptions(st, account, client, cwd, DispatcherOptions{})
}

func NewDispatcherWithOptions(st SessionStore, account store.ChannelAccount, client ACPClient, cwd string, opts DispatcherOptions) *Dispatcher {
	if strings.TrimSpace(cwd) == "" {
		cwd = "/workspace"
	}
	callbacks := opts.Callbacks
	if callbacks == nil {
		callbacks = DefaultChannelCallbacks{}
	}
	return &Dispatcher{
		store:     st,
		account:   account,
		acp:       client,
		cwd:       cwd,
		callbacks: callbacks,
		timeout:   opts.RequestTimeout,
	}
}

func (d *Dispatcher) HandleInbound(ctx context.Context, msg channel.Message) error {
	if d != nil && d.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, d.timeout)
		defer cancel()
	}
	return d.handleInbound(ctx, msg)
}

func (d *Dispatcher) handleInbound(ctx context.Context, msg channel.Message) error {
	startedAt := time.Now()
	if d == nil || d.store == nil || d.acp == nil {
		return errors.New("dispatcher is not configured")
	}
	if strings.TrimSpace(msg.ChannelAccountID) == "" {
		msg.ChannelAccountID = d.account.ChannelAccountID
	}
	if msg.ChannelType == "" {
		msg.ChannelType = channel.Type(d.account.ChannelType)
	}
	if msg.ReceivedAt.IsZero() {
		msg.ReceivedAt = time.Now().UTC()
	}
	inserted, err := d.store.InsertInboundMessage(ctx, store.MessageRecord{
		ChannelAccountID:       msg.ChannelAccountID,
		ChannelType:            string(msg.ChannelType),
		ExternalMessageID:      msg.ExternalMessageID,
		ExternalConversationID: msg.ExternalConversationID,
		Direction:              "inbound",
		Status:                 "received",
		PayloadJSON:            string(msg.Raw),
	})
	if err != nil {
		return err
	}
	if !inserted {
		log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s action=dedup_skip",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID))
		return nil
	}
	log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s chat_type=%s external_conversation_id=%s external_user_id=%s thread_id=%s action=inbound_received kind=%s",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
		logValue(string(msg.ChatType)), logValue(msg.ExternalConversationID), logValue(msg.ExternalUserID),
		logValue(msg.ThreadID), logValue(string(msg.Kind)))
	if msg.Kind != channel.MessageText || strings.TrimSpace(msg.Text) == "" {
		_, err := d.enqueueTextReply(ctx, msg, "", "暂时只支持文本消息。")
		return err
	}
	sessionKey := channel.BuildSessionKey(d.account.AgentID, msg, true, false)
	log.Printf("channelgateway session_trace account_id=%s agent_id=%s message_id=%s chat_type=%s external_conversation_id=%s external_user_id=%s thread_id=%s session_key=%s action=lookup",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
		logValue(string(msg.ChatType)), logValue(msg.ExternalConversationID), logValue(msg.ExternalUserID),
		logValue(msg.ThreadID), logValue(sessionKey))
	sessionLock := d.lockForSessionKey(sessionKey)
	sessionLock.Lock()
	defer sessionLock.Unlock()
	conversation, err := d.store.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       msg.ChannelAccountID,
		ChannelType:            string(msg.ChannelType),
		ExternalConversationID: msg.ExternalConversationID,
		ExternalUserID:         msg.ExternalUserID,
		ChatType:               string(msg.ChatType),
		ThreadID:               msg.ThreadID,
		AgentID:                d.account.AgentID,
		SessionKey:             sessionKey,
	})
	if err != nil {
		return err
	}
	if command, ok := d.callbacksOrDefault().HandleCommand(msg.Text); ok {
		return d.handleCommand(ctx, msg, conversation, command)
	}
	sessionID := conversation.ACPSessionID
	if sessionID == "" {
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s action=session_new reason=missing_acp_session",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID), logValue(conversation.SessionKey))
		sessionID, err = d.acp.NewSession(ctx, d.cwd)
		if err != nil {
			return d.handleACPError(ctx, msg, conversation, "", CallbackStageNewSession, err)
		}
		if err := d.store.BindACPSession(ctx, conversation.ChannelAccountID, conversation.SessionKey, sessionID); err != nil {
			return err
		}
		conversation.ACPSessionID = sessionID
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=session_bound",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
			logValue(conversation.SessionKey), logValue(sessionID))
	} else {
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=session_load",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
			logValue(conversation.SessionKey), logValue(sessionID))
		if err := d.acp.LoadSession(ctx, sessionID, d.cwd); err != nil {
			if !isMissingACPSessionError(err) {
				return d.handleACPError(ctx, msg, conversation, sessionID, CallbackStageLoadSession, err)
			}
			log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=session_recreate reason=missing_acp_runtime_session",
				logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
				logValue(conversation.SessionKey), logValue(sessionID))
			sessionID, err = d.acp.NewSession(ctx, d.cwd)
			if err != nil {
				return d.handleACPError(ctx, msg, conversation, sessionID, CallbackStageNewSession, err)
			}
			if err := d.store.BindACPSession(ctx, conversation.ChannelAccountID, conversation.SessionKey, sessionID); err != nil {
				return err
			}
			conversation.ACPSessionID = sessionID
			log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=session_bound reason=recreated",
				logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
				logValue(conversation.SessionKey), logValue(sessionID))
		}
	}
	promptStartedAt := time.Now()
	log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=acp_prompt_start text_bytes=%d",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
		logValue(conversation.ConversationID), logValue(conversation.SessionKey), logValue(sessionID), len([]byte(msg.Text)))
	result, sessionID, err := d.promptWithRuntimeRecovery(ctx, conversation, msg, sessionID)
	if err != nil {
		log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=acp_prompt_failed duration_ms=%d error=%s",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
			logValue(conversation.ConversationID), logValue(conversation.SessionKey), logValue(sessionID),
			time.Since(promptStartedAt).Milliseconds(), logValue(err.Error()))
		return d.handleACPError(ctx, msg, conversation, sessionID, CallbackStagePrompt, err)
	}
	log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=acp_prompt_done duration_ms=%d stop_reason=%s output_bytes=%d",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
		logValue(conversation.ConversationID), logValue(conversation.SessionKey), logValue(sessionID),
		time.Since(promptStartedAt).Milliseconds(), logValue(result.StopReason), len([]byte(result.Text)))
	replyText := strings.TrimSpace(result.Text)
	if replyText == "" {
		replyText = defaultReplyForStopReason(result.StopReason)
	}
	if replyText == "" {
		log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=inbound_done result=no_reply duration_ms=%d",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
			logValue(conversation.ConversationID), logValue(conversation.SessionKey), logValue(sessionID),
			time.Since(startedAt).Milliseconds())
		return nil
	}
	outbox, err := d.enqueueTextReply(ctx, msg, sessionID, replyText)
	if err != nil {
		return err
	}
	log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s conversation_id=%s session_key=%s acp_session_id=%s outbox_id=%s action=inbound_done result=reply_queued duration_ms=%d",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
		logValue(conversation.ConversationID), logValue(conversation.SessionKey), logValue(sessionID),
		logValue(outbox.OutboxID), time.Since(startedAt).Milliseconds())
	return nil
}

func (d *Dispatcher) callbacksOrDefault() ChannelCallbacks {
	if d.callbacks != nil {
		return d.callbacks
	}
	return DefaultChannelCallbacks{}
}

func (d *Dispatcher) handleCommand(ctx context.Context, msg channel.Message, conversation store.Conversation, command CommandCallbackResult) error {
	switch command.Action {
	case CommandActionReset:
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s action=session_reset",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID), logValue(conversation.SessionKey))
		sessionID, err := d.acp.NewSession(ctx, d.cwd)
		if err != nil {
			return d.handleACPError(ctx, msg, conversation, conversation.ACPSessionID, CallbackStageReset, err)
		}
		if err := d.store.BindACPSession(ctx, conversation.ChannelAccountID, conversation.SessionKey, sessionID); err != nil {
			return err
		}
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=session_reset_bound",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
			logValue(conversation.SessionKey), logValue(sessionID))
		reply := strings.TrimSpace(command.Reply)
		if reply == "" {
			reply = "已重新创建云端会话。你可以继续发送消息。"
		}
		_, err = d.enqueueTextReply(ctx, msg, sessionID, reply)
		return err
	default:
		return nil
	}
}

func (d *Dispatcher) handleACPError(ctx context.Context, msg channel.Message, conversation store.Conversation, sessionID string, stage CallbackStage, err error) error {
	log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=acp_error stage=%s error=%s",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
		logValue(conversation.SessionKey), logValue(sessionID), logValue(string(stage)), logValue(err.Error()))
	reply, ok := d.callbacksOrDefault().HandleACPError(stage, err)
	if !ok || strings.TrimSpace(reply) == "" {
		return err
	}
	enqueueCtx := ctx
	var cancel context.CancelFunc
	if ctx.Err() != nil {
		enqueueCtx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
	}
	if _, enqueueErr := d.enqueueTextReply(enqueueCtx, msg, sessionID, reply); enqueueErr != nil {
		return enqueueErr
	}
	return nil
}

func (d *Dispatcher) promptWithRuntimeRecovery(ctx context.Context, conversation store.Conversation, msg channel.Message, sessionID string) (acp.PromptResult, string, error) {
	result, err := d.acp.Prompt(ctx, sessionID, msg.Text)
	if err == nil {
		return result, sessionID, nil
	}
	if !isRecoverableRuntimeError(err) {
		return acp.PromptResult{}, sessionID, err
	}
	log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=session_recreate reason=runtime_unavailable",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
		logValue(conversation.ConversationID), logValue(conversation.SessionKey), logValue(sessionID))
	newSessionID, newErr := d.acp.NewSession(ctx, d.cwd)
	if newErr != nil {
		return acp.PromptResult{}, sessionID, newErr
	}
	if bindErr := d.store.BindACPSession(ctx, conversation.ChannelAccountID, conversation.SessionKey, newSessionID); bindErr != nil {
		return acp.PromptResult{}, sessionID, bindErr
	}
	log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s conversation_id=%s session_key=%s old_acp_session_id=%s acp_session_id=%s action=session_bound reason=runtime_recreated",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
		logValue(conversation.ConversationID), logValue(conversation.SessionKey), logValue(sessionID), logValue(newSessionID))
	result, retryErr := d.acp.Prompt(ctx, newSessionID, msg.Text)
	if retryErr != nil {
		return acp.PromptResult{}, newSessionID, retryErr
	}
	return result, newSessionID, nil
}

func (d *Dispatcher) lockForSessionKey(sessionKey string) *sync.Mutex {
	lock, _ := d.sessionLocks.LoadOrStore(sessionKey, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func logValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "-"
	}
	value = strings.NewReplacer("\n", "\\n", "\r", "\\r", "\t", "\\t").Replace(value)
	if len(value) > 160 {
		return value[:160] + "...[truncated]"
	}
	return value
}

func isMissingACPSessionError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "session not found")
}

func isRecoverableRuntimeError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "session runtime is unavailable") ||
		strings.Contains(message, "runtime_not_recovered") ||
		strings.Contains(message, "runtime unavailable")
}

func (d *Dispatcher) enqueueTextReply(ctx context.Context, msg channel.Message, sessionID, text string) (store.OutboxRecord, error) {
	payload, err := json.Marshal(channel.Reply{
		ChannelAccountID:       msg.ChannelAccountID,
		ExternalConversationID: msg.ExternalConversationID,
		ExternalMessageID:      msg.ExternalMessageID,
		Text:                   text,
	})
	if err != nil {
		return store.OutboxRecord{}, err
	}
	outbox, err := d.store.EnqueueOutbox(ctx, store.OutboxRecord{
		ChannelAccountID:       msg.ChannelAccountID,
		ChannelType:            string(msg.ChannelType),
		ExternalConversationID: msg.ExternalConversationID,
		ACPSessionID:           sessionID,
		PayloadJSON:            string(payload),
		Status:                 "pending",
		NextRetryAt:            time.Now().UTC(),
	})
	if err != nil {
		return store.OutboxRecord{}, err
	}
	log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s external_conversation_id=%s acp_session_id=%s outbox_id=%s action=outbox_queued payload_bytes=%d text_bytes=%d",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
		logValue(msg.ExternalConversationID), logValue(sessionID), logValue(outbox.OutboxID),
		len([]byte(outbox.PayloadJSON)), len([]byte(text)))
	return outbox, nil
}

func defaultReplyForStopReason(reason string) string {
	switch strings.TrimSpace(reason) {
	case "", "end_turn":
		return ""
	case "cancelled":
		return "当前任务已取消。"
	default:
		return "任务已结束。"
	}
}

type OutboxSender interface {
	Send(ctx context.Context, reply channel.Reply) (channel.SendResult, error)
}

func DrainOutbox(ctx context.Context, st OutboxStore, lease store.ChannelLease, sender OutboxSender, limit int) (int, error) {
	if limit <= 0 {
		limit = 16
	}
	items, err := st.ClaimPendingOutbox(ctx, lease, limit)
	if err != nil {
		return 0, err
	}
	for _, item := range items {
		var reply channel.Reply
		if err := json.Unmarshal([]byte(item.PayloadJSON), &reply); err != nil {
			log.Printf("channelgateway business_trace account_id=%s external_conversation_id=%s acp_session_id=%s outbox_id=%s action=outbox_decode_failed error=%s",
				logValue(item.ChannelAccountID), logValue(item.ExternalConversationID), logValue(item.ACPSessionID),
				logValue(item.OutboxID), logValue(err.Error()))
			_ = st.MarkOutboxFailed(ctx, lease, item.OutboxID, err.Error(), time.Now().UTC().Add(time.Minute))
			continue
		}
		sendStartedAt := time.Now()
		log.Printf("channelgateway business_trace account_id=%s external_conversation_id=%s acp_session_id=%s outbox_id=%s action=outbox_send_start claim_owner=%s claim_fence=%d retry_count=%d text_bytes=%d",
			logValue(item.ChannelAccountID), logValue(item.ExternalConversationID), logValue(item.ACPSessionID),
			logValue(item.OutboxID), logValue(item.ClaimOwnerID), item.ClaimFencingToken, item.RetryCount, len([]byte(reply.Text)))
		result, err := sender.Send(ctx, reply)
		if err != nil {
			log.Printf("channelgateway business_trace account_id=%s external_conversation_id=%s acp_session_id=%s outbox_id=%s action=outbox_send_failed duration_ms=%d error=%s",
				logValue(item.ChannelAccountID), logValue(item.ExternalConversationID), logValue(item.ACPSessionID),
				logValue(item.OutboxID), time.Since(sendStartedAt).Milliseconds(), logValue(err.Error()))
			_ = st.MarkOutboxFailed(ctx, lease, item.OutboxID, err.Error(), time.Now().UTC().Add(retryBackoff(item.RetryCount)))
			continue
		}
		_ = result
		if err := st.MarkOutboxSent(ctx, lease, item.OutboxID); err != nil {
			log.Printf("channelgateway business_trace account_id=%s external_conversation_id=%s acp_session_id=%s outbox_id=%s action=outbox_mark_sent_failed duration_ms=%d error=%s",
				logValue(item.ChannelAccountID), logValue(item.ExternalConversationID), logValue(item.ACPSessionID),
				logValue(item.OutboxID), time.Since(sendStartedAt).Milliseconds(), logValue(err.Error()))
			return len(items), err
		}
		log.Printf("channelgateway business_trace account_id=%s external_conversation_id=%s acp_session_id=%s outbox_id=%s action=outbox_sent duration_ms=%d",
			logValue(item.ChannelAccountID), logValue(item.ExternalConversationID), logValue(item.ACPSessionID),
			logValue(item.OutboxID), time.Since(sendStartedAt).Milliseconds())
	}
	return len(items), nil
}

func retryBackoff(retryCount int) time.Duration {
	if retryCount < 0 {
		retryCount = 0
	}
	backoff := time.Duration(1<<min(retryCount, 6)) * time.Second
	if backoff < time.Second {
		return time.Second
	}
	return backoff
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
