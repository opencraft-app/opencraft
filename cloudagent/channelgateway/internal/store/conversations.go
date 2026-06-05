package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

type IdleConversation struct {
	Conversation
	UpdatedAt time.Time
}

func (s *Store) GetOrCreateConversation(ctx context.Context, conv Conversation) (Conversation, error) {
	if s == nil || s.db == nil {
		return Conversation{}, errors.New("store is nil")
	}
	if conv.ChannelAccountID == "" || conv.SessionKey == "" || conv.AgentID == "" {
		return Conversation{}, errors.New("channel account id, session key and agent id are required")
	}
	if conv.ConversationID == "" {
		conv.ConversationID = "conv_" + randomHex(16)
	}
	now := nowText()
	s.mu.Lock()
	defer s.mu.Unlock()
	query := `
INSERT INTO channel_conversations (
	conversation_id, channel_account_id, channel_type, external_conversation_id,
	external_user_id, external_thread_id, chat_type, agent_id, acp_session_id, session_key, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(channel_account_id, session_key) DO UPDATE SET
	external_conversation_id = excluded.external_conversation_id,
	external_user_id = excluded.external_user_id,
	external_thread_id = excluded.external_thread_id,
	chat_type = excluded.chat_type,
	agent_id = excluded.agent_id,
	updated_at = excluded.updated_at,
	runtime_closed_at = NULL,
	deleted_at = NULL`
	if s.dialect == dialectMySQL {
		query = `
INSERT INTO channel_conversations (
	conversation_id, channel_account_id, channel_type, external_conversation_id,
	external_user_id, external_thread_id, chat_type, agent_id, acp_session_id, session_key, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
	external_conversation_id = VALUES(external_conversation_id),
	external_user_id = VALUES(external_user_id),
	external_thread_id = VALUES(external_thread_id),
	chat_type = VALUES(chat_type),
	agent_id = VALUES(agent_id),
	updated_at = VALUES(updated_at),
	runtime_closed_at = NULL,
	deleted_at = NULL`
	}
	_, err := s.db.ExecContext(ctx, query,
		conv.ConversationID, conv.ChannelAccountID, conv.ChannelType, conv.ExternalConversationID,
		conv.ExternalUserID, conv.ThreadID, conv.ChatType, conv.AgentID, conv.ACPSessionID, conv.SessionKey, now, now)
	if err != nil {
		return Conversation{}, err
	}
	return s.loadConversationBySessionKeyLocked(ctx, conv.ChannelAccountID, conv.SessionKey)
}

func (s *Store) BindACPSession(ctx context.Context, channelAccountID, sessionKey, acpSessionID string) error {
	if s == nil || s.db == nil {
		return errors.New("store is nil")
	}
	if channelAccountID == "" || sessionKey == "" || acpSessionID == "" {
		return errors.New("channel account id, session key and acp session id are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
UPDATE channel_conversations
SET acp_session_id = ?, runtime_closed_at = NULL, updated_at = ?
WHERE channel_account_id = ? AND session_key = ? AND deleted_at IS NULL`,
		acpSessionID, nowText(), channelAccountID, sessionKey)
	return err
}

func (s *Store) LoadConversationBySessionKey(ctx context.Context, channelAccountID, sessionKey string) (Conversation, bool, error) {
	if s == nil || s.db == nil {
		return Conversation{}, false, errors.New("store is nil")
	}
	if channelAccountID == "" || sessionKey == "" {
		return Conversation{}, false, errors.New("channel account id and session key are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	conv, err := s.loadConversationBySessionKeyLocked(ctx, channelAccountID, sessionKey)
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errConversationNotStored) {
		return Conversation{}, false, nil
	}
	return conv, err == nil, err
}

func (s *Store) MarkConversationRuntimeClosed(ctx context.Context, channelAccountID, sessionKey, acpSessionID string) error {
	if s == nil || s.db == nil {
		return errors.New("store is nil")
	}
	if channelAccountID == "" || sessionKey == "" || acpSessionID == "" {
		return errors.New("channel account id, session key and acp session id are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
UPDATE channel_conversations
SET runtime_closed_at = ?, updated_at = ?
WHERE channel_account_id = ? AND session_key = ? AND acp_session_id = ? AND deleted_at IS NULL`,
		nowText(), nowText(), channelAccountID, sessionKey, acpSessionID)
	return err
}

func (s *Store) ListIdleOpenConversations(ctx context.Context, channelAccountID string, cutoff time.Time, limit int) ([]IdleConversation, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("store is nil")
	}
	if channelAccountID == "" {
		return nil, errors.New("channel account id is required")
	}
	if limit <= 0 {
		limit = 16
	}
	cutoffText := cutoff.UTC().Format(time.RFC3339Nano)
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
SELECT c.conversation_id, c.channel_account_id, c.channel_type, c.external_conversation_id,
	c.external_user_id, COALESCE(c.external_thread_id, ''), COALESCE(c.chat_type, ''), c.agent_id,
	c.acp_session_id, c.session_key, c.updated_at
FROM channel_conversations c
WHERE c.channel_account_id = ?
	AND c.deleted_at IS NULL
	AND c.acp_session_id <> ''
	AND c.runtime_closed_at IS NULL
	AND c.updated_at <= ?
	AND NOT EXISTS (
		SELECT 1 FROM channel_messages m
		WHERE m.channel_account_id = c.channel_account_id
			AND m.external_conversation_id = c.external_conversation_id
			AND m.direction = 'inbound'
			AND m.status IN ('received', 'processing', 'pending')
	)
ORDER BY c.updated_at
LIMIT ?`, channelAccountID, cutoffText, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IdleConversation
	for rows.Next() {
		var item IdleConversation
		var updatedAt string
		if err := rows.Scan(
			&item.ConversationID, &item.ChannelAccountID, &item.ChannelType, &item.ExternalConversationID,
			&item.ExternalUserID, &item.ThreadID, &item.ChatType, &item.AgentID,
			&item.ACPSessionID, &item.SessionKey, &updatedAt,
		); err != nil {
			return nil, err
		}
		if parsed, err := time.Parse(time.RFC3339Nano, updatedAt); err == nil {
			item.UpdatedAt = parsed
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) ConversationHasActiveInbound(ctx context.Context, channelAccountID, externalConversationID string) (bool, error) {
	if s == nil || s.db == nil {
		return false, errors.New("store is nil")
	}
	if channelAccountID == "" || externalConversationID == "" {
		return false, errors.New("channel account id and external conversation id are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var id string
	err := s.db.QueryRowContext(ctx, `
SELECT message_id
FROM channel_messages
WHERE channel_account_id = ?
	AND external_conversation_id = ?
	AND direction = 'inbound'
	AND status IN ('received', 'processing', 'pending')
LIMIT 1`, channelAccountID, externalConversationID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) FindConversationByACPSession(ctx context.Context, channelAccountID, acpSessionID string) (Conversation, bool, error) {
	if s == nil || s.db == nil {
		return Conversation{}, false, errors.New("store is nil")
	}
	if channelAccountID == "" || acpSessionID == "" {
		return Conversation{}, false, errors.New("channel account id and acp session id are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var conv Conversation
	err := s.db.QueryRowContext(ctx, `
SELECT conversation_id, channel_account_id, channel_type, external_conversation_id,
	external_user_id, COALESCE(external_thread_id, ''), COALESCE(chat_type, ''), agent_id, acp_session_id,
	session_key, COALESCE(runtime_closed_at, ''), updated_at
FROM channel_conversations
WHERE channel_account_id = ? AND acp_session_id = ? AND deleted_at IS NULL
ORDER BY updated_at DESC
LIMIT 1`,
		channelAccountID, acpSessionID).Scan(
		&conv.ConversationID, &conv.ChannelAccountID, &conv.ChannelType, &conv.ExternalConversationID,
		&conv.ExternalUserID, &conv.ThreadID, &conv.ChatType, &conv.AgentID, &conv.ACPSessionID, &conv.SessionKey,
		&conv.RuntimeClosedAt, &conv.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, false, nil
	}
	return conv, err == nil, err
}

func (s *Store) loadConversationBySessionKeyLocked(ctx context.Context, channelAccountID, sessionKey string) (Conversation, error) {
	var conv Conversation
	err := s.db.QueryRowContext(ctx, `
SELECT conversation_id, channel_account_id, channel_type, external_conversation_id,
	external_user_id, COALESCE(external_thread_id, ''), COALESCE(chat_type, ''), agent_id, acp_session_id,
	session_key, COALESCE(runtime_closed_at, ''), updated_at
FROM channel_conversations
WHERE channel_account_id = ? AND session_key = ? AND deleted_at IS NULL`,
		channelAccountID, sessionKey).Scan(
		&conv.ConversationID, &conv.ChannelAccountID, &conv.ChannelType, &conv.ExternalConversationID,
		&conv.ExternalUserID, &conv.ThreadID, &conv.ChatType, &conv.AgentID, &conv.ACPSessionID, &conv.SessionKey,
		&conv.RuntimeClosedAt, &conv.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, errConversationNotStored
	}
	return conv, err
}

var errConversationNotStored = errors.New("conversation was not stored")
