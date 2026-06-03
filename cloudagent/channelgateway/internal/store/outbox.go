package store

import (
	"context"
	"errors"
	"fmt"
	"time"
)

func (s *Store) EnqueueOutbox(ctx context.Context, rec OutboxRecord) (OutboxRecord, error) {
	if s == nil || s.db == nil {
		return OutboxRecord{}, errors.New("store is nil")
	}
	if rec.OutboxID == "" {
		rec.OutboxID = "out_" + randomHex(16)
	}
	if rec.ChannelAccountID == "" || rec.ExternalConversationID == "" {
		return OutboxRecord{}, errors.New("channel account id and external conversation id are required")
	}
	if rec.PayloadJSON == "" {
		rec.PayloadJSON = "{}"
	}
	if rec.Status == "" {
		rec.Status = "pending"
	}
	now := nowText()
	var nextRetryAt any
	if !rec.NextRetryAt.IsZero() {
		nextRetryAt = rec.NextRetryAt.UTC().Format(time.RFC3339Nano)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO channel_outbox (
	outbox_id, channel_account_id, channel_type, external_conversation_id, acp_session_id,
	payload_json, status, retry_count, next_retry_at, last_error, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rec.OutboxID, rec.ChannelAccountID, rec.ChannelType, rec.ExternalConversationID,
		rec.ACPSessionID, rec.PayloadJSON, rec.Status, rec.RetryCount, nextRetryAt, rec.LastError, now, now)
	if err != nil {
		return OutboxRecord{}, err
	}
	return rec, nil
}

func (s *Store) ClaimPendingOutbox(ctx context.Context, lease ChannelLease, limit int) ([]OutboxRecord, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("store is nil")
	}
	if lease.ChannelAccountID == "" || lease.OwnerID == "" || lease.FencingToken <= 0 {
		return nil, errors.New("valid channel lease is required")
	}
	if limit <= 0 {
		limit = 16
	}
	now := nowText()
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
SELECT outbox_id, channel_account_id, channel_type, external_conversation_id,
	acp_session_id, payload_json, status, retry_count, last_error
FROM channel_outbox
WHERE channel_account_id = ? AND status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
ORDER BY created_at
LIMIT ?`, lease.ChannelAccountID, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []OutboxRecord
	for rows.Next() {
		var rec OutboxRecord
		if err := rows.Scan(&rec.OutboxID, &rec.ChannelAccountID, &rec.ChannelType,
			&rec.ExternalConversationID, &rec.ACPSessionID, &rec.PayloadJSON,
			&rec.Status, &rec.RetryCount, &rec.LastError); err != nil {
			return nil, err
		}
		candidates = append(candidates, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var out []OutboxRecord
	for _, rec := range candidates {
		result, err := s.db.ExecContext(ctx, `
UPDATE channel_outbox
SET status = 'sending',
	claim_owner_id = ?,
	claim_fencing_token = ?,
	claimed_at = ?,
	updated_at = ?
WHERE outbox_id = ?
	AND channel_account_id = ?
	AND status = 'pending'`,
			lease.OwnerID, lease.FencingToken, now, now, rec.OutboxID, lease.ChannelAccountID)
		if err != nil {
			return nil, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return nil, err
		}
		if affected == 0 {
			continue
		}
		rec.Status = "sending"
		rec.ClaimOwnerID = lease.OwnerID
		rec.ClaimFencingToken = lease.FencingToken
		out = append(out, rec)
	}
	return out, nil
}

func (s *Store) MarkOutboxSent(ctx context.Context, lease ChannelLease, outboxID string) error {
	return s.updateOutbox(ctx, lease, outboxID, "sent", "", time.Time{})
}

func (s *Store) MarkOutboxFailed(ctx context.Context, lease ChannelLease, outboxID, detail string, retryAt time.Time) error {
	return s.updateOutbox(ctx, lease, outboxID, "pending", detail, retryAt)
}

func (s *Store) updateOutbox(ctx context.Context, lease ChannelLease, outboxID, status, detail string, retryAt time.Time) error {
	if s == nil || s.db == nil || outboxID == "" {
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
	if status == "sent" {
		result, err := s.db.ExecContext(ctx, `
UPDATE channel_outbox
SET status = 'sent',
	sent_at = ?,
	updated_at = ?,
	last_error = ''
WHERE outbox_id = ?
	AND channel_account_id = ?
	AND claim_owner_id = ?
	AND claim_fencing_token = ?
	AND status = 'sending'`, nowText(), nowText(), outboxID, lease.ChannelAccountID, lease.OwnerID, lease.FencingToken)
		return requireOutboxUpdate(result, err, outboxID)
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE channel_outbox
SET status = ?,
	retry_count = retry_count + 1,
	next_retry_at = ?,
	last_error = ?,
	claim_owner_id = '',
	claim_fencing_token = 0,
	claimed_at = NULL,
	updated_at = ?
WHERE outbox_id = ?
	AND channel_account_id = ?
	AND claim_owner_id = ?
	AND claim_fencing_token = ?
	AND status = 'sending'`, status, retryText, detail, nowText(), outboxID, lease.ChannelAccountID, lease.OwnerID, lease.FencingToken)
	return requireOutboxUpdate(result, err, outboxID)
}

func requireOutboxUpdate(result interface{ RowsAffected() (int64, error) }, err error, outboxID string) error {
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return fmt.Errorf("%w: outbox %s claim is not held by this owner/fence", ErrLeaseHeld, outboxID)
	}
	return nil
}
