package service

import (
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
)

// ---- CalcTokenBalance 辅助函数测试 ----

func TestCalcTokenBalance_Months(t *testing.T) {
	plan := &model.Plan{
		MonthlyTokens: 100000,
		PeriodValue:   3,
		PeriodUnit:    "months",
	}
	got, err := CalcTokenBalance(plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != 300000 {
		t.Errorf("expected 300000, got %d", got)
	}
}

func TestCalcTokenBalance_Days(t *testing.T) {
	plan := &model.Plan{
		MonthlyTokens: 100000,
		PeriodValue:   30,
		PeriodUnit:    "days",
	}
	got, err := CalcTokenBalance(plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != 100000 {
		t.Errorf("expected 100000, got %d", got)
	}
}

func TestCalcTokenBalance_Days7(t *testing.T) {
	plan := &model.Plan{
		MonthlyTokens: 100000,
		PeriodValue:   7,
		PeriodUnit:    "days",
	}
	got, err := CalcTokenBalance(plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 100000 * 7 / 30 = 23333
	if got != 23333 {
		t.Errorf("expected 23333, got %d", got)
	}
}

// ---- CalcPeriodEnd 辅助函数测试 ----

func TestCalcPeriodEnd_Months(t *testing.T) {
	plan := &model.Plan{
		PeriodValue: 1,
		PeriodUnit:  "months",
	}
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end, err := CalcPeriodEnd(start, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	if !end.Equal(want) {
		t.Errorf("expected %v, got %v", want, end)
	}
}

func TestCalcPeriodEnd_Days(t *testing.T) {
	plan := &model.Plan{
		PeriodValue: 7,
		PeriodUnit:  "days",
	}
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end, err := CalcPeriodEnd(start, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := time.Date(2026, 1, 8, 0, 0, 0, 0, time.UTC)
	if !end.Equal(want) {
		t.Errorf("expected %v, got %v", want, end)
	}
}

// ---- Subscribe 新签名测试 ----

func TestSubscribe_NilPeriodStart(t *testing.T) {
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()

	planID := uuid.New()
	planRepo.plans[planID] = &model.Plan{
		ID:            planID,
		Name:          "pro",
		MonthlyTokens: 1000000,
		PeriodValue:   1,
		PeriodUnit:    "months",
		IsActive:      true,
	}

	svc := NewSubscriptionService(subRepo, planRepo, nil)

	before := time.Now()
	sub, err := svc.Subscribe(uuid.New(), planID, nil)
	after := time.Now()

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// period_start 应在 before ~ after 之间（误差1秒内）
	if sub.PeriodStart.Before(before.Add(-time.Second)) || sub.PeriodStart.After(after.Add(time.Second)) {
		t.Errorf("PeriodStart %v out of expected range [%v, %v]", sub.PeriodStart, before, after)
	}
}

func TestSubscribe_CustomPeriodStart(t *testing.T) {
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()

	planID := uuid.New()
	planRepo.plans[planID] = &model.Plan{
		ID:            planID,
		Name:          "pro",
		MonthlyTokens: 1000000,
		PeriodValue:   1,
		PeriodUnit:    "months",
		IsActive:      true,
	}

	svc := NewSubscriptionService(subRepo, planRepo, nil)

	customStart := time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC)
	sub, err := svc.Subscribe(uuid.New(), planID, &customStart)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !sub.PeriodStart.Equal(customStart) {
		t.Errorf("expected PeriodStart %v, got %v", customStart, sub.PeriodStart)
	}
	wantEnd := time.Date(2026, 2, 15, 0, 0, 0, 0, time.UTC)
	if !sub.PeriodEnd.Equal(wantEnd) {
		t.Errorf("expected PeriodEnd %v, got %v", wantEnd, sub.PeriodEnd)
	}
	if sub.TokenBalance != 1000000 {
		t.Errorf("expected token balance 1000000, got %d", sub.TokenBalance)
	}
}

// ---- 保持旧的集成行为测试（更新到新签名）----

func TestSubscriptionService_Subscribe(t *testing.T) {
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()

	planID := uuid.New()
	planRepo.plans[planID] = &model.Plan{
		ID:            planID,
		Name:          "pro",
		MonthlyTokens: 1000000,
		PeriodValue:   3,
		PeriodUnit:    "months",
		IsActive:      true,
	}

	svc := NewSubscriptionService(subRepo, planRepo, nil)

	userID := uuid.New()
	sub, err := svc.Subscribe(userID, planID, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if sub.UserID != userID {
		t.Error("wrong user ID")
	}
	if sub.PlanID != planID {
		t.Error("wrong plan ID")
	}
	if sub.TokenBalance != 3000000 {
		t.Errorf("expected token balance 3000000, got %d", sub.TokenBalance)
	}
	if sub.Status != model.SubscriptionStatusActive {
		t.Errorf("expected active status, got %s", sub.Status)
	}
}

func TestSubscriptionService_Subscribe_CancelsExisting(t *testing.T) {
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()

	planID := uuid.New()
	planRepo.plans[planID] = &model.Plan{
		ID:            planID,
		Name:          "pro",
		MonthlyTokens: 1000000,
		PeriodValue:   1,
		PeriodUnit:    "months",
		IsActive:      true,
	}

	svc := NewSubscriptionService(subRepo, planRepo, nil)

	userID := uuid.New()

	// Create first subscription
	sub1, err := svc.Subscribe(userID, planID, nil)
	if err != nil {
		t.Fatalf("first subscribe: %v", err)
	}

	// Create second subscription — should cancel first
	sub2, err := svc.Subscribe(userID, planID, nil)
	if err != nil {
		t.Fatalf("second subscribe: %v", err)
	}

	// First should be cancelled
	if subRepo.subs[sub1.ID].Status != model.SubscriptionStatusCancelled {
		t.Error("first subscription should be cancelled")
	}
	// Second should be active
	if sub2.Status != model.SubscriptionStatusActive {
		t.Error("second subscription should be active")
	}
}

func TestSubscriptionService_Subscribe_PlanNotFound(t *testing.T) {
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()

	svc := NewSubscriptionService(subRepo, planRepo, nil)

	_, err := svc.Subscribe(uuid.New(), uuid.New(), nil)
	if err == nil {
		t.Error("expected error for non-existent plan")
	}
}
