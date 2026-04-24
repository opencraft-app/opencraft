package service

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
)

func TestApiKeyService_Generate(t *testing.T) {
	keyRepo := newMockApiKeyRepo()
	userRepo := newMockUserRepo()
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()

	svc := NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)

	userID := uuid.New()
	plainKey, apiKey, err := svc.Generate(userID, "test-key")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Key should start with "sk-"
	if !strings.HasPrefix(plainKey, "sk-") {
		t.Errorf("expected key to start with 'sk-', got %s", plainKey)
	}

	// Key should be sk- + 48 hex chars = 51 chars total
	if len(plainKey) != 51 {
		t.Errorf("expected key length 51, got %d", len(plainKey))
	}

	// Verify hash matches
	hash := sha256.Sum256([]byte(plainKey))
	expectedHash := hex.EncodeToString(hash[:])
	if apiKey.KeyHash != expectedHash {
		t.Error("stored hash does not match key hash")
	}

	// Verify prefix
	if apiKey.KeyPrefix != plainKey[:8] {
		t.Errorf("expected prefix %s, got %s", plainKey[:8], apiKey.KeyPrefix)
	}

	// Verify stored in repo
	if len(keyRepo.keys) != 1 {
		t.Errorf("expected 1 key in repo, got %d", len(keyRepo.keys))
	}
}

func TestApiKeyService_Validate(t *testing.T) {
	keyRepo := newMockApiKeyRepo()
	userRepo := newMockUserRepo()
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()

	svc := NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)

	// Setup user, plan, subscription
	userID := uuid.New()
	user := &model.User{ID: userID, PhoneMasked: "123", PhoneHash: "hash123", UserID: "usr_test_1", Status: model.UserStatusActive}
	userRepo.users[userID] = user

	planID := uuid.New()
	plan := &model.Plan{ID: planID, Name: "pro", MonthlyTokens: 1000000, IsActive: true}
	planRepo.plans[planID] = plan

	subID := uuid.New()
	sub := &model.Subscription{
		ID:           subID,
		UserID:       userID,
		PlanID:       planID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 500000,
	}
	subRepo.subs[subID] = sub

	// Generate a key
	plainKey, _, err := svc.Generate(userID, "test")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}

	// Validate the key
	gotKey, gotUser, gotSub, gotPlan, err := svc.Validate(plainKey)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}

	if gotKey == nil || gotUser.ID != userID || gotSub.ID != subID || gotPlan.ID != planID {
		t.Error("validate returned unexpected results")
	}
}

func TestApiKeyService_Validate_InvalidKey(t *testing.T) {
	keyRepo := newMockApiKeyRepo()
	userRepo := newMockUserRepo()
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()

	svc := NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)

	_, _, _, _, err := svc.Validate("sk-invalid-key-that-does-not-exist")
	if err != model.ErrInvalidApiKey {
		t.Errorf("expected ErrInvalidApiKey, got %v", err)
	}
}

func TestApiKeyService_Revoke(t *testing.T) {
	keyRepo := newMockApiKeyRepo()
	userRepo := newMockUserRepo()
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()

	svc := NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)

	userID := uuid.New()
	plainKey, apiKey, err := svc.Generate(userID, "test")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}

	err = svc.Revoke(apiKey.ID, apiKey.KeyHash)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}

	// Key should be deactivated - validate should fail
	_, _, _, _, err = svc.Validate(plainKey)
	if err != model.ErrInvalidApiKey {
		t.Errorf("expected ErrInvalidApiKey after revoke, got %v", err)
	}
}
