package gateway

import (
	"context"
	"time"
)

const tenantStatisticsStaleAfter = 30 * time.Minute

func (s *Service) GetTenantStatisticsSnapshot(ctx context.Context) (TenantStatisticsSnapshot, error) {
	stats, ok, err := s.store.GetTenantStatistics(ctx)
	if err != nil {
		return TenantStatisticsSnapshot{}, err
	}
	if !ok || stats.GeneratedAt.IsZero() {
		return TenantStatisticsSnapshot{Ready: false, Stale: true}, nil
	}
	total := stats.Total
	newTotal := stats.NewTotal
	pendingTotal := stats.PendingTotal
	activeTotal := stats.ActiveTotal
	disabledTotal := stats.DisabledTotal
	deletedTotal := stats.DeletedTotal
	generatedAt := stats.GeneratedAt.UTC()
	age := s.nowUTC().Sub(generatedAt)
	return TenantStatisticsSnapshot{
		Ready:         true,
		Total:         &total,
		NewTotal:      &newTotal,
		PendingTotal:  &pendingTotal,
		ActiveTotal:   &activeTotal,
		DisabledTotal: &disabledTotal,
		DeletedTotal:  &deletedTotal,
		GeneratedAt:   &generatedAt,
		Stale:         age > tenantStatisticsStaleAfter,
	}, nil
}

func (s *Service) GetBackgroundJobsOverview(ctx context.Context) (BackgroundJobsOverview, error) {
	if err := s.ensureDefaultWorkerJobs(ctx); err != nil {
		return BackgroundJobsOverview{}, err
	}
	jobs, err := s.store.ListWorkerJobs(ctx, WorkerJobListOptions{})
	if err != nil {
		return BackgroundJobsOverview{}, err
	}
	now := s.nowUTC()
	byokStats, err := s.store.GetBYOKSyncTaskStats(ctx, now)
	if err != nil {
		return BackgroundJobsOverview{}, err
	}
	observationStats, err := s.store.GetTenantObservationTaskStats(ctx, now)
	if err != nil {
		return BackgroundJobsOverview{}, err
	}
	return BackgroundJobsOverview{
		GeneratedAt:  now,
		Jobs:         visibleWorkerJobs(jobs),
		BYOKSync:     byokStats,
		Observations: observationStats,
	}, nil
}
