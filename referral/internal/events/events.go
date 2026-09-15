package events

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	TypeUserRegistered = "user.registered.v1"
	TypePassFirstPaid  = "pass.first_paid.v1"
	TypePassRefunded   = "pass.refunded.v1"
)

type Envelope struct {
	EventID       string          `json:"event_id"`
	EventType     string          `json:"event_type"`
	OccurredAt    time.Time       `json:"occurred_at"`
	Producer      string          `json:"producer"`
	AggregateID   string          `json:"aggregate_id"`
	CorrelationID string          `json:"correlation_id"`
	Payload       json.RawMessage `json:"payload"`
}

type UserRegistered struct {
	UserID       string `json:"user_id"`
	ReferralCode string `json:"referral_code"`
}

type PassFirstPaid struct {
	UserID   string `json:"user_id"`
	PassID   string `json:"pass_id"`
	BundleID string `json:"bundle_id"`
	DealName string `json:"deal_name"`
}

type PassRefunded struct {
	UserID   string `json:"user_id"`
	PassID   string `json:"pass_id"`
	DealName string `json:"deal_name"`
}

func Decode(raw []byte) (Envelope, error) {
	var event Envelope
	if err := json.Unmarshal(raw, &event); err != nil {
		return Envelope{}, fmt.Errorf("decode referral event: %w", err)
	}
	if strings.TrimSpace(event.EventID) == "" || strings.TrimSpace(event.EventType) == "" ||
		event.OccurredAt.IsZero() || strings.TrimSpace(event.Producer) == "" ||
		strings.TrimSpace(event.AggregateID) == "" || len(event.Payload) == 0 {
		return Envelope{}, fmt.Errorf("referral event envelope is incomplete")
	}
	return event, nil
}

func PayloadHash(payload json.RawMessage) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
