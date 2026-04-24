package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/handler"
	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/crypto"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/serverstate"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// mockProxyTokenBalanceOps wraps proxyMockSubRepo to implement service.TokenBalanceOps.
type mockProxyTokenBalanceOps struct {
	subRepo *proxyMockSubRepo
}

func (m *mockProxyTokenBalanceOps) Deduct(ctx context.Context, subID uuid.UUID, amount int64) error {
	return m.subRepo.DeductTokens(subID, amount)
}
func (m *mockProxyTokenBalanceOps) Refund(ctx context.Context, subID uuid.UUID, amount int64) error {
	return m.subRepo.RefundTokens(subID, amount)
}
func (m *mockProxyTokenBalanceOps) DeductToZero(ctx context.Context, subID uuid.UUID, amount int64) (int64, error) {
	return m.subRepo.DeductTokensToZero(subID, amount)
}

// mockCircuitBreaker implements CircuitBreakerOps for tests (always closed).
type mockCircuitBreaker struct{}

func (m *mockCircuitBreaker) IsOpen(providerID uuid.UUID) bool                 { return false }
func (m *mockCircuitBreaker) RecordSuccess(providerID uuid.UUID) string        { return "" }
func (m *mockCircuitBreaker) RecordFailure(providerID uuid.UUID) (string, int) { return "", 0 }

// testEncryptionKey is a 32-byte key used for tests.
var testEncryptionKey = []byte("01234567890123456789012345678901")

func setupProxyTest(t *testing.T, upstreamHandler http.HandlerFunc) (*gin.Engine, *httptest.Server) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	upstream := httptest.NewServer(upstreamHandler)
	t.Cleanup(upstream.Close)

	// Encrypt a test API key with the test encryption key
	encryptedKey, err := crypto.Encrypt("test-api-key", testEncryptionKey)
	if err != nil {
		t.Fatalf("failed to encrypt test key: %v", err)
	}

	subRepo := &proxyMockSubRepo{balance: 100000}
	provRepo := &proxyMockProvRepo{
		provider: &model.Provider{
			ID:           uuid.New(),
			Name:         "test-provider",
			ProviderType: "openai",
			APIKey:       encryptedKey,
			BaseURL:      upstream.URL,
			TotalQuota:   1000000,
			UsedQuota:    0,
			Status:       "active",
		},
	}
	usageRepo := &proxyMockUsageRepo{}

	billingSvc := service.NewBillingService(&mockProxyTokenBalanceOps{subRepo: subRepo}, provRepo, usageRepo, 4096)
	providerSvc := service.NewProviderService(provRepo, nil, testEncryptionKey)

	// 创建 RuntimeConfigStore（不依赖数据库）
	configStore := &service.RuntimeConfigStore{}
	configStore.SetForTest(service.RoutingConfig{
		FailureThreshold:  5,
		CooldownDurationS: 30,
		DefaultModel:      "gpt-4",
	})

	proxyHandler := handler.NewProxyHandler(
		billingSvc, providerSvc, upstream.URL, &mockCircuitBreaker{}, configStore, nil, &http.Client{Timeout: 10 * time.Second},
		nil, nil, service.GatewayConfig{},
	)

	user := &model.User{ID: uuid.New(), PhoneMasked: "138****8000", PhoneHash: "testhash", Status: "active"}
	sub := &model.Subscription{
		ID:           uuid.New(),
		UserID:       user.ID,
		Status:       "active",
		TokenBalance: 100000,
		PeriodEnd:    time.Now().Add(30 * 24 * time.Hour),
	}
	plan := &model.Plan{
		RateLimits:    datatypes.JSON([]byte(`[{"window":"1m","max_requests":60,"label":"每分钟"},{"window":"1d","max_requests":1000,"label":"每天"}]`)),
		AllowedModels: datatypes.JSON([]byte(`["gpt-4","gpt-3.5-turbo"]`)),
	}

	r := gin.New()
	// Inject user context
	r.Use(func(c *gin.Context) {
		middleware.SetUserContext(c, user, sub, plan)
		c.Set("request_id", uuid.New().String())
		c.Next()
	})
	r.POST("/v1/chat/completions", proxyHandler.ChatCompletions)
	r.GET("/v1/models", proxyHandler.Models)

	return r, upstream
}

func TestProxy_NonStreaming(t *testing.T) {
	upstreamResponse := `{"id":"chatcmpl-123","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"Hello!"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`

	r, _ := setupProxyTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, upstreamResponse)
	})

	body := `{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] != "chatcmpl-123" {
		t.Errorf("unexpected response id: %v", resp["id"])
	}
}

func TestProxy_UpstreamError(t *testing.T) {
	r, _ := setupProxyTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"error":{"message":"Internal server error"}}`)
	})

	body := `{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
}

func TestProxy_RejectsWhenInflightBudgetExceeded(t *testing.T) {
	gin.SetMode(gin.TestMode)

	encryptedKey, err := crypto.Encrypt("test-api-key", testEncryptionKey)
	if err != nil {
		t.Fatalf("failed to encrypt test key: %v", err)
	}

	subRepo := &proxyMockSubRepo{balance: 100000}
	provRepo := &proxyMockProvRepo{
		providers: []model.Provider{{
			ID:           uuid.New(),
			Name:         "test-provider",
			ProviderType: "openai",
			APIKey:       encryptedKey,
			BaseURL:      "http://example.com",
			TotalQuota:   1000000,
			Status:       model.ProviderStatusActive,
		}},
	}
	usageRepo := &proxyMockUsageRepo{}
	billingSvc := service.NewBillingService(&mockProxyTokenBalanceOps{subRepo: subRepo}, provRepo, usageRepo, 4096)
	providerSvc := service.NewProviderService(provRepo, nil, testEncryptionKey)
	configStore := &service.RuntimeConfigStore{}
	configStore.SetForTest(service.RoutingConfig{DefaultModel: "gpt-4"})

	budget := serverstate.NewInflightBudget(1)
	release, ok := budget.TryAcquire(1)
	if !ok {
		t.Fatal("expected pre-acquire to succeed")
	}
	defer release()

	proxyHandler := handler.NewProxyHandler(
		billingSvc, providerSvc, "http://example.com", &mockCircuitBreaker{}, configStore, nil,
		&http.Client{Timeout: 10 * time.Second}, budget, nil, service.GatewayConfig{OverloadStatusCode: http.StatusServiceUnavailable, NonStreamRequestWeight: 1, StreamRequestWeight: 3},
	)

	user := &model.User{ID: uuid.New(), Status: model.UserStatusActive}
	sub := &model.Subscription{ID: uuid.New(), UserID: user.ID, Status: "active", TokenBalance: 100000, PeriodEnd: time.Now().Add(24 * time.Hour)}
	plan := &model.Plan{
		AllowedModels: datatypes.JSON([]byte(`["gpt-4"]`)),
	}

	r := gin.New()
	r.Use(func(c *gin.Context) {
		middleware.SetUserContext(c, user, sub, plan)
		c.Next()
	})
	r.POST("/v1/chat/completions", proxyHandler.ChatCompletions)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected overload rejection, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "overload") {
		t.Fatalf("expected overload error body, got %s", w.Body.String())
	}
}

func TestProxy_Streaming(t *testing.T) {
	sseData := "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: {\"id\":\"chatcmpl-1\",\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\ndata: [DONE]\n\n"

	r, _ := setupProxyTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, sseData)
	})

	body := `{"model":"gpt-4","messages":[{"role":"user","content":"hi"}],"stream":true}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "chatcmpl-1") {
		t.Error("expected SSE data in response")
	}
}

func TestProxy_Models(t *testing.T) {
	r, _ := setupProxyTest(t, nil)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/models", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["object"] != "list" {
		t.Error("expected object 'list'")
	}
	data, ok := resp["data"].([]interface{})
	if !ok || len(data) != 2 {
		t.Errorf("expected 2 models, got %v", resp["data"])
	}
}

func TestProxy_MissingModel(t *testing.T) {
	var upstreamModel string
	r, _ := setupProxyTest(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		upstreamModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"id":"chatcmpl-auto","choices":[{"message":{"role":"assistant","content":"auto"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	})

	body := `{"messages":[{"role":"user","content":"hi"}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}
	if upstreamModel != "gpt-4" {
		t.Errorf("expected auto-selected model gpt-4, got %q", upstreamModel)
	}
}

func TestProxy_Provider429CooldownSkipsCandidateOnNextRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)

	encryptedKeyA, err := crypto.Encrypt("key-a", testEncryptionKey)
	if err != nil {
		t.Fatalf("encrypt key a: %v", err)
	}
	encryptedKeyB, err := crypto.Encrypt("key-b", testEncryptionKey)
	if err != nil {
		t.Fatalf("encrypt key b: %v", err)
	}

	providerA := model.Provider{
		ID:           uuid.New(),
		Name:         "provider-a",
		ProviderType: "openai",
		APIKey:       encryptedKeyA,
		BaseURL:      "https://provider-a.example.com",
		TotalQuota:   1000000,
		Status:       model.ProviderStatusActive,
	}
	providerB := model.Provider{
		ID:           uuid.New(),
		Name:         "provider-b",
		ProviderType: "openai",
		APIKey:       encryptedKeyB,
		BaseURL:      "https://provider-b.example.com",
		TotalQuota:   1000000,
		Status:       model.ProviderStatusActive,
	}

	subRepo := &proxyMockSubRepo{balance: 100000}
	provRepo := &proxyMockProvRepo{providers: []model.Provider{providerA, providerB}}
	usageRepo := &proxyMockUsageRepo{}
	billingSvc := service.NewBillingService(&mockProxyTokenBalanceOps{subRepo: subRepo}, provRepo, usageRepo, 4096)
	providerSvc := service.NewProviderService(provRepo, nil, testEncryptionKey)
	configStore := &service.RuntimeConfigStore{}
	configStore.SetForTest(service.RoutingConfig{
		DefaultModel:      "gpt-4",
		FailureThreshold:  5,
		CooldownDurationS: 30,
		Strategy: service.PortkeyStrategyConfig{
			Mode:             "fallback",
			OnStatusCodes:    []int{429, 500, 502, 503, 504},
			RetryAttempts:    3,
			RetryStatusCodes: []int{429, 503},
		},
	})

	cooldownStore := service.NewProviderCooldownStore(nil, service.ProviderCooldownConfig{
		Default429TTLS: 20,
		Max429TTLS:     60,
	})

	var targetCounts []int
	httpClient := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			var cfg handler.PortkeyConfig
			if err := json.Unmarshal([]byte(r.Header.Get("x-portkey-config")), &cfg); err != nil {
				t.Fatalf("unmarshal portkey config: %v", err)
			}
			targetCounts = append(targetCounts, len(cfg.Targets))

			resp := &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"id":"chatcmpl-456","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)),
			}
			resp.Header.Set("Content-Type", "application/json")
			if len(targetCounts) == 1 {
				resp.StatusCode = http.StatusTooManyRequests
				resp.Body = io.NopCloser(strings.NewReader(`{"error":{"message":"rate limited"}}`))
				resp.Header.Set("x-portkey-last-used-option-index", "0")
				resp.Header.Set("Retry-After", "9")
				return resp, nil
			}

			resp.Header.Set("x-portkey-last-used-option-index", "0")
			return resp, nil
		}),
	}

	proxyHandler := handler.NewProxyHandler(
		billingSvc, providerSvc, "http://portkey.example.com", &mockCircuitBreaker{}, configStore, nil,
		httpClient, nil, cooldownStore, service.GatewayConfig{OverloadStatusCode: http.StatusServiceUnavailable, NonStreamRequestWeight: 1, StreamRequestWeight: 3},
	)

	user := &model.User{ID: uuid.New(), Status: model.UserStatusActive}
	sub := &model.Subscription{ID: uuid.New(), UserID: user.ID, Status: "active", TokenBalance: 100000, PeriodEnd: time.Now().Add(24 * time.Hour)}
	plan := &model.Plan{AllowedModels: datatypes.JSON([]byte(`["gpt-4"]`))}

	r := gin.New()
	r.Use(func(c *gin.Context) {
		middleware.SetUserContext(c, user, sub, plan)
		c.Set("request_id", uuid.New().String())
		c.Next()
	})
	r.POST("/v1/chat/completions", proxyHandler.ChatCompletions)

	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)

		if i == 0 && w.Code != http.StatusOK {
			t.Fatalf("first request expected 200 after fallback, got %d body=%s", w.Code, w.Body.String())
		}
		if i == 1 && w.Code != http.StatusOK {
			t.Fatalf("second request expected 200, got %d body=%s", w.Code, w.Body.String())
		}
	}

	if want, got := []int{1, 1, 1}, targetCounts; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("expected target counts %v, got %v", want, got)
	}
}

// --- Mock repos for proxy tests ---

type proxyMockSubRepo struct {
	balance int64
}

func (m *proxyMockSubRepo) Create(sub *model.Subscription) error              { return nil }
func (m *proxyMockSubRepo) GetByID(id uuid.UUID) (*model.Subscription, error) { return nil, nil }
func (m *proxyMockSubRepo) GetActiveByUserID(userID uuid.UUID) (*model.Subscription, error) {
	return nil, nil
}
func (m *proxyMockSubRepo) DeductTokens(subID uuid.UUID, amount int64) error {
	if m.balance < amount {
		return model.ErrQuotaExceeded
	}
	m.balance -= amount
	return nil
}
func (m *proxyMockSubRepo) DeductTokensToZero(subID uuid.UUID, amount int64) (int64, error) {
	if m.balance <= 0 {
		return 0, nil
	}
	if m.balance > amount {
		m.balance -= amount
		return amount, nil
	}
	m.balance = 0
	return m.balance, nil
}
func (m *proxyMockSubRepo) RefundTokens(subID uuid.UUID, amount int64) error {
	m.balance += amount
	return nil
}
func (m *proxyMockSubRepo) SetTokenBalance(subID uuid.UUID, balance int64) error {
	m.balance = balance
	return nil
}
func (m *proxyMockSubRepo) ExpireOverdue() (int64, error)            { return 0, nil }
func (m *proxyMockSubRepo) ListExpiredUserIDs() ([]uuid.UUID, error) { return nil, nil }
func (m *proxyMockSubRepo) CancelByUserID(userID uuid.UUID) error    { return nil }
func (m *proxyMockSubRepo) Update(sub *model.Subscription) error     { return nil }
func (m *proxyMockSubRepo) CountActive() (int64, error)              { return 0, nil }
func (m *proxyMockSubRepo) SumActiveTokenBalance() (int64, error)    { return 0, nil }

func (m *proxyMockSubRepo) DB() *gorm.DB { return nil }

type proxyMockProvRepo struct {
	provider  *model.Provider
	providers []model.Provider
}

func (m *proxyMockProvRepo) Create(p *model.Provider) error { return nil }
func (m *proxyMockProvRepo) GetByID(id uuid.UUID) (*model.Provider, error) {
	if m.provider != nil {
		return m.provider, nil
	}
	for i := range m.providers {
		if m.providers[i].ID == id {
			return &m.providers[i], nil
		}
	}
	return nil, model.ErrProviderUnavailable
}
func (m *proxyMockProvRepo) SelectBest(providerType string) (*model.Provider, error) {
	if m.provider == nil {
		if len(m.providers) == 0 {
			return nil, model.ErrProviderUnavailable
		}
		return &m.providers[0], nil
	}
	return m.provider, nil
}
func (m *proxyMockProvRepo) SelectBestForModel(modelName string) (*model.Provider, error) {
	candidates, err := m.SelectCandidatesForModel(modelName)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, model.ErrProviderUnavailable
	}
	return &candidates[0], nil
}
func (m *proxyMockProvRepo) SelectCandidatesForModel(modelName string) ([]model.Provider, error) {
	if len(m.providers) > 0 {
		return append([]model.Provider(nil), m.providers...), nil
	}
	if m.provider == nil {
		return nil, model.ErrProviderUnavailable
	}
	return []model.Provider{*m.provider}, nil
}
func (m *proxyMockProvRepo) SelectCandidates(providerType string) ([]model.Provider, error) {
	if len(m.providers) > 0 {
		return append([]model.Provider(nil), m.providers...), nil
	}
	if m.provider == nil {
		return nil, model.ErrProviderUnavailable
	}
	return []model.Provider{*m.provider}, nil
}
func (m *proxyMockProvRepo) IncrementUsedQuota(id uuid.UUID, amount int64) error {
	if m.provider != nil {
		m.provider.UsedQuota += amount
		return nil
	}
	for i := range m.providers {
		if m.providers[i].ID == id {
			m.providers[i].UsedQuota += amount
			return nil
		}
	}
	return nil
}
func (m *proxyMockProvRepo) IncrementUsedQuotaAndCheckExhaustion(id uuid.UUID, amount int64) (bool, error) {
	if m.provider != nil {
		m.provider.UsedQuota += amount
		return false, nil
	}
	for i := range m.providers {
		if m.providers[i].ID == id {
			m.providers[i].UsedQuota += amount
			return false, nil
		}
	}
	return false, nil
}
func (m *proxyMockProvRepo) MarkExhausted(id uuid.UUID) error                      { return nil }
func (m *proxyMockProvRepo) List() ([]model.Provider, error)                       { return nil, nil }
func (m *proxyMockProvRepo) Update(p *model.Provider) error                        { return nil }
func (m *proxyMockProvRepo) UpdateStatus(id uuid.UUID, status string) error        { return nil }
func (m *proxyMockProvRepo) UpdateHeartbeat(id uuid.UUID) error                    { return nil }
func (m *proxyMockProvRepo) Delete(id uuid.UUID) error                             { return nil }
func (m *proxyMockProvRepo) FindByBaseURL(baseURL string) (*model.Provider, error) { return nil, nil }
func (m *proxyMockProvRepo) ListByRegistrationSource(source string) ([]model.Provider, error) {
	return nil, nil
}
func (m *proxyMockProvRepo) ListForHealthCheck(source string) ([]model.Provider, error) {
	return nil, nil
}
func (m *proxyMockProvRepo) CountActive() (int64, error) { return 0, nil }

type proxyMockUsageRepo struct{}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func (m *proxyMockUsageRepo) BatchCreate(logs []model.UsageLog) error                  { return nil }
func (m *proxyMockUsageRepo) Create(log *model.UsageLog) error                         { return nil }
func (m *proxyMockUsageRepo) SumTokensSince(since time.Time) (int64, error)            { return 0, nil }
func (m *proxyMockUsageRepo) CountRequestsSince(since time.Time) (int64, error)        { return 0, nil }
func (m *proxyMockUsageRepo) SumTokensBetween(start, end time.Time) (int64, error)     { return 0, nil }
func (m *proxyMockUsageRepo) CountRequestsBetween(start, end time.Time) (int64, error) { return 0, nil }
func (m *proxyMockUsageRepo) SumAllConsumedTokens() (int64, error)                     { return 0, nil }
func (m *proxyMockUsageRepo) SumConsumedTokensSince(since time.Time) (int64, error)    { return 0, nil }
func (m *proxyMockUsageRepo) DailyTrend(start, end time.Time) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}
func (m *proxyMockUsageRepo) ModelDistribution(start, end time.Time) ([]repository.ModelDistPoint, error) {
	return nil, nil
}
func (m *proxyMockUsageRepo) ModelDailyDistribution(start, end time.Time) ([]repository.ModelDailyDistPoint, error) {
	return nil, nil
}
func (m *proxyMockUsageRepo) UserDailyUsage(userID uuid.UUID, days int) ([]repository.DailyTrendPoint, error) {
	return nil, nil
}
func (m *proxyMockUsageRepo) UserTotalUsage(userID uuid.UUID, since time.Time) (int64, int64, error) {
	return 0, 0, nil
}
func (m *proxyMockUsageRepo) ListUserUsageLogs(
	uuid.UUID,
	time.Time,
	time.Time,
	int,
	int,
) ([]repository.UserUsageLogRecord, int64, repository.UserUsageLogSummary, error) {
	return nil, 0, repository.UserUsageLogSummary{}, nil
}
func (m *proxyMockUsageRepo) SubscriptionModelUsage(uuid.UUID) ([]repository.ModelDistPoint, error) {
	return nil, nil
}
func (m *proxyMockUsageRepo) TopUsersByTokens(time.Time, int) ([]repository.UserUsagePoint, error) {
	return nil, nil
}
func (m *proxyMockUsageRepo) ProviderRequestCount(providerID uuid.UUID) (int64, error) { return 0, nil }
func (m *proxyMockUsageRepo) ProviderLastUsedAt(providerID uuid.UUID) (*time.Time, error) {
	return nil, nil
}
