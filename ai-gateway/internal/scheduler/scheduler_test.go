package scheduler

import (
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// mockSubRepo implements repository.SubscriptionRepo for scheduler tests.
type mockSubRepo struct {
	expireCalled atomic.Int64
}

func (m *mockSubRepo) Create(sub *model.Subscription) error                         { return nil }
func (m *mockSubRepo) GetByID(id uuid.UUID) (*model.Subscription, error)            { return nil, nil }
func (m *mockSubRepo) GetActiveByUserID(uid uuid.UUID) (*model.Subscription, error) { return nil, nil }
func (m *mockSubRepo) DeductTokens(sid uuid.UUID, amount int64) error               { return nil }
func (m *mockSubRepo) DeductTokensToZero(sid uuid.UUID, amount int64) (int64, error) {
	return amount, nil
}
func (m *mockSubRepo) RefundTokens(sid uuid.UUID, amount int64) error     { return nil }
func (m *mockSubRepo) SetTokenBalance(sid uuid.UUID, balance int64) error { return nil }
func (m *mockSubRepo) CancelByUserID(uid uuid.UUID) error                 { return nil }
func (m *mockSubRepo) Update(sub *model.Subscription) error               { return nil }
func (m *mockSubRepo) CountActive() (int64, error)                        { return 0, nil }
func (m *mockSubRepo) SumActiveTokenBalance() (int64, error)              { return 0, nil }
func (m *mockSubRepo) ListRefreshCandidates(limit int) ([]repository.SubscriptionRefreshCandidate, error) {
	return nil, nil
}
func (m *mockSubRepo) RefreshByIDs(items []repository.SubscriptionRefreshItem) (int64, error) {
	return 0, nil
}
func (m *mockSubRepo) ExtendActivePeriodEnd(userID uuid.UUID, newPeriodEnd time.Time) (int64, *model.Subscription, error) {
	return 0, nil, nil
}

func (m *mockSubRepo) ExpireOverdue() (int64, error) {
	m.expireCalled.Add(1)
	return 2, nil
}

func (m *mockSubRepo) ListExpiredUserIDs() ([]uuid.UUID, error) {
	return nil, nil
}

func (m *mockSubRepo) DB() *gorm.DB { return nil }

// mockPlanRepo for SubscriptionService dependency.
type mockPlanRepo struct{}

func (m *mockPlanRepo) Create(plan *model.Plan) error              { return nil }
func (m *mockPlanRepo) GetByID(id uuid.UUID) (*model.Plan, error)  { return nil, nil }
func (m *mockPlanRepo) GetByName(name string) (*model.Plan, error) { return nil, nil }
func (m *mockPlanRepo) List(onlyActive bool) ([]model.Plan, error) { return nil, nil }
func (m *mockPlanRepo) Update(plan *model.Plan) error              { return nil }
func (m *mockPlanRepo) DB() *gorm.DB                               { return nil }

func TestScheduler_ExpireSubscriptionsJobIsDisabled(t *testing.T) {
	// expire-subscriptions 周期任务已在 scheduler.Start 中被注释停用
	// （详见 scheduler.go 注释，2026-06-24）。本测试守护这一行为：
	// Start() 之后等待一段足以触发"立即执行"分支的时间，subRepo.ExpireOverdue
	// 不应被调用任何一次。
	subRepo := &mockSubRepo{}
	planRepo := &mockPlanRepo{}
	subSvc := service.NewSubscriptionService(subRepo, planRepo, nil)

	sched := New(subSvc, nil, nil, nil)
	sched.Start()

	// Wait long enough for any scheduled "run on start" goroutine to fire.
	time.Sleep(100 * time.Millisecond)

	if called := subRepo.expireCalled.Load(); called != 0 {
		t.Errorf("expected ExpireOverdue NOT to be called (job disabled), got %d", called)
	}

	sched.Stop()
}

func TestScheduler_StopIsGraceful(t *testing.T) {
	subRepo := &mockSubRepo{}
	planRepo := &mockPlanRepo{}
	subSvc := service.NewSubscriptionService(subRepo, planRepo, nil)

	sched := New(subSvc, nil, nil, nil)
	sched.Start()

	// Stop should not hang
	done := make(chan struct{})
	go func() {
		sched.Stop()
		close(done)
	}()

	select {
	case <-done:
		// OK
	case <-time.After(2 * time.Second):
		t.Fatal("Stop() did not return within 2 seconds")
	}
}
