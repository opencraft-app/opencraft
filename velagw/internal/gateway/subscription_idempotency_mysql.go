package gateway

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

func (s *MySQLStore) TryBeginSubscriptionIdempotency(ctx context.Context, candidate SubscriptionIdempotency) (SubscriptionIdempotency, bool, error) {
	result, err := s.db.ExecContext(ctx, `
		INSERT IGNORE INTO llmgateway_subscription_idempotencies (
			idempotency_key, request_hash, status, last_error, created_at, updated_at
		) VALUES (?, ?, ?, '', ?, ?)
	`, candidate.IdempotencyKey, []byte(candidate.RequestHash), SubscriptionIdempotencyProcessing, candidate.CreatedAt.UTC(), candidate.UpdatedAt.UTC())
	if err != nil {
		return SubscriptionIdempotency{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return SubscriptionIdempotency{}, false, err
	}
	if affected == 1 {
		candidate.Status = SubscriptionIdempotencyProcessing
		return candidate, true, nil
	}

	existing, err := s.getSubscriptionIdempotency(ctx, candidate.IdempotencyKey)
	if err != nil {
		return SubscriptionIdempotency{}, false, err
	}
	if existing.RequestHash != candidate.RequestHash ||
		(existing.Status != SubscriptionIdempotencyFailed && existing.Status != SubscriptionIdempotencyUnknown) {
		return existing, false, nil
	}
	result, err = s.db.ExecContext(ctx, `
		UPDATE llmgateway_subscription_idempotencies
		SET status = ?, last_error = '', updated_at = ?
		WHERE idempotency_key = ? AND request_hash = ? AND status IN (?, ?)
	`, SubscriptionIdempotencyProcessing, candidate.UpdatedAt.UTC(), candidate.IdempotencyKey, []byte(candidate.RequestHash),
		SubscriptionIdempotencyFailed, SubscriptionIdempotencyUnknown)
	if err != nil {
		return SubscriptionIdempotency{}, false, err
	}
	affected, err = result.RowsAffected()
	if err != nil {
		return SubscriptionIdempotency{}, false, err
	}
	if affected == 1 {
		existing.Status = SubscriptionIdempotencyProcessing
		existing.LastError = ""
		existing.UpdatedAt = candidate.UpdatedAt.UTC()
		return existing, true, nil
	}
	existing, err = s.getSubscriptionIdempotency(ctx, candidate.IdempotencyKey)
	return existing, false, err
}

func (s *MySQLStore) FinishSubscriptionIdempotency(ctx context.Context, key string, status int, lastError string, now time.Time) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_subscription_idempotencies
		SET status = ?, last_error = ?, updated_at = ?
		WHERE idempotency_key = ? AND status = ?
	`, status, truncateSubscriptionIdempotencyError(lastError), now.UTC(), key, SubscriptionIdempotencyProcessing)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return fmt.Errorf("subscription idempotency key %q is not processing", key)
	}
	return nil
}

func (s *MySQLStore) getSubscriptionIdempotency(ctx context.Context, key string) (SubscriptionIdempotency, error) {
	var record SubscriptionIdempotency
	var requestHash []byte
	err := s.db.QueryRowContext(ctx, `
		SELECT idempotency_key, request_hash, status, last_error, created_at, updated_at
		FROM llmgateway_subscription_idempotencies
		WHERE idempotency_key = ?
	`, key).Scan(&record.IdempotencyKey, &requestHash, &record.Status, &record.LastError, &record.CreatedAt, &record.UpdatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return SubscriptionIdempotency{}, fmt.Errorf("subscription idempotency key %q not found", key)
		}
		return SubscriptionIdempotency{}, err
	}
	record.RequestHash = string(requestHash)
	return record, nil
}
