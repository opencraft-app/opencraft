package gateway

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

var (
	ErrSubscriptionIdempotencyConflict = errors.New("subscription idempotency key conflicts with a different request")
	ErrSubscriptionIdempotencyPending  = errors.New("subscription idempotency request is still processing")
	ErrSubscriptionOutcomeUnknown      = errors.New("subscription delivery outcome is unknown")
)

func validateSubscriptionIdempotencyKey(key string) error {
	if key == "" {
		return fmt.Errorf("idempotency_key is required")
	}
	if len(key) > 128 {
		return fmt.Errorf("idempotency_key must not exceed 128 ASCII characters")
	}
	for i := 0; i < len(key); i++ {
		if key[i] < 0x21 || key[i] > 0x7e {
			return fmt.Errorf("idempotency_key must contain printable ASCII characters only")
		}
	}
	return nil
}

func subscriptionRequestHash(req ApplySubscriptionRequest) string {
	periodStart := ""
	if req.PeriodStart != nil {
		periodStart = req.PeriodStart.UTC().Format(time.RFC3339Nano)
	}
	periodEnd := ""
	if req.PeriodEnd != nil {
		periodEnd = req.PeriodEnd.UTC().Format(time.RFC3339Nano)
	}
	payload := strings.Join([]string{
		strings.TrimSpace(req.UserID),
		strings.TrimSpace(req.PlanID),
		strings.TrimSpace(req.SubscriptionName),
		strings.TrimSpace(req.Nickname),
		strings.TrimSpace(req.Phone),
		periodStart,
		strconv.Itoa(req.PeriodValue),
		strings.TrimSpace(req.PeriodUnit),
		periodEnd,
		strconv.FormatBool(req.IsUnique),
	}, "\x00")
	sum := sha256.Sum256([]byte(payload))
	return string(sum[:])
}

func upstreamSubscriptionRequestID(idempotencyKey string) string {
	if idempotencyKey == "" {
		return "llmgw:subscription:" + randomSecret()
	}
	sum := sha256.Sum256([]byte(idempotencyKey))
	return "llmgw:subscription:" + fmt.Sprintf("%x", sum[:])
}

func (s *MemoryStore) TryBeginSubscriptionIdempotency(_ context.Context, candidate SubscriptionIdempotency) (SubscriptionIdempotency, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.subscriptionIdem[candidate.IdempotencyKey]
	if !ok {
		candidate.Status = SubscriptionIdempotencyProcessing
		s.subscriptionIdem[candidate.IdempotencyKey] = candidate
		return candidate, true, nil
	}
	if existing.RequestHash == candidate.RequestHash &&
		(existing.Status == SubscriptionIdempotencyFailed || existing.Status == SubscriptionIdempotencyUnknown) {
		existing.Status = SubscriptionIdempotencyProcessing
		existing.LastError = ""
		existing.UpdatedAt = candidate.UpdatedAt
		s.subscriptionIdem[candidate.IdempotencyKey] = existing
		return existing, true, nil
	}
	return existing, false, nil
}

func (s *MemoryStore) FinishSubscriptionIdempotency(_ context.Context, key string, status int, lastError string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, ok := s.subscriptionIdem[key]
	if !ok {
		return fmt.Errorf("subscription idempotency key %q not found", key)
	}
	if record.Status != SubscriptionIdempotencyProcessing {
		return fmt.Errorf("subscription idempotency key %q is not processing", key)
	}
	record.Status = status
	record.LastError = truncateSubscriptionIdempotencyError(lastError)
	record.UpdatedAt = now.UTC()
	s.subscriptionIdem[key] = record
	return nil
}

func truncateSubscriptionIdempotencyError(message string) string {
	message = strings.TrimSpace(message)
	if len(message) <= 1024 {
		return message
	}
	return message[:1024]
}
