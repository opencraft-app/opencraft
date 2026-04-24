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

	// Expire overdue subscriptions every 5 minutes
	s.runPeriodic(ctx, "expire-subscriptions", 5*time.Minute, s.expireOverdueSubscriptions)

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
