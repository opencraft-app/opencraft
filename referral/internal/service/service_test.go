package service

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/referral/internal/domain"
	"git.woa.com/wisp/mono/referral/internal/events"
)

type fakeStore struct {
	campaign      *domain.Campaign
	codes         map[string]*domain.Code
	registrations int
	claims        int
	payments      int
	refunds       int
}

func (f *fakeStore) UpsertCampaign(_ context.Context, campaign domain.Campaign) error {
	f.campaign = &campaign
	return nil
}

func (f *fakeStore) ActiveCampaign(context.Context, time.Time) (*domain.Campaign, error) {
	if f.campaign == nil {
		return nil, domain.ErrNoActiveCampaign
	}
	return f.campaign, nil
}
func (f *fakeStore) ResolveCode(context.Context, string, time.Time) (*domain.CodeResolution, error) {
	return nil, domain.ErrCodeNotFound
}
func (f *fakeStore) CodeForOwner(_ context.Context, campaignID, userID string) (*domain.Code, error) {
	if code := f.codes[campaignID+":"+userID]; code != nil {
		return code, nil
	}
	return nil, domain.ErrCodeNotFound
}
func (f *fakeStore) CreateCode(_ context.Context, code *domain.Code) error {
	f.codes[code.CampaignID+":"+code.OwnerUserID] = code
	return nil
}
func (f *fakeStore) StatsForUser(context.Context, string) (domain.Stats, error) {
	return domain.Stats{}, nil
}
func (f *fakeStore) RecordRegistration(context.Context, events.Envelope, events.UserRegistered) error {
	f.registrations++
	return nil
}
func (f *fakeStore) RecordClaim(context.Context, events.Envelope, events.UserReferralClaimed) error {
	f.claims++
	return nil
}
func (f *fakeStore) RecordFirstPaid(context.Context, events.Envelope, events.PassFirstPaid) error {
	f.payments++
	return nil
}
func (f *fakeStore) RecordRefunded(context.Context, events.Envelope, events.PassRefunded) error {
	f.refunds++
	return nil
}
func (f *fakeStore) ClaimRewards(context.Context, time.Time, int, string, time.Duration) ([]domain.Reward, error) {
	return nil, nil
}
func (f *fakeStore) MarkRewardGranted(context.Context, string, string, string, time.Time) error {
	return nil
}
func (f *fakeStore) MarkRewardRetryable(context.Context, string, string, string, time.Time) error {
	return nil
}
func (f *fakeStore) CancelExpiredRewards(context.Context, time.Time) (int64, error) { return 0, nil }

func TestIssueCodeIsStableAndUsesUnambiguousAlphabet(t *testing.T) {
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	store := &fakeStore{
		campaign: &domain.Campaign{ID: "campaign-1", Name: "Beijing pilot", StartsAt: now.Add(-time.Hour), EndsAt: now.Add(time.Hour)},
		codes:    map[string]*domain.Code{},
	}
	svc := New(store, "https://lightvela.com/")
	svc.now = func() time.Time { return now }

	first, err := svc.IssueCode(t.Context(), "usr_1")
	if err != nil {
		t.Fatalf("IssueCode first: %v", err)
	}
	second, err := svc.IssueCode(t.Context(), "usr_1")
	if err != nil {
		t.Fatalf("IssueCode second: %v", err)
	}
	if first.Code != second.Code || len(first.Code) != 10 {
		t.Fatalf("code is not stable: first=%q second=%q", first.Code, second.Code)
	}
	for _, char := range first.Code {
		if !strings.ContainsRune(referralAlphabet, char) {
			t.Fatalf("code contains unsupported character %q", char)
		}
	}
	if first.URL != "https://lightvela.com/?ref="+first.Code {
		t.Fatalf("unexpected referral URL %q", first.URL)
	}
}

func TestGenerateCodeDoesNotIndexPastAlphabet(t *testing.T) {
	for i := 0; i < 10_000; i++ {
		if _, err := generateCode(10); err != nil {
			t.Fatalf("generateCode: %v", err)
		}
	}
}

func TestIngestDispatchesVersionedEvents(t *testing.T) {
	store := &fakeStore{codes: map[string]*domain.Code{}}
	svc := New(store, "https://lightvela.com")
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		typeName string
		payload  any
	}{
		{events.TypeUserRegistered, events.UserRegistered{UserID: "usr_invitee", ReferralCode: "ABC234"}},
		{events.TypeUserReferralClaimed, events.UserReferralClaimed{UserID: "usr_invitee", ReferralCode: "ABC234"}},
		{events.TypePassFirstPaid, events.PassFirstPaid{UserID: "usr_invitee", PassID: "pass_1", BundleID: "bundle_1", DealName: "deal_1"}},
		{events.TypePassRefunded, events.PassRefunded{UserID: "usr_invitee", PassID: "pass_1", DealName: "refund_1"}},
	}
	for i, test := range tests {
		payload, _ := json.Marshal(test.payload)
		envelope, _ := json.Marshal(events.Envelope{
			EventID: "event-" + test.typeName, EventType: test.typeName, OccurredAt: now,
			Producer: "test", AggregateID: "aggregate", CorrelationID: "correlation", Payload: payload,
		})
		if err := svc.Ingest(t.Context(), envelope); err != nil {
			t.Fatalf("Ingest[%d]: %v", i, err)
		}
	}
	if store.registrations != 1 || store.claims != 1 || store.payments != 1 || store.refunds != 1 {
		t.Fatalf("dispatch counts registration=%d claim=%d payment=%d refund=%d", store.registrations, store.claims, store.payments, store.refunds)
	}
}
