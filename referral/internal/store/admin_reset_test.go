package store

import (
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"git.woa.com/wisp/mono/referral/internal/domain"
)

func TestCompleteAttributionResetArchivesThenDeletesRelation(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	registeredAt := now.Add(-time.Hour)
	preview := domain.AttributionResetPreview{
		Attribution: domain.Attribution{
			ID: "rattr_1", CampaignID: "campaign", InviteeUserID: "invitee", InviterUserID: "inviter",
			ReferralCode: "CODE234", RegistrationEventID: "event-1", RegisteredAt: registeredAt, CreatedAt: registeredAt,
		},
		Rewards: []domain.AttributionReward{
			{ID: "reward-1", BeneficiaryUserID: "invitee", Side: domain.RewardSideInvitee, CreditAmount: 500, Status: domain.RewardStatusGranted, SubscriptionID: "sub-1", SubscriptionName: "free-credit:referral:reward-1"},
		},
	}

	mock.ExpectBegin()
	mock.ExpectQuery("FROM referral_attribution_reset_audit WHERE idempotency_key").WithArgs("ops-1").
		WillReturnRows(sqlmock.NewRows([]string{"operation_id", "idempotency_key", "invitee_user_id", "attribution_id", "reward_count", "revoked_subscription_count", "completed_at"}))
	mock.ExpectQuery("FROM referral_attribution").WithArgs("invitee", "rattr_1", "rattr_1").
		WillReturnRows(sqlmock.NewRows([]string{"attribution_id", "campaign_id", "invitee_user_id", "inviter_user_id", "referral_code", "registration_event_id", "registered_at", "created_at"}).
			AddRow("rattr_1", "campaign", "invitee", "inviter", "CODE234", "event-1", registeredAt, registeredAt))
	mock.ExpectQuery("FROM referral_reward WHERE campaign_id").WithArgs("campaign", "invitee").
		WillReturnRows(sqlmock.NewRows([]string{"reward_id", "beneficiary_user_id", "reward_side", "credit_amount", "status", "subscription_id", "subscription_name"}).
			AddRow("reward-1", "invitee", domain.RewardSideInvitee, 500, domain.RewardStatusGranted, "sub-1", "free-credit:referral:reward-1"))
	mock.ExpectExec("INSERT INTO referral_attribution_reset_audit").
		WithArgs(sqlmock.AnyArg(), "ops-1", "rattr_1", "campaign", "invitee", "inviter", "CODE234", "operator", "wrong attribution", 1, 1, sqlmock.AnyArg(), now, now).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("DELETE FROM referral_reward").WithArgs("campaign", "invitee").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("DELETE FROM referral_attribution").WithArgs("rattr_1").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	store := &MySQLStore{db: db}
	result, err := store.CompleteAttributionReset(t.Context(), preview, "ops-1", "operator", "wrong attribution", now)
	if err != nil {
		t.Fatal(err)
	}
	if result.RewardsRemoved != 1 || result.SubscriptionsRevoked != 1 || result.InviteeUserID != "invitee" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
