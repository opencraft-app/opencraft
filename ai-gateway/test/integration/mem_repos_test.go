package integration

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// --- memUserRepo ---

type memUserRepo struct {
	mu    sync.Mutex
	users map[uuid.UUID]*model.User
}

func newMemUserRepo() *memUserRepo {
	return &memUserRepo{users: make(map[uuid.UUID]*model.User)}
}

func (r *memUserRepo) Create(user *model.User) error {
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

func (r *memUserRepo) GetByID(id uuid.UUID) (*model.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if u, ok := r.users[id]; ok {
		return u, nil
	}
	return nil, model.ErrUserNotFound
}

func (r *memUserRepo) GetByPhoneHash(phoneHash string) (*model.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, u := range r.users {
		if u.PhoneHash == phoneHash {
			return u, nil
		}
	}
	return nil, model.ErrUserNotFound
}

func (r *memUserRepo) GetByUserID(userID string) (*model.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, u := range r.users {
		if u.UserID == userID {
			return u, nil
		}
	}
	return nil, model.ErrUserNotFound
}

func (r *memUserRepo) Update(user *model.User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.users[user.ID] = user
	return nil
}

func (r *memUserRepo) CountAll() (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return int64(len(r.users)), nil
}

func (r *memUserRepo) CountByStatus(status string) (int64, error) {
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

func (r *memUserRepo) List(offset, limit int, search string, phoneHash string) ([]model.User, int64, error) {
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

func (r *memUserRepo) SoftDelete(id uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if u, ok := r.users[id]; ok {
		u.Status = model.UserStatusDeleted
		return nil
	}
	return model.ErrUserNotFound
}

func (r *memUserRepo) DB() *gorm.DB { return nil }

func (r *memUserRepo) ListWithActiveSubscription(offset, limit int, search string, status string) ([]repository.UserWithSubRow, int64, error) {
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

// --- memPlanRepo ---

type memPlanRepo struct {
	mu    sync.Mutex
	plans map[uuid.UUID]*model.Plan
}

func newMemPlanRepo() *memPlanRepo {
	return &memPlanRepo{plans: make(map[uuid.UUID]*model.Plan)}
}

func (r *memPlanRepo) Create(plan *model.Plan) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if plan.ID == uuid.Nil {
		plan.ID = uuid.New()
	}
	r.plans[plan.ID] = plan
	return nil
}

func (r *memPlanRepo) GetByID(id uuid.UUID) (*model.Plan, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.plans[id]; ok {
		return p, nil
	}
	return nil, model.ErrPlanNotFound
}

func (r *memPlanRepo) GetByName(name string) (*model.Plan, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.plans {
		if p.Name == name {
			return p, nil
		}
	}
	return nil, model.ErrPlanNotFound
}

func (r *memPlanRepo) List(onlyActive bool) ([]model.Plan, error) {
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

func (r *memPlanRepo) Update(plan *model.Plan) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.plans[plan.ID] = plan
	return nil
}

func (r *memPlanRepo) DB() *gorm.DB { return nil }

// --- memSubRepo ---

type memSubRepo struct {
	mu   sync.Mutex
	subs map[uuid.UUID]*model.Subscription
}

func newMemSubRepo() *memSubRepo {
	return &memSubRepo{subs: make(map[uuid.UUID]*model.Subscription)}
}

func (r *memSubRepo) Create(sub *model.Subscription) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if sub.ID == uuid.Nil {
		sub.ID = uuid.New()
	}
	r.subs[sub.ID] = sub
	return nil
}

func (r *memSubRepo) GetByID(id uuid.UUID) (*model.Subscription, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.subs[id]; ok {
		return s, nil
	}
	return nil, model.ErrSubscriptionNotFound
}

func (r *memSubRepo) GetActiveByUserID(userID uuid.UUID) (*model.Subscription, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.subs {
		if s.UserID == userID && s.Status == model.SubscriptionStatusActive {
			return s, nil
		}
	}
	return nil, model.ErrSubscriptionNotFound
}

func (r *memSubRepo) DeductTokens(subID uuid.UUID, amount int64) error {
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

func (r *memSubRepo) DeductTokensToZero(subID uuid.UUID, amount int64) (int64, error) {
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

func (r *memSubRepo) RefundTokens(subID uuid.UUID, amount int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.subs[subID]
	if !ok {
		return model.ErrSubscriptionNotFound
	}
	s.TokenBalance += amount
	return nil
}

func (r *memSubRepo) SetTokenBalance(subID uuid.UUID, balance int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.subs[subID]
	if !ok {
		return model.ErrSubscriptionNotFound
	}
	s.TokenBalance = balance
	return nil
}

// TokenBalanceOps implements service.TokenBalanceOps for memSubRepo.

func (r *memSubRepo) Deduct(ctx context.Context, subID uuid.UUID, amount int64) error {
	return r.DeductTokens(subID, amount)
}

func (r *memSubRepo) Refund(ctx context.Context, subID uuid.UUID, amount int64) error {
	return r.RefundTokens(subID, amount)
}

func (r *memSubRepo) DeductToZero(ctx context.Context, subID uuid.UUID, amount int64) (int64, error) {
	return r.DeductTokensToZero(subID, amount)
}

func (r *memSubRepo) ExpireOverdue() (int64, error) {
	return 0, nil
}

func (r *memSubRepo) ListRefreshCandidates(limit int) ([]repository.SubscriptionRefreshCandidate, error) {
	return nil, nil
}

func (r *memSubRepo) RefreshByIDs(items []repository.SubscriptionRefreshItem) (int64, error) {
	return 0, nil
}

func (r *memSubRepo) ExtendActivePeriodEnd(userID uuid.UUID, newPeriodEnd time.Time) (int64, *model.Subscription, error) {
	return 0, nil, nil
}

func (r *memSubRepo) CancelByUserID(userID uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.subs {
		if s.UserID == userID && s.Status == model.SubscriptionStatusActive {
			s.Status = model.SubscriptionStatusCancelled
		}
	}
	return nil
}

func (r *memSubRepo) SumActiveTokenBalance() (int64, error) {
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

func (r *memSubRepo) CountActive() (int64, error) {
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

func (r *memSubRepo) ListExpiredUserIDs() ([]uuid.UUID, error) {
	return nil, nil
}

func (r *memSubRepo) Update(sub *model.Subscription) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.subs[sub.ID] = sub
	return nil
}

func (r *memSubRepo) DB() *gorm.DB { return nil }

// --- memProviderRepo ---

type memProviderRepo struct {
	mu        sync.Mutex
	providers map[uuid.UUID]*model.Provider
}

func newMemProviderRepo() *memProviderRepo {
	return &memProviderRepo{providers: make(map[uuid.UUID]*model.Provider)}
}

func (r *memProviderRepo) Create(p *model.Provider) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	r.providers[p.ID] = p
	return nil
}

func (r *memProviderRepo) GetByID(id uuid.UUID) (*model.Provider, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.providers[id]; ok {
		return p, nil
	}
	return nil, model.ErrProviderNotFound
}

func (r *memProviderRepo) SelectBest(providerType string) (*model.Provider, error) {
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

func (r *memProviderRepo) IncrementUsedQuota(providerID uuid.UUID, amount int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.providers[providerID]
	if !ok {
		return model.ErrProviderNotFound
	}
	p.UsedQuota += amount
	return nil
}

func (r *memProviderRepo) IncrementUsedQuotaAndCheckExhaustion(providerID uuid.UUID, amount int64) (bool, error) {
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

func (r *memProviderRepo) MarkExhausted(providerID uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.providers[providerID]
	if !ok {
		return model.ErrProviderNotFound
	}
	p.Status = model.ProviderStatusExhausted
	return nil
}

func (r *memProviderRepo) List() ([]model.Provider, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var result []model.Provider
	for _, p := range r.providers {
		result = append(result, *p)
	}
	return result, nil
}

func (r *memProviderRepo) Update(p *model.Provider) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.providers[p.ID] = p
	return nil
}

func (r *memProviderRepo) SelectBestForModel(modelName string) (*model.Provider, error) {
	candidates, err := r.SelectCandidatesForModel(modelName)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, model.ErrProviderUnavailable
	}
	return &candidates[0], nil
}

func (r *memProviderRepo) SelectCandidatesForModel(modelName string) ([]model.Provider, error) {
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

func (r *memProviderRepo) SelectCandidates(providerType string) ([]model.Provider, error) {
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

func (r *memProviderRepo) UpdateStatus(id uuid.UUID, status string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.providers[id]; ok {
		p.Status = status
		return nil
	}
	return model.ErrProviderNotFound
}

func (r *memProviderRepo) UpdateHeartbeat(id uuid.UUID) error { return nil }

func (r *memProviderRepo) Delete(id uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.providers, id)
	return nil
}

func (r *memProviderRepo) FindByBaseURL(baseURL string) (*model.Provider, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.providers {
		if p.BaseURL == baseURL {
			return p, nil
		}
	}
	return nil, nil
}

func (r *memProviderRepo) ListByRegistrationSource(source string) ([]model.Provider, error) {
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

func (r *memProviderRepo) ListForHealthCheck(source string) ([]model.Provider, error) {
	return r.ListByRegistrationSource(source)
}

func (r *memProviderRepo) CountActive() (int64, error) {
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

// --- memApiKeyRepo ---

type memApiKeyRepo struct {
	mu   sync.Mutex
	keys map[uuid.UUID]*model.ApiKey
}

func newMemApiKeyRepo() *memApiKeyRepo {
	return &memApiKeyRepo{keys: make(map[uuid.UUID]*model.ApiKey)}
}

func (r *memApiKeyRepo) Create(key *model.ApiKey) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if key.ID == uuid.Nil {
		key.ID = uuid.New()
	}
	r.keys[key.ID] = key
	return nil
}

func (r *memApiKeyRepo) GetByID(id uuid.UUID) (*model.ApiKey, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if k, ok := r.keys[id]; ok {
		return k, nil
	}
	return nil, model.ErrApiKeyNotFound
}

func (r *memApiKeyRepo) GetByHash(hash string) (*model.ApiKey, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range r.keys {
		if k.KeyHash == hash && k.IsActive {
			return k, nil
		}
	}
	return nil, model.ErrApiKeyNotFound
}

func (r *memApiKeyRepo) DeactivateByID(id uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if k, ok := r.keys[id]; ok {
		k.IsActive = false
		return nil
	}
	return model.ErrApiKeyNotFound
}

func (r *memApiKeyRepo) DeactivateAllForUser(userID uuid.UUID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range r.keys {
		if k.UserID == userID && k.IsActive {
			k.IsActive = false
		}
	}
	return nil
}

func (r *memApiKeyRepo) ListAll(offset, limit int, search string) ([]model.ApiKey, int64, error) {
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

func (r *memApiKeyRepo) ListByUserID(userID uuid.UUID) ([]model.ApiKey, error) {
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

func (r *memApiKeyRepo) CountActive() (int64, error) {
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

func (r *memApiKeyRepo) DB() *gorm.DB { return nil }

func (r *memApiKeyRepo) ListAllWithUsers(offset, limit int, search string, status string) ([]repository.ApiKeyWithUserRow, int64, error) {
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

// --- memUsageRepo ---

type memUsageRepo struct {
	mu   sync.Mutex
	logs []model.UsageLog
}

func newMemUsageRepo() *memUsageRepo {
	return &memUsageRepo{}
}

func (r *memUsageRepo) Create(log *model.UsageLog) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.logs = append(r.logs, *log)
	return nil
}

func (r *memUsageRepo) BatchCreate(logs []model.UsageLog) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.logs = append(r.logs, logs...)
	return nil
}

func (r *memUsageRepo) CountRequestsBetween(start, end time.Time) (int64, error) {
	return 0, nil
}

func (r *memUsageRepo) SumTokensSince(since time.Time) (int64, error)         { return 0, nil }
func (r *memUsageRepo) CountRequestsSince(since time.Time) (int64, error)     { return 0, nil }
func (r *memUsageRepo) SumTokensBetween(start, end time.Time) (int64, error)  { return 0, nil }
func (r *memUsageRepo) SumAllConsumedTokens() (int64, error)                  { return 0, nil }
func (r *memUsageRepo) SumConsumedTokensSince(since time.Time) (int64, error) { return 0, nil }

func (r *memUsageRepo) DailyTrend(start, end time.Time) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}

func (r *memUsageRepo) ModelDistribution(start, end time.Time) ([]repository.ModelDistPoint, error) {
	return nil, nil
}
func (r *memUsageRepo) ModelDailyDistribution(start, end time.Time) ([]repository.ModelDailyDistPoint, error) {
	return nil, nil
}

func (r *memUsageRepo) UserDailyUsage(userID uuid.UUID, days int) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}

func (r *memUsageRepo) UserTotalUsage(userID uuid.UUID, since time.Time) (int64, int64, error) {
	return 0, 0, nil
}
func (r *memUsageRepo) ListUserUsageLogs(
	userID uuid.UUID,
	start time.Time,
	end time.Time,
	offset int,
	limit int,
) ([]repository.UserUsageLogRecord, int64, repository.UserUsageLogSummary, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	filtered := make([]model.UsageLog, 0)
	var totalTokens int64
	for _, log := range r.logs {
		if log.UserID != userID {
			continue
		}
		if log.CreatedAt.Before(start) || !log.CreatedAt.Before(end) {
			continue
		}
		filtered = append(filtered, log)
		totalTokens += int64(log.TotalTokens)
	}

	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].CreatedAt.After(filtered[j].CreatedAt)
	})

	total := int64(len(filtered))
	if offset > len(filtered) {
		offset = len(filtered)
	}
	endIndex := offset + limit
	if endIndex > len(filtered) {
		endIndex = len(filtered)
	}

	items := make([]repository.UserUsageLogRecord, 0, endIndex-offset)
	for _, log := range filtered[offset:endIndex] {
		items = append(items, repository.UserUsageLogRecord{
			CreatedAt:        log.CreatedAt,
			Model:            log.Model,
			PromptTokens:     log.PromptTokens,
			CompletionTokens: log.CompletionTokens,
			TotalTokens:      log.TotalTokens,
			RequestID:        log.RequestID,
			StatusCode:       log.StatusCode,
			LatencyMs:        log.LatencyMs,
			Source:           log.Source,
		})
	}

	return items, total, repository.UserUsageLogSummary{
		TotalRequests: total,
		TotalTokens:   totalTokens,
	}, nil
}
func (r *memUsageRepo) SubscriptionModelUsage(subscriptionID uuid.UUID) ([]repository.ModelDistPoint, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	grouped := map[string]repository.ModelDistPoint{}
	for _, log := range r.logs {
		if log.SubscriptionID != subscriptionID {
			continue
		}
		point := grouped[log.Model]
		point.Model = log.Model
		point.Tokens += int64(log.TotalTokens)
		point.Requests++
		grouped[log.Model] = point
	}

	results := make([]repository.ModelDistPoint, 0, len(grouped))
	for _, point := range grouped {
		results = append(results, point)
	}
	return results, nil
}

func (r *memUsageRepo) TopUsersByTokens(since time.Time, limit int) ([]repository.UserUsagePoint, error) {
	return nil, nil
}

func (r *memUsageRepo) ProviderRequestCount(providerID uuid.UUID) (int64, error)    { return 0, nil }
func (r *memUsageRepo) ProviderLastUsedAt(providerID uuid.UUID) (*time.Time, error) { return nil, nil }
