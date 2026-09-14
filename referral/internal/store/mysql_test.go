package store

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"git.woa.com/wisp/mono/referral/internal/domain"
	"git.woa.com/wisp/mono/referral/internal/events"
)

func TestRecordRefundedCancelsOnlyQualifyingPassRewards(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	payload := events.PassRefunded{UserID: "usr_invitee", PassID: "pass_refunded", DealName: "deal_refund"}
	rawPayload, _ := json.Marshal(payload)
	event := events.Envelope{
		EventID: "pass.refunded:pass_refunded", EventType: events.TypePassRefunded,
		OccurredAt: now, Producer: "ctl", AggregateID: payload.PassID,
		CorrelationID: payload.DealName, Payload: rawPayload,
	}

	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO referral_event_inbox").
		WithArgs(event.EventID, event.EventType, event.Producer, event.AggregateID, event.CorrelationID,
			now, sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("INSERT INTO referral_refund_fact").
		WithArgs(payload.PassID, event.EventID, payload.UserID, payload.DealName, now, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("UPDATE referral_first_paid_fact SET refunded_at").
		WithArgs(now, payload.PassID).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE referral_reward").
		WithArgs(domain.RewardStatusCancelled, sqlmock.AnyArg(), payload.PassID,
			domain.RewardStatusPending, domain.RewardStatusVesting, domain.RewardStatusRetryable, domain.RewardStatusGranting).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectCommit()

	store := &MySQLStore{db: db}
	if err := store.RecordRefunded(t.Context(), event, payload); err != nil {
		t.Fatalf("RecordRefunded: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestUpsertCampaignRejectsUnboundedConfiguration(t *testing.T) {
	store := &MySQLStore{}
	err := store.UpsertCampaign(t.Context(), domain.Campaign{
		ID: "campaign", Name: "campaign", Status: domain.CampaignStatusActive,
		StartsAt: nowForTest(), EndsAt: nowForTest().Add(30 * 24 * time.Hour),
		InviterCredit: 500, InviteeCredit: 200,
		VestingDays: 7, PendingTTLDays: 90, MaxRewardsPerInviter: 50,
		BudgetCredit: 699,
	})
	if err == nil {
		t.Fatal("campaign budget below one reward pair must be rejected")
	}
}

func nowForTest() time.Time {
	return time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC)
}
