package service

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// mockTokenBalanceOps 将 mockSubscriptionRepo 适配为 TokenBalanceOps 接口（测试用）。
type mockTokenBalanceOps struct {
	*mockSubscriptionRepo
}

func (m *mockTokenBalanceOps) Deduct(ctx context.Context, subID uuid.UUID, amount int64) error {
	return m.mockSubscriptionRepo.DeductTokens(subID, amount)
}

func (m *mockTokenBalanceOps) Refund(ctx context.Context, subID uuid.UUID, amount int64) error {
	return m.mockSubscriptionRepo.RefundTokens(subID, amount)
}

func (m *mockTokenBalanceOps) DeductToZero(ctx context.Context, subID uuid.UUID, amount int64) (int64, error) {
	return m.mockSubscriptionRepo.DeductTokensToZero(subID, amount)
}

// --- mockUserRepo ---

type mockUserRepo struct {
	mu    sync.Mutex
	users map[uuid.UUID]*model.User
}

func newMockUserRepo() *mockUserRepo {
	return &mockUserRepo{users: make(map[uuid.UUID]*model.User)}
}

func (r *mockUserRepo) Create(user *model.User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if user.ID == uuid.Nil {
		user.ID = uuid.New()
	}
	for _, u := range r.users {
		if u.PhoneHash != "" && u.PhoneHash == user.PhoneHash {
			return errors.New("duplicate phone")
		}
	}
	r.users[user.ID] = user
	return nil
}

func (r *mockUserRepo) GetByID(id uuid.UUID) (*model.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if u, ok := r.users[id]; ok {
		return u, nil
	}
	return nil, model.ErrUserNotFound
}

func (r *mockUserRepo) GetByPhoneHash(phoneHash string) (*model.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, u := range r.users {
		if u.PhoneHash == phoneHash {
			return u, nil
		}
	}
	return nil, model.ErrUserNotFound
}

func (r *mockUserRepo) GetByUserID(userID string) (*model.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, u := range r.users {
		if u.UserID == userID {
			return u, nil
		}
	}
	return nil, model.ErrUserNotFound
}

func (r *mockUserRepo) Update(user *model.User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.users[user.ID] = user
	return nil
}

func (r *mockUserRepo) CountAll() (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return int64(len(r.users)), nil
}

func (r *mockUserRepo) CountByStatus(status string) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var count int64
	for _, u := range r.users {
		if u.Status == status {
			count++
		}
	}
	return count, nil
}

func (r *mockUserRepo) List(offset, limit int, search string, phoneHash string) ([]model.User, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var all []model.User
	for _, u := range r.users {
		all = append(all, *u)
	}
	total := int64(len(all))
	end := offset + limit
	if end > len(all) {
		end = len(all)
	}
	if offset >= len(all) {
		return []model.User{}, total, nil
	}
	return all[offset:end], total, nil
}

func (r *mockUserRepo) SoftDelete(id uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if u, ok := r.users[id]; ok {
		u.Status = model.UserStatusDeleted
		return nil
	}
	return model.ErrUserNotFound
}

func (r *mockUserRepo) DB() *gorm.DB { return nil }

func (r *mockUserRepo) ListWithActiveSubscription(offset, limit int, search string, status string) ([]repository.UserWithSubRow, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var all []repository.UserWithSubRow
	for _, u := range r.users {
		if status != "" && u.Status != status {
			continue
		}
		all = append(all, repository.UserWithSubRow{User: *u})
	}
	total := int64(len(all))
	end := offset + limit
	if end > len(all) {
		end = len(all)
	}
	if offset >= len(all) {
		return []repository.UserWithSubRow{}, total, nil
	}
	return all[offset:end], total, nil
}

// --- mockPlanRepo ---

type mockPlanRepo struct {
	mu    sync.Mutex
	plans map[uuid.UUID]*model.Plan
}

func newMockPlanRepo() *mockPlanRepo {
	return &mockPlanRepo{plans: make(map[uuid.UUID]*model.Plan)}
}

func (r *mockPlanRepo) Create(plan *model.Plan) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if plan.ID == uuid.Nil {
		plan.ID = uuid.New()
	}
	r.plans[plan.ID] = plan
	return nil
}

func (r *mockPlanRepo) GetByID(id uuid.UUID) (*model.Plan, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.plans[id]; ok {
		return p, nil
	}
	return nil, model.ErrPlanNotFound
}

func (r *mockPlanRepo) GetByName(name string) (*model.Plan, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.plans {
		if p.Name == name {
			return p, nil
		}
	}
	return nil, model.ErrPlanNotFound
}

func (r *mockPlanRepo) List(onlyActive bool) ([]model.Plan, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var result []model.Plan
	for _, p := range r.plans {
		if onlyActive && !p.IsActive {
			continue
		}
		result = append(result, *p)
	}
	return result, nil
}

func (r *mockPlanRepo) Update(plan *model.Plan) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.plans[plan.ID] = plan
	return nil
}

func (r *mockPlanRepo) DB() *gorm.DB { return nil }

// --- mockSubscriptionRepo ---

type mockSubscriptionRepo struct {
	mu          sync.Mutex
	subs        map[uuid.UUID]*model.Subscription
	plans       map[uuid.UUID]*model.Plan // optional; populated when tests need ListRefreshCandidates
	nowOverride time.Time                 // for ListRefreshCandidates determinism in tests
}

func newMockSubscriptionRepo() *mockSubscriptionRepo {
	return &mockSubscriptionRepo{subs: make(map[uuid.UUID]*model.Subscription)}
}

func (r *mockSubscriptionRepo) Create(sub *model.Subscription) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if sub.ID == uuid.Nil {
		sub.ID = uuid.New()
	}
	r.subs[sub.ID] = sub
	return nil
}

func (r *mockSubscriptionRepo) GetByID(id uuid.UUID) (*model.Subscription, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.subs[id]; ok {
		return s, nil
	}
	return nil, model.ErrSubscriptionNotFound
}

func (r *mockSubscriptionRepo) GetActiveByUserID(userID uuid.UUID) (*model.Subscription, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.subs {
		if s.UserID == userID && s.Status == model.SubscriptionStatusActive {
			return s, nil
		}
	}
	return nil, model.ErrSubscriptionNotFound
}

func (r *mockSubscriptionRepo) DeductTokens(subID uuid.UUID, amount int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.subs[subID]
	if !ok || s.Status != model.SubscriptionStatusActive {
		return model.ErrQuotaExceeded
	}
	if s.TokenBalance < amount {
		return model.ErrQuotaExceeded
	}
	s.TokenBalance -= amount
	return nil
}

func (r *mockSubscriptionRepo) DeductTokensToZero(subID uuid.UUID, amount int64) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.subs[subID]
	if !ok {
		return 0, model.ErrSubscriptionNotFound
	}
	actual := s.TokenBalance
	if actual <= 0 {
		return 0, nil
	}
	if actual > amount {
		actual = amount
	}
	s.TokenBalance -= actual
	return actual, nil
}

func (r *mockSubscriptionRepo) RefundTokens(subID uuid.UUID, amount int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.subs[subID]
	if !ok {
		return model.ErrSubscriptionNotFound
	}
	s.TokenBalance += amount
	return nil
}

func (r *mockSubscriptionRepo) SetTokenBalance(subID uuid.UUID, balance int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.subs[subID]
	if !ok {
		return model.ErrSubscriptionNotFound
	}
	s.TokenBalance = balance
	return nil
}

func (r *mockSubscriptionRepo) ExpireOverdue() (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var count int64
	for _, s := range r.subs {
		if s.Status == model.SubscriptionStatusActive && s.PeriodEnd.Before(s.PeriodEnd) {
			s.Status = model.SubscriptionStatusExpired
			count++
		}
	}
	return count, nil
}

func (r *mockSubscriptionRepo) CancelByUserID(userID uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.subs {
		if s.UserID == userID && s.Status == model.SubscriptionStatusActive {
			s.Status = model.SubscriptionStatusCancelled
		}
	}
	return nil
}

func (r *mockSubscriptionRepo) ListExpiredUserIDs() ([]uuid.UUID, error) {
	return nil, nil
}

func (r *mockSubscriptionRepo) SumActiveTokenBalance() (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var total int64
	for _, s := range r.subs {
		if s.Status == model.SubscriptionStatusActive {
			total += s.TokenBalance
		}
	}
	return total, nil
}

func (r *mockSubscriptionRepo) CountActive() (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var count int64
	for _, s := range r.subs {
		if s.Status == model.SubscriptionStatusActive {
			count++
		}
	}
	return count, nil
}

func (r *mockSubscriptionRepo) Update(sub *model.Subscription) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.subs[sub.ID] = sub
	return nil
}

func (r *mockSubscriptionRepo) DB() *gorm.DB { return nil }

func (r *mockSubscriptionRepo) ListRefreshCandidates(limit int) ([]repository.SubscriptionRefreshCandidate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.nowOverride
	if now.IsZero() {
		now = time.Now().UTC()
	}
	cutoff := now.Add(-28 * 24 * time.Hour)
	out := make([]repository.SubscriptionRefreshCandidate, 0)
	for _, s := range r.subs {
		if s.Status != model.SubscriptionStatusActive {
			continue
		}
		if !s.PeriodEnd.After(now) {
			continue
		}
		anchor := s.PeriodStart
		if s.LastRefreshedAt != nil {
			anchor = *s.LastRefreshedAt
		}
		if anchor.After(cutoff) {
			continue
		}
		var monthlyTokens int64
		if r.plans != nil {
			if plan, ok := r.plans[s.PlanID]; ok && plan != nil {
				monthlyTokens = plan.MonthlyTokens
			}
		}
		if monthlyTokens <= 0 {
			continue
		}
		out = append(out, repository.SubscriptionRefreshCandidate{
			ID:              s.ID,
			LastRefreshedAt: anchor,
			PeriodEnd:       s.PeriodEnd,
			MonthlyTokens:   monthlyTokens,
		})
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (r *mockSubscriptionRepo) RefreshByIDs(items []repository.SubscriptionRefreshItem) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var affected int64
	for _, it := range items {
		s, ok := r.subs[it.ID]
		if !ok || s.Status != model.SubscriptionStatusActive {
			continue
		}
		s.TokenBalance = it.NewTokenBalance
		anchor := it.NewRefreshedAt.UTC()
		s.LastRefreshedAt = &anchor
		affected++
	}
	return affected, nil
}

func (r *mockSubscriptionRepo) ExtendActivePeriodEnd(userID uuid.UUID, newPeriodEnd time.Time) (int64, *model.Subscription, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	newUTC := newPeriodEnd.UTC()
	var affected int64
	var sub *model.Subscription
	for _, s := range r.subs {
		if s.UserID == userID && s.Status == model.SubscriptionStatusActive {
			sub = s
			// 对齐语义（2026-05-24 用户拍板）：等值即 no-op，不等则强制覆盖
			// （含向后延期 + 向前缩短两种方向）。与 subscriptionRepo 真实实现保持一致。
			if !s.PeriodEnd.Equal(newUTC) {
				s.PeriodEnd = newUTC
				affected++
			}
			break
		}
	}
	if sub == nil {
		return 0, nil, model.ErrSubscriptionNotFound
	}
	return affected, sub, nil
}

// --- mockProviderRepo ---

type mockProviderRepo struct {
	mu        sync.Mutex
	providers map[uuid.UUID]*model.Provider
}

func newMockProviderRepo() *mockProviderRepo {
	return &mockProviderRepo{providers: make(map[uuid.UUID]*model.Provider)}
}

func (r *mockProviderRepo) Create(provider *model.Provider) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if provider.ID == uuid.Nil {
		provider.ID = uuid.New()
	}
	r.providers[provider.ID] = provider
	return nil
}

func (r *mockProviderRepo) GetByID(id uuid.UUID) (*model.Provider, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.providers[id]; ok {
		return p, nil
	}
	return nil, model.ErrProviderNotFound
}

func (r *mockProviderRepo) SelectBest(providerType string) (*model.Provider, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var best *model.Provider
	for _, p := range r.providers {
		if p.ProviderType == providerType && p.Status == model.ProviderStatusActive && p.UsedQuota < p.TotalQuota {
			if best == nil || p.Priority > best.Priority {
				best = p
			}
		}
	}
	if best == nil {
		return nil, model.ErrProviderUnavailable
	}
	return best, nil
}

func (r *mockProviderRepo) IncrementUsedQuota(providerID uuid.UUID, amount int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.providers[providerID]
	if !ok {
		return model.ErrProviderNotFound
	}
	p.UsedQuota += amount
	return nil
}

func (r *mockProviderRepo) IncrementUsedQuotaAndCheckExhaustion(providerID uuid.UUID, amount int64) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.providers[providerID]
	if !ok {
		return false, model.ErrProviderNotFound
	}
	p.UsedQuota += amount
	exhausted := p.UsedQuota >= p.TotalQuota && p.Status == model.ProviderStatusActive
	if exhausted {
		p.Status = model.ProviderStatusExhausted
	}
	return exhausted, nil
}

func (r *mockProviderRepo) MarkExhausted(providerID uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.providers[providerID]
	if !ok {
		return model.ErrProviderNotFound
	}
	p.Status = model.ProviderStatusExhausted
	return nil
}

func (r *mockProviderRepo) List() ([]model.Provider, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var result []model.Provider
	for _, p := range r.providers {
		result = append(result, *p)
	}
	return result, nil
}

func (r *mockProviderRepo) Update(provider *model.Provider) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.providers[provider.ID] = provider
	return nil
}

func (r *mockProviderRepo) SelectBestForModel(modelName string) (*model.Provider, error) {
	candidates, err := r.SelectCandidatesForModel(modelName)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, model.ErrProviderUnavailable
	}
	return &candidates[0], nil
}

func (r *mockProviderRepo) SelectCandidatesForModel(modelName string) ([]model.Provider, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var result []model.Provider
	for _, p := range r.providers {
		if p.Status == model.ProviderStatusActive && p.UsedQuota < p.TotalQuota && p.SupportedModels != nil {
			var models []string
			if err := json.Unmarshal([]byte(p.SupportedModels), &models); err == nil {
				for _, m := range models {
					if m == modelName {
						result = append(result, *p)
						break
					}
				}
			}
		}
	}
	return result, nil
}

func (r *mockProviderRepo) SelectCandidates(providerType string) ([]model.Provider, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var result []model.Provider
	for _, p := range r.providers {
		if p.ProviderType == providerType && p.Status == model.ProviderStatusActive && p.UsedQuota < p.TotalQuota {
			result = append(result, *p)
		}
	}
	return result, nil
}

func (r *mockProviderRepo) UpdateStatus(id uuid.UUID, status string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.providers[id]; ok {
		p.Status = status
		return nil
	}
	return model.ErrProviderNotFound
}

func (r *mockProviderRepo) UpdateHeartbeat(id uuid.UUID) error {
	return nil
}

func (r *mockProviderRepo) Delete(id uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.providers, id)
	return nil
}

func (r *mockProviderRepo) FindByBaseURL(baseURL string) (*model.Provider, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.providers {
		if p.BaseURL == baseURL {
			return p, nil
		}
	}
	return nil, nil
}

func (r *mockProviderRepo) ListByRegistrationSource(source string) ([]model.Provider, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var result []model.Provider
	for _, p := range r.providers {
		if p.RegistrationSource == source {
			result = append(result, *p)
		}
	}
	return result, nil
}

func (r *mockProviderRepo) ListForHealthCheck(source string) ([]model.Provider, error) {
	return r.ListByRegistrationSource(source)
}

func (r *mockProviderRepo) CountActive() (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var count int64
	for _, p := range r.providers {
		if p.Status == model.ProviderStatusActive {
			count++
		}
	}
	return count, nil
}

// --- mockApiKeyRepo ---

type mockApiKeyRepo struct {
	mu   sync.Mutex
	keys map[uuid.UUID]*model.ApiKey
}

func newMockApiKeyRepo() *mockApiKeyRepo {
	return &mockApiKeyRepo{keys: make(map[uuid.UUID]*model.ApiKey)}
}

func (r *mockApiKeyRepo) Create(key *model.ApiKey) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if key.ID == uuid.Nil {
		key.ID = uuid.New()
	}
	r.keys[key.ID] = key
	return nil
}

func (r *mockApiKeyRepo) GetByID(id uuid.UUID) (*model.ApiKey, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if k, ok := r.keys[id]; ok {
		return k, nil
	}
	return nil, model.ErrApiKeyNotFound
}

func (r *mockApiKeyRepo) GetByHash(hash string) (*model.ApiKey, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range r.keys {
		if k.KeyHash == hash && k.IsActive {
			return k, nil
		}
	}
	return nil, model.ErrApiKeyNotFound
}

func (r *mockApiKeyRepo) DeactivateByID(id uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if k, ok := r.keys[id]; ok {
		k.IsActive = false
		return nil
	}
	return model.ErrApiKeyNotFound
}

func (r *mockApiKeyRepo) DeactivateAllForUser(userID uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range r.keys {
		if k.UserID == userID && k.IsActive {
			k.IsActive = false
		}
	}
	return nil
}

func (r *mockApiKeyRepo) ListAll(offset, limit int, search string) ([]model.ApiKey, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var all []model.ApiKey
	for _, k := range r.keys {
		all = append(all, *k)
	}
	total := int64(len(all))
	end := offset + limit
	if end > len(all) {
		end = len(all)
	}
	if offset >= len(all) {
		return []model.ApiKey{}, total, nil
	}
	return all[offset:end], total, nil
}

func (r *mockApiKeyRepo) ListByUserID(userID uuid.UUID) ([]model.ApiKey, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var result []model.ApiKey
	for _, k := range r.keys {
		if k.UserID == userID {
			result = append(result, *k)
		}
	}
	return result, nil
}

func (r *mockApiKeyRepo) CountActive() (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var count int64
	for _, k := range r.keys {
		if k.IsActive {
			count++
		}
	}
	return count, nil
}

func (r *mockApiKeyRepo) DB() *gorm.DB { return nil }

func (r *mockApiKeyRepo) ListAllWithUsers(offset, limit int, search string, status string) ([]repository.ApiKeyWithUserRow, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var all []repository.ApiKeyWithUserRow
	for _, k := range r.keys {
		if status == "active" && !k.IsActive {
			continue
		}
		if status == "revoked" && k.IsActive {
			continue
		}
		all = append(all, repository.ApiKeyWithUserRow{ApiKey: *k})
	}
	total := int64(len(all))
	end := offset + limit
	if end > len(all) {
		end = len(all)
	}
	if offset >= len(all) {
		return []repository.ApiKeyWithUserRow{}, total, nil
	}
	return all[offset:end], total, nil
}

// --- mockUsageRepo ---

type mockUsageRepo struct {
	mu   sync.Mutex
	logs []model.UsageLog
}

func newMockUsageRepo() *mockUsageRepo {
	return &mockUsageRepo{}
}

func (r *mockUsageRepo) Create(log *model.UsageLog) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.logs = append(r.logs, *log)
	return nil
}

func (r *mockUsageRepo) BatchCreate(logs []model.UsageLog) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.logs = append(r.logs, logs...)
	return nil
}

func (r *mockUsageRepo) CountRequestsBetween(start, end time.Time) (int64, error) {
	return 0, nil
}

func (r *mockUsageRepo) SumTokensSince(since time.Time) (int64, error)         { return 0, nil }
func (r *mockUsageRepo) CountRequestsSince(since time.Time) (int64, error)     { return 0, nil }
func (r *mockUsageRepo) SumTokensBetween(start, end time.Time) (int64, error)  { return 0, nil }
func (r *mockUsageRepo) SumAllConsumedTokens() (int64, error)                  { return 0, nil }
func (r *mockUsageRepo) SumConsumedTokensSince(since time.Time) (int64, error) { return 0, nil }

func (r *mockUsageRepo) DailyTrend(start, end time.Time) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}

func (r *mockUsageRepo) ModelDistribution(start, end time.Time) ([]repository.ModelDistPoint, error) {
	return nil, nil
}
func (r *mockUsageRepo) ModelDailyDistribution(start, end time.Time) ([]repository.ModelDailyDistPoint, error) {
	return nil, nil
}

func (r *mockUsageRepo) UserDailyUsage(userID uuid.UUID, days int) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}

func (r *mockUsageRepo) UserTotalUsage(userID uuid.UUID, since time.Time) (int64, int64, error) {
	return 0, 0, nil
}
func (r *mockUsageRepo) ListUserUsageLogs(
	userID uuid.UUID,
	start time.Time,
	end time.Time,
	offset int,
	limit int,
) ([]repository.UserUsageLogRecord, int64, repository.UserUsageLogSummary, error) {
	return nil, 0, repository.UserUsageLogSummary{}, nil
}
func (r *mockUsageRepo) SubscriptionModelUsage(uuid.UUID) ([]repository.ModelDistPoint, error) {
	return nil, nil
}

func (r *mockUsageRepo) TopUsersByTokens(since time.Time, limit int) ([]repository.UserUsagePoint, error) {
	return nil, nil
}

func (r *mockUsageRepo) ProviderRequestCount(providerID uuid.UUID) (int64, error)    { return 0, nil }
func (r *mockUsageRepo) ProviderLastUsedAt(providerID uuid.UUID) (*time.Time, error) { return nil, nil }
