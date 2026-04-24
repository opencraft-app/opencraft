package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/adapter"
	"git.woa.com/wisp/mono/ai-gateway/internal/config"
	"git.woa.com/wisp/mono/ai-gateway/internal/handler"
	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/crypto"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"gorm.io/datatypes"
)

var testEncryptionKey = []byte("01234567890123456789012345678901")

// testStarterPlanID 是集成测试中 starter 套餐的固定 UUID。
var testStarterPlanID = uuid.MustParse("00000000-0000-0000-0000-000000000001")

type integrationBootstrap struct {
	UserRepo *memUserRepo
	PlanRepo *memPlanRepo
	SubRepo  *memSubRepo
	User     *model.User
	Sub      *model.Subscription
	Plan     *model.Plan
	APIKey   string
	Redis    *redisclient.Client
	Upstream *httptest.Server
}

// setupIntegrationRouter builds a fully wired router with in-memory repos
// and a mock upstream LLM server. Returns (router, upstream server, api key, starter plan ID).
func setupIntegrationRouter(
	t *testing.T,
	upstreamHandler http.HandlerFunc,
	bootstrapFns ...func(*integrationBootstrap),
) (*gin.Engine, *httptest.Server, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	// Mock upstream LLM
	upstream := httptest.NewServer(upstreamHandler)
	t.Cleanup(upstream.Close)

	// Mock Redis
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	redisClient := redisclient.NewClientFromRedis(rdb)

	// In-memory repos
	userRepo := newMemUserRepo()
	planRepo := newMemPlanRepo()
	subRepo := newMemSubRepo()
	providerRepo := newMemProviderRepo()
	apiKeyRepo := newMemApiKeyRepo()
	usageRepo := newMemUsageRepo()

	// Seed data: plan
	plan := &model.Plan{
		ID:               testStarterPlanID,
		Name:             "starter",
		MonthlyTokens:    1000000,
		PeriodValue:      1,
		PeriodUnit:       "months",
		RateLimits:       datatypes.JSON([]byte(`[{"window":"1m","max_requests":60,"label":"每分钟"},{"window":"1d","max_requests":1000,"label":"每天"}]`)),
		IsActive:         true,
		TokenMultipliers: datatypes.JSON([]byte(`{"gpt-4":30,"gpt-3.5-turbo":1}`)),
		AllowedModels:    datatypes.JSON([]byte(`["gpt-4","gpt-3.5-turbo","claude-3-opus-20240229","gemini-pro"]`)),
	}
	planRepo.Create(plan)

	// Seed data: provider with encrypted key
	encryptedKey, _ := crypto.Encrypt("test-upstream-key", testEncryptionKey)
	provider := &model.Provider{
		ID:           uuid.New(),
		Name:         "test-openai",
		ProviderType: "openai",
		APIKey:       encryptedKey,
		BaseURL:      upstream.URL,
		TotalQuota:   10000000,
		UsedQuota:    0,
		Status:       model.ProviderStatusActive,
		Priority:     10,
	}
	providerRepo.Create(provider)

	// Services
	keySvc := service.NewApiKeyService(apiKeyRepo, userRepo, subRepo, planRepo, redisClient, 5*time.Minute)
	userSvc := service.NewUserService(userRepo, keySvc, testEncryptionKey)
	planSvc := service.NewPlanService(planRepo)
	subSvc := service.NewSubscriptionService(subRepo, planRepo, keySvc)
	providerSvc := service.NewProviderService(providerRepo, nil, testEncryptionKey)
	billingSvc := service.NewBillingService(subRepo, providerRepo, usageRepo, 4096)
	provisionSvc := service.NewProvisionService(userSvc, subSvc, keySvc, planRepo)

	// Provision a user to get an API key
	user, sub, plainKey, err := provisionSvc.Provision("ext-001", "13800138000", "Test User", plan.ID.String(), nil, true)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}
	if plainKey == nil {
		t.Fatal("expected provision to create api key for integration bootstrap")
	}
	fixture := &integrationBootstrap{
		UserRepo: userRepo,
		PlanRepo: planRepo,
		SubRepo:  subRepo,
		User:     user,
		Sub:      sub,
		Plan:     plan,
		APIKey:   *plainKey,
		Redis:    redisClient,
		Upstream: upstream,
	}
	for _, fn := range bootstrapFns {
		fn(fixture)
	}

	// Handlers
	configStore := &service.RuntimeConfigStore{}
	configStore.SetForTest(service.RoutingConfig{
		FailureThreshold:  5,
		CooldownDurationS: 30,
		DefaultModel:      "gpt-4",
	})
	cb := service.NewCircuitBreaker(configStore)
	httpClient := &http.Client{Timeout: 5 * time.Minute}
	proxyHandler := handler.NewProxyHandler(
		billingSvc, providerSvc, upstream.URL, cb, configStore, nil, httpClient,
		nil, nil, service.GatewayConfig{},
	)
	adminHandler := handler.NewAdminHandler(userSvc, planSvc, subSvc, providerSvc, keySvc, provisionSvc, usageRepo)
	healthHandler := handler.NewHealthHandler(nil, redisClient)
	userSelfHandler := handler.NewUserSelfHandler(usageRepo)

	cfg := &config.Config{
		Server: config.ServerConfig{
			AdminToken:       "admin-secret",
			AdminIPWhitelist: []string{},
		},
	}

	// Build router
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(middleware.RequestLogger())

	r.GET("/health", healthHandler.Health)

	v1 := r.Group("/v1")
	v1.Use(middleware.Auth(keySvc))
	v1.Use(middleware.RateLimiter(redisClient))
	{
		v1.GET("/models", proxyHandler.Models)
		v1.GET("/me", userSelfHandler.Me)

		proxy := v1.Group("")
		proxy.Use(middleware.BillingCheck())
		proxy.Use(middleware.ModelAuth())
		{
			proxy.POST("/chat/completions", proxyHandler.ChatCompletions)
			proxy.POST("/completions", proxyHandler.Completions)
		}

		// Anthropic Messages API（Claude Code 兼容）
		anthropic := v1.Group("")
		anthropic.Use(adapter.FormatAdapter())
		anthropic.Use(adapter.ResponseAdapter())
		anthropic.Use(middleware.BillingCheck())
		anthropic.Use(middleware.ModelAuth())
		{
			anthropic.POST("/messages", proxyHandler.ChatCompletions)
		}
	}

	v1Self := r.Group("/v1")
	v1Self.Use(middleware.AuthAllowMissingSubscription(keySvc))
	v1Self.Use(middleware.RateLimiter(redisClient))
	{
		v1Self.GET("/me/usage", userSelfHandler.Usage)
		v1Self.GET("/me/token-balance", userSelfHandler.TokenBalance)
	}

	// Gemini API（Gemini CLI 兼容）
	gemini := r.Group("/v1beta")
	gemini.Use(middleware.Auth(keySvc))
	gemini.Use(middleware.RateLimiter(redisClient))
	gemini.Use(adapter.FormatAdapter())
	gemini.Use(adapter.ResponseAdapter())
	gemini.Use(middleware.BillingCheck())
	gemini.Use(middleware.ModelAuth())
	{
		gemini.POST("/models/*path", proxyHandler.ChatCompletions)
	}

	admin := r.Group("/api/admin")
	admin.Use(middleware.AdminAuth(cfg.Server.AdminToken, cfg.Server.AdminIPWhitelist))
	{
		admin.POST("/provision", adminHandler.Provision)
		admin.GET("/users", adminHandler.ListUsers)
		admin.GET("/plans", adminHandler.ListPlans)
		admin.GET("/stats", adminHandler.StatsOverview)
	}

	return r, upstream, *plainKey
}

// TestIntegration_FullChatFlow tests the complete request flow:
// auth → rate limit → billing → model check → proxy → settle
func TestIntegration_FullChatFlow(t *testing.T) {
	upstreamResp := `{"id":"chatcmpl-test","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"Hello!"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`

	r, _, apiKey := setupIntegrationRouter(t, func(w http.ResponseWriter, r *http.Request) {
		// 新架构: API key 通过 x-portkey-config header 传递给 Portkey Gateway
		portkeyConfig := r.Header.Get("x-portkey-config")
		if portkeyConfig == "" {
			t.Error("upstream did not receive x-portkey-config header")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, upstreamResp)
	})

	body := `{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] != "chatcmpl-test" {
		t.Errorf("expected response id chatcmpl-test, got %v", resp["id"])
	}
}

// TestIntegration_UnauthorizedRequest tests that requests without API key are rejected.
func TestIntegration_UnauthorizedRequest(t *testing.T) {
	r, _, _ := setupIntegrationRouter(t, nil)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/models", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

// TestIntegration_ModelList tests that authenticated users can list allowed models.
func TestIntegration_ModelList(t *testing.T) {
	r, _, apiKey := setupIntegrationRouter(t, nil)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	data, ok := resp["data"].([]interface{})
	if !ok || len(data) != 4 {
		t.Errorf("expected 4 models, got %v", resp["data"])
	}
}

// TestIntegration_UserSelf tests GET /v1/me returns user info.
func TestIntegration_UserSelf(t *testing.T) {
	r, _, apiKey := setupIntegrationRouter(t, nil)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["user"] == nil {
		t.Error("expected user field in response")
	}
	if resp["subscription"] == nil {
		t.Error("expected subscription field in response")
	}
}

func TestIntegration_UserTokenBalance(t *testing.T) {
	r, _, apiKey := setupIntegrationRouter(t, nil)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/me/token-balance", nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)

	if resp["token_balance"] != float64(1000000) {
		t.Errorf("expected token_balance 1000000, got %v", resp["token_balance"])
	}
	if resp["status"] != model.SubscriptionStatusActive {
		t.Errorf("expected status %q, got %v", model.SubscriptionStatusActive, resp["status"])
	}
	if resp["is_unlimited"] != false {
		t.Errorf("expected is_unlimited false, got %v", resp["is_unlimited"])
	}
	if resp["display_text"] != "1,000,000" {
		t.Errorf("expected display_text 1,000,000, got %v", resp["display_text"])
	}
	if resp["period_end"] == nil {
		t.Error("expected period_end in response")
	}
}

func TestIntegration_UserTokenBalance_UnlimitedPlan(t *testing.T) {
	r, _, apiKey := setupIntegrationRouter(t, nil, func(f *integrationBootstrap) {
		f.Plan.MonthlyTokens = 0
		if err := f.PlanRepo.Update(f.Plan); err != nil {
			t.Fatalf("update plan: %v", err)
		}
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/me/token-balance", nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)

	if resp["token_balance"] != nil {
		t.Errorf("expected token_balance nil for unlimited plan, got %v", resp["token_balance"])
	}
	if resp["is_unlimited"] != true {
		t.Errorf("expected is_unlimited true, got %v", resp["is_unlimited"])
	}
	if resp["display_text"] != "无限额度" {
		t.Errorf("expected display_text 无限额度, got %v", resp["display_text"])
	}
}

func TestIntegration_UserTokenBalance_NoActiveSubscription(t *testing.T) {
	r, _, apiKey := setupIntegrationRouter(t, nil, func(f *integrationBootstrap) {
		if err := f.SubRepo.CancelByUserID(f.User.ID); err != nil {
			t.Fatalf("cancel subscription: %v", err)
		}
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/me/token-balance", nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)

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

func TestIntegration_UserTokenBalance_AuthVariants(t *testing.T) {
	r, _, apiKey := setupIntegrationRouter(t, nil)

	tests := []struct {
		name       string
		path       string
		headerName string
		headerVal  string
	}{
		{
			name:       "x-api-key",
			path:       "/v1/me/token-balance",
			headerName: "x-api-key",
			headerVal:  apiKey,
		},
		{
			name: "query-key",
			path: "/v1/me/token-balance?key=" + apiKey,
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

			if w.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
			}
		})
	}
}

// TestIntegration_AdminProvision tests the admin provision endpoint.
func TestIntegration_AdminProvision(t *testing.T) {
	r, _, _ := setupIntegrationRouter(t, nil)

	body := `{"phone":"13900139000","user_id":"ext-002","nickname":"New User","plan_id":"00000000-0000-0000-0000-000000000001"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/provision", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer admin-secret")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["api_key"] != nil {
		t.Errorf("expected api_key to be nil by default, got %v", resp["api_key"])
	}
	if assigned, ok := resp["api_key_assigned"].(bool); !ok || assigned {
		t.Errorf("expected api_key_assigned=false, got %v", resp["api_key_assigned"])
	}
	if resp["user"] == nil {
		t.Error("expected user in provision response")
	}
}

// TestIntegration_AdminWithoutAuth tests admin endpoints require authentication.
func TestIntegration_AdminWithoutAuth(t *testing.T) {
	r, _, _ := setupIntegrationRouter(t, nil)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/admin/stats", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

// TestIntegration_DisallowedModel tests that requesting a disallowed model returns 403.
func TestIntegration_DisallowedModel(t *testing.T) {
	r, _, apiKey := setupIntegrationRouter(t, nil)

	body := `{"model":"claude-3-opus","messages":[{"role":"user","content":"hi"}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for disallowed model, got %d, body: %s", w.Code, w.Body.String())
	}
}

// TestIntegration_Health tests the health endpoint.
func TestIntegration_Health(t *testing.T) {
	r, _, _ := setupIntegrationRouter(t, nil)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/health", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

// --- Anthropic Messages API (Claude Code 兼容) ---

// TestIntegration_AnthropicMessages tests POST /v1/messages with Anthropic format.
func TestIntegration_AnthropicMessages(t *testing.T) {
	upstreamResp := `{"id":"chatcmpl-test","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"Hello from Claude!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`

	r, _, apiKey := setupIntegrationRouter(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, upstreamResp)
	})

	// Anthropic 格式请求（使用 gpt-4 因为测试环境只有 openai 类型的 provider）
	body := `{"model":"gpt-4","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey) // Anthropic 使用 x-api-key
	req.Header.Set("anthropic-version", "2023-06-01")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	// 验证响应是 Anthropic 格式
	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)

	if resp["type"] != "message" {
		t.Errorf("expected type 'message', got %v", resp["type"])
	}
	if resp["role"] != "assistant" {
		t.Errorf("expected role 'assistant', got %v", resp["role"])
	}
	if resp["stop_reason"] != "end_turn" {
		t.Errorf("expected stop_reason 'end_turn', got %v", resp["stop_reason"])
	}

	// 验证 content blocks 格式
	content, ok := resp["content"].([]interface{})
	if !ok || len(content) == 0 {
		t.Fatalf("expected content blocks, got %v", resp["content"])
	}
	block := content[0].(map[string]interface{})
	if block["type"] != "text" {
		t.Errorf("expected text content block, got %v", block["type"])
	}

	// 验证 usage 格式 (input_tokens/output_tokens)
	usage, ok := resp["usage"].(map[string]interface{})
	if !ok {
		t.Fatal("expected usage field")
	}
	if usage["input_tokens"] == nil {
		t.Error("expected input_tokens in usage")
	}
	if usage["output_tokens"] == nil {
		t.Error("expected output_tokens in usage")
	}
}

func TestIntegration_AnthropicMessagesAutoModel(t *testing.T) {
	upstreamResp := `{"id":"chatcmpl-auto","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"Hello from auto!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`

	r, _, apiKey := setupIntegrationRouter(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "gpt-4" {
			t.Errorf("expected auto-selected model gpt-4, got %v", body["model"])
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, upstreamResp)
	})

	body := `{"max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}
}

// TestIntegration_AnthropicWithSystemPrompt tests Anthropic format with system prompt.
func TestIntegration_AnthropicWithSystemPrompt(t *testing.T) {
	upstreamResp := `{"id":"chatcmpl-sys","choices":[{"message":{"role":"assistant","content":"I am helpful"},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":3}}`

	r, _, apiKey := setupIntegrationRouter(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, upstreamResp)
	})

	body := `{"model":"gpt-4","max_tokens":100,"system":"You are a helpful assistant","messages":[{"role":"user","content":"Who are you?"}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}
}

// TestIntegration_AnthropicUnauthorized tests that x-api-key with invalid key returns 401.
func TestIntegration_AnthropicUnauthorized(t *testing.T) {
	r, _, _ := setupIntegrationRouter(t, nil)

	body := `{"model":"gpt-4","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", "invalid-key")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

// --- Gemini API (Gemini CLI 兼容) ---

// TestIntegration_GeminiGenerateContent tests POST /v1beta/models/{model}:generateContent.
func TestIntegration_GeminiGenerateContent(t *testing.T) {
	upstreamResp := `{"id":"chatcmpl-gem","choices":[{"message":{"role":"assistant","content":"Hello from Gemini!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":8,"total_tokens":13}}`

	r, _, apiKey := setupIntegrationRouter(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, upstreamResp)
	})

	// Gemini 格式请求
	body := `{"contents":[{"parts":[{"text":"Hello"}]}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1beta/models/gemini-pro:generateContent?key="+apiKey, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	// 验证响应是 Gemini 格式
	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)

	candidates, ok := resp["candidates"].([]interface{})
	if !ok || len(candidates) == 0 {
		t.Fatalf("expected candidates array, got %v", resp["candidates"])
	}

	candidate := candidates[0].(map[string]interface{})
	if candidate["finishReason"] != "STOP" {
		t.Errorf("expected finishReason STOP, got %v", candidate["finishReason"])
	}

	content := candidate["content"].(map[string]interface{})
	if content["role"] != "model" {
		t.Errorf("expected role 'model', got %v", content["role"])
	}

	// 验证 usageMetadata
	usage, ok := resp["usageMetadata"].(map[string]interface{})
	if !ok {
		t.Fatal("expected usageMetadata field")
	}
	if usage["promptTokenCount"] == nil {
		t.Error("expected promptTokenCount")
	}
	if usage["totalTokenCount"] == nil {
		t.Error("expected totalTokenCount")
	}
}

func TestIntegration_CompletionsAutoModel(t *testing.T) {
	r, _, apiKey := setupIntegrationRouter(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "gpt-4" {
			t.Errorf("expected auto-selected model gpt-4, got %v", body["model"])
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"cmpl-auto","object":"text_completion","choices":[{"text":"Hello"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`)
	})

	body := `{"prompt":"hi"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}
}

// TestIntegration_GeminiUnauthorized tests invalid ?key= returns 401.
func TestIntegration_GeminiUnauthorized(t *testing.T) {
	r, _, _ := setupIntegrationRouter(t, nil)

	body := `{"contents":[{"parts":[{"text":"hi"}]}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1beta/models/gemini-pro:generateContent?key=invalid", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

// TestIntegration_GeminiNoKey tests missing key returns 401.
func TestIntegration_GeminiNoKey(t *testing.T) {
	r, _, _ := setupIntegrationRouter(t, nil)

	body := `{"contents":[{"parts":[{"text":"hi"}]}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1beta/models/gemini-pro:generateContent", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

// TestIntegration_OpenAI_StillWorks verifies OpenAI format still works after adding new routes.
func TestIntegration_OpenAI_StillWorks(t *testing.T) {
	upstreamResp := `{"id":"chatcmpl-compat","choices":[{"message":{"role":"assistant","content":"Works!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}`

	r, _, apiKey := setupIntegrationRouter(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, upstreamResp)
	})

	body := `{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	// 验证仍然是 OpenAI 格式
	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] != "chatcmpl-compat" {
		t.Errorf("expected OpenAI format response, got %v", resp)
	}
}
