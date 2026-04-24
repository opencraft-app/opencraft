package service

import (
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/crypto"
	"github.com/google/uuid"
)

func TestProviderTypeFromModel_IsCaseInsensitive(t *testing.T) {
	tests := []struct {
		model    string
		expected string
	}{
		{"DeepSeek-V3.1", "deepseek"},
		{"GPT-4o", "openai"},
		{"Claude-3-7-Sonnet", "anthropic"},
	}

	for _, tt := range tests {
		if got := providerTypeFromModel(tt.model); got != tt.expected {
			t.Errorf("providerTypeFromModel(%q) = %q, want %q", tt.model, got, tt.expected)
		}
	}
}

func TestProviderService_SelectProvider(t *testing.T) {
	provRepo := newMockProviderRepo()

	encKey := []byte("01234567890123456789012345678901") // 32 bytes
	apiKeyPlain := "test-openai-api-key"
	encrypted, err := crypto.Encrypt(apiKeyPlain, encKey)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	provID := uuid.New()
	provRepo.providers[provID] = &model.Provider{
		ID:           provID,
		Name:         "openai-1",
		ProviderType: "openai",
		APIKey:       encrypted,
		BaseURL:      "https://api.openai.com",
		TotalQuota:   1000000,
		UsedQuota:    0,
		Status:       model.ProviderStatusActive,
		Priority:     10,
	}

	svc := NewProviderService(provRepo, nil, encKey)

	provider, decryptedKey, err := svc.SelectProvider("openai")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider.ID != provID {
		t.Error("wrong provider returned")
	}
	if decryptedKey != apiKeyPlain {
		t.Errorf("expected decrypted key %q, got %q", apiKeyPlain, decryptedKey)
	}
}

func TestProviderService_SelectProvider_Unavailable(t *testing.T) {
	provRepo := newMockProviderRepo()
	encKey := []byte("01234567890123456789012345678901")

	svc := NewProviderService(provRepo, nil, encKey)

	_, _, err := svc.SelectProvider("openai")
	if err != model.ErrProviderUnavailable {
		t.Errorf("expected ErrProviderUnavailable, got %v", err)
	}
}

func TestProviderService_TrackUsage(t *testing.T) {
	provRepo := newMockProviderRepo()
	encKey := []byte("01234567890123456789012345678901")

	provID := uuid.New()
	provRepo.providers[provID] = &model.Provider{
		ID:         provID,
		TotalQuota: 1000,
		UsedQuota:  900,
		Status:     model.ProviderStatusActive,
	}

	svc := NewProviderService(provRepo, nil, encKey)

	err := svc.TrackUsage(provID, 100)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// After tracking 100 tokens, used_quota = 1000 = total_quota → should be exhausted
	if provRepo.providers[provID].Status != model.ProviderStatusExhausted {
		t.Errorf("expected exhausted status, got %s", provRepo.providers[provID].Status)
	}
}

func TestProviderService_TrackUsage_NotExhausted(t *testing.T) {
	provRepo := newMockProviderRepo()
	encKey := []byte("01234567890123456789012345678901")

	provID := uuid.New()
	provRepo.providers[provID] = &model.Provider{
		ID:         provID,
		TotalQuota: 1000,
		UsedQuota:  0,
		Status:     model.ProviderStatusActive,
	}

	svc := NewProviderService(provRepo, nil, encKey)

	err := svc.TrackUsage(provID, 100)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if provRepo.providers[provID].Status != model.ProviderStatusActive {
		t.Errorf("expected active status, got %s", provRepo.providers[provID].Status)
	}
	if provRepo.providers[provID].UsedQuota != 100 {
		t.Errorf("expected used_quota 100, got %d", provRepo.providers[provID].UsedQuota)
	}
}
