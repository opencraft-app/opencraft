package scheduler

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/config"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
)

// Scheduler runs background jobs on configurable intervals.
type Scheduler struct {
	subSvc        *service.SubscriptionService
	healthChecker *HealthChecker
	registryCfg   *config.RegistryConfig
	cancel        context.CancelFunc
	wg            sync.WaitGroup
}

// New creates a new Scheduler.
func New(subSvc *service.SubscriptionService, providerRepo repository.ProviderRepo, mappingRepo repository.ModelMappingRepo, registryCfg *config.RegistryConfig) *Scheduler {
	var hc *HealthChecker
	if registryCfg != nil && registryCfg.Token != "" {
		hc = NewHealthChecker(providerRepo, mappingRepo, registryCfg.StaleTimeoutS)
	}

	return &Scheduler{
		subSvc:        subSvc,
		healthChecker: hc,
		registryCfg:   registryCfg,
	}
}

// Start begins all background jobs. Call Stop() to gracefully shut down.
func (s *Scheduler) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel

	// expire-subscriptions 周期任务已停用（2026-06-24）：
	//   1. middleware/billing.go 已用 time.Now().After(sub.PeriodEnd) 兜底拦截
	//      到期订阅的 AI 调用，sub.Status='expired' 在拦截路径上是冗余信号；
	//   2. 翻成 expired 后 SubscriptionRepo.ExtendActivePeriodEnd 的
	//      WHERE status='active' 会失配，导致 ctl 续费/退费对齐 ai-gateway
	//      时拿不到目标行——典型故障：到期超过本 job 周期再续费的用户，
	//      ai-gateway sub 仍停在 expired，AI 服务无法恢复；
	//   3. 同步导致 token_balance 被清零，用户失去"看到最后剩余配额"的能力。
	// 保留 expireOverdueSubscriptions / service.ExpireOverdue / repo.ExpireOverdue
	// 等底层实现不动，方便未来按需恢复或重构（例如改成只翻 cancelled 不翻 expired）。
	// 上线前置条件：上海正式环境上线前确保没有 active 订阅自然到期未续。
	// s.runPeriodic(ctx, "expire-subscriptions", 5*time.Minute, s.expireOverdueSubscriptions)

	// Refresh monthly token balances every 1 hour (b3 same-day-of-month anchor;
	// see .tmp/aigateway-monthly-token-refresh-design.md §3.4 / §3.2).
	s.runPeriodic(ctx, "refresh-token-balances", 1*time.Hour, s.refreshTokenBalances)

	// Health check for registry providers
	if s.healthChecker != nil && s.registryCfg != nil {
		interval := time.Duration(s.registryCfg.HealthCheckIntervalS) * time.Second
		s.runPeriodic(ctx, "health-check", interval, s.healthChecker.Check)
	}

}

// Stop gracefully shuts down all background jobs.
func (s *Scheduler) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	s.wg.Wait()
	slog.Info("scheduler stopped")
}

// runPeriodic runs a job immediately, then repeats at the given interval.
func (s *Scheduler) runPeriodic(ctx context.Context, name string, interval time.Duration, job func()) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()

		// Run immediately on startup
		slog.Info("scheduler job starting", "job", name, "interval", interval)
		job()

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				slog.Info("scheduler job stopped", "job", name)
				return
			case <-ticker.C:
				job()
			}
		}
	}()
}

// expireOverdueSubscriptions marks expired subscriptions as expired.
func (s *Scheduler) expireOverdueSubscriptions() {
	count, err := s.subSvc.ExpireOverdue()
	if err != nil {
		slog.Error("failed to expire overdue subscriptions", "error", err)
		return
	}
	if count > 0 {
		slog.Info("expired overdue subscriptions", "count", count)
	}
}

// refreshTokenBalances triggers monthly token balance refresh per b3 same-day-of-month.
func (s *Scheduler) refreshTokenBalances() {
	count, err := s.subSvc.RefreshDueBalances(context.Background())
	if err != nil {
		slog.Error("failed to refresh token balances", "error", err)
		return
	}
	if count > 0 {
		slog.Info("refreshed token balances", "count", count)
	}
}
