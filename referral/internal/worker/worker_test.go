package worker

import (
	"context"
	"errors"
	"testing"
	"time"

	"git.woa.com/wisp/mono/referral/internal/ctlclient"
	"git.woa.com/wisp/mono/referral/internal/domain"
	"git.woa.com/wisp/mono/referral/internal/events"
)

type rewardStore struct {
	rewards   []domain.Reward
	granted   int
	retryable int
}

func (*rewardStore) UpsertCampaign(context.Context, domain.Campaign) error { return nil }

func (*rewardStore) ActiveCampaign(context.Context, time.Time) (*domain.Campaign, error) {
	return nil, nil
}
func (*rewardStore) ResolveCode(context.Context, string, time.Time) (*domain.CodeResolution, error) {
	return nil, nil
}
func (*rewardStore) CodeForOwner(context.Context, string, string) (*domain.Code, error) {
	return nil, nil
}
func (*rewardStore) CreateCode(context.Context, *domain.Code) error { return nil }
func (*rewardStore) StatsForUser(context.Context, string) (domain.Stats, error) {
	return domain.Stats{}, nil
}
func (*rewardStore) RecordRegistration(context.Context, events.Envelope, events.UserRegistered) error {
	return nil
}
func (*rewardStore) RecordFirstPaid(context.Context, events.Envelope, events.PassFirstPaid) error {
	return nil
}
func (*rewardStore) RecordRefunded(context.Context, events.Envelope, events.PassRefunded) error {
	return nil
}
func (s *rewardStore) ClaimRewards(context.Context, time.Time, int, string, time.Duration) ([]domain.Reward, error) {
	return s.rewards, nil
}
func (s *rewardStore) MarkRewardGranted(_ context.Context, _, _, _ string, _ time.Time) error {
	s.granted++
	return nil
}
func (s *rewardStore) MarkRewardRetryable(context.Context, string, string, string, time.Time) error {
	s.retryable++
	return nil
}
func (*rewardStore) CancelExpiredRewards(context.Context, time.Time) (int64, error) { return 0, nil }

type granter struct {
	err  error
	seen *ctlclient.GrantRequest
}

func (g granter) Grant(_ context.Context, request ctlclient.GrantRequest) (ctlclient.GrantResult, error) {
	if g.seen != nil {
		*g.seen = request
	}
	if g.err != nil {
		return ctlclient.GrantResult{}, g.err
	}
	return ctlclient.GrantResult{SubscriptionID: "sub_1", SubscriptionName: "free-credit:referral:reward"}, nil
}

func TestGrantPassesAmountAndQualification(t *testing.T) {
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	store := &rewardStore{}
	var request ctlclient.GrantRequest
	w := &Worker{store: store, granter: granter{seen: &request}, now: func() time.Time { return now }}
	w.grant(t.Context(), domain.Reward{
		ID: "reward_1", BeneficiaryUserID: "usr_1", InviteeUserID: "usr_invitee",
		QualifyingPassID: "pass_1", CreditAmount: 500,
	})
	if store.granted != 1 || store.retryable != 0 {
		t.Fatalf("granted=%d retryable=%d", store.granted, store.retryable)
	}
	if request.InviteeUserID != "usr_invitee" || request.QualifyingPassID != "pass_1" ||
		request.CreditAmount != 500 {
		t.Fatalf("grant request lost qualification: %+v", request)
	}
}

func TestGrantFailureReturnsRewardToRetryable(t *testing.T) {
	store := &rewardStore{}
	w := &Worker{store: store, granter: granter{err: errors.New("no active pass")}, now: time.Now}
	w.grant(t.Context(), domain.Reward{ID: "reward_1", BeneficiaryUserID: "usr_1", CreditAmount: 500})
	if store.granted != 0 || store.retryable != 1 {
		t.Fatalf("granted=%d retryable=%d", store.granted, store.retryable)
	}
}
