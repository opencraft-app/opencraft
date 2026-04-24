package handler

import (
	"context"
	"net/http"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

var testEncryptionKey = []byte("01234567890123456789012345678901")

func TestResolveAutoModel(t *testing.T) {
	plan := &model.Plan{
		AllowedModels: datatypes.JSON([]byte(`["gpt-4","gpt-3.5-turbo"]`)),
	}

	modelName, err := resolveAutoModel(plan, "gpt-3.5-turbo")
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if modelName != "gpt-3.5-turbo" {
		t.Fatalf("expected configured default model, got %q", modelName)
	}

	modelName, err = resolveAutoModel(plan, "claude-3-opus")
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if modelName != "gpt-4" {
		t.Fatalf("expected fallback to first allowed model, got %q", modelName)
	}
}

func TestResolveActualProvider(t *testing.T) {
	providerA := model.Provider{ID: uuid.New(), Name: "provider-a", ProviderType: "openai"}
	providerB := model.Provider{ID: uuid.New(), Name: "provider-b", ProviderType: "anthropic"}
	candidates := []model.Provider{providerA, providerB}

	resp := &http.Response{Header: make(http.Header)}
	resp.Header.Set("x-portkey-target-index", "1")
	if got := resolveActualProvider(resp, candidates); got != providerB.ID {
		t.Fatalf("expected provider from target index, got %s", got)
	}

	resp = &http.Response{Header: make(http.Header)}
	resp.Header.Set("x-portkey-provider", "anthropic")
	if got := resolveActualProvider(resp, candidates); got != providerB.ID {
		t.Fatalf("expected provider from name/type header, got %s", got)
	}

	resp = &http.Response{Header: make(http.Header)}
	resp.Header.Set("x-portkey-last-used-option-index", "0")
	if got := resolveActualProvider(resp, candidates); got != providerA.ID {
		t.Fatalf("expected provider from last-used-option-index header, got %s", got)
	}

	resp = &http.Response{Header: make(http.Header)}
	if got := resolveActualProvider(resp, candidates); got != uuid.Nil {
		t.Fatalf("expected nil provider when headers are absent, got %s", got)
	}
}

func TestProviderTypeFromModel(t *testing.T) {
	tests := []struct {
		model    string
		expected string
	}{
		{"gpt-4", "openai"},
		{"gpt-3.5-turbo", "openai"},
		{"deepseek-chat", "deepseek"},
		{"DeepSeek-V3.1", "deepseek"},
		{"qwen-turbo", "qwen"},
		{"claude-3-opus", "anthropic"},
		{"unknown-model", "openai"},
	}

	for _, tt := range tests {
		got := providerTypeFromModel(tt.model)
		if got != tt.expected {
			t.Errorf("providerTypeFromModel(%q) = %q, want %q", tt.model, got, tt.expected)
		}
	}
}

func TestSelectFallbackModel(t *testing.T) {
	providerID := uuid.New()
	providerRepo := &adminMockProvRepo{}
	providerRepo.providers = []model.Provider{{
		ID:              providerID,
		Name:            "kimi-provider",
		ProviderType:    model.ProviderTypeOpenAI,
		Status:          model.ProviderStatusActive,
		TotalQuota:      1000,
		UsedQuota:       0,
		SupportedModels: datatypes.JSON([]byte(`["kimi-k2.5"]`)),
	}}

	providerSvc := service.NewProviderService(providerRepo, nil, testEncryptionKey)
	plan := &model.Plan{
		AllowedModels: datatypes.JSON([]byte(`["DeepSeek-V3.1","kimi-k2.5","glm-5"]`)),
	}

	result, err := selectFallbackModel(context.Background(), providerSvc, plan, "DeepSeek-V3.1")
	if err != nil {
		t.Fatalf("expected fallback model, got error: %v", err)
	}
	if result.ResolvedModel != "kimi-k2.5" {
		t.Fatalf("expected kimi-k2.5, got %q", result.ResolvedModel)
	}
	if !result.FallbackApplied {
		t.Fatalf("expected fallback to be applied")
	}
	if result.FallbackReason != fallbackReasonNoAvailableProvider {
		t.Fatalf("unexpected fallback reason: %q", result.FallbackReason)
	}
}

func TestSelectFallbackModel_NoRouteableAlternative(t *testing.T) {
	providerSvc := service.NewProviderService(&adminMockProvRepo{}, nil, testEncryptionKey)
	plan := &model.Plan{
		AllowedModels: datatypes.JSON([]byte(`["DeepSeek-V3.1","glm-5"]`)),
	}

	_, err := selectFallbackModel(context.Background(), providerSvc, plan, "DeepSeek-V3.1")
	if err == nil {
		t.Fatalf("expected error when no routeable fallback exists")
	}
}

func TestClassifyProviderFailure(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       string
		expected   providerFailureAction
	}{
		{
			name:       "invalid model 400 retries next provider",
			statusCode: http.StatusBadRequest,
			body:       `{"error":{"message":"openai error: invalid model","code":"20033"}}`,
			expected:   providerFailureRetryNextProvider,
		},
		{
			name:       "unsupported model 400 retries next provider",
			statusCode: http.StatusBadRequest,
			body:       `{"error":{"message":"unsupported model"}}`,
			expected:   providerFailureRetryNextProvider,
		},
		{
			name:       "plain text invalid model 400 retries next provider",
			statusCode: http.StatusBadRequest,
			body:       `openai error: invalid model`,
			expected:   providerFailureRetryNextProvider,
		},
		{
			name:       "html invalid model 400 retries next provider",
			statusCode: http.StatusBadRequest,
			body:       `<html><body><h1>invalid model</h1></body></html>`,
			expected:   providerFailureRetryNextProvider,
		},
		{
			name:       "generic bad request returns to client",
			statusCode: http.StatusBadRequest,
			body:       `{"error":{"message":"missing messages"}}`,
			expected:   providerFailureReturnToClient,
		},
		{
			name:       "401 retries next provider",
			statusCode: http.StatusUnauthorized,
			body:       `{"error":{"message":"invalid api key"}}`,
			expected:   providerFailureRetryNextProvider,
		},
		{
			name:       "404 retries next provider",
			statusCode: http.StatusNotFound,
			body:       `{"detail":"Not Found"}`,
			expected:   providerFailureRetryNextProvider,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			action := classifyProviderFailure(tt.statusCode, []byte(tt.body))
			if action != tt.expected {
				t.Fatalf("expected %q, got %q", tt.expected, action)
			}
		})
	}
}
