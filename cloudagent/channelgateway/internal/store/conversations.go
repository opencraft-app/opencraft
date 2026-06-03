package store

import (
	"context"
	"database/sql"
	"errors"
)

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
	_, err := s.db.ExecContext(ctx, `
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
	deleted_at = NULL`,
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
SET acp_session_id = ?, updated_at = ?
WHERE channel_account_id = ? AND session_key = ? AND deleted_at IS NULL`,
		acpSessionID, nowText(), channelAccountID, sessionKey)
	return err
}

func (s *Store) loadConversationBySessionKeyLocked(ctx context.Context, channelAccountID, sessionKey string) (Conversation, error) {
	var conv Conversation
	err := s.db.QueryRowContext(ctx, `
SELECT conversation_id, channel_account_id, channel_type, external_conversation_id,
	external_user_id, COALESCE(external_thread_id, ''), COALESCE(chat_type, ''), agent_id, acp_session_id, session_key
FROM channel_conversations
WHERE channel_account_id = ? AND session_key = ? AND deleted_at IS NULL`,
		channelAccountID, sessionKey).Scan(
		&conv.ConversationID, &conv.ChannelAccountID, &conv.ChannelType, &conv.ExternalConversationID,
		&conv.ExternalUserID, &conv.ThreadID, &conv.ChatType, &conv.AgentID, &conv.ACPSessionID, &conv.SessionKey,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, errors.New("conversation was not stored")
	}
	return conv, err
}
