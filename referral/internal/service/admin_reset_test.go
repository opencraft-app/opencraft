package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"git.woa.com/wisp/mono/referral/internal/ctlclient"
	"git.woa.com/wisp/mono/referral/internal/domain"
)

type fakeAttributionAdminStore struct {
	preview   *domain.AttributionResetPreview
	existing  *domain.AttributionResetResult
	completed *domain.AttributionResetResult
}

func (f *fakeAttributionAdminStore) AttributionResetPreview(context.Context, string, string) (*domain.AttributionResetPreview, error) {
	if f.preview == nil {
		return nil, domain.ErrAttributionNotFound
	}
	return f.preview, nil
}

func (f *fakeAttributionAdminStore) AttributionResetResult(context.Context, string) (*domain.AttributionResetResult, error) {
	return f.existing, nil
}

func (f *fakeAttributionAdminStore) CompleteAttributionReset(_ context.Context, preview domain.AttributionResetPreview, key, _, _ string, now time.Time) (*domain.AttributionResetResult, error) {
	f.completed = &domain.AttributionResetResult{
		OperationID: "rrst_test", IdempotencyKey: key, InviteeUserID: preview.Attribution.InviteeUserID,
		AttributionID: preview.Attribution.ID, RewardsRemoved: len(preview.Rewards), SubscriptionsRevoked: 2,
		CompletedAt: now,
	}
	return f.completed, nil
}

type fakeCreditRevoker struct {
	requests []ctlclient.RevokeRequest
}

func (f *fakeCreditRevoker) Revoke(_ context.Context, request ctlclient.RevokeRequest) error {
	f.requests = append(f.requests, request)
	return nil
}

func TestResetAttributionRevokesExactGrantedSubscriptionsThenCompletes(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	adminStore := &fakeAttributionAdminStore{preview: &domain.AttributionResetPreview{
		Attribution: domain.Attribution{ID: "rattr_1", CampaignID: "campaign", InviteeUserID: "invitee", InviterUserID: "inviter", ReferralCode: "CODE234"},
		Rewards: []domain.AttributionReward{
			{ID: "reward_invitee", BeneficiaryUserID: "invitee", Side: domain.RewardSideInvitee, Status: domain.RewardStatusGranted, SubscriptionName: "free-credit:referral:invitee"},
			{ID: "reward_inviter", BeneficiaryUserID: "inviter", Side: domain.RewardSideInviter, Status: domain.RewardStatusGranted, SubscriptionName: "free-credit:referral:inviter"},
		},
	}}
	revoker := &fakeCreditRevoker{}
	svc := NewWithAdmin(&fakeStore{codes: map[string]*domain.Code{}}, adminStore, revoker, "https://lightvela.com")
	svc.now = func() time.Time { return now }

	result, err := svc.ResetAttribution(t.Context(), AttributionResetInput{
		InviteeUserID: "invitee", ExpectedAttributionID: "rattr_1", IdempotencyKey: "ops-1",
		Operator: "operator", Reason: "incorrect attribution",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(revoker.requests) != 2 || result.RewardsRemoved != 2 || result.SubscriptionsRevoked != 2 {
		t.Fatalf("requests=%+v result=%+v", revoker.requests, result)
	}
	for _, request := range revoker.requests {
		if len(request.SubscriptionNames) != 1 || request.SubscriptionNames[0] == "" {
			t.Fatalf("revocation must use exact names: %+v", request)
		}
	}
}

func TestResetAttributionBlocksInFlightRewards(t *testing.T) {
	adminStore := &fakeAttributionAdminStore{preview: &domain.AttributionResetPreview{
		Attribution: domain.Attribution{ID: "rattr_1", InviteeUserID: "invitee"},
		Rewards:     []domain.AttributionReward{{ID: "reward_1", Status: domain.RewardStatusRetryable}},
	}}
	revoker := &fakeCreditRevoker{}
	svc := NewWithAdmin(&fakeStore{codes: map[string]*domain.Code{}}, adminStore, revoker, "https://lightvela.com")
	preview, err := svc.PreviewAttributionReset(t.Context(), "invitee", "rattr_1")
	if err != nil || preview.Resettable || preview.BlockReason == "" {
		t.Fatalf("preview=%+v err=%v", preview, err)
	}

	_, err = svc.ResetAttribution(t.Context(), AttributionResetInput{
		InviteeUserID: "invitee", ExpectedAttributionID: "rattr_1", IdempotencyKey: "ops-1",
		Operator: "operator", Reason: "incorrect attribution",
	})
	if !errors.Is(err, domain.ErrAttributionResetConflict) || len(revoker.requests) != 0 {
		t.Fatalf("err=%v requests=%+v", err, revoker.requests)
	}
}

func TestResetAttributionIdempotencyReplaySkipsRevocation(t *testing.T) {
	existing := &domain.AttributionResetResult{OperationID: "rrst_1", IdempotencyKey: "ops-1", InviteeUserID: "invitee", AttributionID: "rattr_1"}
	adminStore := &fakeAttributionAdminStore{existing: existing}
	revoker := &fakeCreditRevoker{}
	svc := NewWithAdmin(&fakeStore{codes: map[string]*domain.Code{}}, adminStore, revoker, "https://lightvela.com")

	result, err := svc.ResetAttribution(t.Context(), AttributionResetInput{
		InviteeUserID: "invitee", ExpectedAttributionID: "rattr_1", IdempotencyKey: "ops-1",
		Operator: "operator", Reason: "retry",
	})
	if err != nil || result != existing || len(revoker.requests) != 0 {
		t.Fatalf("result=%+v err=%v requests=%+v", result, err, revoker.requests)
	}
}
