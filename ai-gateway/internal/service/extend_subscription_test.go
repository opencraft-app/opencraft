package service

import (
	"context"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
)

// R-MR-4 unit tests: SubscriptionService.ExtendSubscription
// (.tmp/aigateway-monthly-token-refresh-design.md §5.1 / §8 stage 4).
//
// 语义升级（2026-05-24 用户拍板）：ExtendSubscription 现为 "对齐" 语义。
// 不再受 only-forward CAS 限制 — 既支持续费向后延期，也支持退费向前缩短，
// 统一覆盖到传入的 newPeriodEnd。幂等语义从 "同一 newPeriodEnd 重复调返 false"。

func newExtendTestSvc(sub *model.Subscription) *SubscriptionService {
	subRepo := newMockSubscriptionRepo()
	subRepo.subs[sub.ID] = sub
	planRepo := newMockPlanRepo()
	return NewSubscriptionService(subRepo, planRepo, nil)
}

func TestExtendSubscription_PushesPeriodEndForward(t *testing.T) {
	userID := uuid.New()
	original := time.Date(2026, time.June, 15, 0, 0, 0, 0, time.UTC)
	sub := &model.Subscription{
		ID:           uuid.New(),
		UserID:       userID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 1_000_000,
		PeriodStart:  time.Date(2026, time.May, 15, 0, 0, 0, 0, time.UTC),
		PeriodEnd:    original,
	}
	svc := newExtendTestSvc(sub)

	newEnd := time.Date(2026, time.September, 15, 0, 0, 0, 0, time.UTC)
	got, updated, err := svc.ExtendSubscription(context.Background(), userID, newEnd)
	if err != nil {
		t.Fatalf("ExtendSubscription error: %v", err)
	}
	if !updated {
		t.Errorf("expected updated=true on first extension")
	}
	if !got.PeriodEnd.Equal(newEnd.UTC()) {
		t.Errorf("PeriodEnd = %v; want %v", got.PeriodEnd, newEnd)
	}
	// token_balance must NOT be touched.
	if got.TokenBalance != 1_000_000 {
		t.Errorf("token_balance changed during renewal: got %d, want 1_000_000", got.TokenBalance)
	}
}

func TestExtendSubscription_IdempotentNoOp(t *testing.T) {
	userID := uuid.New()
	already := time.Date(2026, time.September, 15, 0, 0, 0, 0, time.UTC)
	sub := &model.Subscription{
		ID:           uuid.New(),
		UserID:       userID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 500_000,
		PeriodStart:  time.Date(2026, time.May, 15, 0, 0, 0, 0, time.UTC),
		PeriodEnd:    already,
	}
	svc := newExtendTestSvc(sub)

	// Same target — idempotent no-op (PeriodEnd 已与入参相等）。
	_, updated, err := svc.ExtendSubscription(context.Background(), userID, already)
	if err != nil {
		t.Fatalf("idempotent ExtendSubscription error: %v", err)
	}
	if updated {
		t.Errorf("expected updated=false on idempotent no-op (period_end already at target)")
	}
	if !sub.PeriodEnd.Equal(already.UTC()) {
		t.Errorf("PeriodEnd should remain unchanged on idempotent no-op, got %v", sub.PeriodEnd)
	}
}

// TestExtendSubscription_PullsPeriodEndBackward 验证："对齐" 语义下，传入较早的
// newPeriodEnd 能向前缩短 period_end（退费场景：jifei isolateResource 给出 newDeadline <
// 当前订阅 PeriodEnd，两侧必须对齐到 newDeadline）。
// 原 only-forward CAS 语义会让这个便是 no-op，在退费场景下造成 ctl 与 ai-gateway
// 状态不一致；2026-05-24 语义升级后必须实际覆盖。
func TestExtendSubscription_PullsPeriodEndBackward(t *testing.T) {
	userID := uuid.New()
	original := time.Date(2026, time.September, 15, 0, 0, 0, 0, time.UTC)
	sub := &model.Subscription{
		ID:           uuid.New(),
		UserID:       userID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: 700_000,
		PeriodStart:  time.Date(2026, time.May, 15, 0, 0, 0, 0, time.UTC),
		PeriodEnd:    original,
	}
	svc := newExtendTestSvc(sub)

	// jifei 退费场景：newDeadline 为 7/15，早于当前 9/15。
	earlier := time.Date(2026, time.July, 15, 0, 0, 0, 0, time.UTC)
	got, updated, err := svc.ExtendSubscription(context.Background(), userID, earlier)
	if err != nil {
		t.Fatalf("backward ExtendSubscription error: %v", err)
	}
	if !updated {
		t.Errorf("expected updated=true when pulling period_end backward (refund alignment)")
	}
	if !got.PeriodEnd.Equal(earlier.UTC()) {
		t.Errorf("PeriodEnd should be aligned to earlier target, got %v want %v", got.PeriodEnd, earlier)
	}
	if got.TokenBalance != 700_000 {
		t.Errorf("token_balance must NOT change during refund alignment, got %d, want 700_000", got.TokenBalance)
	}
}

func TestExtendSubscription_NoActiveReturnsErr(t *testing.T) {
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()
	svc := NewSubscriptionService(subRepo, planRepo, nil)

	_, _, err := svc.ExtendSubscription(context.Background(), uuid.New(),
		time.Date(2026, time.September, 15, 0, 0, 0, 0, time.UTC))
	if err == nil {
		t.Fatalf("expected error when no active subscription, got nil")
	}
}
