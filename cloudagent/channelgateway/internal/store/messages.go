package store

import (
	"context"
	"database/sql"
	"errors"
)

func (s *Store) InsertInboundMessage(ctx context.Context, rec MessageRecord) (bool, error) {
	return s.insertMessage(ctx, rec)
}

func (s *Store) InsertOutboundMessage(ctx context.Context, rec MessageRecord) (bool, error) {
	return s.insertMessage(ctx, rec)
}

func (s *Store) insertMessage(ctx context.Context, rec MessageRecord) (bool, error) {
	if s == nil || s.db == nil {
		return false, errors.New("store is nil")
	}
	if rec.MessageID == "" {
		rec.MessageID = "msg_" + randomHex(16)
	}
	if rec.ChannelAccountID == "" || rec.ExternalMessageID == "" || rec.Direction == "" {
		return false, errors.New("channel account id, external message id and direction are required")
	}
	if rec.PayloadJSON == "" {
		rec.PayloadJSON = "{}"
	}
	if rec.Status == "" {
		rec.Status = "received"
	}
	now := nowText()
	s.mu.Lock()
	defer s.mu.Unlock()
	query := `
INSERT OR IGNORE INTO channel_messages (
	message_id, channel_account_id, channel_type, external_message_id,
	external_conversation_id, acp_session_id, direction, status, payload_json,
	created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.dialect == dialectMySQL {
		query = `
INSERT IGNORE INTO channel_messages (
	message_id, channel_account_id, channel_type, external_message_id,
	external_conversation_id, acp_session_id, direction, status, payload_json,
	created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	}
	result, err := s.db.ExecContext(ctx, query,
		rec.MessageID, rec.ChannelAccountID, rec.ChannelType, rec.ExternalMessageID,
		rec.ExternalConversationID, rec.ACPSessionID, rec.Direction, rec.Status,
		rec.PayloadJSON, now, now)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

func (s *Store) MessageExists(ctx context.Context, channelAccountID, externalMessageID, direction string) (bool, error) {
	if s == nil || s.db == nil {
		return false, errors.New("store is nil")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var id string
	err := s.db.QueryRowContext(ctx, `
SELECT message_id FROM channel_messages
WHERE channel_account_id = ? AND external_message_id = ? AND direction = ?`,
		channelAccountID, externalMessageID, direction).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
