package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

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

type integrationHarness struct {
	router           *gin.Engine
	apiKey           string
	userID           uuid.UUID
	subscriptionRepo *memSubRepo
	providerRepo     *memProviderRepo
	providerID       uuid.UUID
	usageRepo        *memUsageRepo
}

func setupIntegrationHarness(t *testing.T, upstreamHandler http.Handler) *integrationHarness {
	t.Helper()
	gin.SetMode(gin.TestMode)

	upstream := httptest.NewServer(upstreamHandler)
	t.Cleanup(upstream.Close)

	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	redisClient := redisclient.NewClientFromRedis(rdb)

	userRepo := newMemUserRepo()
	planRepo := newMemPlanRepo()
	subRepo := newMemSubRepo()
	providerRepo := newMemProviderRepo()
	apiKeyRepo := newMemApiKeyRepo()
	usageRepo := newMemUsageRepo()

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
	if err := planRepo.Create(plan); err != nil {
		t.Fatalf("create plan: %v", err)
	}

	encryptedKey, err := crypto.Encrypt("test-upstream-key", testEncryptionKey)
	if err != nil {
		t.Fatalf("encrypt provider key: %v", err)
	}
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
	if err := providerRepo.Create(provider); err != nil {
		t.Fatalf("create provider: %v", err)
	}

	keySvc := service.NewApiKeyService(apiKeyRepo, userRepo, subRepo, planRepo, redisClient, 5*time.Minute)
	userSvc := service.NewUserService(userRepo, keySvc, testEncryptionKey)
	planSvc := service.NewPlanService(planRepo)
	subSvc := service.NewSubscriptionService(subRepo, planRepo, keySvc)
	providerSvc := service.NewProviderService(providerRepo, nil, testEncryptionKey)
	billingSvc := service.NewBillingService(subRepo, providerRepo, usageRepo, 4096)
	provisionSvc := service.NewProvisionService(userSvc, subSvc, keySvc, planRepo)

	user, _, plainKey, err := provisionSvc.Provision("ext-001", "13800138000", "Test User", plan.ID.String(), nil, true)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

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

	}

	admin := r.Group("/api/admin")
	admin.Use(middleware.AdminAuth(cfg.Server.AdminToken, cfg.Server.AdminIPWhitelist))
	{
		admin.POST("/provision", adminHandler.Provision)
		admin.GET("/users", adminHandler.ListUsers)
		admin.GET("/plans", adminHandler.ListPlans)
		admin.GET("/stats", adminHandler.StatsOverview)
	}

	return &integrationHarness{
		router:           r,
		apiKey:           *plainKey,
		userID:           user.ID,
		subscriptionRepo: subRepo,
		providerRepo:     providerRepo,
		providerID:       provider.ID,
		usageRepo:        usageRepo,
	}
}

type openAIStreamingMockUsage struct {
	PromptTokens     int64
	CompletionTokens int64
	TotalTokens      int64
}

type openAIStreamingMockEvent struct {
	Content string
}

type openAIStreamingMockScenario struct {
	Model              string
	Events             []openAIStreamingMockEvent
	RawDataEvents      []string
	Usage              openAIStreamingMockUsage
	OmitUsage          bool
	OmitProviderHeader bool
	ProviderHeader     string
	TargetIndex        *int
	CloseEarly         bool
	EventDelay         time.Duration
	StatusCode         int
	ErrorBody          string
}

type openAIStreamingMockServer struct {
	t        *testing.T
	scenario openAIStreamingMockScenario

	mu          sync.Mutex
	lastRequest map[string]any
}

func newOpenAIStreamingMockServer(t *testing.T, scenario openAIStreamingMockScenario) *openAIStreamingMockServer {
	t.Helper()
	return &openAIStreamingMockServer{t: t, scenario: scenario}
}

func (m *openAIStreamingMockServer) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}

		defer r.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}

		m.mu.Lock()
		m.lastRequest = body
		m.mu.Unlock()

		if m.scenario.StatusCode >= http.StatusBadRequest {
			w.Header().Set("Content-Type", "application/json")
			m.applyProviderHeaders(w)
			w.WriteHeader(m.scenario.StatusCode)
			if m.scenario.ErrorBody != "" {
				fmt.Fprint(w, m.scenario.ErrorBody)
			}
			return
		}

		isStream, _ := body["stream"].(bool)
		if !isStream {
			m.writeNonStreamResponse(w)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		m.applyProviderHeaders(w)
		flusher, ok := w.(http.Flusher)
		if !ok {
			m.t.Fatalf("response writer does not support flushing")
		}

		for _, event := range m.scenario.Events {
			fmt.Fprintf(w, "data: {\"id\":\"chatcmpl-mock\",\"object\":\"chat.completion.chunk\",\"model\":%q,\"choices\":[{\"index\":0,\"delta\":{\"content\":%q}}]}\n\n", m.scenario.Model, event.Content)
			flusher.Flush()
			if m.scenario.EventDelay > 0 {
				time.Sleep(m.scenario.EventDelay)
			}
		}
		for _, raw := range m.scenario.RawDataEvents {
			fmt.Fprintf(w, "data: %s\n\n", raw)
			flusher.Flush()
			if m.scenario.EventDelay > 0 {
				time.Sleep(m.scenario.EventDelay)
			}
		}
		if m.scenario.CloseEarly {
			return
		}
		if !m.scenario.OmitUsage {
			fmt.Fprintf(w, "data: {\"id\":\"chatcmpl-mock\",\"object\":\"chat.completion.chunk\",\"model\":%q,\"choices\":[],\"usage\":{\"prompt_tokens\":%d,\"completion_tokens\":%d,\"total_tokens\":%d}}\n\n", m.scenario.Model, m.scenario.Usage.PromptTokens, m.scenario.Usage.CompletionTokens, m.scenario.Usage.TotalTokens)
			flusher.Flush()
			if m.scenario.EventDelay > 0 {
				time.Sleep(m.scenario.EventDelay)
			}
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	})
}

func (m *openAIStreamingMockServer) applyProviderHeaders(w http.ResponseWriter) {
	if m.scenario.OmitProviderHeader {
		return
	}
	if m.scenario.TargetIndex != nil {
		w.Header().Set("x-portkey-target-index", fmt.Sprintf("%d", *m.scenario.TargetIndex))
	} else if m.scenario.ProviderHeader == "" {
		w.Header().Set("x-portkey-target-index", "0")
	}
	if m.scenario.ProviderHeader != "" {
		w.Header().Set("x-portkey-provider", m.scenario.ProviderHeader)
	}
}

func (m *openAIStreamingMockServer) writeNonStreamResponse(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	m.applyProviderHeaders(w)
	if m.scenario.EventDelay > 0 {
		delayUnits := len(m.scenario.Events) + len(m.scenario.RawDataEvents)
		if !m.scenario.OmitUsage && !m.scenario.CloseEarly {
			delayUnits++
		}
		if delayUnits == 0 {
			delayUnits = 1
		}
		time.Sleep(time.Duration(delayUnits) * m.scenario.EventDelay)
	}

	content, reasoning, toolCalls, finishReason := m.aggregateSyntheticMessage()
	message := map[string]any{
		"role":    "assistant",
		"content": content,
	}
	if reasoning != "" {
		message["reasoning_content"] = reasoning
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}

	response := map[string]any{
		"id":      "chatcmpl-mock",
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   m.scenario.Model,
		"choices": []map[string]any{
			{
				"index":         0,
				"message":       message,
				"finish_reason": finishReason,
			},
		},
	}
	if !m.scenario.OmitUsage && !m.scenario.CloseEarly {
		response["usage"] = map[string]any{
			"prompt_tokens":     m.scenario.Usage.PromptTokens,
			"completion_tokens": m.scenario.Usage.CompletionTokens,
			"total_tokens":      m.scenario.Usage.TotalTokens,
		}
	}

	if err := json.NewEncoder(w).Encode(response); err != nil {
		m.t.Fatalf("encode non-stream response: %v", err)
	}
}

func (m *openAIStreamingMockServer) aggregateSyntheticMessage() (content string, reasoning string, toolCalls []map[string]any, finishReason string) {
	type toolState struct {
		id        string
		toolType  string
		name      string
		arguments strings.Builder
	}
	toolStates := map[int]*toolState{}
	finishReason = "stop"

	for _, event := range m.scenario.Events {
		content += event.Content
	}

	for _, raw := range m.scenario.RawDataEvents {
		var payload struct {
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
					ToolCalls        []struct {
						Index    *int   `json:"index"`
						ID       string `json:"id"`
						Type     string `json:"type"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			continue
		}
		for _, choice := range payload.Choices {
			content += choice.Delta.Content
			if choice.Delta.ReasoningContent != "" {
				reasoning += choice.Delta.ReasoningContent
			}
			for _, tc := range choice.Delta.ToolCalls {
				index := 0
				if tc.Index != nil {
					index = *tc.Index
				}
				state := toolStates[index]
				if state == nil {
					state = &toolState{}
					toolStates[index] = state
				}
				if tc.ID != "" {
					state.id = tc.ID
				}
				if tc.Type != "" {
					state.toolType = tc.Type
				}
				if tc.Function.Name != "" {
					state.name = tc.Function.Name
				}
				if tc.Function.Arguments != "" {
					state.arguments.WriteString(tc.Function.Arguments)
				}
			}
			if choice.FinishReason != nil && *choice.FinishReason != "" {
				finishReason = *choice.FinishReason
			}
		}
	}

	if len(toolStates) > 0 {
		finishReason = "tool_calls"
		for index := 0; ; index++ {
			state, ok := toolStates[index]
			if !ok {
				remaining := false
				for k := range toolStates {
					if k > index {
						remaining = true
						break
					}
				}
				if !remaining {
					break
				}
				continue
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":    state.id,
				"type":  firstNonEmpty(state.toolType, "function"),
				"index": index,
				"function": map[string]any{
					"name":      state.name,
					"arguments": state.arguments.String(),
				},
			})
		}
	}

	return content, reasoning, toolCalls, finishReason
}

func firstNonEmpty(value string, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func (m *openAIStreamingMockServer) LastRequestJSON(t *testing.T) map[string]any {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.lastRequest == nil {
		t.Fatal("expected mock server to receive a request")
	}
	cloned := make(map[string]any, len(m.lastRequest))
	for k, v := range m.lastRequest {
		cloned[k] = v
	}
	return cloned
}

func (r *memSubRepo) mustActiveByUserID(t *testing.T, userID uuid.UUID) *model.Subscription {
	t.Helper()
	sub, err := r.GetActiveByUserID(userID)
	if err != nil {
		t.Fatalf("expected active subscription for user %s: %v", userID, err)
	}
	return sub
}

func (r *memProviderRepo) mustGetByID(t *testing.T, id uuid.UUID) *model.Provider {
	t.Helper()
	provider, err := r.GetByID(id)
	if err != nil {
		t.Fatalf("expected provider %s: %v", id, err)
	}
	return provider
}

func (h *integrationHarness) addProvider(t *testing.T, providerType string, priority int) uuid.UUID {
	t.Helper()
	encryptedKey, err := crypto.Encrypt(fmt.Sprintf("test-upstream-key-%d", priority), testEncryptionKey)
	if err != nil {
		t.Fatalf("encrypt extra provider key: %v", err)
	}
	provider := &model.Provider{
		ID:           uuid.New(),
		Name:         fmt.Sprintf("test-%s-%d", providerType, priority),
		ProviderType: providerType,
		APIKey:       encryptedKey,
		BaseURL:      "http://mock-provider.invalid",
		TotalQuota:   10000000,
		UsedQuota:    0,
		Status:       model.ProviderStatusActive,
		Priority:     priority,
	}
	if err := h.providerRepo.Create(provider); err != nil {
		t.Fatalf("create extra provider: %v", err)
	}
	return provider.ID
}
