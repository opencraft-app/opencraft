package handler

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/crypto"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

type countingProxyUsageRepo struct {
	createCalls int
	batchCalls  int
	logs        []model.UsageLog
}

type proxyUsageRoundTripper func(*http.Request) (*http.Response, error)

func (fn proxyUsageRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func (m *countingProxyUsageRepo) Create(log *model.UsageLog) error {
	m.createCalls++
	m.logs = append(m.logs, *log)
	return nil
}

func (m *countingProxyUsageRepo) BatchCreate(logs []model.UsageLog) error {
	m.batchCalls++
	m.logs = append(m.logs, logs...)
	return nil
}

func (m *countingProxyUsageRepo) SumTokensSince(time.Time) (int64, error)              { return 0, nil }
func (m *countingProxyUsageRepo) CountRequestsSince(time.Time) (int64, error)          { return 0, nil }
func (m *countingProxyUsageRepo) SumTokensBetween(time.Time, time.Time) (int64, error) { return 0, nil }
func (m *countingProxyUsageRepo) CountRequestsBetween(time.Time, time.Time) (int64, error) {
	return 0, nil
}
func (m *countingProxyUsageRepo) SumAllConsumedTokens() (int64, error)            { return 0, nil }
func (m *countingProxyUsageRepo) SumConsumedTokensSince(time.Time) (int64, error) { return 0, nil }
func (m *countingProxyUsageRepo) DailyTrend(time.Time, time.Time) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}
func (m *countingProxyUsageRepo) ModelDistribution(time.Time, time.Time) ([]repository.ModelDistPoint, error) {
	return nil, nil
}
func (m *countingProxyUsageRepo) ModelDailyDistribution(time.Time, time.Time) ([]repository.ModelDailyDistPoint, error) {
	return nil, nil
}
func (m *countingProxyUsageRepo) UserDailyUsage(uuid.UUID, int) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}
func (m *countingProxyUsageRepo) UserTotalUsage(uuid.UUID, time.Time) (int64, int64, error) {
	return 0, 0, nil
}
func (m *countingProxyUsageRepo) ListUserUsageLogs(
	uuid.UUID,
	time.Time,
	time.Time,
	int,
	int,
) ([]repository.UserUsageLogRecord, int64, repository.UserUsageLogSummary, error) {
	return nil, 0, repository.UserUsageLogSummary{}, nil
}
func (m *countingProxyUsageRepo) SubscriptionModelUsage(uuid.UUID) ([]repository.ModelDistPoint, error) {
	return nil, nil
}
func (m *countingProxyUsageRepo) TopUsersByTokens(time.Time, int) ([]repository.UserUsagePoint, error) {
	return nil, nil
}
func (m *countingProxyUsageRepo) ProviderRequestCount(uuid.UUID) (int64, error) { return 0, nil }
func (m *countingProxyUsageRepo) ProviderLastUsedAt(uuid.UUID) (*time.Time, error) {
	return nil, nil
}

type proxyUsageSinkSubRepo struct {
	balance int64
}

func (m *proxyUsageSinkSubRepo) Create(*model.Subscription) error               { return nil }
func (m *proxyUsageSinkSubRepo) GetByID(uuid.UUID) (*model.Subscription, error) { return nil, nil }
func (m *proxyUsageSinkSubRepo) GetActiveByUserID(uuid.UUID) (*model.Subscription, error) {
	return nil, nil
}
func (m *proxyUsageSinkSubRepo) DeductTokens(uuid.UUID, int64) error { return nil }
func (m *proxyUsageSinkSubRepo) DeductTokensToZero(_ uuid.UUID, amount int64) (int64, error) {
	return amount, nil
}
func (m *proxyUsageSinkSubRepo) RefundTokens(uuid.UUID, int64) error      { return nil }
func (m *proxyUsageSinkSubRepo) SetTokenBalance(uuid.UUID, int64) error   { return nil }
func (m *proxyUsageSinkSubRepo) ExpireOverdue() (int64, error)            { return 0, nil }
func (m *proxyUsageSinkSubRepo) CancelByUserID(uuid.UUID) error           { return nil }
func (m *proxyUsageSinkSubRepo) CountActive() (int64, error)              { return 0, nil }
func (m *proxyUsageSinkSubRepo) SumActiveTokenBalance() (int64, error)    { return 0, nil }
func (m *proxyUsageSinkSubRepo) ListExpiredUserIDs() ([]uuid.UUID, error) { return nil, nil }
func (m *proxyUsageSinkSubRepo) Update(*model.Subscription) error         { return nil }
func (m *proxyUsageSinkSubRepo) ListRefreshCandidates(limit int) ([]repository.SubscriptionRefreshCandidate, error) {
	return nil, nil
}
func (m *proxyUsageSinkSubRepo) RefreshByIDs(items []repository.SubscriptionRefreshItem) (int64, error) {
	return 0, nil
}
func (m *proxyUsageSinkSubRepo) ExtendActivePeriodEnd(userID uuid.UUID, newPeriodEnd time.Time) (int64, *model.Subscription, error) {
	return 0, nil, nil
}
func (m *proxyUsageSinkSubRepo) DB() *gorm.DB                             { return nil }

type proxyUsageSinkTokenBalanceOps struct{ subRepo *proxyUsageSinkSubRepo }

func (m *proxyUsageSinkTokenBalanceOps) Deduct(context.Context, uuid.UUID, int64) error { return nil }
func (m *proxyUsageSinkTokenBalanceOps) Refund(context.Context, uuid.UUID, int64) error { return nil }
func (m *proxyUsageSinkTokenBalanceOps) DeductToZero(context.Context, uuid.UUID, int64) (int64, error) {
	return 0, nil
}

type proxyUsageSinkProvRepo struct {
	provider *model.Provider
}

func (m *proxyUsageSinkProvRepo) Create(*model.Provider) error               { return nil }
func (m *proxyUsageSinkProvRepo) GetByID(uuid.UUID) (*model.Provider, error) { return m.provider, nil }
func (m *proxyUsageSinkProvRepo) SelectBest(string) (*model.Provider, error) { return m.provider, nil }
func (m *proxyUsageSinkProvRepo) SelectBestForModel(string) (*model.Provider, error) {
	return m.provider, nil
}
func (m *proxyUsageSinkProvRepo) SelectCandidatesForModel(string) ([]model.Provider, error) {
	return []model.Provider{*m.provider}, nil
}
func (m *proxyUsageSinkProvRepo) SelectCandidates(string) ([]model.Provider, error) {
	return []model.Provider{*m.provider}, nil
}
func (m *proxyUsageSinkProvRepo) IncrementUsedQuota(uuid.UUID, int64) error { return nil }
func (m *proxyUsageSinkProvRepo) MarkExhausted(uuid.UUID) error             { return nil }
func (m *proxyUsageSinkProvRepo) IncrementUsedQuotaAndCheckExhaustion(uuid.UUID, int64) (bool, error) {
	return false, nil
}
func (m *proxyUsageSinkProvRepo) List() ([]model.Provider, error) {
	return []model.Provider{*m.provider}, nil
}
func (m *proxyUsageSinkProvRepo) Update(*model.Provider) error                  { return nil }
func (m *proxyUsageSinkProvRepo) UpdateStatus(uuid.UUID, string) error          { return nil }
func (m *proxyUsageSinkProvRepo) UpdateHeartbeat(uuid.UUID) error               { return nil }
func (m *proxyUsageSinkProvRepo) Delete(uuid.UUID) error                        { return nil }
func (m *proxyUsageSinkProvRepo) FindByBaseURL(string) (*model.Provider, error) { return nil, nil }
func (m *proxyUsageSinkProvRepo) ListByRegistrationSource(string) ([]model.Provider, error) {
	return nil, nil
}
func (m *proxyUsageSinkProvRepo) ListForHealthCheck(string) ([]model.Provider, error) {
	return nil, nil
}
func (m *proxyUsageSinkProvRepo) CountActive() (int64, error) { return 1, nil }

type proxyUsageSinkCircuitBreaker struct{}

func (m *proxyUsageSinkCircuitBreaker) IsOpen(uuid.UUID) bool                 { return false }
func (m *proxyUsageSinkCircuitBreaker) RecordSuccess(uuid.UUID) string        { return "" }
func (m *proxyUsageSinkCircuitBreaker) RecordFailure(uuid.UUID) (string, int) { return "", 0 }

func TestProxy_UsageSinkBatchesLogsInsteadOfDirectCreate(t *testing.T) {
	gin.SetMode(gin.TestMode)

	encryptedKey, err := crypto.Encrypt("test-api-key", testEncryptionKey)
	if err != nil {
		t.Fatalf("failed to encrypt test key: %v", err)
	}

	subRepo := &proxyUsageSinkSubRepo{balance: 100000}
	provRepo := &proxyUsageSinkProvRepo{
		provider: &model.Provider{
			ID:           uuid.New(),
			Name:         "test-provider",
			ProviderType: "openai",
			APIKey:       encryptedKey,
			BaseURL:      "https://provider.test",
			TotalQuota:   1000000,
			UsedQuota:    0,
			Status:       "active",
		},
	}
	usageRepo := &countingProxyUsageRepo{}
	billingSvc := service.NewBillingService(&proxyUsageSinkTokenBalanceOps{subRepo: subRepo}, provRepo, usageRepo, 4096)
	providerSvc := service.NewProviderService(provRepo, nil, testEncryptionKey)
	configStore := &service.RuntimeConfigStore{}
	configStore.SetForTest(service.RoutingConfig{
		FailureThreshold:  5,
		CooldownDurationS: 30,
		DefaultModel:      "gpt-4",
	})

	httpClient := &http.Client{
		Transport: proxyUsageRoundTripper(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body: io.NopCloser(strings.NewReader(
					`{"id":"chatcmpl-123","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"Hello!"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
				)),
			}, nil
		}),
		Timeout: 10 * time.Second,
	}

	proxyHandler := NewProxyHandler(
		billingSvc,
		providerSvc,
		"http://portkey.test",
		&proxyUsageSinkCircuitBreaker{},
		configStore,
		nil,
		httpClient,
		nil,
		nil,
		service.GatewayConfig{},
	)
	sink := service.NewUsageBatchWriter(usageRepo, 16, 8, time.Hour)
	proxyHandler.SetUsageSink(sink)

	user := &model.User{ID: uuid.New(), PhoneMasked: "138****8000", PhoneHash: "testhash", Status: "active"}
	sub := &model.Subscription{
		ID:           uuid.New(),
		UserID:       user.ID,
		Status:       "active",
		TokenBalance: 100000,
		PeriodEnd:    time.Now().Add(30 * 24 * time.Hour),
	}
	plan := &model.Plan{
		MonthlyTokens: 100000,
		RateLimits:    datatypes.JSON([]byte(`[{"window":"1m","max_requests":60,"label":"每分钟"},{"window":"1d","max_requests":1000,"label":"每天"}]`)),
		AllowedModels: datatypes.JSON([]byte(`["gpt-4","gpt-3.5-turbo"]`)),
	}

	r := gin.New()
	r.Use(func(c *gin.Context) {
		middleware.SetUserContext(c, user, sub, plan)
		c.Set("request_id", "req-usage-sink")
		c.Next()
	})
	r.POST("/v1/chat/completions", proxyHandler.ChatCompletions)

	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body=%s", rec.Code, rec.Body.String())
	}

	time.Sleep(50 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := sink.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown usage sink: %v", err)
	}

	if usageRepo.createCalls != 0 {
		t.Fatalf("expected 0 direct Create calls, got %d", usageRepo.createCalls)
	}
	if usageRepo.batchCalls != 1 {
		t.Fatalf("expected 1 BatchCreate call, got %d", usageRepo.batchCalls)
	}
	if len(usageRepo.logs) != 1 {
		t.Fatalf("expected 1 usage log, got %d", len(usageRepo.logs))
	}
	if usageRepo.logs[0].RequestID != "req-usage-sink" {
		t.Fatalf("unexpected request id: %s", usageRepo.logs[0].RequestID)
	}
}
