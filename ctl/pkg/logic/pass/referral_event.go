package pass

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"ctl/pkg/model/eventoutbox"
	"gorm.io/gorm"
)

func referralEventsEnabled() bool {
	enabled, err := strconv.ParseBool(strings.TrimSpace(os.Getenv("REFERRAL_ENABLED")))
	return err == nil && enabled
}

type firstPaidEnvelope struct {
	EventID       string           `json:"event_id"`
	EventType     string           `json:"event_type"`
	OccurredAt    time.Time        `json:"occurred_at"`
	Producer      string           `json:"producer"`
	AggregateID   string           `json:"aggregate_id"`
	CorrelationID string           `json:"correlation_id"`
	Payload       firstPaidPayload `json:"payload"`
}

func insertFirstPaidEvent(tx *gorm.DB, userID, passID, bundleID, dealName string, occurredAt time.Time) error {
	event, err := buildFirstPaidEvent(userID, passID, bundleID, dealName, occurredAt)
	if err != nil {
		return err
	}
	return eventoutbox.Insert(tx, event)
}

type firstPaidPayload struct {
	UserID   string `json:"user_id"`
	PassID   string `json:"pass_id"`
	BundleID string `json:"bundle_id"`
	DealName string `json:"deal_name"`
}

type refundedEnvelope struct {
	EventID       string          `json:"event_id"`
	EventType     string          `json:"event_type"`
	OccurredAt    time.Time       `json:"occurred_at"`
	Producer      string          `json:"producer"`
	AggregateID   string          `json:"aggregate_id"`
	CorrelationID string          `json:"correlation_id"`
	Payload       refundedPayload `json:"payload"`
}

type refundedPayload struct {
	UserID   string `json:"user_id"`
	PassID   string `json:"pass_id"`
	DealName string `json:"deal_name"`
}

func buildRefundedEvent(userID, passID, dealName string, occurredAt time.Time) (*eventoutbox.Event, error) {
	eventID := "pass.refunded:" + passID
	correlationID := dealName
	if correlationID == "" {
		correlationID = eventID
	}
	envelope := refundedEnvelope{
		EventID: eventID, EventType: "pass.refunded.v1", OccurredAt: occurredAt.UTC(),
		Producer: "ctl", AggregateID: passID, CorrelationID: correlationID,
		Payload: refundedPayload{UserID: userID, PassID: passID, DealName: dealName},
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("marshal pass refunded event: %w", err)
	}
	return &eventoutbox.Event{
		EventID: eventID, EventType: envelope.EventType, AggregateID: passID,
		PayloadJSON: payload, OccurredAt: occurredAt.UTC(),
	}, nil
}

func buildFirstPaidEvent(userID, passID, bundleID, dealName string, occurredAt time.Time) (*eventoutbox.Event, error) {
	eventID := "pass.first_paid:" + passID
	envelope := firstPaidEnvelope{
		EventID: eventID, EventType: "pass.first_paid.v1", OccurredAt: occurredAt.UTC(),
		Producer: "ctl", AggregateID: passID, CorrelationID: dealName,
		Payload: firstPaidPayload{UserID: userID, PassID: passID, BundleID: bundleID, DealName: dealName},
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("marshal pass first-paid event: %w", err)
	}
	return &eventoutbox.Event{
		EventID: eventID, EventType: envelope.EventType, AggregateID: passID,
		PayloadJSON: payload, OccurredAt: occurredAt.UTC(),
	}, nil
}
