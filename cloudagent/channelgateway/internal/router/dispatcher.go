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
	sessionLocks sync.Map
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
	if strings.TrimSpace(cwd) == "" {
		cwd = "/workspace"
	}
	return &Dispatcher{store: st, account: account, acp: client, cwd: cwd}
}

func (d *Dispatcher) HandleInbound(ctx context.Context, msg channel.Message) error {
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
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s message_id=%s action=dedup_skip",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID))
		return nil
	}
	if msg.Kind != channel.MessageText || strings.TrimSpace(msg.Text) == "" {
		return d.enqueueTextReply(ctx, msg, "", "暂时只支持文本消息。")
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
	sessionID := conversation.ACPSessionID
	if sessionID == "" {
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s action=session_new reason=missing_acp_session",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID), logValue(conversation.SessionKey))
		sessionID, err = d.acp.NewSession(ctx, d.cwd)
		if err != nil {
			return err
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
				return err
			}
			log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=session_recreate reason=missing_acp_runtime_session",
				logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
				logValue(conversation.SessionKey), logValue(sessionID))
			sessionID, err = d.acp.NewSession(ctx, d.cwd)
			if err != nil {
				return err
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
	result, err := d.acp.Prompt(ctx, sessionID, msg.Text)
	if err != nil {
		return err
	}
	replyText := strings.TrimSpace(result.Text)
	if replyText == "" {
		replyText = defaultReplyForStopReason(result.StopReason)
	}
	if replyText == "" {
		return nil
	}
	return d.enqueueTextReply(ctx, msg, sessionID, replyText)
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

func (d *Dispatcher) enqueueTextReply(ctx context.Context, msg channel.Message, sessionID, text string) error {
	payload, err := json.Marshal(channel.Reply{
		ChannelAccountID:       msg.ChannelAccountID,
		ExternalConversationID: msg.ExternalConversationID,
		ExternalMessageID:      msg.ExternalMessageID,
		Text:                   text,
	})
	if err != nil {
		return err
	}
	_, err = d.store.EnqueueOutbox(ctx, store.OutboxRecord{
		ChannelAccountID:       msg.ChannelAccountID,
		ChannelType:            string(msg.ChannelType),
		ExternalConversationID: msg.ExternalConversationID,
		ACPSessionID:           sessionID,
		PayloadJSON:            string(payload),
		Status:                 "pending",
		NextRetryAt:            time.Now().UTC(),
	})
	return err
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
			_ = st.MarkOutboxFailed(ctx, lease, item.OutboxID, err.Error(), time.Now().UTC().Add(time.Minute))
			continue
		}
		result, err := sender.Send(ctx, reply)
		if err != nil {
			_ = st.MarkOutboxFailed(ctx, lease, item.OutboxID, err.Error(), time.Now().UTC().Add(retryBackoff(item.RetryCount)))
			continue
		}
		_ = result
		if err := st.MarkOutboxSent(ctx, lease, item.OutboxID); err != nil {
			return len(items), err
		}
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
