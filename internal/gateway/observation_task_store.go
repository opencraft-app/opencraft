package gateway

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

var ErrTenantObservationTaskLeaseLost = errors.New("tenant observation task lease lost")

func (s *Service) enqueueTenantObservationEvent(ctx context.Context, externalUserID string, setID string) {
	enqueueCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	_, _ = s.store.EnqueueTenantObservationTask(enqueueCtx, TenantObservationTask{
		ExternalUserID: strings.TrimSpace(externalUserID),
		SetID:          strings.TrimSpace(setID),
		Priority:       TenantObservationPriorityEvent,
		NextRunAt:      s.nowUTC(),
	})
}

func (s *MemoryStore) ListTenantObservationSeedTenants(_ context.Context, afterUserID string, limit int) ([]Tenant, error) {
	if limit <= 0 {
		limit = 1000
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]Tenant, 0, limit)
	for _, tenant := range s.tenants {
		if tenant.Backend != UserBackendNew || tenant.Status != TenantStatusActive || tenant.ExternalUserID <= afterUserID {
			continue
		}
		items = append(items, tenant)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ExternalUserID < items[j].ExternalUserID })
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *MemoryStore) EnqueueTenantObservationTask(_ context.Context, task TenantObservationTask) (TenantObservationTask, error) {
	task.ExternalUserID = strings.TrimSpace(task.ExternalUserID)
	if task.ExternalUserID == "" {
		return TenantObservationTask{}, fmt.Errorf("external user id is required")
	}
	now := time.Now().UTC()
	if task.Priority <= 0 {
		task.Priority = TenantObservationPriorityPeriodic
	}
	if task.NextRunAt.IsZero() {
		task.NextRunAt = now
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.observationTasks[task.ExternalUserID]
	if ok {
		live := current.Status == TenantObservationTaskStatusRunning && current.LeaseUntil.After(now)
		current.RequestedVersion++
		current.SetID = task.SetID
		if task.Priority > current.Priority {
			current.Priority = task.Priority
		}
		current.LastError = ""
		current.UpdatedAt = now
		if !live {
			current.Status = TenantObservationTaskStatusPending
			current.LeaseOwner = ""
			current.LeaseUntil = time.Time{}
			current.NextRunAt = task.NextRunAt
		}
		s.observationTasks[current.ExternalUserID] = current
		return current, nil
	}
	task.Status = TenantObservationTaskStatusPending
	task.RequestedVersion = 1
	task.CreatedAt = now
	task.UpdatedAt = now
	s.observationTasks[task.ExternalUserID] = task
	return task, nil
}

func (s *MemoryStore) SeedTenantObservationTask(_ context.Context, task TenantObservationTask) (TenantObservationTask, error) {
	task.ExternalUserID = strings.TrimSpace(task.ExternalUserID)
	if task.ExternalUserID == "" {
		return TenantObservationTask{}, fmt.Errorf("external user id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, ok := s.observationTasks[task.ExternalUserID]; ok {
		return current, nil
	}
	now := time.Now().UTC()
	if task.Priority <= 0 {
		task.Priority = TenantObservationPriorityPeriodic
	}
	if task.NextRunAt.IsZero() {
		task.NextRunAt = now
	}
	task.Status = TenantObservationTaskStatusPending
	task.RequestedVersion = 1
	task.CreatedAt = now
	task.UpdatedAt = now
	s.observationTasks[task.ExternalUserID] = task
	return task, nil
}

func (s *MemoryStore) GetTenantObservationTask(_ context.Context, externalUserID string) (TenantObservationTask, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	task, ok := s.observationTasks[strings.TrimSpace(externalUserID)]
	return task, ok, nil
}

func (s *MemoryStore) ListTenantObservationTasks(_ context.Context, opts TenantObservationTaskListOptions) ([]TenantObservationTask, error) {
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	tasks := make([]TenantObservationTask, 0, len(s.observationTasks))
	for _, task := range s.observationTasks {
		if taskSetExcluded(task.SetID, opts.ExcludeSetIDs) {
			continue
		}
		claimable := false
		switch task.Status {
		case TenantObservationTaskStatusPending, TenantObservationTaskStatusError, TenantObservationTaskStatusBlocked:
			claimable = task.NextRunAt.IsZero() || !task.NextRunAt.After(now)
		case TenantObservationTaskStatusRunning:
			claimable = task.LeaseUntil.IsZero() || !task.LeaseUntil.After(now)
		}
		if claimable {
			tasks = append(tasks, task)
		}
	}
	sort.Slice(tasks, func(i, j int) bool {
		if tasks[i].Priority != tasks[j].Priority {
			return tasks[i].Priority > tasks[j].Priority
		}
		if !tasks[i].NextRunAt.Equal(tasks[j].NextRunAt) {
			return tasks[i].NextRunAt.Before(tasks[j].NextRunAt)
		}
		return tasks[i].ExternalUserID < tasks[j].ExternalUserID
	})
	if opts.Limit > 0 && len(tasks) > opts.Limit {
		tasks = tasks[:opts.Limit]
	}
	return tasks, nil
}

func taskSetExcluded(setID string, excluded []string) bool {
	setID = strings.TrimSpace(setID)
	for _, candidate := range excluded {
		if strings.TrimSpace(candidate) == setID {
			return true
		}
	}
	return false
}

func (s *MemoryStore) GetTenantObservationTaskStats(_ context.Context, now time.Time) (TenantObservationQueueStats, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	stats := TenantObservationQueueStats{LastCalculatedAt: now}
	for _, task := range s.observationTasks {
		switch task.Status {
		case TenantObservationTaskStatusPending:
			stats.Pending++
		case TenantObservationTaskStatusRunning:
			stats.Running++
			if task.LeaseUntil.IsZero() || !task.LeaseUntil.After(now) {
				stats.ExpiredRunningLeases++
			}
		case TenantObservationTaskStatusError:
			stats.Error++
		case TenantObservationTaskStatusBlocked:
			stats.Blocked++
		}
		if task.AppliedVersion > 0 && task.LastError == "" && task.LastFinishedAt.After(stats.LastSuccessAt) {
			stats.LastSuccessAt = task.LastFinishedAt
		}
		if task.Status == TenantObservationTaskStatusError && task.LastFinishedAt.After(stats.LastFailureAt) {
			stats.LastFailureAt = task.LastFinishedAt
		}
		if task.Status != TenantObservationTaskStatusRunning && (task.NextRunAt.IsZero() || !task.NextRunAt.After(now)) {
			stats.Due++
			if stats.OldestDueAt.IsZero() || task.NextRunAt.Before(stats.OldestDueAt) {
				stats.OldestDueAt = task.NextRunAt
			}
		}
	}
	if !stats.OldestDueAt.IsZero() {
		stats.OldestDueAgeSeconds = nonNegativeSeconds(now.Sub(stats.OldestDueAt))
	}
	return stats, nil
}

func (s *MemoryStore) TryAcquireTenantObservationTask(_ context.Context, externalUserID string, owner string, ttl time.Duration, now time.Time) (TenantObservationTask, bool, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	owner = strings.TrimSpace(owner)
	if externalUserID == "" || owner == "" || ttl <= 0 {
		return TenantObservationTask{}, false, fmt.Errorf("tenant observation task acquire requires user, owner and ttl")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.observationTasks[externalUserID]
	if !ok {
		return TenantObservationTask{}, false, nil
	}
	if task.Status == TenantObservationTaskStatusRunning && task.LeaseUntil.After(now) && task.LeaseOwner != owner {
		return task, false, nil
	}
	if task.Status != TenantObservationTaskStatusRunning && !task.NextRunAt.IsZero() && task.NextRunAt.After(now) {
		return task, false, nil
	}
	task.Status = TenantObservationTaskStatusRunning
	task.LeaseOwner = owner
	task.LeaseUntil = now.Add(ttl)
	task.ProcessingVersion = task.RequestedVersion
	task.LastStartedAt = now
	task.UpdatedAt = now
	s.observationTasks[externalUserID] = task
	return task, true, nil
}

func (s *MemoryStore) RenewTenantObservationTaskLease(_ context.Context, task TenantObservationTask, ttl time.Duration, now time.Time) (bool, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.observationTasks[task.ExternalUserID]
	if !ok || ttl <= 0 || current.Status != TenantObservationTaskStatusRunning || current.LeaseOwner != task.LeaseOwner || current.ProcessingVersion != task.ProcessingVersion || !current.LeaseUntil.After(now) {
		return false, nil
	}
	current.LeaseUntil = now.Add(ttl)
	current.UpdatedAt = now
	s.observationTasks[current.ExternalUserID] = current
	return true, nil
}

func (s *MemoryStore) ReleaseTenantObservationTaskLease(_ context.Context, task TenantObservationTask, now time.Time) (bool, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.observationTasks[task.ExternalUserID]
	if !ok || current.Status != TenantObservationTaskStatusRunning || current.LeaseOwner != task.LeaseOwner || current.ProcessingVersion != task.ProcessingVersion {
		return false, nil
	}
	current.Status = TenantObservationTaskStatusPending
	current.LeaseOwner = ""
	current.LeaseUntil = time.Time{}
	current.NextRunAt = now
	current.UpdatedAt = now
	s.observationTasks[current.ExternalUserID] = current
	return true, nil
}

func (s *MemoryStore) CompleteTenantObservationTask(_ context.Context, task TenantObservationTask, completion TenantObservationTaskCompletion, now time.Time) (TenantObservationTask, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.observationTasks[task.ExternalUserID]
	if !ok {
		return TenantObservationTask{}, fmt.Errorf("tenant observation task for user %q not found", task.ExternalUserID)
	}
	if current.Status != TenantObservationTaskStatusRunning || current.LeaseOwner != task.LeaseOwner || current.ProcessingVersion != task.ProcessingVersion || !current.LeaseUntil.After(now) {
		return current, ErrTenantObservationTaskLeaseLost
	}
	newerIntent := current.RequestedVersion > task.ProcessingVersion
	current.LeaseOwner = ""
	current.LeaseUntil = time.Time{}
	current.LastFinishedAt = now
	current.UpdatedAt = now
	if completion.Succeeded {
		current.AppliedVersion = task.ProcessingVersion
	}
	if newerIntent {
		current.Status = TenantObservationTaskStatusPending
		current.NextRunAt = now
		current.LastError = ""
	} else if completion.Succeeded {
		current.Status = TenantObservationTaskStatusPending
		current.Attempts = 0
		current.Priority = TenantObservationPriorityPeriodic
		current.LastError = ""
		current.NextRunAt = completion.NextRunAt
	} else if completion.Blocked {
		current.Status = TenantObservationTaskStatusBlocked
		current.Priority = TenantObservationPriorityPeriodic
		current.LastError = completion.Message
		current.NextRunAt = completion.NextRunAt
	} else {
		current.Status = TenantObservationTaskStatusError
		current.Attempts++
		current.LastError = completion.Message
		current.NextRunAt = completion.NextRunAt
	}
	if current.NextRunAt.IsZero() {
		current.NextRunAt = now.Add(tenantObservationBackoff(current.Attempts))
	}
	s.observationTasks[current.ExternalUserID] = current
	return current, nil
}

func tenantObservationBackoff(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	if attempts > 30 {
		attempts = 30
	}
	return time.Duration(attempts) * time.Minute
}
