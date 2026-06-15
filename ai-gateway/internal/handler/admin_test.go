package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// --- Mock repos for admin tests ---

type adminMockUserRepo struct {
	users          []model.User
	nextID         uuid.UUID
	lastListStatus string
}

func (m *adminMockUserRepo) Create(user *model.User) error {
	if m.nextID != uuid.Nil {
		user.ID = m.nextID
	} else {
		user.ID = uuid.New()
	}
	user.CreatedAt = time.Now()
	user.UpdatedAt = time.Now()
	m.users = append(m.users, *user)
	return nil
}

func (m *adminMockUserRepo) GetByID(id uuid.UUID) (*model.User, error) {
	for i := range m.users {
		if m.users[i].ID == id {
			return &m.users[i], nil
		}
	}
	return nil, model.ErrUserNotFound
}

func (m *adminMockUserRepo) GetByPhoneHash(phoneHash string) (*model.User, error) {
	for i := range m.users {
		if m.users[i].PhoneHash == phoneHash {
			return &m.users[i], nil
		}
	}
	return nil, model.ErrUserNotFound
}

func (m *adminMockUserRepo) GetByUserID(uid string) (*model.User, error) {
	for i := range m.users {
		if m.users[i].UserID == uid {
			return &m.users[i], nil
		}
	}
	return nil, model.ErrUserNotFound
}

func (m *adminMockUserRepo) Update(user *model.User) error {
	for i := range m.users {
		if m.users[i].ID == user.ID {
			m.users[i] = *user
			return nil
		}
	}
	return model.ErrUserNotFound
}

func (m *adminMockUserRepo) SoftDelete(id uuid.UUID) error {
	for i := range m.users {
		if m.users[i].ID == id {
			m.users[i].Status = model.UserStatusDeleted
			return nil
		}
	}
	return model.ErrUserNotFound
}

func (m *adminMockUserRepo) CountByStatus(status string) (int64, error) {
	var count int64
	for _, u := range m.users {
		if u.Status == status {
			count++
		}
	}
	return count, nil
}

func (m *adminMockUserRepo) List(offset, limit int, search string, phoneHash string) ([]model.User, int64, error) {
	total := int64(len(m.users))
	end := offset + limit
	if end > len(m.users) {
		end = len(m.users)
	}
	if offset >= len(m.users) {
		return []model.User{}, total, nil
	}
	return m.users[offset:end], total, nil
}

func (m *adminMockUserRepo) CountAll() (int64, error) {
	return int64(len(m.users)), nil
}

func (m *adminMockUserRepo) DB() *gorm.DB { return nil }

func (m *adminMockUserRepo) ListWithActiveSubscription(offset, limit int, search string, status string) ([]repository.UserWithSubRow, int64, error) {
	m.lastListStatus = status
	filtered := make([]model.User, 0, len(m.users))
	for _, user := range m.users {
		if status != "" && user.Status != status {
			continue
		}
		filtered = append(filtered, user)
	}
	total := int64(len(filtered))
	end := offset + limit
	if end > len(filtered) {
		end = len(filtered)
	}
	if offset >= len(filtered) {
		return []repository.UserWithSubRow{}, total, nil
	}
	result := make([]repository.UserWithSubRow, end-offset)
	for i := range result {
		row := repository.UserWithSubRow{User: filtered[offset+i]}
		if row.User.UserID == "usr_unlimited" {
			subID := uuid.New()
			row.SubID = subID
			row.SubStatus = model.SubscriptionStatusActive
			row.SubTokenBalance = 0
			monthly := int64(0)
			row.PlanMonthlyTokens = &monthly
			row.PlanName = "Unlimited"
		}
		result[i] = row
	}
	return result, total, nil
}

type adminMockPlanRepo struct {
	plans []model.Plan
}

func (m *adminMockPlanRepo) Create(plan *model.Plan) error {
	plan.ID = uuid.New()
	plan.CreatedAt = time.Now()
	m.plans = append(m.plans, *plan)
	return nil
}

func (m *adminMockPlanRepo) GetByID(id uuid.UUID) (*model.Plan, error) {
	for i := range m.plans {
		if m.plans[i].ID == id {
			return &m.plans[i], nil
		}
	}
	return nil, model.ErrPlanNotFound
}

func (m *adminMockPlanRepo) GetByName(name string) (*model.Plan, error) {
	for i := range m.plans {
		if m.plans[i].Name == name {
			return &m.plans[i], nil
		}
	}
	return nil, model.ErrPlanNotFound
}

func (m *adminMockPlanRepo) List(onlyActive bool) ([]model.Plan, error) {
	if !onlyActive {
		return m.plans, nil
	}
	var result []model.Plan
	for _, p := range m.plans {
		if p.IsActive {
			result = append(result, p)
		}
	}
	return result, nil
}

func (m *adminMockPlanRepo) Update(plan *model.Plan) error {
	for i := range m.plans {
		if m.plans[i].ID == plan.ID {
			m.plans[i] = *plan
			return nil
		}
	}
	return model.ErrPlanNotFound
}

func (m *adminMockPlanRepo) DB() *gorm.DB { return nil }

type adminMockSubRepo struct {
	subs []model.Subscription
}

func (m *adminMockSubRepo) Create(sub *model.Subscription) error {
	sub.ID = uuid.New()
	sub.CreatedAt = time.Now()
	sub.UpdatedAt = time.Now()
	m.subs = append(m.subs, *sub)
	return nil
}

func (m *adminMockSubRepo) GetByID(id uuid.UUID) (*model.Subscription, error) {
	for i := range m.subs {
		if m.subs[i].ID == id {
			return &m.subs[i], nil
		}
	}
	return nil, model.ErrSubscriptionNotFound
}

func (m *adminMockSubRepo) GetActiveByUserID(userID uuid.UUID) (*model.Subscription, error) {
	for i := range m.subs {
		if m.subs[i].UserID == userID && m.subs[i].Status == model.SubscriptionStatusActive {
			return &m.subs[i], nil
		}
	}
	return nil, model.ErrSubscriptionNotFound
}

func (m *adminMockSubRepo) DeductTokens(subID uuid.UUID, amount int64) error { return nil }
func (m *adminMockSubRepo) DeductTokensToZero(subID uuid.UUID, amount int64) (int64, error) {
	return amount, nil
}
func (m *adminMockSubRepo) RefundTokens(subID uuid.UUID, amount int64) error     { return nil }
func (m *adminMockSubRepo) SetTokenBalance(subID uuid.UUID, balance int64) error { return nil }
func (m *adminMockSubRepo) ExpireOverdue() (int64, error)                        { return 0, nil }
func (m *adminMockSubRepo) ListExpiredUserIDs() ([]uuid.UUID, error)             { return nil, nil }

func (m *adminMockSubRepo) CancelByUserID(userID uuid.UUID) error {
	for i := range m.subs {
		if m.subs[i].UserID == userID && m.subs[i].Status == model.SubscriptionStatusActive {
			m.subs[i].Status = model.SubscriptionStatusCancelled
		}
	}
	return nil
}

func (m *adminMockSubRepo) Update(sub *model.Subscription) error { return nil }

func (m *adminMockSubRepo) SumActiveTokenBalance() (int64, error) {
	var total int64
	for _, s := range m.subs {
		if s.Status == model.SubscriptionStatusActive {
			total += s.TokenBalance
		}
	}
	return total, nil
}

func (m *adminMockSubRepo) CountActive() (int64, error) {
	var count int64
	for _, s := range m.subs {
		if s.Status == model.SubscriptionStatusActive {
			count++
		}
	}
	return count, nil
}

func (m *adminMockSubRepo) DB() *gorm.DB { return nil }

func (m *adminMockSubRepo) ListRefreshCandidates(limit int) ([]repository.SubscriptionRefreshCandidate, error) {
	return nil, nil
}

func (m *adminMockSubRepo) RefreshByIDs(items []repository.SubscriptionRefreshItem) (int64, error) {
	return 0, nil
}

func (m *adminMockSubRepo) ExtendActivePeriodEnd(userID uuid.UUID, newPeriodEnd time.Time) (int64, *model.Subscription, error) {
	return 0, nil, nil
}

type adminMockProvRepo struct {
	providers []model.Provider
}

func (m *adminMockProvRepo) Create(p *model.Provider) error {
	p.ID = uuid.New()
	p.CreatedAt = time.Now()
	m.providers = append(m.providers, *p)
	return nil
}

func (m *adminMockProvRepo) GetByID(id uuid.UUID) (*model.Provider, error) {
	for i := range m.providers {
		if m.providers[i].ID == id {
			provider := m.providers[i]
			return &provider, nil
		}
	}
	return nil, model.ErrProviderNotFound
}

func (m *adminMockProvRepo) SelectBest(providerType string) (*model.Provider, error) {
	return nil, model.ErrProviderUnavailable
}

func (m *adminMockProvRepo) IncrementUsedQuota(id uuid.UUID, amount int64) error { return nil }
func (m *adminMockProvRepo) IncrementUsedQuotaAndCheckExhaustion(id uuid.UUID, amount int64) (bool, error) {
	return false, nil
}
func (m *adminMockProvRepo) MarkExhausted(id uuid.UUID) error { return nil }

func (m *adminMockProvRepo) List() ([]model.Provider, error) {
	return m.providers, nil
}

func (m *adminMockProvRepo) Update(p *model.Provider) error {
	for i := range m.providers {
		if m.providers[i].ID == p.ID {
			m.providers[i] = *p
			return nil
		}
	}
	return model.ErrProviderNotFound
}

func (m *adminMockProvRepo) SelectBestForModel(modelName string) (*model.Provider, error) {
	candidates, err := m.SelectCandidatesForModel(modelName)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, model.ErrProviderUnavailable
	}
	return &candidates[0], nil
}

func (m *adminMockProvRepo) SelectCandidatesForModel(modelName string) ([]model.Provider, error) {
	var result []model.Provider
	for _, p := range m.providers {
		if p.Status != model.ProviderStatusActive || p.UsedQuota >= p.TotalQuota {
			continue
		}
		var models []string
		if err := json.Unmarshal([]byte(p.SupportedModels), &models); err != nil {
			continue
		}
		for _, supportedModel := range models {
			if supportedModel == modelName {
				result = append(result, p)
				break
			}
		}
	}
	return result, nil
}

func (m *adminMockProvRepo) SelectCandidates(providerType string) ([]model.Provider, error) {
	var result []model.Provider
	for _, p := range m.providers {
		if p.ProviderType == providerType && p.Status == model.ProviderStatusActive {
			result = append(result, p)
		}
	}
	return result, nil
}

func (m *adminMockProvRepo) UpdateStatus(id uuid.UUID, status string) error { return nil }
func (m *adminMockProvRepo) UpdateHeartbeat(id uuid.UUID) error             { return nil }
func (m *adminMockProvRepo) Delete(id uuid.UUID) error                      { return nil }
func (m *adminMockProvRepo) FindByBaseURL(baseURL string) (*model.Provider, error) {
	return nil, nil
}
func (m *adminMockProvRepo) ListByRegistrationSource(source string) ([]model.Provider, error) {
	return nil, nil
}

func (m *adminMockProvRepo) ListForHealthCheck(source string) ([]model.Provider, error) {
	return nil, nil
}

func (m *adminMockProvRepo) CountActive() (int64, error) {
	var count int64
	for _, p := range m.providers {
		if p.Status == model.ProviderStatusActive {
			count++
		}
	}
	return count, nil
}

type adminMockKeyRepo struct {
	keys           []model.ApiKey
	lastListSearch string
	lastListStatus string
}

func (m *adminMockKeyRepo) Create(key *model.ApiKey) error {
	key.ID = uuid.New()
	key.CreatedAt = time.Now()
	m.keys = append(m.keys, *key)
	return nil
}

func (m *adminMockKeyRepo) GetByID(id uuid.UUID) (*model.ApiKey, error) {
	for i := range m.keys {
		if m.keys[i].ID == id {
			return &m.keys[i], nil
		}
	}
	return nil, model.ErrApiKeyNotFound
}

func (m *adminMockKeyRepo) GetByHash(hash string) (*model.ApiKey, error) {
	for i := range m.keys {
		if m.keys[i].KeyHash == hash {
			return &m.keys[i], nil
		}
	}
	return nil, model.ErrApiKeyNotFound
}

func (m *adminMockKeyRepo) DeactivateByID(id uuid.UUID) error {
	for i := range m.keys {
		if m.keys[i].ID == id {
			m.keys[i].IsActive = false
			return nil
		}
	}
	return nil
}

func (m *adminMockKeyRepo) DeactivateAllForUser(userID uuid.UUID) error { return nil }

func (m *adminMockKeyRepo) ListAll(offset, limit int, search string) ([]model.ApiKey, int64, error) {
	total := int64(len(m.keys))
	end := offset + limit
	if end > len(m.keys) {
		end = len(m.keys)
	}
	if offset >= len(m.keys) {
		return []model.ApiKey{}, total, nil
	}
	return m.keys[offset:end], total, nil
}

func (m *adminMockKeyRepo) ListByUserID(userID uuid.UUID) ([]model.ApiKey, error) {
	var result []model.ApiKey
	for _, k := range m.keys {
		if k.UserID == userID {
			result = append(result, k)
		}
	}
	return result, nil
}

func (m *adminMockKeyRepo) CountActive() (int64, error) {
	var count int64
	for _, k := range m.keys {
		if k.IsActive {
			count++
		}
	}
	return count, nil
}

func (m *adminMockKeyRepo) DB() *gorm.DB { return nil }

func (m *adminMockKeyRepo) ListAllWithUsers(offset, limit int, search string, status string) ([]repository.ApiKeyWithUserRow, int64, error) {
	m.lastListSearch = search
	m.lastListStatus = status

	filtered := make([]model.ApiKey, 0, len(m.keys))
	for _, key := range m.keys {
		if status == "active" && !key.IsActive {
			continue
		}
		if status == "revoked" && key.IsActive {
			continue
		}
		filtered = append(filtered, key)
	}

	total := int64(len(filtered))
	end := offset + limit
	if end > len(filtered) {
		end = len(filtered)
	}
	if offset >= len(filtered) {
		return []repository.ApiKeyWithUserRow{}, total, nil
	}
	result := make([]repository.ApiKeyWithUserRow, end-offset)
	for i := range result {
		result[i] = repository.ApiKeyWithUserRow{ApiKey: filtered[offset+i]}
	}
	return result, total, nil
}

// --- Setup helper ---

type adminMockUsageRepo struct{}

func (m *adminMockUsageRepo) Create(log *model.UsageLog) error                         { return nil }
func (m *adminMockUsageRepo) BatchCreate(logs []model.UsageLog) error                  { return nil }
func (m *adminMockUsageRepo) SumTokensSince(since time.Time) (int64, error)            { return 0, nil }
func (m *adminMockUsageRepo) CountRequestsSince(since time.Time) (int64, error)        { return 0, nil }
func (m *adminMockUsageRepo) SumTokensBetween(start, end time.Time) (int64, error)     { return 0, nil }
func (m *adminMockUsageRepo) CountRequestsBetween(start, end time.Time) (int64, error) { return 0, nil }
func (m *adminMockUsageRepo) SumAllConsumedTokens() (int64, error)                     { return 0, nil }
func (m *adminMockUsageRepo) SumConsumedTokensSince(since time.Time) (int64, error)    { return 0, nil }
func (m *adminMockUsageRepo) DailyTrend(start, end time.Time) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}
func (m *adminMockUsageRepo) ModelDistribution(start, end time.Time) ([]repository.ModelDistPoint, error) {
	return nil, nil
}
func (m *adminMockUsageRepo) ModelDailyDistribution(start, end time.Time) ([]repository.ModelDailyDistPoint, error) {
	return nil, nil
}
func (m *adminMockUsageRepo) UserDailyUsage(userID uuid.UUID, days int) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}
func (m *adminMockUsageRepo) UserTotalUsage(userID uuid.UUID, since time.Time) (int64, int64, error) {
	return 0, 0, nil
}
func (m *adminMockUsageRepo) ListUserUsageLogs(
	userID uuid.UUID,
	start time.Time,
	end time.Time,
	offset int,
	limit int,
) ([]repository.UserUsageLogRecord, int64, repository.UserUsageLogSummary, error) {
	return nil, 0, repository.UserUsageLogSummary{}, nil
}
func (m *adminMockUsageRepo) SubscriptionModelUsage(uuid.UUID) ([]repository.ModelDistPoint, error) {
	return nil, nil
}
func (m *adminMockUsageRepo) TopUsersByTokens(since time.Time, limit int) ([]repository.UserUsagePoint, error) {
	return nil, nil
}
func (m *adminMockUsageRepo) ProviderRequestCount(providerID uuid.UUID) (int64, error) { return 0, nil }
func (m *adminMockUsageRepo) ProviderLastUsedAt(providerID uuid.UUID) (*time.Time, error) {
	return nil, nil
}

type configurableAdminMockUsageRepo struct {
	adminMockUsageRepo
	sumTokensBetweenResult     []int64
	countRequestsBetweenResult []int64
	userTotalTokens            int64
	userTotalRequests          int64
	userDailyUsage             []repository.DailyTrendPoint
	userUsageLogItems          []repository.UserUsageLogRecord
	userUsageLogTotal          int64
	userUsageLogSummary        repository.UserUsageLogSummary
	topUsers                   []repository.UserUsagePoint
	dailyTrend                 []repository.DailyTrendPoint
	modelDistribution          []repository.ModelDistPoint
	modelDailyDistribution     []repository.ModelDailyDistPoint
}

func (m *configurableAdminMockUsageRepo) SumTokensBetween(start, end time.Time) (int64, error) {
	if len(m.sumTokensBetweenResult) == 0 {
		return 0, nil
	}
	result := m.sumTokensBetweenResult[0]
	m.sumTokensBetweenResult = m.sumTokensBetweenResult[1:]
	return result, nil
}

func (m *configurableAdminMockUsageRepo) CountRequestsBetween(start, end time.Time) (int64, error) {
	if len(m.countRequestsBetweenResult) == 0 {
		return 0, nil
	}
	result := m.countRequestsBetweenResult[0]
	m.countRequestsBetweenResult = m.countRequestsBetweenResult[1:]
	return result, nil
}

func (m *configurableAdminMockUsageRepo) DailyTrend(start, end time.Time) ([]repository.DailyTrendPoint, error) {
	return m.dailyTrend, nil
}

func (m *configurableAdminMockUsageRepo) ModelDistribution(start, end time.Time) ([]repository.ModelDistPoint, error) {
	return m.modelDistribution, nil
}

func (m *configurableAdminMockUsageRepo) ModelDailyDistribution(start, end time.Time) ([]repository.ModelDailyDistPoint, error) {
	return m.modelDailyDistribution, nil
}

func (m *configurableAdminMockUsageRepo) UserDailyUsage(userID uuid.UUID, days int) ([]repository.DailyTrendPoint, error) {
	return m.userDailyUsage, nil
}

func (m *configurableAdminMockUsageRepo) UserTotalUsage(userID uuid.UUID, since time.Time) (int64, int64, error) {
	return m.userTotalTokens, m.userTotalRequests, nil
}

func (m *configurableAdminMockUsageRepo) ListUserUsageLogs(
	userID uuid.UUID,
	start time.Time,
	end time.Time,
	offset int,
	limit int,
) ([]repository.UserUsageLogRecord, int64, repository.UserUsageLogSummary, error) {
	return m.userUsageLogItems, m.userUsageLogTotal, m.userUsageLogSummary, nil
}

func (m *configurableAdminMockUsageRepo) TopUsersByTokens(since time.Time, limit int) ([]repository.UserUsagePoint, error) {
	return m.topUsers, nil
}

func setupAdminTest(t *testing.T) (*gin.Engine, *AdminHandler) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	r, adminHandler, _, _ := setupAdminTestWithRepos(t)
	return r, adminHandler
}

func setupAdminTestWithRepos(t *testing.T) (*gin.Engine, *AdminHandler, *adminMockUserRepo, *adminMockKeyRepo) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	userRepo := &adminMockUserRepo{}
	planRepo := &adminMockPlanRepo{}
	subRepo := &adminMockSubRepo{}
	provRepo := &adminMockProvRepo{}
	keyRepo := &adminMockKeyRepo{}
	usageRepo := &adminMockUsageRepo{}

	keySvc := service.NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)
	userSvc := service.NewUserService(userRepo, keySvc, testEncryptionKey)
	planSvc := service.NewPlanService(planRepo)
	subSvc := service.NewSubscriptionService(subRepo, planRepo, keySvc)
	providerSvc := service.NewProviderService(provRepo, nil, testEncryptionKey)
	provisionSvc := service.NewProvisionService(userSvc, subSvc, keySvc, planRepo)

	adminHandler := NewAdminHandler(userSvc, planSvc, subSvc, providerSvc, keySvc, provisionSvc, usageRepo)

	r := gin.New()
	return r, adminHandler, userRepo, keyRepo
}

func setupAdminTestWithKeyRepo(t *testing.T) (*gin.Engine, *AdminHandler, *adminMockKeyRepo) {
	t.Helper()
	r, adminHandler, _, keyRepo := setupAdminTestWithRepos(t)
	return r, adminHandler, keyRepo
}

func setupAdminTestWithUsageRepo(t *testing.T, usageRepo repository.UsageRepo) (*gin.Engine, *AdminHandler) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	userRepo := &adminMockUserRepo{}
	planRepo := &adminMockPlanRepo{}
	subRepo := &adminMockSubRepo{}
	provRepo := &adminMockProvRepo{}
	keyRepo := &adminMockKeyRepo{}

	keySvc := service.NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)
	userSvc := service.NewUserService(userRepo, keySvc, testEncryptionKey)
	planSvc := service.NewPlanService(planRepo)
	subSvc := service.NewSubscriptionService(subRepo, planRepo, keySvc)
	providerSvc := service.NewProviderService(provRepo, nil, testEncryptionKey)
	provisionSvc := service.NewProvisionService(userSvc, subSvc, keySvc, planRepo)

	adminHandler := NewAdminHandler(userSvc, planSvc, subSvc, providerSvc, keySvc, provisionSvc, usageRepo)

	r := gin.New()
	return r, adminHandler
}

// seedPlan creates a plan in the planRepo used by the admin handler.
// It returns the plan ID.
func seedPlan(t *testing.T, r *gin.Engine, h *AdminHandler) uuid.UUID {
	t.Helper()
	r.POST("/api/admin/plans", h.CreatePlan)

	body := `{"name":"basic","monthly_tokens":100000,"rate_limits":[{"window":"1m","max_requests":60,"label":"每分钟"}],"price_cents":999,"allowed_models":["gpt-4"]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/plans", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Logf("seedPlan failed: %d - %s", w.Code, w.Body.String())
	}
	var resp model.Plan
	json.Unmarshal(w.Body.Bytes(), &resp)
	return resp.ID
}

// --- Tests ---

func TestAdminRevokeApiKeyDeactivatesExistingKey(t *testing.T) {
	r, h, keyRepo := setupAdminTestWithKeyRepo(t)
	keyID := uuid.New()
	keyRepo.keys = append(keyRepo.keys, model.ApiKey{
		ID:        keyID,
		UserID:    uuid.New(),
		KeyHash:   "hash-revoke",
		KeyPrefix: "sk-revoke",
		Name:      "revoke me",
		IsActive:  true,
		CreatedAt: time.Now(),
	})
	r.DELETE("/api/admin/api-keys/:id", h.RevokeApiKey)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/admin/api-keys/"+keyID.String(), nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	stored, err := keyRepo.GetByID(keyID)
	if err != nil {
		t.Fatalf("get key: %v", err)
	}
	if stored.IsActive {
		t.Fatal("expected key to be deactivated")
	}
}

func TestAdminRevokeApiKeyRejectsUnknownKey(t *testing.T) {
	r, h := setupAdminTest(t)
	r.DELETE("/api/admin/api-keys/:id", h.RevokeApiKey)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/admin/api-keys/"+uuid.NewString(), nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestAdminProvision_Success(t *testing.T) {
	r, h := setupAdminTest(t)

	// First create a plan
	planID := seedPlan(t, r, h)

	r.POST("/api/admin/provision", h.Provision)

	body := `{"phone":"13800138000","user_id":"ext-001","nickname":"Test User","plan_id":"` + planID.String() + `"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/provision", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)

	if resp["user"] == nil {
		t.Error("expected user in response")
	}
	if resp["subscription"] == nil {
		t.Error("expected subscription in response")
	}
	if resp["api_key"] != nil {
		t.Errorf("expected api_key to be nil by default, got: %v", resp["api_key"])
	}
	if assigned, ok := resp["api_key_assigned"].(bool); !ok || assigned {
		t.Errorf("expected api_key_assigned=false, got: %v", resp["api_key_assigned"])
	}
}

func TestAdminUpdateProvider_IgnoresMaskedAPIKey(t *testing.T) {
	r, h := setupAdminTest(t)
	r.PUT("/api/admin/providers/:id", h.UpdateProvider)

	provider := &model.Provider{
		Name:         "Provider A",
		ProviderType: model.ProviderTypeOpenAI,
		APIKey:       "sk-original-secret",
		BaseURL:      "https://provider.example.com",
		TotalQuota:   1000,
		Status:       model.ProviderStatusActive,
	}
	if err := h.providerSvc.Create(provider); err != nil {
		t.Fatalf("create provider: %v", err)
	}

	body := `{"api_key":"sk-origi***cret","priority":7}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/admin/providers/"+provider.ID.String(), strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	stored, err := h.providerSvc.GetByID(provider.ID)
	if err != nil {
		t.Fatalf("get provider: %v", err)
	}
	if stored.Priority != 7 {
		t.Fatalf("expected priority to be updated, got %d", stored.Priority)
	}

	h.providerSvc.SetHTTPClient(&http.Client{
		Transport: validationRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			if got := req.Header.Get("Authorization"); got != "Bearer sk-original-secret" {
				t.Fatalf("expected preserved key to be used, got %q", got)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"data":[{"id":"gpt-4"}]}`)),
			}, nil
		}),
	})

	result, err := h.providerSvc.ValidateConnectivity(
		req.Context(),
		service.ProviderValidationInput{
			ProviderID:   provider.ID,
			ProviderType: model.ProviderTypeOpenAI,
			BaseURL:      "https://provider.example.com",
		},
	)
	if err != nil {
		t.Fatalf("validate connectivity with stored key: %v", err)
	}
	if !result.OK {
		t.Fatalf("expected stored key validation to succeed")
	}
}

func TestAdminStatsUsage_ReturnsInteractionsFields(t *testing.T) {
	usageRepo := &configurableAdminMockUsageRepo{
		sumTokensBetweenResult:     []int64{120, 80},
		countRequestsBetweenResult: []int64{9, 6},
	}
	r, h := setupAdminTestWithUsageRepo(t, usageRepo)
	r.GET("/api/admin/stats/usage", h.StatsUsage)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/stats/usage", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp["total_interactions"] != float64(9) {
		t.Fatalf("expected total_interactions 9, got %v", resp["total_interactions"])
	}
	if resp["interactions_change_pct"] != float64(50) {
		t.Fatalf("expected interactions_change_pct 50, got %v", resp["interactions_change_pct"])
	}
	if _, exists := resp["total_requests"]; exists {
		t.Fatalf("expected total_requests to be absent, got %v", resp["total_requests"])
	}
}

func TestAdminStatsUsageTrend_ReturnsModelDailyDistribution(t *testing.T) {
	usageRepo := &configurableAdminMockUsageRepo{
		dailyTrend: []repository.DailyTrendPoint{
			{Date: "2026-04-01", TotalTokens: 200, TotalInteractions: 5},
		},
		modelDistribution: []repository.ModelDistPoint{
			{Model: "deepseek-r1", Tokens: 120, Requests: 3},
		},
		modelDailyDistribution: []repository.ModelDailyDistPoint{
			{Date: "2026-04-01", Model: "deepseek-r1", Tokens: 120, Requests: 3},
			{Date: "2026-04-01", Model: "gpt-4o", Tokens: 80, Requests: 2},
		},
	}
	r, h := setupAdminTestWithUsageRepo(t, usageRepo)
	r.GET("/api/admin/stats/usage/trend", h.StatsUsageTrend)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/stats/usage/trend?period=30d&granularity=daily", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp["period"] != "30d" {
		t.Fatalf("expected period 30d, got %v", resp["period"])
	}
	items, ok := resp["model_daily_distribution"].([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("expected two model_daily_distribution rows, got %#v", resp["model_daily_distribution"])
	}
	first := items[0].(map[string]any)
	if first["date"] != "2026-04-01" || first["model"] != "deepseek-r1" || first["tokens"] != float64(120) || first["requests"] != float64(3) {
		t.Fatalf("unexpected first model_daily_distribution row: %#v", first)
	}
}

func TestAdminStatsTopUsers_ReturnsInteractionsFields(t *testing.T) {
	usageRepo := &configurableAdminMockUsageRepo{}
	r, h := setupAdminTestWithUsageRepo(t, usageRepo)

	user := &model.User{UserID: "usr_top", Nickname: "Top User", Status: model.UserStatusActive}
	if err := h.userSvc.Create(user); err != nil {
		t.Fatalf("create user: %v", err)
	}
	usageRepo.topUsers = []repository.UserUsagePoint{{
		UserID:            user.ID,
		TotalTokens:       321,
		TotalInteractions: 7,
	}}

	r.GET("/api/admin/stats/users/top", h.StatsTopUsers)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/stats/users/top", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	items, ok := resp["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("expected one item, got %v", resp["items"])
	}
	item := items[0].(map[string]any)
	if item["total_interactions"] != float64(7) {
		t.Fatalf("expected total_interactions 7, got %v", item["total_interactions"])
	}
	if _, exists := item["total_requests"]; exists {
		t.Fatalf("expected total_requests to be absent, got %v", item["total_requests"])
	}
}

func TestListAllApiKeys_RejectsInvalidStatusFilter(t *testing.T) {
	r, h := setupAdminTest(t)
	r.GET("/api/admin/api-keys", h.ListAllApiKeys)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/api-keys?status=disabled", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d, body: %s", w.Code, w.Body.String())
	}
}

func TestListAllApiKeys_PassesStatusFilterToService(t *testing.T) {
	r, h, keyRepo := setupAdminTestWithKeyRepo(t)
	r.GET("/api/admin/api-keys", h.ListAllApiKeys)

	keyRepo.keys = []model.ApiKey{
		{ID: uuid.New(), UserID: uuid.New(), KeyHash: "hash-active", KeyPrefix: "sk-active", Name: "active", IsActive: true},
		{ID: uuid.New(), UserID: uuid.New(), KeyHash: "hash-revoked", KeyPrefix: "sk-revoked", Name: "revoked", IsActive: false},
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/api-keys?status=active", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	if keyRepo.lastListStatus != "active" {
		t.Fatalf("expected status filter 'active', got %q", keyRepo.lastListStatus)
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if total, ok := resp["total"].(float64); !ok || total != 1 {
		t.Fatalf("expected total 1, got %v", resp["total"])
	}
}

func TestListApiKeys_RejectsInvalidStatusFilter(t *testing.T) {
	r, h := setupAdminTest(t)
	r.GET("/api/admin/users/:user_id/api-keys", h.ListApiKeys)

	user := &model.User{UserID: "usr_keys_filter", Nickname: "Key Filter User", Status: model.UserStatusActive}
	if err := h.userSvc.Create(user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/usr_keys_filter/api-keys?status=disabled", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d, body: %s", w.Code, w.Body.String())
	}
}

func TestListApiKeys_FiltersByStatus(t *testing.T) {
	r, h, _, keyRepo := setupAdminTestWithRepos(t)
	r.GET("/api/admin/users/:user_id/api-keys", h.ListApiKeys)

	user := &model.User{UserID: "usr_keys_filter", Nickname: "Key Filter User", Status: model.UserStatusActive}
	if err := h.userSvc.Create(user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	keyRepo.keys = []model.ApiKey{
		{ID: uuid.New(), UserID: user.ID, KeyHash: "hash-active", KeyPrefix: "sk-active", Name: "active", IsActive: true, CreatedAt: time.Now()},
		{ID: uuid.New(), UserID: user.ID, KeyHash: "hash-revoked", KeyPrefix: "sk-revoked", Name: "revoked", IsActive: false, CreatedAt: time.Now()},
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/usr_keys_filter/api-keys?status=active", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		APIKeys []struct {
			KeyPrefix string `json:"key_prefix"`
			IsActive  bool   `json:"is_active"`
		} `json:"api_keys"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(resp.APIKeys) != 1 {
		t.Fatalf("expected 1 api key, got %d", len(resp.APIKeys))
	}
	if !resp.APIKeys[0].IsActive || resp.APIKeys[0].KeyPrefix != "sk-active" {
		t.Fatalf("expected active key only, got %+v", resp.APIKeys[0])
	}
}

func TestListApiKeys_FiltersRevokedStatus(t *testing.T) {
	r, h, _, keyRepo := setupAdminTestWithRepos(t)
	r.GET("/api/admin/users/:user_id/api-keys", h.ListApiKeys)

	user := &model.User{UserID: "usr_keys_revoked", Nickname: "Key Revoked User", Status: model.UserStatusActive}
	if err := h.userSvc.Create(user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	keyRepo.keys = []model.ApiKey{
		{ID: uuid.New(), UserID: user.ID, KeyHash: "hash-active", KeyPrefix: "sk-active", Name: "active", IsActive: true, CreatedAt: time.Now()},
		{ID: uuid.New(), UserID: user.ID, KeyHash: "hash-revoked", KeyPrefix: "sk-revoked", Name: "revoked", IsActive: false, CreatedAt: time.Now()},
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/usr_keys_revoked/api-keys?status=revoked", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		APIKeys []struct {
			KeyPrefix string `json:"key_prefix"`
			IsActive  bool   `json:"is_active"`
		} `json:"api_keys"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(resp.APIKeys) != 1 {
		t.Fatalf("expected 1 api key, got %d", len(resp.APIKeys))
	}
	if resp.APIKeys[0].IsActive || resp.APIKeys[0].KeyPrefix != "sk-revoked" {
		t.Fatalf("expected revoked key only, got %+v", resp.APIKeys[0])
	}
}

func TestListApiKeys_WithoutStatusReturnsAllKeys(t *testing.T) {
	r, h, _, keyRepo := setupAdminTestWithRepos(t)
	r.GET("/api/admin/users/:user_id/api-keys", h.ListApiKeys)

	user := &model.User{UserID: "usr_keys_all", Nickname: "Key All User", Status: model.UserStatusActive}
	if err := h.userSvc.Create(user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	keyRepo.keys = []model.ApiKey{
		{ID: uuid.New(), UserID: user.ID, KeyHash: "hash-active", KeyPrefix: "sk-active", Name: "active", IsActive: true, CreatedAt: time.Now()},
		{ID: uuid.New(), UserID: user.ID, KeyHash: "hash-revoked", KeyPrefix: "sk-revoked", Name: "revoked", IsActive: false, CreatedAt: time.Now()},
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/usr_keys_all/api-keys", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		APIKeys []struct{} `json:"api_keys"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(resp.APIKeys) != 2 {
		t.Fatalf("expected 2 api keys, got %d", len(resp.APIKeys))
	}
}

func TestAdminGetUserUsage_ReturnsInteractionsFields(t *testing.T) {
	usageRepo := &configurableAdminMockUsageRepo{
		userTotalTokens:   210,
		userTotalRequests: 4,
		userDailyUsage: []repository.DailyTrendPoint{{
			Date:              "2026-04-01",
			TotalTokens:       210,
			TotalInteractions: 4,
		}},
	}
	r, h := setupAdminTestWithUsageRepo(t, usageRepo)

	user := &model.User{UserID: "usr_usage", Nickname: "Usage User", Status: model.UserStatusActive}
	if err := h.userSvc.Create(user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	r.GET("/api/admin/users/:user_id/usage", h.GetUserUsage)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/usr_usage/usage?days=7", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp["total_interactions"] != float64(4) {
		t.Fatalf("expected total_interactions 4, got %v", resp["total_interactions"])
	}
	if _, exists := resp["total_requests"]; exists {
		t.Fatalf("expected total_requests to be absent, got %v", resp["total_requests"])
	}

	daily, ok := resp["daily"].([]any)
	if !ok || len(daily) != 1 {
		t.Fatalf("expected one daily point, got %v", resp["daily"])
	}
	point := daily[0].(map[string]any)
	if point["total_interactions"] != float64(4) {
		t.Fatalf("expected daily total_interactions 4, got %v", point["total_interactions"])
	}
}

func TestAdminGetUserUsageLogs_DefaultRangeReturnsEvidenceList(t *testing.T) {
	usageRepo := &configurableAdminMockUsageRepo{
		userUsageLogItems: []repository.UserUsageLogRecord{
			{
				CreatedAt:        time.Date(2026, 4, 1, 8, 0, 0, 0, time.UTC),
				Model:            "gpt-4.1",
				PromptTokens:     120,
				CompletionTokens: 80,
				TotalTokens:      200,
				RequestID:        "req_123",
				StatusCode:       200,
				LatencyMs:        1532,
				Source:           "api",
			},
		},
		userUsageLogTotal: 1,
		userUsageLogSummary: repository.UserUsageLogSummary{
			TotalRequests: 1,
			TotalTokens:   200,
		},
	}
	r, h := setupAdminTestWithUsageRepo(t, usageRepo)

	user := &model.User{UserID: "usr_logs", Nickname: "Usage Logs User", Status: model.UserStatusActive}
	if err := h.userSvc.Create(user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	r.GET("/api/admin/users/:user_id/usage-logs", h.GetUserUsageLogs)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/usr_logs/usage-logs", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Items   []map[string]any `json:"items"`
		Total   float64          `json:"total"`
		Page    float64          `json:"page"`
		Summary struct {
			TotalRequests float64 `json:"total_requests"`
			TotalTokens   float64 `json:"total_tokens"`
		} `json:"summary"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp.Page != 1 || resp.Total != 1 {
		t.Fatalf("expected page=1 total=1, got page=%v total=%v", resp.Page, resp.Total)
	}
	if resp.Summary.TotalRequests != 1 || resp.Summary.TotalTokens != 200 {
		t.Fatalf("unexpected summary: %+v", resp.Summary)
	}
	if len(resp.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(resp.Items))
	}
	if _, exists := resp.Items[0]["multiplier"]; exists {
		t.Fatalf("expected multiplier field to be absent, got %+v", resp.Items[0])
	}
	if resp.Items[0]["request_id"] != "req_123" {
		t.Fatalf("expected request_id req_123, got %v", resp.Items[0]["request_id"])
	}
}

func TestAdminGetUserUsageLogs_InvalidRangeReturnsBadRequest(t *testing.T) {
	r, h := setupAdminTestWithUsageRepo(t, &configurableAdminMockUsageRepo{})

	user := &model.User{UserID: "usr_invalid_range", Nickname: "Invalid Range User", Status: model.UserStatusActive}
	if err := h.userSvc.Create(user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	r.GET("/api/admin/users/:user_id/usage-logs", h.GetUserUsageLogs)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/usr_invalid_range/usage-logs?range=90d", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d, body: %s", w.Code, w.Body.String())
	}
}

func TestAdminGetUserUsageLogs_CustomRangeRequiresStartAndEnd(t *testing.T) {
	r, h := setupAdminTestWithUsageRepo(t, &configurableAdminMockUsageRepo{})

	user := &model.User{UserID: "usr_custom_missing", Nickname: "Custom Missing User", Status: model.UserStatusActive}
	if err := h.userSvc.Create(user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	r.GET("/api/admin/users/:user_id/usage-logs", h.GetUserUsageLogs)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/usr_custom_missing/usage-logs?range=custom&start=2026-03-01", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d, body: %s", w.Code, w.Body.String())
	}
}

func TestAdminProvision_AssignAPIKeyWhenRequested(t *testing.T) {
	r, h := setupAdminTest(t)

	planID := seedPlan(t, r, h)

	r.POST("/api/admin/provision", h.Provision)

	body := `{"phone":"13800138000","user_id":"ext-001","nickname":"Test User","plan_id":"` + planID.String() + `","assign_api_key":true}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/provision", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)

	apiKey, ok := resp["api_key"].(string)
	if !ok || !strings.HasPrefix(apiKey, "sk-") {
		t.Errorf("expected api_key to start with 'sk-', got: %v", resp["api_key"])
	}
	if assigned, ok := resp["api_key_assigned"].(bool); !ok || !assigned {
		t.Errorf("expected api_key_assigned=true, got: %v", resp["api_key_assigned"])
	}
}

func TestAdminProvision_MissingFields(t *testing.T) {
	r, h := setupAdminTest(t)
	r.POST("/api/admin/provision", h.Provision)

	// Missing plan_id
	body := `{"phone":"13800138000","user_id":"ext-001"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/provision", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d, body: %s", w.Code, w.Body.String())
	}
}

func TestAdminCreateUser(t *testing.T) {
	r, h := setupAdminTest(t)
	r.POST("/api/admin/users", h.CreateUser)

	body := `{"phone":"13900139000","user_id":"usr_test_2","nickname":"New User"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/users", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp model.User
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.PhoneMasked != "139****9000" {
		t.Errorf("expected phone masked 139****9000, got %s", resp.PhoneMasked)
	}
	if resp.Status != model.UserStatusActive {
		t.Errorf("expected status active, got %s", resp.Status)
	}
}

func TestAdminListUsers(t *testing.T) {
	r, h := setupAdminTest(t)
	r.POST("/api/admin/users", h.CreateUser)
	r.GET("/api/admin/users", h.ListUsers)

	// Create a user first
	body := `{"phone":"13900139000","user_id":"usr_test_2"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/users", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	// List users
	w = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/admin/users?page=1&page_size=10", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["total"].(float64) != 1 {
		t.Errorf("expected total 1, got %v", resp["total"])
	}
}

func TestAdminListUsers_RejectsInvalidStatusFilter(t *testing.T) {
	r, h := setupAdminTest(t)
	r.GET("/api/admin/users", h.ListUsers)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users?status=disabled", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d, body: %s", w.Code, w.Body.String())
	}
}

func TestAdminListUsers_PassesStatusFilterAndUnlimitedFlag(t *testing.T) {
	r, h, userRepo, _ := setupAdminTestWithRepos(t)
	r.POST("/api/admin/users", h.CreateUser)
	r.GET("/api/admin/users", h.ListUsers)

	seedBodies := []string{
		`{"phone":"13900139000","user_id":"usr_active"}`,
		`{"phone":"13900139001","user_id":"usr_unlimited"}`,
	}
	for _, body := range seedBodies {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("seed user failed: %d body=%s", w.Code, w.Body.String())
		}
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users?status=active", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	items, ok := resp["items"].([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("expected 2 items, got %v", resp["items"])
	}
	foundUnlimited := false
	for _, raw := range items {
		item := raw.(map[string]any)
		if item["user_id"] == "usr_unlimited" {
			foundUnlimited = true
			if unlimited, ok := item["is_unlimited"].(bool); !ok || !unlimited {
				t.Fatalf("expected is_unlimited=true, got %v", item["is_unlimited"])
			}
		}
	}
	if !foundUnlimited {
		t.Fatalf("expected unlimited user in response")
	}
	if userRepo.lastListStatus != model.UserStatusActive {
		t.Fatalf("expected active status filter, got %q", userRepo.lastListStatus)
	}
}

func TestAdminStatsOverview(t *testing.T) {
	r, h := setupAdminTest(t)
	r.GET("/api/admin/stats/overview", h.StatsOverview)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/admin/stats/overview", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["total_users"] == nil {
		t.Error("expected total_users in response")
	}
	if resp["active_subscriptions"] == nil {
		t.Error("expected active_subscriptions in response")
	}
}

// Ensure the mock repos satisfy their interfaces at compile time.
var _ repository.UserRepo = (*adminMockUserRepo)(nil)
var _ repository.PlanRepo = (*adminMockPlanRepo)(nil)
var _ repository.SubscriptionRepo = (*adminMockSubRepo)(nil)
var _ repository.ProviderRepo = (*adminMockProvRepo)(nil)
var _ repository.ApiKeyRepo = (*adminMockKeyRepo)(nil)
