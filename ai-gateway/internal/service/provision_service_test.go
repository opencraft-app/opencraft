package service

import (
	"strings"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
)

var testProvEncKey = []byte("01234567890123456789012345678901")

func TestProvisionService_Provision_NewUser(t *testing.T) {
	userRepo := newMockUserRepo()
	planRepo := newMockPlanRepo()
	subRepo := newMockSubscriptionRepo()
	keyRepo := newMockApiKeyRepo()

	keySvc := NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)
	userSvc := NewUserService(userRepo, keySvc, testProvEncKey)
	subSvc := NewSubscriptionService(subRepo, planRepo, keySvc)

	plan := &model.Plan{
		Name:          "starter",
		MonthlyTokens: 500000,
		PeriodValue:   1,
		PeriodUnit:    "months",
		IsActive:      true,
	}
	_ = planRepo.Create(plan)

	provisionSvc := NewProvisionService(userSvc, subSvc, keySvc, planRepo)

	user, sub, plainKey, err := provisionSvc.Provision("usr_test_1", "13800138000", "test-user", plan.ID.String(), nil, false)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}

	if user == nil {
		t.Fatal("user should not be nil")
	}
	if user.PhoneMasked != "138****8000" {
		t.Errorf("wrong phone masked, got %s", user.PhoneMasked)
	}

	if sub == nil {
		t.Fatal("subscription should not be nil")
	}
	if sub.TokenBalance != 500000 {
		t.Errorf("expected token balance 500000, got %d", sub.TokenBalance)
	}

	if plainKey != nil {
		t.Errorf("expected no api key by default, got %v", *plainKey)
	}
}

func TestProvisionService_Provision_ExistingUser(t *testing.T) {
	userRepo := newMockUserRepo()
	planRepo := newMockPlanRepo()
	subRepo := newMockSubscriptionRepo()
	keyRepo := newMockApiKeyRepo()

	keySvc := NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)
	userSvc := NewUserService(userRepo, keySvc, testProvEncKey)
	subSvc := NewSubscriptionService(subRepo, planRepo, keySvc)

	// Pre-create user with encrypted phone fields
	existingUser := &model.User{
		UserID:   "usr_test_1",
		Nickname: "existing",
		Status:   model.UserStatusActive,
	}
	_ = userSvc.SetPhoneFields(existingUser, "13800138000")
	_ = userRepo.Create(existingUser)

	plan := &model.Plan{
		Name:          "starter",
		MonthlyTokens: 500000,
		PeriodValue:   1,
		PeriodUnit:    "months",
		IsActive:      true,
	}
	_ = planRepo.Create(plan)

	provisionSvc := NewProvisionService(userSvc, subSvc, keySvc, planRepo)

	user, sub, plainKey, err := provisionSvc.Provision("usr_test_1", "13800138000", "existing", plan.ID.String(), nil, false)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}

	// Should reuse existing user
	if user.ID != existingUser.ID {
		t.Error("should reuse existing user")
	}
	if sub == nil {
		t.Fatal("subscription should not be nil")
	}
	if plainKey != nil {
		t.Error("should not generate an API key by default")
	}
}

func TestProvisionService_Provision_AssignsAPIKeyWhenRequested(t *testing.T) {
	userRepo := newMockUserRepo()
	planRepo := newMockPlanRepo()
	subRepo := newMockSubscriptionRepo()
	keyRepo := newMockApiKeyRepo()

	keySvc := NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)
	userSvc := NewUserService(userRepo, keySvc, testProvEncKey)
	subSvc := NewSubscriptionService(subRepo, planRepo, keySvc)

	plan := &model.Plan{
		Name:          "starter",
		MonthlyTokens: 500000,
		PeriodValue:   1,
		PeriodUnit:    "months",
		IsActive:      true,
	}
	_ = planRepo.Create(plan)

	provisionSvc := NewProvisionService(userSvc, subSvc, keySvc, planRepo)

	user, sub, plainKey, err := provisionSvc.Provision("usr_test_2", "13800138000", "assign-key", plan.ID.String(), nil, true)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if user == nil || sub == nil {
		t.Fatal("user and subscription should not be nil")
	}
	if plainKey == nil {
		t.Fatal("expected api key when assign_api_key=true")
	}
	if !strings.HasPrefix(*plainKey, "sk-") {
		t.Errorf("expected key starting with sk-, got %s", *plainKey)
	}
}

func TestProvisionService_Provision_PlanNotFound(t *testing.T) {
	userRepo := newMockUserRepo()
	planRepo := newMockPlanRepo()
	subRepo := newMockSubscriptionRepo()
	keyRepo := newMockApiKeyRepo()

	keySvc := NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)
	userSvc := NewUserService(userRepo, keySvc, testProvEncKey)
	subSvc := NewSubscriptionService(subRepo, planRepo, keySvc)

	provisionSvc := NewProvisionService(userSvc, subSvc, keySvc, planRepo)

	_, _, _, err := provisionSvc.Provision("usr_test_1", "13800138000", "test", uuid.Nil.String(), nil, false)
	if err == nil {
		t.Error("expected error for non-existent plan")
	}
}
