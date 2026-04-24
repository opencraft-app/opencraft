package passsync

import (
	"context"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
)

func TestRunCreatesActiveSubscriptionAndAPIKeyForActivePass(t *testing.T) {
	now := time.Date(2026, 4, 23, 12, 0, 0, 0, time.UTC)
	planID := uuid.New()
	source := &fakePassSource{
		passes: []PassRecord{
			{
				PassID:      "pass_active_1",
				UserID:      "usr_active_1",
				BundleID:    "bundle_active_1",
				PlanID:      planID.String(),
				CreatedTime: now.Add(-24 * time.Hour),
				ExpiredTime: now.Add(29 * 24 * time.Hour),
			},
		},
	}
	users := newFakeUserManager()
	apiKeys := newFakeAPIKeyManager()
	plans := &fakePlanLoader{
		plans: map[uuid.UUID]*model.Plan{
			planID: {
				ID:            planID,
				Name:          "starter",
				MonthlyTokens: 900000,
				PeriodValue:   1,
				PeriodUnit:    "months",
				IsActive:      true,
			},
		},
	}
	subscriptions := newFakeSubscriptionStore()

	svc := NewService(source, users, apiKeys, plans, subscriptions, func() time.Time { return now })
	summary, err := svc.Run(context.Background(), SyncOptions{})
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	if summary.PassesSeen != 1 || summary.UsersEnsured != 1 || summary.APIKeysCreated != 1 || summary.SubscriptionsCreated != 1 {
		t.Fatalf("unexpected summary: %+v", summary)
	}
	if len(subscriptions.created) != 1 {
		t.Fatalf("expected one created subscription, got %d", len(subscriptions.created))
	}
	got := subscriptions.created[0]
	if got.Status != model.SubscriptionStatusActive {
		t.Fatalf("expected active status, got %q", got.Status)
	}
	if got.TokenBalance != 900000 {
		t.Fatalf("expected token balance 900000, got %d", got.TokenBalance)
	}
	if !got.PeriodStart.Equal(now.Add(-24 * time.Hour)) {
		t.Fatalf("expected period start from pass created_time, got %s", got.PeriodStart)
	}
	if !got.PeriodEnd.Equal(now.Add(29 * 24 * time.Hour)) {
		t.Fatalf("expected period end from pass expired_time, got %s", got.PeriodEnd)
	}
}

func TestRunCreatesExpiredSubscriptionForExpiredPass(t *testing.T) {
	now := time.Date(2026, 4, 23, 12, 0, 0, 0, time.UTC)
	planID := uuid.New()
	source := &fakePassSource{
		passes: []PassRecord{
			{
				PassID:      "pass_expired_1",
				UserID:      "usr_expired_1",
				BundleID:    "bundle_expired_1",
				PlanID:      planID.String(),
				CreatedTime: now.Add(-60 * 24 * time.Hour),
				ExpiredTime: now.Add(-30 * 24 * time.Hour),
			},
		},
	}
	users := newFakeUserManager()
	apiKeys := newFakeAPIKeyManager()
	plans := &fakePlanLoader{
		plans: map[uuid.UUID]*model.Plan{
			planID: {
				ID:            planID,
				Name:          "legacy",
				MonthlyTokens: 1200000,
				PeriodValue:   1,
				PeriodUnit:    "months",
				IsActive:      true,
			},
		},
	}
	subscriptions := newFakeSubscriptionStore()

	svc := NewService(source, users, apiKeys, plans, subscriptions, func() time.Time { return now })
	summary, err := svc.Run(context.Background(), SyncOptions{})
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	if summary.SubscriptionsCreated != 1 {
		t.Fatalf("expected one expired subscription create, got %+v", summary)
	}
	got := subscriptions.created[0]
	if got.Status != model.SubscriptionStatusExpired {
		t.Fatalf("expected expired status, got %q", got.Status)
	}
	if got.TokenBalance != 0 {
		t.Fatalf("expected expired subscription token balance 0, got %d", got.TokenBalance)
	}
}

func TestRunSkipsExistingActiveKeyAndMatchingSubscription(t *testing.T) {
	now := time.Date(2026, 4, 23, 12, 0, 0, 0, time.UTC)
	planID := uuid.New()
	source := &fakePassSource{
		passes: []PassRecord{
			{
				PassID:      "pass_existing_1",
				UserID:      "usr_existing_1",
				BundleID:    "bundle_existing_1",
				PlanID:      planID.String(),
				CreatedTime: now.Add(-48 * time.Hour),
				ExpiredTime: now.Add(10 * 24 * time.Hour),
			},
		},
	}
	users := newFakeUserManager()
	user := users.ensure("usr_existing_1")
	apiKeys := newFakeAPIKeyManager()
	apiKeys.byUser[user.ID] = []model.ApiKey{
		{ID: uuid.New(), UserID: user.ID, KeyPrefix: "sk-live", Name: "default", IsActive: true},
	}
	plans := &fakePlanLoader{
		plans: map[uuid.UUID]*model.Plan{
			planID: {
				ID:            planID,
				Name:          "starter",
				MonthlyTokens: 800000,
				PeriodValue:   1,
				PeriodUnit:    "months",
				IsActive:      true,
			},
		},
	}
	subscriptions := newFakeSubscriptionStore()
	subscriptions.byUser[user.ID] = []model.Subscription{
		{
			ID:           uuid.New(),
			UserID:       user.ID,
			PlanID:       planID,
			Status:       model.SubscriptionStatusActive,
			TokenBalance: 800000,
			PeriodStart:  now.Add(-48 * time.Hour),
			PeriodEnd:    now.Add(10 * 24 * time.Hour),
		},
	}

	svc := NewService(source, users, apiKeys, plans, subscriptions, func() time.Time { return now })
	summary, err := svc.Run(context.Background(), SyncOptions{})
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	if summary.APIKeysCreated != 0 || summary.APIKeysSkipped != 1 {
		t.Fatalf("expected api key skip, got %+v", summary)
	}
	if summary.SubscriptionsCreated != 0 || summary.SubscriptionsSkipped != 1 {
		t.Fatalf("expected subscription skip, got %+v", summary)
	}
}

func TestRunDryRunDoesNotMutate(t *testing.T) {
	now := time.Date(2026, 4, 23, 12, 0, 0, 0, time.UTC)
	planID := uuid.New()
	source := &fakePassSource{
		passes: []PassRecord{
			{
				PassID:      "pass_dry_run",
				UserID:      "usr_dry_run",
				BundleID:    "bundle_dry_run",
				PlanID:      planID.String(),
				CreatedTime: now.Add(-2 * time.Hour),
				ExpiredTime: now.Add(7 * 24 * time.Hour),
			},
		},
	}
	users := newFakeUserManager()
	apiKeys := newFakeAPIKeyManager()
	plans := &fakePlanLoader{
		plans: map[uuid.UUID]*model.Plan{
			planID: {
				ID:            planID,
				Name:          "starter",
				MonthlyTokens: 100,
				PeriodValue:   7,
				PeriodUnit:    "days",
				IsActive:      true,
			},
		},
	}
	subscriptions := newFakeSubscriptionStore()

	svc := NewService(source, users, apiKeys, plans, subscriptions, func() time.Time { return now })
	summary, err := svc.Run(context.Background(), SyncOptions{DryRun: true})
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	if !summary.DryRun {
		t.Fatalf("expected dry-run summary: %+v", summary)
	}
	if len(users.byBusinessID) != 0 || len(apiKeys.created) != 0 || len(subscriptions.created) != 0 {
		t.Fatalf("expected no mutations in dry-run")
	}
}

func TestRunCreatesOneAPIKeyPerUserAcrossMultiplePasses(t *testing.T) {
	now := time.Date(2026, 4, 23, 12, 0, 0, 0, time.UTC)
	planID := uuid.New()
	source := &fakePassSource{
		passes: []PassRecord{
			{
				PassID:      "pass_multi_1",
				UserID:      "usr_multi_1",
				BundleID:    "bundle_multi_1",
				PlanID:      planID.String(),
				CreatedTime: now.Add(-72 * time.Hour),
				ExpiredTime: now.Add(-24 * time.Hour),
			},
			{
				PassID:      "pass_multi_2",
				UserID:      "usr_multi_1",
				BundleID:    "bundle_multi_2",
				PlanID:      "",
				CreatedTime: now.Add(-12 * time.Hour),
				ExpiredTime: now.Add(30 * 24 * time.Hour),
			},
		},
	}
	users := newFakeUserManager()
	apiKeys := newFakeAPIKeyManager()
	plans := &fakePlanLoader{
		plans: map[uuid.UUID]*model.Plan{
			planID: {
				ID:            planID,
				Name:          "legacy",
				MonthlyTokens: 500,
				PeriodValue:   1,
				PeriodUnit:    "months",
				IsActive:      true,
			},
		},
	}
	subscriptions := newFakeSubscriptionStore()

	svc := NewService(source, users, apiKeys, plans, subscriptions, func() time.Time { return now })
	summary, err := svc.Run(context.Background(), SyncOptions{})
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	if summary.APIKeysCreated != 1 {
		t.Fatalf("expected exactly one api key creation, got %+v", summary)
	}
}

type fakePassSource struct {
	passes []PassRecord
}

func (f *fakePassSource) ListPasses(_ context.Context, opts SyncOptions) ([]PassRecord, error) {
	items := make([]PassRecord, 0, len(f.passes))
	for _, pass := range f.passes {
		if opts.UserID != "" && pass.UserID != opts.UserID {
			continue
		}
		items = append(items, pass)
		if opts.Limit > 0 && len(items) >= opts.Limit {
			break
		}
	}
	return items, nil
}

type fakeUserManager struct {
	byBusinessID map[string]*model.User
}

func newFakeUserManager() *fakeUserManager {
	return &fakeUserManager{byBusinessID: map[string]*model.User{}}
}

func (f *fakeUserManager) ensure(userID string) *model.User {
	user := &model.User{ID: uuid.New(), UserID: userID, Nickname: userID, Status: model.UserStatusActive}
	f.byBusinessID[userID] = user
	return user
}

func (f *fakeUserManager) EnsureUser(_ context.Context, userID, nickname string) (*model.User, string, error) {
	if existing, ok := f.byBusinessID[userID]; ok {
		return existing, "already_exists", nil
	}
	user := &model.User{ID: uuid.New(), UserID: userID, Nickname: nickname, Status: model.UserStatusActive}
	f.byBusinessID[userID] = user
	return user, "created", nil
}

func (f *fakeUserManager) GetByUserID(_ context.Context, userID string) (*model.User, error) {
	if user, ok := f.byBusinessID[userID]; ok {
		return user, nil
	}
	return nil, model.ErrUserNotFound
}

type fakeAPIKeyManager struct {
	byUser  map[uuid.UUID][]model.ApiKey
	created []uuid.UUID
}

func newFakeAPIKeyManager() *fakeAPIKeyManager {
	return &fakeAPIKeyManager{byUser: map[uuid.UUID][]model.ApiKey{}}
}

func (f *fakeAPIKeyManager) ListByUserID(_ context.Context, userID uuid.UUID) ([]model.ApiKey, error) {
	return append([]model.ApiKey(nil), f.byUser[userID]...), nil
}

func (f *fakeAPIKeyManager) Generate(_ context.Context, userID uuid.UUID, name string) (*model.ApiKey, error) {
	key := model.ApiKey{ID: uuid.New(), UserID: userID, KeyPrefix: "sk-test", Name: name, IsActive: true}
	f.byUser[userID] = append(f.byUser[userID], key)
	f.created = append(f.created, userID)
	return &key, nil
}

type fakePlanLoader struct {
	plans map[uuid.UUID]*model.Plan
}

func (f *fakePlanLoader) GetByID(_ context.Context, id uuid.UUID) (*model.Plan, error) {
	plan, ok := f.plans[id]
	if !ok {
		return nil, model.ErrPlanNotFound
	}
	return plan, nil
}

type fakeSubscriptionStore struct {
	byUser  map[uuid.UUID][]model.Subscription
	created []model.Subscription
}

func newFakeSubscriptionStore() *fakeSubscriptionStore {
	return &fakeSubscriptionStore{byUser: map[uuid.UUID][]model.Subscription{}}
}

func (f *fakeSubscriptionStore) ListByUserID(_ context.Context, userID uuid.UUID) ([]model.Subscription, error) {
	return append([]model.Subscription(nil), f.byUser[userID]...), nil
}

func (f *fakeSubscriptionStore) Create(_ context.Context, sub *model.Subscription) error {
	f.created = append(f.created, *sub)
	f.byUser[sub.UserID] = append(f.byUser[sub.UserID], *sub)
	return nil
}
