package service

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type referralRegistrationEnvelope struct {
	EventID       string                      `json:"event_id"`
	EventType     string                      `json:"event_type"`
	OccurredAt    time.Time                   `json:"occurred_at"`
	Producer      string                      `json:"producer"`
	AggregateID   string                      `json:"aggregate_id"`
	CorrelationID string                      `json:"correlation_id"`
	Payload       referralRegistrationPayload `json:"payload"`
}

type referralRegistrationPayload struct {
	UserID              string `json:"user_id"`
	ReferralCode        string `json:"referral_code"`
	RegistrationChannel string `json:"registration_channel"`
}

type referralClaimEnvelope struct {
	EventID       string               `json:"event_id"`
	EventType     string               `json:"event_type"`
	OccurredAt    time.Time            `json:"occurred_at"`
	Producer      string               `json:"producer"`
	AggregateID   string               `json:"aggregate_id"`
	CorrelationID string               `json:"correlation_id"`
	Payload       referralClaimPayload `json:"payload"`
}

type referralClaimPayload struct {
	UserID       string `json:"user_id"`
	ReferralCode string `json:"referral_code"`
	ClaimChannel string `json:"claim_channel"`
}

func newReferralClaimEnvelope(userID, referralCode, channel string, occurredAt time.Time) referralClaimEnvelope {
	userID = strings.TrimSpace(userID)
	referralCode = strings.ToUpper(strings.TrimSpace(referralCode))
	digest := sha256.Sum256([]byte(referralCode))
	eventID := fmt.Sprintf("user.referral_claimed:%s:%x", userID, digest[:8])
	return referralClaimEnvelope{
		EventID: eventID, EventType: "user.referral_claimed.v1", OccurredAt: occurredAt.UTC(),
		Producer: "user-auth", AggregateID: userID, CorrelationID: eventID,
		Payload: referralClaimPayload{UserID: userID, ReferralCode: referralCode, ClaimChannel: strings.TrimSpace(channel)},
	}
}

func insertReferralRegistrationOutboxTx(ctx context.Context, tx *sql.Tx, userID, referralCode, channel string, occurredAt time.Time) error {
	referralCode = strings.ToUpper(strings.TrimSpace(referralCode))
	if referralCode == "" {
		return nil
	}
	eventID := "user.registered:" + userID
	envelope := referralRegistrationEnvelope{
		EventID: eventID, EventType: "user.registered.v1", OccurredAt: occurredAt.UTC(),
		Producer: "user-auth", AggregateID: userID, CorrelationID: eventID,
		Payload: referralRegistrationPayload{UserID: userID, ReferralCode: referralCode, RegistrationChannel: channel},
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("marshal referral registration event: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO auth_event_outbox (
			event_id, event_type, aggregate_id, payload_json, status,
			next_attempt_at, created_at
		) VALUES (?, ?, ?, ?, 'pending', ?, ?)
		ON DUPLICATE KEY UPDATE event_id = event_id
	`, eventID, envelope.EventType, userID, payload, occurredAt.UTC(), occurredAt.UTC())
	if err != nil {
		return fmt.Errorf("insert referral registration outbox: %w", err)
	}
	return nil
}

func insertReferralClaimOutboxTx(ctx context.Context, tx *sql.Tx, userID, referralCode, channel string, occurredAt time.Time) error {
	referralCode = strings.ToUpper(strings.TrimSpace(referralCode))
	if strings.TrimSpace(userID) == "" || referralCode == "" {
		return nil
	}
	envelope := newReferralClaimEnvelope(userID, referralCode, channel, occurredAt)
	payload, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("marshal referral claim event: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO auth_event_outbox (
			event_id, event_type, aggregate_id, payload_json, status,
			next_attempt_at, created_at
		) VALUES (?, ?, ?, ?, 'pending', ?, ?)
		ON DUPLICATE KEY UPDATE event_id = event_id
	`, envelope.EventID, envelope.EventType, envelope.AggregateID, payload, occurredAt.UTC(), occurredAt.UTC())
	if err != nil {
		return fmt.Errorf("insert referral claim outbox: %w", err)
	}
	return nil
}
