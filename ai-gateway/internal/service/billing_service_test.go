package service

import (
	"context"
	"encoding/json"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

func newMockTokenBalanceOps() *mockTokenBalanceOps {
	return &mockTokenBalanceOps{mockSubscriptionRepo: newMockSubscriptionRepo()}
}

func TestGetMultiplier(t *testing.T) {
	multipliers := map[string]float64{"gpt-4": 30.0, "gpt-3.5-turbo": 1.0}
	data, _ := json.Marshal(multipliers)

	plan := &model.Plan{TokenMultipliers: datatypes.JSON(data)}

	// Known model
	if m := GetMultiplier(plan, "gpt-4"); m != 30.0 {
		t.Errorf("expected 30.0, got %f", m)
	}

	// Default for unknown model
	if m := GetMultiplier(plan, "unknown"); m != 1.0 {
		t.Errorf("expected 1.0, got %f", m)
	}

	// Nil multipliers
	nilPlan := &model.Plan{}
	if m := GetMultiplier(nilPlan, "gpt-4"); m != 1.0 {
		t.Errorf("expected 1.0, got %f", m)
	}
}

func TestBillingService_Reserve_Success(t *testing.T) {
	balanceOps := newMockTokenBalanceOps()
	provRepo := newMockProviderRepo()
	usageRepo := newMockUsageRepo()
	svc := NewBillingService(balanceOps, provRepo, usageRepo, 4096)

	subID := uuid.New()
	balanceOps.mockSubscriptionRepo.subs[subID] = &model.Subscription{
		ID:           subID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 100000,
	}

	plan := &model.Plan{MonthlyTokens: 1000000}
	ctx := context.Background()
	reserved, err := svc.Reserve(ctx, subID, "gpt-3.5-turbo", plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reserved != 4096 {
		t.Errorf("expected 4096, got %d", reserved)
	}
	if balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance != 100000-4096 {
		t.Errorf("expected balance %d, got %d", 100000-4096, balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance)
	}
}

func TestBillingService_Reserve_WithMultiplier(t *testing.T) {
	balanceOps := newMockTokenBalanceOps()
	provRepo := newMockProviderRepo()
	usageRepo := newMockUsageRepo()
	svc := NewBillingService(balanceOps, provRepo, usageRepo, 4096)

	subID := uuid.New()
	balanceOps.mockSubscriptionRepo.subs[subID] = &model.Subscription{
		ID:           subID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 500000,
	}

	multipliers, _ := json.Marshal(map[string]float64{"gpt-4": 30.0})
	plan := &model.Plan{MonthlyTokens: 1000000, TokenMultipliers: datatypes.JSON(multipliers)}

	ctx := context.Background()
	reserved, err := svc.Reserve(ctx, subID, "gpt-4", plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := int64(4096 * 30)
	if reserved != expected {
		t.Errorf("expected %d, got %d", expected, reserved)
	}
}

func TestBillingService_Reserve_InsufficientBalance(t *testing.T) {
	balanceOps := newMockTokenBalanceOps()
	provRepo := newMockProviderRepo()
	usageRepo := newMockUsageRepo()
	svc := NewBillingService(balanceOps, provRepo, usageRepo, 4096)

	subID := uuid.New()
	balanceOps.mockSubscriptionRepo.subs[subID] = &model.Subscription{
		ID:           subID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 100,
	}

	plan := &model.Plan{MonthlyTokens: 1000000}
	ctx := context.Background()
	_, err := svc.Reserve(ctx, subID, "gpt-3.5-turbo", plan)
	if err != model.ErrQuotaExceeded {
		t.Errorf("expected ErrQuotaExceeded, got %v", err)
	}
}

func TestBillingService_Settle_Refund(t *testing.T) {
	balanceOps := newMockTokenBalanceOps()
	provRepo := newMockProviderRepo()
	usageRepo := newMockUsageRepo()
	svc := NewBillingService(balanceOps, provRepo, usageRepo, 4096)

	subID := uuid.New()
	providerID := uuid.New()
	balanceOps.mockSubscriptionRepo.subs[subID] = &model.Subscription{
		ID:           subID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 90000,
	}
	provRepo.providers[providerID] = &model.Provider{
		ID:         providerID,
		Status:     model.ProviderStatusActive,
		TotalQuota: 1000000,
		UsedQuota:  0,
	}

	plan := &model.Plan{MonthlyTokens: 1000000}
	ctx := context.Background()
	err := svc.Settle(ctx, subID, providerID, 4096, 1000, "gpt-3.5-turbo", plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	expectedBalance := int64(90000 + 3096)
	if balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance != expectedBalance {
		t.Errorf("expected balance %d, got %d", expectedBalance, balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance)
	}

	if provRepo.providers[providerID].UsedQuota != 0 {
		t.Errorf("expected provider used_quota 0, got %d", provRepo.providers[providerID].UsedQuota)
	}
}

func TestBillingService_Settle_DeductExtra(t *testing.T) {
	balanceOps := newMockTokenBalanceOps()
	provRepo := newMockProviderRepo()
	usageRepo := newMockUsageRepo()
	svc := NewBillingService(balanceOps, provRepo, usageRepo, 4096)

	subID := uuid.New()
	providerID := uuid.New()
	balanceOps.mockSubscriptionRepo.subs[subID] = &model.Subscription{
		ID:           subID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 90000,
	}
	provRepo.providers[providerID] = &model.Provider{
		ID:         providerID,
		Status:     model.ProviderStatusActive,
		TotalQuota: 1000000,
		UsedQuota:  0,
	}

	plan := &model.Plan{MonthlyTokens: 1000000}
	ctx := context.Background()
	err := svc.Settle(ctx, subID, providerID, 4096, 8000, "gpt-3.5-turbo", plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	expectedBalance := int64(90000 - 3904)
	if balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance != expectedBalance {
		t.Errorf("expected balance %d, got %d", expectedBalance, balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance)
	}
}

func TestBillingService_Settle_DeductExtra_InsufficientBalance(t *testing.T) {
	balanceOps := newMockTokenBalanceOps()
	provRepo := newMockProviderRepo()
	usageRepo := newMockUsageRepo()
	svc := NewBillingService(balanceOps, provRepo, usageRepo, 4096)

	subID := uuid.New()
	providerID := uuid.New()
	balanceOps.mockSubscriptionRepo.subs[subID] = &model.Subscription{
		ID:           subID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 100,
	}

	plan := &model.Plan{MonthlyTokens: 1000000}
	ctx := context.Background()
	err := svc.Settle(ctx, subID, providerID, 4096, 8000, "gpt-3.5-turbo", plan)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance != 0 {
		t.Errorf("expected balance 0, got %d", balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance)
	}
}

func TestBillingService_Settle_DeductExtra_ZeroBalance(t *testing.T) {
	balanceOps := newMockTokenBalanceOps()
	provRepo := newMockProviderRepo()
	usageRepo := newMockUsageRepo()
	svc := NewBillingService(balanceOps, provRepo, usageRepo, 4096)

	subID := uuid.New()
	providerID := uuid.New()
	balanceOps.mockSubscriptionRepo.subs[subID] = &model.Subscription{
		ID:           subID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 0,
	}

	plan := &model.Plan{MonthlyTokens: 1000000}
	ctx := context.Background()
	err := svc.Settle(ctx, subID, providerID, 4096, 8000, "gpt-3.5-turbo", plan)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance != 0 {
		t.Errorf("expected balance 0, got %d", balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance)
	}
}

func TestBillingService_Settle_DeductExtra_PartialDeduction(t *testing.T) {
	balanceOps := newMockTokenBalanceOps()
	provRepo := newMockProviderRepo()
	usageRepo := newMockUsageRepo()
	svc := NewBillingService(balanceOps, provRepo, usageRepo, 4096)

	subID := uuid.New()
	providerID := uuid.New()
	balanceOps.mockSubscriptionRepo.subs[subID] = &model.Subscription{
		ID:           subID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 5000,
	}

	plan := &model.Plan{MonthlyTokens: 1000000}
	ctx := context.Background()
	err := svc.Settle(ctx, subID, providerID, 4096, 8000, "gpt-3.5-turbo", plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance != 1096 {
		t.Errorf("expected balance 1096, got %d", balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance)
	}
}

func TestBillingService_ReserveAndSettle_UsesResolvedModelMultiplier(t *testing.T) {
	balanceOps := newMockTokenBalanceOps()
	provRepo := newMockProviderRepo()
	usageRepo := newMockUsageRepo()
	svc := NewBillingService(balanceOps, provRepo, usageRepo, 100)

	subID := uuid.New()
	balanceOps.mockSubscriptionRepo.subs[subID] = &model.Subscription{
		ID:           subID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 10000,
	}

	multipliers, _ := json.Marshal(map[string]float64{
		"DeepSeek-V3.1": 5.0,
		"kimi-k2.5":     2.0,
	})
	plan := &model.Plan{MonthlyTokens: 1000000, TokenMultipliers: datatypes.JSON(multipliers)}

	ctx := context.Background()
	reserved, err := svc.Reserve(ctx, subID, "kimi-k2.5", plan)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if reserved != 200 {
		t.Fatalf("expected reserve to use resolved model multiplier, got %d", reserved)
	}

	err = svc.Settle(ctx, subID, uuid.New(), reserved, 50, "kimi-k2.5", plan)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}

	expectedBalance := int64(10000 - 100)
	if balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance != expectedBalance {
		t.Fatalf("expected balance %d, got %d", expectedBalance, balanceOps.mockSubscriptionRepo.subs[subID].TokenBalance)
	}
}
