package store

import (
	"encoding/json"
	"fmt"
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
		InviterCredit: 500, InviteeCredit: 500,
		VestingDays: 7, PendingTTLDays: 90, MaxRewardsPerInviter: 50,
		BudgetCredit: 999,
	})
	if err == nil {
		t.Fatal("campaign budget below one reward pair must be rejected")
	}
}

func nowForTest() time.Time {
	return time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC)
}

func TestCreateRewardsUsesCampaignDelayAndIndependentAmounts(t *testing.T) {
	for _, delay := range []int{0, 7} {
		t.Run(fmt.Sprintf("delay_%d", delay), func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			now := nowForTest()
			eligible := now.AddDate(0, 0, delay)
			status := domain.RewardStatusPending
			if delay > 0 {
				status = domain.RewardStatusVesting
			}
			mock.ExpectBegin()
			mock.ExpectQuery("SELECT referral_campaign.campaign_id").WithArgs("campaign", "invitee").
				WillReturnRows(sqlmock.NewRows([]string{"id", "name", "status", "starts", "ends", "inviter_credit", "invitee_credit", "delay", "ttl", "limit", "budget", "inviter", "event", "registered", "paid", "pass"}).
					AddRow("campaign", "test", "active", now.Add(-time.Hour), now.AddDate(0, 1, 0), 500, 500, delay, 90, 50, 100000, "inviter", "registration", now, now, "pass"))
			mock.ExpectQuery("SELECT COUNT\\(\\*\\) FROM referral_reward").WithArgs("campaign", "invitee").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
			mock.ExpectQuery("SELECT COUNT\\(\\*\\) FROM referral_reward").WithArgs("campaign", "inviter", domain.RewardSideInviter, domain.RewardStatusCancelled).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
			mock.ExpectQuery("SELECT COALESCE").WithArgs("campaign", domain.RewardStatusCancelled).WillReturnRows(sqlmock.NewRows([]string{"sum"}).AddRow(0))
			for _, side := range []string{"inviter", "invitee"} {
				mock.ExpectExec("INSERT INTO referral_reward").WithArgs(sqlmock.AnyArg(), "campaign", "invitee", "pass", side, side, 500,
					"referral:campaign:invitee:"+side, status, eligible, now.AddDate(0, 0, 90), eligible, sqlmock.AnyArg(), sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(1, 1))
			}
			mock.ExpectCommit()
			tx, err := db.BeginTx(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			if err := createRewardsIfQualified(t.Context(), tx, "campaign", "invitee"); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
