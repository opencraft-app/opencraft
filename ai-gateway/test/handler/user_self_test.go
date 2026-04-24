package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/handler"
	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type userSelfMockValidator struct {
	entries map[string]userSelfValidationEntry
}

type userSelfValidationEntry struct {
	key  *model.ApiKey
	user *model.User
	sub  *model.Subscription
	plan *model.Plan
	err  error
}

type userSelfMockUsageRepo struct {
	totalTokens   int64
	totalRequests int64
	totalErr      error
	modelUsage    []repository.ModelDistPoint
	modelUsageErr error
	lastSubID     uuid.UUID
}

func (m *userSelfMockValidator) Validate(plainKey string) (*model.ApiKey, *model.User, *model.Subscription, *model.Plan, error) {
	entry, ok := m.entries[plainKey]
	if !ok {
		return nil, nil, nil, nil, model.ErrInvalidApiKey
	}
	return entry.key, entry.user, entry.sub, entry.plan, entry.err
}

func (m *userSelfMockValidator) ValidateAllowMissingSubscription(plainKey string) (*model.ApiKey, *model.User, *model.Subscription, *model.Plan, error) {
	return m.Validate(plainKey)
}

func (m *userSelfMockUsageRepo) BatchCreate([]model.UsageLog) error { return nil }
func (m *userSelfMockUsageRepo) Create(*model.UsageLog) error       { return nil }
func (m *userSelfMockUsageRepo) SumTokensSince(time.Time) (int64, error) {
	return 0, nil
}
func (m *userSelfMockUsageRepo) CountRequestsSince(time.Time) (int64, error) {
	return 0, nil
}
func (m *userSelfMockUsageRepo) SumTokensBetween(time.Time, time.Time) (int64, error) {
	return 0, nil
}
func (m *userSelfMockUsageRepo) CountRequestsBetween(time.Time, time.Time) (int64, error) {
	return 0, nil
}
func (m *userSelfMockUsageRepo) SumAllConsumedTokens() (int64, error) { return 0, nil }
func (m *userSelfMockUsageRepo) SumConsumedTokensSince(time.Time) (int64, error) {
	return 0, nil
}
func (m *userSelfMockUsageRepo) DailyTrend(time.Time, time.Time) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}
func (m *userSelfMockUsageRepo) ModelDistribution(time.Time, time.Time) ([]repository.ModelDistPoint, error) {
	return nil, nil
}
func (m *userSelfMockUsageRepo) ModelDailyDistribution(time.Time, time.Time) ([]repository.ModelDailyDistPoint, error) {
	return nil, nil
}
func (m *userSelfMockUsageRepo) UserDailyUsage(uuid.UUID, int) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}
func (m *userSelfMockUsageRepo) UserTotalUsage(uuid.UUID, time.Time) (int64, int64, error) {
	return m.totalTokens, m.totalRequests, m.totalErr
}
func (m *userSelfMockUsageRepo) ListUserUsageLogs(
	uuid.UUID,
	time.Time,
	time.Time,
	int,
	int,
) ([]repository.UserUsageLogRecord, int64, repository.UserUsageLogSummary, error) {
	return nil, 0, repository.UserUsageLogSummary{}, nil
}
func (m *userSelfMockUsageRepo) SubscriptionModelUsage(subscriptionID uuid.UUID) ([]repository.ModelDistPoint, error) {
	m.lastSubID = subscriptionID
	return m.modelUsage, m.modelUsageErr
}
func (m *userSelfMockUsageRepo) TopUsersByTokens(time.Time, int) ([]repository.UserUsagePoint, error) {
	return nil, nil
}
func (m *userSelfMockUsageRepo) ProviderRequestCount(uuid.UUID) (int64, error) { return 0, nil }
func (m *userSelfMockUsageRepo) ProviderLastUsedAt(uuid.UUID) (*time.Time, error) {
	return nil, nil
}

func TestUserSelfHandler_TokenBalance(t *testing.T) {
	gin.SetMode(gin.TestMode)

	sub := &model.Subscription{
		ID:           uuid.New(),
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 123456,
		PeriodEnd:    time.Date(2026, 4, 26, 0, 0, 0, 0, time.UTC),
	}
	plan := &model.Plan{MonthlyTokens: 1000}

	r := gin.New()
	r.GET("/v1/me/token-balance", func(c *gin.Context) {
		middleware.SetUserContext(c, &model.User{ID: uuid.New()}, sub, plan)
		handler.NewUserSelfHandler(nil).TokenBalance(c)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/me/token-balance", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp["token_balance"] != float64(123456) {
		t.Errorf("expected token_balance 123456, got %v", resp["token_balance"])
	}
	if resp["status"] != model.SubscriptionStatusActive {
		t.Errorf("expected status active, got %v", resp["status"])
	}
	if resp["is_unlimited"] != false {
		t.Errorf("expected is_unlimited false, got %v", resp["is_unlimited"])
	}
	if resp["display_text"] != "123,456" {
		t.Errorf("expected display_text 123,456, got %v", resp["display_text"])
	}
	if resp["period_end"] == nil {
		t.Error("expected period_end to be present")
	}
}

func TestUserSelfHandler_TokenBalance_UnlimitedPlan(t *testing.T) {
	gin.SetMode(gin.TestMode)

	sub := &model.Subscription{
		ID:           uuid.New(),
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 0,
		PeriodEnd:    time.Date(2026, 4, 26, 0, 0, 0, 0, time.UTC),
	}
	plan := &model.Plan{MonthlyTokens: 0}

	r := gin.New()
	r.GET("/v1/me/token-balance", func(c *gin.Context) {
		middleware.SetUserContext(c, &model.User{ID: uuid.New()}, sub, plan)
		handler.NewUserSelfHandler(nil).TokenBalance(c)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/me/token-balance", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp["token_balance"] != nil {
		t.Errorf("expected token_balance nil, got %v", resp["token_balance"])
	}
	if resp["is_unlimited"] != true {
		t.Errorf("expected is_unlimited true, got %v", resp["is_unlimited"])
	}
	if resp["display_text"] != "无限额度" {
		t.Errorf("expected display_text 无限额度, got %v", resp["display_text"])
	}
}

func TestUserSelfHandler_TokenBalance_NoSubscription(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.GET("/v1/me/token-balance", func(c *gin.Context) {
		middleware.SetUserContext(c, &model.User{ID: uuid.New()}, nil, nil)
		handler.NewUserSelfHandler(nil).TokenBalance(c)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/me/token-balance", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp["token_balance"] != float64(0) {
		t.Errorf("expected token_balance 0, got %v", resp["token_balance"])
	}
	if resp["status"] != "inactive" {
		t.Errorf("expected status inactive, got %v", resp["status"])
	}
	if resp["period_end"] != nil {
		t.Errorf("expected period_end nil, got %v", resp["period_end"])
	}
	if resp["is_unlimited"] != false {
		t.Errorf("expected is_unlimited false, got %v", resp["is_unlimited"])
	}
	if resp["display_text"] != "0" {
		t.Errorf("expected display_text 0, got %v", resp["display_text"])
	}
}

func TestUserSelfHandler_TokenBalance_AuthVariants(t *testing.T) {
	gin.SetMode(gin.TestMode)

	user := &model.User{ID: uuid.New()}
	sub := &model.Subscription{
		ID:           uuid.New(),
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 123,
		PeriodEnd:    time.Now().Add(24 * time.Hour),
	}
	plan := &model.Plan{MonthlyTokens: 1000}
	validator := &userSelfMockValidator{
		entries: map[string]userSelfValidationEntry{
			"valid-key":  {key: &model.ApiKey{UserID: user.ID}, user: user, sub: sub, plan: plan},
			"no-sub-key": {key: &model.ApiKey{UserID: user.ID}, user: user},
		},
	}

	r := gin.New()
	v1 := r.Group("/v1")
	v1.Use(middleware.AuthAllowMissingSubscription(validator))
	v1.GET("/me/token-balance", handler.NewUserSelfHandler(nil).TokenBalance)

	tests := []struct {
		name       string
		path       string
		headerName string
		headerVal  string
		wantStatus int
	}{
		{
			name:       "bearer",
			path:       "/v1/me/token-balance",
			headerName: "Authorization",
			headerVal:  "Bearer valid-key",
			wantStatus: http.StatusOK,
		},
		{
			name:       "x-api-key",
			path:       "/v1/me/token-balance",
			headerName: "x-api-key",
			headerVal:  "valid-key",
			wantStatus: http.StatusOK,
		},
		{
			name:       "query-key",
			path:       "/v1/me/token-balance?key=valid-key",
			wantStatus: http.StatusOK,
		},
		{
			name:       "no-subscription-still-authenticated",
			path:       "/v1/me/token-balance",
			headerName: "Authorization",
			headerVal:  "Bearer no-sub-key",
			wantStatus: http.StatusOK,
		},
		{
			name:       "invalid-key",
			path:       "/v1/me/token-balance",
			headerName: "Authorization",
			headerVal:  "Bearer bad-key",
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			req := httptest.NewRequest("GET", tt.path, nil)
			if tt.headerName != "" {
				req.Header.Set(tt.headerName, tt.headerVal)
			}
			r.ServeHTTP(w, req)
			if w.Code != tt.wantStatus {
				t.Fatalf("expected %d, got %d, body: %s", tt.wantStatus, w.Code, w.Body.String())
			}
		})
	}
}

func TestUserSelfHandler_UsageSummary(t *testing.T) {
	gin.SetMode(gin.TestMode)

	user := &model.User{ID: uuid.New(), UserID: "usr_123"}
	sub := &model.Subscription{
		ID:           uuid.New(),
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 900,
		PeriodStart:  time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC),
		PeriodEnd:    time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC),
	}
	plan := &model.Plan{
		MonthlyTokens: 1000,
		PeriodValue:   1,
		PeriodUnit:    "months",
		TokenMultipliers: []byte(`{
			"gpt-4": 30
		}`),
	}
	usageRepo := &userSelfMockUsageRepo{
		totalTokens:   10,
		totalRequests: 2,
		modelUsage: []repository.ModelDistPoint{
			{Model: "gpt-4", Tokens: 10, Requests: 2},
		},
	}

	r := gin.New()
	r.GET("/v1/me/usage", func(c *gin.Context) {
		middleware.SetUserContext(c, user, sub, plan)
		handler.NewUserSelfHandler(usageRepo).Usage(c)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/me/usage?user_id=usr_123", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp["user_id"] != "usr_123" {
		t.Fatalf("expected user_id usr_123, got %v", resp["user_id"])
	}
	if usageRepo.lastSubID != sub.ID {
		t.Fatalf("expected usage query scoped by subscription %s, got %s", sub.ID, usageRepo.lastSubID)
	}
	if resp["plan_total_tokens"] != float64(1200) {
		t.Fatalf("expected plan_total_tokens 1200, got %v", resp["plan_total_tokens"])
	}
	if resp["used_tokens"] != float64(300) {
		t.Fatalf("expected used_tokens 300, got %v", resp["used_tokens"])
	}
	if resp["remaining_tokens"] != float64(900) {
		t.Fatalf("expected remaining_tokens 900, got %v", resp["remaining_tokens"])
	}
	if resp["total_requests"] != float64(2) {
		t.Fatalf("expected total_requests 2, got %v", resp["total_requests"])
	}
	if resp["status"] != model.SubscriptionStatusActive {
		t.Fatalf("expected status active, got %v", resp["status"])
	}
	if resp["is_unlimited"] != false {
		t.Fatalf("expected is_unlimited false, got %v", resp["is_unlimited"])
	}
}

func TestUserSelfHandler_UsageRequiresMatchingUserID(t *testing.T) {
	gin.SetMode(gin.TestMode)

	user := &model.User{ID: uuid.New(), UserID: "usr_self"}
	r := gin.New()
	r.GET("/v1/me/usage", func(c *gin.Context) {
		middleware.SetUserContext(c, user, nil, nil)
		handler.NewUserSelfHandler(&userSelfMockUsageRepo{}).Usage(c)
	})

	tests := []struct {
		name       string
		path       string
		wantStatus int
	}{
		{
			name:       "missing user_id",
			path:       "/v1/me/usage",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "mismatched user_id",
			path:       "/v1/me/usage?user_id=usr_other",
			wantStatus: http.StatusForbidden,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			req := httptest.NewRequest("GET", tt.path, nil)
			r.ServeHTTP(w, req)
			if w.Code != tt.wantStatus {
				t.Fatalf("expected %d, got %d, body: %s", tt.wantStatus, w.Code, w.Body.String())
			}
		})
	}
}
