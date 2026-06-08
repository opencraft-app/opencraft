package router

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	inboundLease store.ChannelLease
	inboundStale time.Duration
	sessionLocks sync.Map
}

type DispatcherOptions struct {
	Callbacks      ChannelCallbacks
	RequestTimeout time.Duration
	InboundLease   store.ChannelLease
	InboundStale   time.Duration
}

type SessionStore interface {
	InsertInboundMessage(ctx context.Context, rec store.MessageRecord) (bool, error)
	ClaimInboundMessage(ctx context.Context, lease store.ChannelLease, externalMessageID string, staleAfter time.Duration) (store.MessageRecord, bool, error)
	MarkInboundMessageDone(ctx context.Context, lease store.ChannelLease, messageID, acpSessionID string) error
	MarkInboundMessageFailed(ctx context.Context, lease store.ChannelLease, messageID, acpSessionID, detail string, retryAt time.Time) error
	GetOrCreateConversation(ctx context.Context, conv store.Conversation) (store.Conversation, error)
	LoadConversationBySessionKey(ctx context.Context, channelAccountID, sessionKey string) (store.Conversation, bool, error)
	ListIdleOpenConversations(ctx context.Context, channelAccountID string, cutoff time.Time, limit int) ([]store.IdleConversation, error)
	ConversationHasActiveInbound(ctx context.Context, channelAccountID, externalConversationID string) (bool, error)
	FindConversationByACPSession(ctx context.Context, channelAccountID, acpSessionID string) (store.Conversation, bool, error)
	BindACPSession(ctx context.Context, channelAccountID, sessionKey, acpSessionID string) error
	BindACPWorkspaceSession(ctx context.Context, channelAccountID, sessionKey, acpSessionID, workspaceKey string) error
	MarkConversationRuntimeClosed(ctx context.Context, channelAccountID, sessionKey, acpSessionID string) error
	EnqueueOutbox(ctx context.Context, rec store.OutboxRecord) (store.OutboxRecord, error)
}

type OutboxStore interface {
	ClaimPendingOutbox(ctx context.Context, lease store.ChannelLease, limit int) ([]store.OutboxRecord, error)
	MarkOutboxAbandoned(ctx context.Context, lease store.ChannelLease, outboxID, detail string) error
	MarkOutboxFailed(ctx context.Context, lease store.ChannelLease, outboxID, detail string, retryAt time.Time) error
	MarkOutboxSent(ctx context.Context, lease store.ChannelLease, outboxID string) error
}

type ACPClient interface {
	NewSession(ctx context.Context, cwd, workspaceKey string) (string, error)
	LoadSession(ctx context.Context, sessionID, cwd string) error
	CloseSession(ctx context.Context, sessionID string) error
	EnsureRuntimeReady(ctx context.Context, sessionID, cwd string) (acp.RuntimeReadyResult, error)
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
		store:        st,
		account:      account,
		acp:          client,
		cwd:          cwd,
		callbacks:    callbacks,
		timeout:      opts.RequestTimeout,
		inboundLease: normalizedInboundLease(account.ChannelAccountID, opts.InboundLease),
		inboundStale: opts.InboundStale,
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

func (d *Dispatcher) CloseIdleConversations(ctx context.Context, idleFor time.Duration, limit int) (int, error) {
	if d == nil || d.store == nil || d.acp == nil {
		return 0, errors.New("dispatcher is not configured")
	}
	if idleFor <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-idleFor)
	items, err := d.store.ListIdleOpenConversations(ctx, d.account.ChannelAccountID, cutoff, limit)
	if err != nil {
		return 0, err
	}
	log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=session_idle_close_batch_start candidates=%d idle_seconds=%.3f cutoff=%s",
		logValue(d.account.ChannelAccountID), logValue(d.account.AgentID), len(items), idleFor.Seconds(), logValue(cutoff.Format(time.RFC3339Nano)))
	for idx, item := range items {
		idleSeconds := 0.0
		if !item.UpdatedAt.IsZero() {
			idleSeconds = time.Since(item.UpdatedAt).Seconds()
		}
		log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=session_idle_close_candidate index=%d conversation_id=%s session_key=%s acp_session_id=%s idle_seconds=%.3f updated_at=%s",
			logValue(d.account.ChannelAccountID), logValue(d.account.AgentID), idx,
			logValue(item.ConversationID), logValue(item.SessionKey), logValue(item.ACPSessionID),
			idleSeconds, logValue(item.UpdatedAt.UTC().Format(time.RFC3339Nano)))
	}
	closed := 0
	for _, item := range items {
		if strings.TrimSpace(item.SessionKey) == "" || strings.TrimSpace(item.ACPSessionID) == "" {
			log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=session_idle_close_skip conversation_id=%s session_key=%s acp_session_id=%s reason=missing_session_key_or_acp_session_id",
				logValue(d.account.ChannelAccountID), logValue(d.account.AgentID),
				logValue(item.ConversationID), logValue(item.SessionKey), logValue(item.ACPSessionID))
			continue
		}
		sessionLock := d.lockForSessionKey(item.SessionKey)
		sessionLock.Lock()
		ok, err := d.closeIdleConversationLocked(ctx, item, cutoff)
		sessionLock.Unlock()
		if err != nil {
			log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=session_idle_close_batch_abort closed=%d candidate_conversation_id=%s candidate_session_key=%s candidate_acp_session_id=%s error=%s",
				logValue(d.account.ChannelAccountID), logValue(d.account.AgentID), closed,
				logValue(item.ConversationID), logValue(item.SessionKey), logValue(item.ACPSessionID), logValue(err.Error()))
			return closed, err
		}
		if ok {
			closed++
		}
	}
	log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=session_idle_close_batch_complete closed=%d candidates=%d",
		logValue(d.account.ChannelAccountID), logValue(d.account.AgentID), closed, len(items))
	return closed, nil
}

func (d *Dispatcher) closeIdleConversationLocked(ctx context.Context, item store.IdleConversation, cutoff time.Time) (bool, error) {
	current, ok, err := d.store.LoadConversationBySessionKey(ctx, item.ChannelAccountID, item.SessionKey)
	if err != nil || !ok {
		if err == nil {
			log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=session_idle_close_skip conversation_id=%s session_key=%s acp_session_id=%s reason=conversation_not_found",
				logValue(item.ChannelAccountID), logValue(d.account.AgentID),
				logValue(item.ConversationID), logValue(item.SessionKey), logValue(item.ACPSessionID))
		}
		return false, err
	}
	if current.ACPSessionID != item.ACPSessionID || strings.TrimSpace(current.RuntimeClosedAt) != "" {
		log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=session_idle_close_skip conversation_id=%s session_key=%s acp_session_id=%s reason=session_binding_changed current_acp_session_id=%s runtime_closed_at=%s",
			logValue(current.ChannelAccountID), logValue(d.account.AgentID),
			logValue(current.ConversationID), logValue(current.SessionKey), logValue(item.ACPSessionID),
			logValue(current.ACPSessionID), logValue(current.RuntimeClosedAt))
		return false, nil
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, current.UpdatedAt)
	if err != nil || updatedAt.After(cutoff) {
		reason := "not_idle_enough"
		if err != nil {
			reason = "invalid_updated_at"
		}
		log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=session_idle_close_skip conversation_id=%s session_key=%s acp_session_id=%s reason=%s updated_at=%s cutoff=%s",
			logValue(current.ChannelAccountID), logValue(d.account.AgentID),
			logValue(current.ConversationID), logValue(current.SessionKey), logValue(current.ACPSessionID),
			logValue(reason), logValue(current.UpdatedAt), logValue(cutoff.Format(time.RFC3339Nano)))
		return false, nil
	}
	active, err := d.store.ConversationHasActiveInbound(ctx, current.ChannelAccountID, current.ExternalConversationID)
	if err != nil || active {
		if err == nil {
			log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=session_idle_close_skip conversation_id=%s session_key=%s acp_session_id=%s reason=active_inbound external_conversation_id=%s",
				logValue(current.ChannelAccountID), logValue(d.account.AgentID),
				logValue(current.ConversationID), logValue(current.SessionKey), logValue(current.ACPSessionID),
				logValue(current.ExternalConversationID))
		}
		return false, err
	}
	log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s idle_seconds=%.3f action=session_idle_close_start",
		logValue(current.ChannelAccountID), logValue(d.account.AgentID), logValue(current.ConversationID),
		logValue(current.SessionKey), logValue(current.ACPSessionID), time.Since(updatedAt).Seconds())
	if err := d.acp.CloseSession(ctx, current.ACPSessionID); err != nil {
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=session_idle_close_failed error=%s",
			logValue(current.ChannelAccountID), logValue(d.account.AgentID), logValue(current.ConversationID),
			logValue(current.SessionKey), logValue(current.ACPSessionID), logValue(err.Error()))
		return false, err
	}
	if err := d.store.MarkConversationRuntimeClosed(ctx, current.ChannelAccountID, current.SessionKey, current.ACPSessionID); err != nil {
		return false, err
	}
	log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=session_idle_close_done",
		logValue(current.ChannelAccountID), logValue(d.account.AgentID), logValue(current.ConversationID),
		logValue(current.SessionKey), logValue(current.ACPSessionID))
	return true, nil
}

func (d *Dispatcher) handleInbound(ctx context.Context, msg channel.Message) (retErr error) {
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
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	inserted, err := d.store.InsertInboundMessage(ctx, store.MessageRecord{
		ChannelAccountID:       msg.ChannelAccountID,
		ChannelType:            string(msg.ChannelType),
		ExternalMessageID:      msg.ExternalMessageID,
		ExternalConversationID: msg.ExternalConversationID,
		Direction:              "inbound",
		Status:                 "received",
		PayloadJSON:            string(payload),
	})
	if err != nil {
		return err
	}
	inboundLease := d.inboundLeaseFor(msg.ChannelAccountID)
	inbound, claimed, err := d.store.ClaimInboundMessage(ctx, inboundLease, msg.ExternalMessageID, d.inboundStale)
	if err != nil {
		return err
	}
	if !inserted {
		if !claimed {
			log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s status=%s action=dedup_skip",
				logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID), logValue(inbound.Status))
			return nil
		}
		log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s status=%s action=inbound_reclaimed",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID), logValue(inbound.Status))
	}
	if inserted && !claimed {
		log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s status=%s action=inbound_claim_skip",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID), logValue(inbound.Status))
		return nil
	}
	var sessionID string
	defer func() {
		if inbound.MessageID == "" {
			return
		}
		if markErr := d.finishInboundMessage(ctx, inboundLease, inbound.MessageID, sessionID, retErr); markErr != nil && retErr == nil {
			retErr = markErr
		}
	}()
	log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s chat_type=%s external_conversation_id=%s external_user_id=%s thread_id=%s action=inbound_received kind=%s",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID),
		logValue(string(msg.ChatType)), logValue(msg.ExternalConversationID), logValue(msg.ExternalUserID),
		logValue(msg.ThreadID), logValue(string(msg.Kind)))
	if msg.Kind != channel.MessageText || strings.TrimSpace(msg.Text) == "" {
		log.Printf("channelgateway business_trace account_id=%s agent_id=%s message_id=%s kind=%s action=unsupported_message_ignored",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(msg.ExternalMessageID), logValue(string(msg.Kind)))
		return nil
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
	sessionID = conversation.ACPSessionID
	if sessionID == "" {
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s workspace_key=%s action=session_new reason=missing_acp_session",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID), logValue(conversation.SessionKey),
			logValue(conversation.WorkspaceKey))
		sessionID, err = d.acp.NewSession(ctx, d.cwd, conversation.WorkspaceKey)
		if err != nil {
			return d.handleACPError(ctx, msg, conversation, "", CallbackStageNewSession, err)
		}
		if err := d.store.BindACPSession(ctx, conversation.ChannelAccountID, conversation.SessionKey, sessionID); err != nil {
			return err
		}
		conversation.ACPSessionID = sessionID
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s workspace_key=%s acp_session_id=%s action=session_bound",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
			logValue(conversation.SessionKey), logValue(conversation.WorkspaceKey), logValue(sessionID))
	} else {
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s workspace_key=%s acp_session_id=%s action=session_load",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
			logValue(conversation.SessionKey), logValue(conversation.WorkspaceKey), logValue(sessionID))
		if err := d.acp.LoadSession(ctx, sessionID, d.cwd); err != nil {
			if !isMissingACPSessionError(err) {
				log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=load_session_no_recovery stage=load_session recoverable_runtime=%t error=%s",
					logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
					logValue(conversation.SessionKey), logValue(sessionID), isRecoverableRuntimeError(err), logValue(err.Error()))
				return d.handleACPError(ctx, msg, conversation, sessionID, CallbackStageLoadSession, err)
			}
			rebuiltSessionID, rebuildErr := d.recreateSessionWithSameWorkspace(ctx, msg, conversation, sessionID, "missing_acp_runtime_session")
			if rebuildErr != nil {
				return d.handleACPError(ctx, msg, conversation, sessionID, CallbackStageNewSession, rebuildErr)
			}
			sessionID = rebuiltSessionID
			conversation.ACPSessionID = rebuiltSessionID
			if err := d.ensureRuntimeReady(ctx, msg, conversation, sessionID); err != nil {
				return d.handleACPError(ctx, msg, conversation, sessionID, CallbackStageLoadSession, err)
			}
		} else if err := d.ensureRuntimeReady(ctx, msg, conversation, sessionID); err != nil {
			if !isMissingACPSessionError(err) {
				log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=load_session_no_recovery stage=ensure_runtime_ready recoverable_runtime=%t error=%s",
					logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
					logValue(conversation.SessionKey), logValue(sessionID), isRecoverableRuntimeError(err), logValue(err.Error()))
				return d.handleACPError(ctx, msg, conversation, sessionID, CallbackStageLoadSession, err)
			}
			rebuiltSessionID, rebuildErr := d.recreateSessionWithSameWorkspace(ctx, msg, conversation, sessionID, "ensure_ready_missing_acp_runtime_session")
			if rebuildErr != nil {
				return d.handleACPError(ctx, msg, conversation, sessionID, CallbackStageNewSession, rebuildErr)
			}
			sessionID = rebuiltSessionID
			conversation.ACPSessionID = rebuiltSessionID
			if err := d.ensureRuntimeReady(ctx, msg, conversation, sessionID); err != nil {
				return d.handleACPError(ctx, msg, conversation, sessionID, CallbackStageLoadSession, err)
			}
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

func normalizedInboundLease(accountID string, lease store.ChannelLease) store.ChannelLease {
	if strings.TrimSpace(lease.ChannelAccountID) == "" {
		lease.ChannelAccountID = accountID
	}
	if strings.TrimSpace(lease.OwnerID) == "" {
		lease.OwnerID = "local"
	}
	if lease.FencingToken <= 0 {
		lease.FencingToken = 1
	}
	return lease
}

func (d *Dispatcher) inboundLeaseFor(accountID string) store.ChannelLease {
	return normalizedInboundLease(accountID, d.inboundLease)
}

func (d *Dispatcher) finishInboundMessage(ctx context.Context, lease store.ChannelLease, messageID, sessionID string, retErr error) error {
	finishCtx := ctx
	var cancel context.CancelFunc
	if ctx.Err() != nil {
		finishCtx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
	}
	if retErr != nil {
		return d.store.MarkInboundMessageFailed(finishCtx, lease, messageID, sessionID, retErr.Error(), time.Now().UTC().Add(retryBackoff(0)))
	}
	return d.store.MarkInboundMessageDone(finishCtx, lease, messageID, sessionID)
}

func (d *Dispatcher) handleCommand(ctx context.Context, msg channel.Message, conversation store.Conversation, command CommandCallbackResult) error {
	switch command.Action {
	case CommandActionReset:
		workspaceKey := store.NewWorkspaceKeyForReset()
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s old_workspace_key=%s new_workspace_key=%s action=session_reset",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID), logValue(conversation.SessionKey),
			logValue(conversation.WorkspaceKey), logValue(workspaceKey))
		sessionID, err := d.acp.NewSession(ctx, d.cwd, workspaceKey)
		if err != nil {
			return d.handleACPError(ctx, msg, conversation, conversation.ACPSessionID, CallbackStageReset, err)
		}
		if err := d.store.BindACPWorkspaceSession(ctx, conversation.ChannelAccountID, conversation.SessionKey, sessionID, workspaceKey); err != nil {
			return err
		}
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s workspace_key=%s acp_session_id=%s action=session_reset_bound",
			logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
			logValue(conversation.SessionKey), logValue(workspaceKey), logValue(sessionID))
		reply := strings.TrimSpace(command.Reply)
		if reply == "" {
			reply = resetSessionReply
		}
		_, err = d.enqueueTextReply(ctx, msg, sessionID, reply)
		return err
	default:
		return nil
	}
}

func (d *Dispatcher) recreateSessionWithSameWorkspace(ctx context.Context, msg channel.Message, conversation store.Conversation, oldSessionID, reason string) (string, error) {
	workspaceKey := strings.TrimSpace(conversation.WorkspaceKey)
	if workspaceKey == "" {
		workspaceKey = strings.TrimSpace(oldSessionID)
	}
	if workspaceKey == "" {
		workspaceKey = store.NewWorkspaceKeyForReset()
	}
	log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s workspace_key=%s acp_session_id=%s action=session_recreate_same_workspace reason=%s",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
		logValue(conversation.SessionKey), logValue(workspaceKey), logValue(oldSessionID), logValue(reason))
	sessionID, err := d.acp.NewSession(ctx, d.cwd, workspaceKey)
	if err != nil {
		return "", err
	}
	if err := d.store.BindACPWorkspaceSession(ctx, conversation.ChannelAccountID, conversation.SessionKey, sessionID, workspaceKey); err != nil {
		return "", err
	}
	log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s workspace_key=%s old_acp_session_id=%s acp_session_id=%s action=session_recreate_same_workspace_bound reason=%s",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
		logValue(conversation.SessionKey), logValue(workspaceKey), logValue(oldSessionID), logValue(sessionID), logValue(reason))
	return sessionID, nil
}

func (d *Dispatcher) handleACPError(ctx context.Context, msg channel.Message, conversation store.Conversation, sessionID string, stage CallbackStage, err error) error {
	log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=acp_error stage=%s error=%s",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
		logValue(conversation.SessionKey), logValue(sessionID), logValue(string(stage)), logValue(err.Error()))
	if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		return err
	}
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

func (d *Dispatcher) ensureRuntimeReady(ctx context.Context, msg channel.Message, conversation store.Conversation, sessionID string) error {
	ready, err := d.acp.EnsureRuntimeReady(ctx, sessionID, d.cwd)
	if err != nil {
		return err
	}
	if !ready.Changed {
		return nil
	}
	log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s action=session_restored runtime_changed=true",
		logValue(msg.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
		logValue(conversation.SessionKey), logValue(sessionID))
	reply, ok := d.callbacksOrDefault().HandleSessionRestored(SessionRestoredEvent{
		ChannelAccountID:       msg.ChannelAccountID,
		ChannelType:            string(msg.ChannelType),
		ExternalConversationID: msg.ExternalConversationID,
		ExternalMessageID:      msg.ExternalMessageID,
		ConversationID:         conversation.ConversationID,
		SessionKey:             conversation.SessionKey,
		ACPSessionID:           sessionID,
		RuntimeChanged:         ready.Changed,
	})
	if !ok || strings.TrimSpace(reply) == "" {
		return nil
	}
	_, err = d.enqueueTextReply(ctx, msg, sessionID, reply)
	return err
}

func (d *Dispatcher) HandleWorkspaceLifecycle(ctx context.Context, event acp.WorkspaceLifecycleEvent) error {
	if d == nil || d.store == nil {
		return errors.New("dispatcher is not configured")
	}
	if event.Operation != "storage" || event.Status != "done" {
		return nil
	}
	conversation, ok, err := d.store.FindConversationByACPSession(ctx, d.account.ChannelAccountID, event.SessionID)
	if err != nil {
		return err
	}
	if !ok {
		log.Printf("channelgateway session_trace account_id=%s agent_id=%s acp_session_id=%s lifecycle_id=%s action=session_stored_skip reason=conversation_not_found",
			logValue(d.account.ChannelAccountID), logValue(d.account.AgentID), logValue(event.SessionID), logValue(event.LifecycleID))
		return nil
	}
	log.Printf("channelgateway session_trace account_id=%s agent_id=%s conversation_id=%s session_key=%s acp_session_id=%s lifecycle_id=%s action=session_stored operation=%s phase=%s status=%s",
		logValue(conversation.ChannelAccountID), logValue(d.account.AgentID), logValue(conversation.ConversationID),
		logValue(conversation.SessionKey), logValue(event.SessionID), logValue(event.LifecycleID),
		logValue(event.Operation), logValue(event.Phase), logValue(event.Status))
	reply, ok := d.callbacksOrDefault().HandleSessionStored(SessionStoredEvent{
		ChannelAccountID:       conversation.ChannelAccountID,
		ChannelType:            conversation.ChannelType,
		ExternalConversationID: conversation.ExternalConversationID,
		ConversationID:         conversation.ConversationID,
		SessionKey:             conversation.SessionKey,
		ACPSessionID:           event.SessionID,
		Operation:              event.Operation,
		Phase:                  event.Phase,
		Status:                 event.Status,
	})
	if !ok || strings.TrimSpace(reply) == "" {
		return nil
	}
	msg := channel.Message{
		ChannelAccountID:       conversation.ChannelAccountID,
		ChannelType:            channel.Type(conversation.ChannelType),
		ExternalMessageID:      lifecycleMessageID(event),
		ExternalConversationID: conversation.ExternalConversationID,
		Kind:                   channel.MessageText,
	}
	_, err = d.enqueueTextReply(ctx, msg, event.SessionID, reply)
	return err
}

func lifecycleMessageID(event acp.WorkspaceLifecycleEvent) string {
	if strings.TrimSpace(event.LifecycleID) != "" {
		return event.LifecycleID
	}
	return strings.Join([]string{
		"lifecycle",
		event.SessionID,
		event.Operation,
		event.Phase,
		event.Status,
		event.Timestamp,
	}, ":")
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
	newSessionID, newErr := d.recreateSessionWithSameWorkspace(ctx, msg, conversation, sessionID, "runtime_unavailable")
	if newErr != nil {
		return acp.PromptResult{}, sessionID, newErr
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
		OutboxID:               replyOutboxID(msg, text),
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

func replyOutboxID(msg channel.Message, text string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		msg.ChannelAccountID,
		string(msg.ChannelType),
		msg.ExternalConversationID,
		msg.ExternalMessageID,
		text,
	}, "\x00")))
	return "out_reply_" + hex.EncodeToString(sum[:])[:32]
}

func defaultReplyForStopReason(reason string) string {
	switch strings.TrimSpace(reason) {
	case "", "end_turn":
		return ""
	case "cancelled":
		return taskCancelledReply
	default:
		return taskEndedReply
	}
}

type OutboxSender interface {
	Send(ctx context.Context, reply channel.Reply) (channel.SendResult, error)
}

const maxOutboxRetries = 6

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
		if item.RetryCount >= maxOutboxRetries {
			log.Printf("channelgateway business_trace account_id=%s external_conversation_id=%s acp_session_id=%s outbox_id=%s action=outbox_abandoned retry_count=%d reason=retry_limit",
				logValue(item.ChannelAccountID), logValue(item.ExternalConversationID), logValue(item.ACPSessionID),
				logValue(item.OutboxID), item.RetryCount)
			_ = st.MarkOutboxAbandoned(ctx, lease, item.OutboxID, "outbox retry limit reached")
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
