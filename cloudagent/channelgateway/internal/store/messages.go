package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
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

func (s *Store) ClaimInboundMessage(ctx context.Context, lease ChannelLease, externalMessageID string, staleAfter time.Duration) (MessageRecord, bool, error) {
	if s == nil || s.db == nil {
		return MessageRecord{}, false, errors.New("store is nil")
	}
	if lease.ChannelAccountID == "" || lease.OwnerID == "" || lease.FencingToken <= 0 {
		return MessageRecord{}, false, errors.New("valid channel lease is required")
	}
	if externalMessageID == "" {
		return MessageRecord{}, false, errors.New("external message id is required")
	}
	now := time.Now().UTC()
	if staleAfter <= 0 {
		staleAfter = 30 * time.Second
	}
	staleBefore := now.Add(-staleAfter).Format(time.RFC3339Nano)
	nowText := now.Format(time.RFC3339Nano)
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok, err := s.loadMessageByExternalLocked(ctx, lease.ChannelAccountID, externalMessageID, "inbound")
	if err != nil || !ok {
		return MessageRecord{}, false, err
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE channel_messages
SET status = 'processing',
	claim_owner_id = ?,
	claim_fencing_token = ?,
	claimed_at = ?,
	updated_at = ?,
	last_error = ''
WHERE message_id = ?
	AND channel_account_id = ?
	AND direction = 'inbound'
	AND (
		status IN ('received', 'pending', 'failed')
		OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at <= ?))
	)`,
		lease.OwnerID, lease.FencingToken, nowText, nowText,
		rec.MessageID, lease.ChannelAccountID, staleBefore)
	if err != nil {
		return MessageRecord{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return MessageRecord{}, false, err
	}
	if affected == 0 {
		return rec, false, nil
	}
	rec.Status = "processing"
	rec.ClaimOwnerID = lease.OwnerID
	rec.ClaimFencingToken = lease.FencingToken
	return rec, true, nil
}

func (s *Store) ListRecoverableInboundMessages(ctx context.Context, lease ChannelLease, limit int, staleAfter time.Duration) ([]MessageRecord, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("store is nil")
	}
	if lease.ChannelAccountID == "" || lease.OwnerID == "" || lease.FencingToken <= 0 {
		return nil, errors.New("valid channel lease is required")
	}
	if limit <= 0 {
		limit = 16
	}
	now := time.Now().UTC()
	if staleAfter <= 0 {
		staleAfter = 30 * time.Second
	}
	nowText := now.Format(time.RFC3339Nano)
	staleBefore := now.Add(-staleAfter).Format(time.RFC3339Nano)
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
SELECT message_id, channel_account_id, channel_type, external_message_id,
	external_conversation_id, acp_session_id, direction, status, payload_json,
	retry_count, COALESCE(last_error, '')
FROM channel_messages
WHERE channel_account_id = ?
	AND direction = 'inbound'
	AND (
		status IN ('received', 'pending', 'failed')
		OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at <= ?))
	)
	AND (next_retry_at IS NULL OR next_retry_at <= ?)
ORDER BY updated_at
LIMIT ?`, lease.ChannelAccountID, staleBefore, nowText, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []MessageRecord
	for rows.Next() {
		var rec MessageRecord
		if err := rows.Scan(&rec.MessageID, &rec.ChannelAccountID, &rec.ChannelType,
			&rec.ExternalMessageID, &rec.ExternalConversationID, &rec.ACPSessionID,
			&rec.Direction, &rec.Status, &rec.PayloadJSON, &rec.RetryCount, &rec.LastError); err != nil {
			return nil, err
		}
		candidates = append(candidates, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

func (s *Store) MarkInboundMessageDone(ctx context.Context, lease ChannelLease, messageID, acpSessionID string) error {
	return s.updateInboundMessage(ctx, lease, messageID, acpSessionID, "done", "", time.Time{})
}

func (s *Store) MarkInboundMessageFailed(ctx context.Context, lease ChannelLease, messageID, acpSessionID, detail string, retryAt time.Time) error {
	return s.updateInboundMessage(ctx, lease, messageID, acpSessionID, "failed", detail, retryAt)
}

func (s *Store) updateInboundMessage(ctx context.Context, lease ChannelLease, messageID, acpSessionID, status, detail string, retryAt time.Time) error {
	if s == nil || s.db == nil || messageID == "" {
		return nil
	}
	if lease.ChannelAccountID == "" || lease.OwnerID == "" || lease.FencingToken <= 0 {
		return errors.New("valid channel lease is required")
	}
	var retryText any
	if !retryAt.IsZero() {
		retryText = retryAt.UTC().Format(time.RFC3339Nano)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.ExecContext(ctx, `
UPDATE channel_messages
SET status = ?,
	acp_session_id = CASE WHEN ? = '' THEN acp_session_id ELSE ? END,
	updated_at = ?,
	last_error = ?,
	next_retry_at = ?,
	retry_count = CASE WHEN ? = 'failed' THEN retry_count + 1 ELSE retry_count END
WHERE message_id = ?
	AND channel_account_id = ?
	AND direction = 'inbound'
	AND claim_owner_id = ?
	AND claim_fencing_token = ?
	AND status = 'processing'`,
		status, acpSessionID, acpSessionID, nowText(), detail, retryText, status,
		messageID, lease.ChannelAccountID, lease.OwnerID, lease.FencingToken)
	return requireMessageUpdate(result, err, messageID)
}

func (s *Store) loadMessageByExternalLocked(ctx context.Context, channelAccountID, externalMessageID, direction string) (MessageRecord, bool, error) {
	var rec MessageRecord
	err := s.db.QueryRowContext(ctx, `
SELECT message_id, channel_account_id, channel_type, external_message_id,
	external_conversation_id, acp_session_id, direction, status, payload_json,
	COALESCE(claim_owner_id, ''), claim_fencing_token, retry_count, COALESCE(last_error, '')
FROM channel_messages
WHERE channel_account_id = ? AND external_message_id = ? AND direction = ?`,
		channelAccountID, externalMessageID, direction).Scan(
		&rec.MessageID, &rec.ChannelAccountID, &rec.ChannelType, &rec.ExternalMessageID,
		&rec.ExternalConversationID, &rec.ACPSessionID, &rec.Direction, &rec.Status,
		&rec.PayloadJSON, &rec.ClaimOwnerID, &rec.ClaimFencingToken, &rec.RetryCount, &rec.LastError,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return MessageRecord{}, false, nil
	}
	return rec, err == nil, err
}

func requireMessageUpdate(result sql.Result, err error, messageID string) error {
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrLeaseHeld
	}
	return nil
}
