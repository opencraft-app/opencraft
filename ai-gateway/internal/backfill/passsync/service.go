package passsync

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
)

type PassRecord struct {
	PassID      string
	UserID      string
	BundleID    string
	PlanID      string
	CreatedTime time.Time
	ExpiredTime time.Time
}

type SyncOptions struct {
	UserID string
	Limit  int
	DryRun bool
}

type SyncSummary struct {
	DryRun               bool
	PassesSeen           int
	UsersEnsured         int
	UsersAlreadyPresent  int
	APIKeysCreated       int
	APIKeysSkipped       int
	SubscriptionsCreated int
	SubscriptionsSkipped int
	Failures             int
}

type PassSource interface {
	ListPasses(ctx context.Context, opts SyncOptions) ([]PassRecord, error)
}

type UserManager interface {
	EnsureUser(ctx context.Context, userID string, nickname string) (*model.User, string, error)
	GetByUserID(ctx context.Context, userID string) (*model.User, error)
}

type APIKeyManager interface {
	ListByUserID(ctx context.Context, userID uuid.UUID) ([]model.ApiKey, error)
	Generate(ctx context.Context, userID uuid.UUID, name string) (*model.ApiKey, error)
}

type PlanLoader interface {
	GetByID(ctx context.Context, id uuid.UUID) (*model.Plan, error)
}

type SubscriptionStore interface {
	ListByUserID(ctx context.Context, userID uuid.UUID) ([]model.Subscription, error)
	Create(ctx context.Context, sub *model.Subscription) error
}

type Service struct {
	source        PassSource
	users         UserManager
	apiKeys       APIKeyManager
	plans         PlanLoader
	subscriptions SubscriptionStore
	now           func() time.Time
}

func NewService(
	source PassSource,
	users UserManager,
	apiKeys APIKeyManager,
	plans PlanLoader,
	subscriptions SubscriptionStore,
	now func() time.Time,
) *Service {
	if now == nil {
		now = time.Now
	}
	return &Service{
		source:        source,
		users:         users,
		apiKeys:       apiKeys,
		plans:         plans,
		subscriptions: subscriptions,
		now:           now,
	}
}

func (s *Service) Run(ctx context.Context, opts SyncOptions) (SyncSummary, error) {
	summary := SyncSummary{DryRun: opts.DryRun}
	passes, err := s.source.ListPasses(ctx, opts)
	if err != nil {
		return summary, fmt.Errorf("list passes: %w", err)
	}
	summary.PassesSeen = len(passes)

	userCache := map[string]*model.User{}
	keyState := map[string]bool{}
	subCache := map[string][]model.Subscription{}
	now := s.now().UTC()

	for _, pass := range passes {
		userID := strings.TrimSpace(pass.UserID)
		if userID == "" {
			summary.Failures++
			continue
		}

		user, ok := userCache[userID]
		if !ok {
			user, err = s.lookupOrEnsureUser(ctx, userID, opts.DryRun, &summary)
			if err != nil {
				summary.Failures++
				continue
			}
			userCache[userID] = user
		}

		if _, ok := keyState[userID]; !ok {
			created, keyErr := s.ensureAPIKey(ctx, user, opts.DryRun)
			if keyErr != nil {
				summary.Failures++
				continue
			}
			if created {
				summary.APIKeysCreated++
			} else {
				summary.APIKeysSkipped++
			}
			keyState[userID] = true
		}

		planID := strings.TrimSpace(pass.PlanID)
		if planID == "" {
			summary.SubscriptionsSkipped++
			continue
		}

		if _, ok := subCache[userID]; !ok {
			existing, listErr := s.subscriptions.ListByUserID(ctx, user.ID)
			if listErr != nil {
				summary.Failures++
				continue
			}
			subCache[userID] = existing
		}

		created, createdSub, subErr := s.ensureSubscription(ctx, user, pass, subCache[userID], now, opts.DryRun)
		if subErr != nil {
			summary.Failures++
			continue
		}
		if created {
			summary.SubscriptionsCreated++
			if createdSub != nil {
				subCache[userID] = append(subCache[userID], *createdSub)
			}
		} else {
			summary.SubscriptionsSkipped++
		}
	}

	return summary, nil
}

func (s *Service) lookupOrEnsureUser(ctx context.Context, businessUserID string, dryRun bool, summary *SyncSummary) (*model.User, error) {
	user, err := s.users.GetByUserID(ctx, businessUserID)
	if err == nil {
		summary.UsersAlreadyPresent++
		return user, nil
	}
	if err != nil && err != model.ErrUserNotFound {
		return nil, fmt.Errorf("get user by user_id %s: %w", businessUserID, err)
	}
	if dryRun {
		return &model.User{
			ID:       uuid.New(),
			UserID:   businessUserID,
			Nickname: businessUserID,
			Status:   model.UserStatusActive,
		}, nil
	}
	user, result, err := s.users.EnsureUser(ctx, businessUserID, businessUserID)
	if err != nil {
		return nil, fmt.Errorf("ensure user %s: %w", businessUserID, err)
	}
	if result == "created" {
		summary.UsersEnsured++
	} else {
		summary.UsersAlreadyPresent++
	}
	return user, nil
}

func (s *Service) ensureAPIKey(ctx context.Context, user *model.User, dryRun bool) (bool, error) {
	keys, err := s.apiKeys.ListByUserID(ctx, user.ID)
	if err != nil {
		return false, fmt.Errorf("list api keys for %s: %w", user.UserID, err)
	}
	if slices.ContainsFunc(keys, func(key model.ApiKey) bool { return key.IsActive }) {
		return false, nil
	}
	if dryRun {
		return true, nil
	}
	if _, err := s.apiKeys.Generate(ctx, user.ID, "default"); err != nil {
		return false, fmt.Errorf("create api key for %s: %w", user.UserID, err)
	}
	return true, nil
}

func (s *Service) ensureSubscription(
	ctx context.Context,
	user *model.User,
	pass PassRecord,
	existing []model.Subscription,
	now time.Time,
	dryRun bool,
) (bool, *model.Subscription, error) {
	planUUID, err := uuid.Parse(strings.TrimSpace(pass.PlanID))
	if err != nil {
		return false, nil, fmt.Errorf("parse plan_id %q for pass %s: %w", pass.PlanID, pass.PassID, err)
	}
	if hasMatchingSubscription(existing, planUUID, pass.CreatedTime, pass.ExpiredTime) {
		return false, nil, nil
	}

	desiredStatus := model.SubscriptionStatusExpired
	if pass.ExpiredTime.After(now) {
		desiredStatus = model.SubscriptionStatusActive
	}
	if desiredStatus == model.SubscriptionStatusActive && hasAnyActiveSubscription(existing) {
		return false, nil, nil
	}

	plan, err := s.plans.GetByID(ctx, planUUID)
	if err != nil {
		return false, nil, fmt.Errorf("load plan %s for pass %s: %w", planUUID, pass.PassID, err)
	}

	tokenBalance, err := calcTokenBalance(plan)
	if err != nil {
		return false, nil, fmt.Errorf("calc token balance for plan %s: %w", planUUID, err)
	}
	if desiredStatus != model.SubscriptionStatusActive {
		tokenBalance = 0
	}

	sub := &model.Subscription{
		UserID:       user.ID,
		PlanID:       planUUID,
		Status:       desiredStatus,
		TokenBalance: tokenBalance,
		PeriodStart:  pass.CreatedTime.UTC(),
		PeriodEnd:    pass.ExpiredTime.UTC(),
	}
	// 月度刷新模型（v0.2.4）：active 订阅必须有 LastRefreshedAt，否则 scheduler
	// 永远拉不到（COALESCE 兜底为 period_start，但显式写入更直观且测试更稳定）。
	if desiredStatus == model.SubscriptionStatusActive {
		anchor := pass.CreatedTime.UTC()
		sub.LastRefreshedAt = &anchor
	}
	if dryRun {
		if sub.ID == uuid.Nil {
			sub.ID = uuid.New()
		}
		return true, sub, nil
	}
	if err := s.subscriptions.Create(ctx, sub); err != nil {
		return false, nil, fmt.Errorf("create subscription for %s: %w", user.UserID, err)
	}
	return true, sub, nil
}

func hasAnyActiveSubscription(existing []model.Subscription) bool {
	return slices.ContainsFunc(existing, func(sub model.Subscription) bool {
		return sub.Status == model.SubscriptionStatusActive
	})
}

func hasMatchingSubscription(existing []model.Subscription, planID uuid.UUID, start, end time.Time) bool {
	start = start.UTC()
	end = end.UTC()
	return slices.ContainsFunc(existing, func(sub model.Subscription) bool {
		return sub.PlanID == planID &&
			sub.PeriodStart.UTC().Equal(start) &&
			sub.PeriodEnd.UTC().Equal(end)
	})
}

// calcTokenBalance returns the initial token balance for a backfilled subscription.
//
// v0.2.4 月度刷新模型：返回单月配额（plan.MonthlyTokens），不再按 PeriodValue
// 折算总额。后续按月配额由 scheduler 的 RefreshDueBalances 在每个 b3 同号日刷新。
//
// "unlimited" 套餐（MonthlyTokens <= 0）返回 0，与 service.CalcInitialTokenBalance
// 行为一致。"days" / "months" 单位差异在月度模型下已无意义（PeriodEnd 由
// pass.ExpiredTime 直接给定，token_balance 不依赖 PeriodValue）。
func calcTokenBalance(plan *model.Plan) (int64, error) {
	if plan.MonthlyTokens <= 0 {
		return 0, nil
	}
	switch plan.PeriodUnit {
	case "days", "months":
		return plan.MonthlyTokens, nil
	default:
		return 0, fmt.Errorf("unsupported period_unit: %q", plan.PeriodUnit)
	}
}
