package service

import (
	"context"
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
