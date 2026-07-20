package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel/attribute"
)

var defaultWorkerJobs = []WorkerJob{
	{Name: WorkerJobRefreshTenantObservations, Kind: WorkerJobRefreshTenantObservations, Enabled: true, IntervalSeconds: 300},
	{Name: WorkerJobRefreshSetCapacity, Kind: WorkerJobRefreshSetCapacity, Enabled: true, IntervalSeconds: 300},
	{Name: WorkerJobReconcileSetCapacity, Kind: WorkerJobReconcileSetCapacity, Enabled: true, IntervalSeconds: 60},
	{Name: WorkerJobCheckChannelDrift, Kind: WorkerJobCheckChannelDrift, Enabled: true, IntervalSeconds: 300},
	{Name: WorkerJobCheckSetAdmission, Kind: WorkerJobCheckSetAdmission, Enabled: true, IntervalSeconds: 60},
	{Name: WorkerJobCheckSetAdminHealth, Kind: WorkerJobCheckSetAdminHealth, Enabled: true, IntervalSeconds: 30},
	{Name: WorkerJobSyncPlans, Kind: WorkerJobSyncPlans, Enabled: true, IntervalSeconds: 30},
	{Name: WorkerJobReconcileSetFacts, Kind: WorkerJobReconcileSetFacts, Enabled: true, IntervalSeconds: 60},
	{Name: WorkerJobRetryBYOKSync, Kind: WorkerJobRetryBYOKSync, Enabled: false, IntervalSeconds: 60},
	{Name: WorkerJobReconcileGroupRatios, Kind: WorkerJobReconcileGroupRatios, Enabled: true, IntervalSeconds: 30},
	{Name: WorkerJobCleanupPending, Kind: WorkerJobCleanupPending, Enabled: true, IntervalSeconds: 600},
	{Name: WorkerJobRefreshTenantStatistics, Kind: WorkerJobRefreshTenantStatistics, Enabled: true, IntervalSeconds: 600},
	{Name: WorkerJobPublishAPIKeyRoutes, Kind: WorkerJobPublishAPIKeyRoutes, Enabled: true, IntervalSeconds: 30},
	{Name: WorkerJobRebuildAPIKeyRoutes, Kind: WorkerJobRebuildAPIKeyRoutes, Enabled: true, IntervalSeconds: idleAPIKeyRouteRebuildInterval},
	{Name: WorkerJobReconcileShardExpansions, Kind: WorkerJobReconcileShardExpansions, Enabled: true, IntervalSeconds: 30},
	{Name: WorkerJobReconcileReleaseCampaigns, Kind: WorkerJobReconcileReleaseCampaigns, Enabled: true, IntervalSeconds: 10},
}

const defaultBYOKSyncBatchSize = 1000

const defaultChannelDriftBatchSize = 10

func (s *Service) GetOperationalOverview(ctx context.Context) (OperationalOverview, error) {
	now := s.nowUTC()
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return OperationalOverview{}, err
	}
	userCounts := projectedUserCountsBySet(sets)
	facts, err := s.store.ListSetReconcileFacts(ctx, SetReconcileFactListOptions{Limit: 200})
	if err != nil {
		return OperationalOverview{}, err
	}
	requests, err := s.store.ListSetProvisionRequests(ctx, SetProvisionRequestListOptions{Limit: 200})
	if err != nil {
		return OperationalOverview{}, err
	}
	bundles, err := s.desiredChannelBundles(ctx)
	if err != nil {
		return OperationalOverview{}, err
	}
	lastFactError := map[string]SetReconcileFact{}
	for _, fact := range facts {
		if fact.Status != SetReconcileStatusError || fact.LastError == "" {
			continue
		}
		if existing, ok := lastFactError[fact.SetID]; !ok || fact.UpdatedAt.After(existing.UpdatedAt) {
			lastFactError[fact.SetID] = fact
		}
	}
	lastProvision := map[string]SetProvisionRequest{}
	for _, request := range requests {
		if existing, ok := lastProvision[request.SetID]; !ok || request.UpdatedAt.After(existing.UpdatedAt) {
			lastProvision[request.SetID] = request
		}
	}
	activeSets := map[string]bool{}

	overview := OperationalOverview{GeneratedAt: now, TrafficErrors: s.trafficMetrics.ErrorSummaries()}
	for _, set := range sets {
		ready := setReadyForServing(set)
		if set.Status == SetStatusActive {
			overview.Totals.ActiveSets++
			activeSets[set.ID] = true
		}
		if ready {
			overview.Totals.ReadySets++
		}
		if set.RuntimeHADesiredReplicas > 0 && set.RuntimeHAStatus != SetRuntimeHAHealthy {
			overview.Totals.RuntimeHADegradedSets++
		}
		users := userCounts[set.ID]
		overview.Totals.Users += users
		capacity := setCapacitySnapshot(set, users, 0)
		if ready {
			overview.Totals.AvailableUserSlots += capacity.FreeUsers
		}
		if capacity.Status == "full" {
			overview.Totals.FullSets++
		}
		item := SetOverview{
			ID:                       set.ID,
			Name:                     set.Name,
			Status:                   set.Status,
			Setup:                    set.Setup,
			Ready:                    ready,
			UserCount:                users,
			MaxUsers:                 capacity.MaxUsers,
			WarnUsers:                capacity.WarnUsers,
			ReservedUsers:            capacity.ReservedUsers,
			FreeUsers:                capacity.FreeUsers,
			AcceptingNewUsers:        ready && capacity.AcceptingNewUsers,
			CapacityStatus:           capacity.Status,
			CapacityUpdatedAt:        set.CapacityUpdatedAt,
			AdmissionStatus:          firstNonEmpty(set.AdmissionStatus, SetAdmissionStatusPending),
			AdmissionError:           set.AdmissionError,
			AdmissionCheckedAt:       set.AdmissionCheckedAt,
			AdminHealthStatus:        firstNonEmpty(set.AdminHealthStatus, "unknown"),
			AdminHealthError:         set.AdminHealthError,
			AdminHealthCheckedAt:     set.AdminHealthCheckedAt,
			RuntimeHAStatus:          set.RuntimeHAStatus,
			RuntimeHADesiredReplicas: set.RuntimeHADesiredReplicas,
			RuntimeHAReadyReplicas:   set.RuntimeHAReadyReplicas,
			RuntimeHAPDBHealthy:      set.RuntimeHAPDBHealthy,
			RuntimeHATopologyKey:     set.RuntimeHATopologyKey,
			RuntimeHAError:           set.RuntimeHAError,
			RuntimeHACheckedAt:       set.RuntimeHACheckedAt,
			UpdatedAt:                set.UpdatedAt,
		}
		if set.AdminHealthStatus == SetAdminHealthUnhealthy {
			overview.Alerts = append(overview.Alerts, OperationalAlert{
				Kind: "set_admin_unhealthy", Severity: "critical", Message: set.AdminHealthError, SetID: set.ID, CreatedAt: set.AdminHealthCheckedAt,
			})
		}
		if set.RuntimeHADesiredReplicas > 0 && set.RuntimeHAStatus != SetRuntimeHAHealthy {
			overview.Alerts = append(overview.Alerts, OperationalAlert{
				Kind: "set_runtime_ha_degraded", Severity: "critical", Message: firstNonEmpty(set.RuntimeHAError, "Set traffic runtime 高可用未就绪"), SetID: set.ID, CreatedAt: firstNonZeroTime(set.RuntimeHACheckedAt, now),
			})
		}
		if fact, ok := lastFactError[set.ID]; ok {
			item.LastError = fact.LastError
			item.LastErrorAt = fact.UpdatedAt
			item.LastReconciledAt = fact.LastReconciledAt
			overview.Alerts = append(overview.Alerts, OperationalAlert{
				Kind: "set_reconcile_error", Severity: "critical", Message: fact.LastError, SetID: set.ID, CreatedAt: fact.UpdatedAt,
			})
		}
		if request, ok := lastProvision[set.ID]; ok {
			item.LastProvisionStatus = request.Status
			if request.LastError != "" && item.LastError == "" {
				item.LastError = request.LastError
				item.LastErrorAt = request.UpdatedAt
			}
			if request.Status == SetProvisionStatusError {
				overview.Alerts = append(overview.Alerts, OperationalAlert{
					Kind: "set_provision_error", Severity: "critical", Message: request.LastError, SetID: set.ID, CreatedAt: request.UpdatedAt,
				})
			}
		}
		if !ready {
			overview.Alerts = append(overview.Alerts, OperationalAlert{
				Kind: "set_unready", Severity: "warning", Message: "Set 当前不可服务", SetID: set.ID, CreatedAt: now,
			})
		}
		switch capacity.Status {
		case "full":
			overview.Alerts = append(overview.Alerts, OperationalAlert{
				Kind: "set_capacity_full", Severity: "critical", Message: "Set 用户水位已满", SetID: set.ID, CreatedAt: now,
			})
		case "warn":
			overview.Alerts = append(overview.Alerts, OperationalAlert{
				Kind: "set_capacity_warn", Severity: "warning", Message: "Set 用户水位接近上限", SetID: set.ID, CreatedAt: now,
			})
		}
		overview.Sets = append(overview.Sets, item)
	}
	overview.Totals.Sets = len(sets)

	for _, bundle := range bundles {
		states, err := s.store.ListChannelBundleSyncStates(ctx, bundle.ID)
		if err != nil {
			return OperationalOverview{}, err
		}
		summary := ChannelBundleOverview{BundleID: bundle.ID, Name: bundle.Name, Fingerprint: bundle.Fingerprint}
		for _, state := range states {
			if !activeSets[state.SetID] {
				continue
			}
			if state.LastCheckedAt.After(summary.LastCheckedAt) {
				summary.LastCheckedAt = state.LastCheckedAt
			}
			if state.LastError != "" {
				summary.LastError = state.LastError
			}
			switch state.Status {
			case ChannelSyncStatusSynced:
				summary.SyncedSets++
			case ChannelSyncStatusPending:
				summary.PendingSets++
			case ChannelSyncStatusDrift, ChannelSyncStatusConflict:
				summary.DriftSets++
			case ChannelSyncStatusError:
				summary.ErrorSets++
			case ChannelSyncStatusSkipped:
				summary.SkippedSets++
			}
		}
		overview.Totals.ChannelDrifts += summary.DriftSets
		if summary.DriftSets > 0 {
			overview.Alerts = append(overview.Alerts, OperationalAlert{
				Kind: "channel_drift", Severity: "warning", Message: "渠道配置存在漂移", BundleID: bundle.ID, CreatedAt: summary.LastCheckedAt,
			})
		}
		if summary.ErrorSets > 0 {
			overview.Alerts = append(overview.Alerts, OperationalAlert{
				Kind: "channel_sync_error", Severity: "critical", Message: firstNonEmpty(summary.LastError, "渠道同步失败"), BundleID: bundle.ID, CreatedAt: summary.LastCheckedAt,
			})
		}
		overview.ChannelBundles = append(overview.ChannelBundles, summary)
	}
	sort.Slice(overview.Alerts, func(i, j int) bool {
		return overview.Alerts[i].CreatedAt.After(overview.Alerts[j].CreatedAt)
	})
	return overview, nil
}

func nonNegativeSeconds(d time.Duration) int64 {
	if d <= 0 {
		return 0
	}
	return int64(d.Seconds())
}

func firstNonZeroTime(values ...time.Time) time.Time {
	for _, value := range values {
		if !value.IsZero() {
			return value
		}
	}
	return time.Time{}
}

func (s *Service) ListWorkerJobs(ctx context.Context) ([]WorkerJob, error) {
	if err := s.ensureDefaultWorkerJobs(ctx); err != nil {
		return nil, err
	}
	jobs, err := s.store.ListWorkerJobs(ctx, WorkerJobListOptions{})
	if err != nil {
		return nil, err
	}
	return visibleWorkerJobs(jobs), nil
}

func visibleWorkerJobs(jobs []WorkerJob) []WorkerJob {
	visible := make([]WorkerJob, 0, len(jobs))
	for _, job := range jobs {
		if job.Name == WorkerJobRetryBYOKSync {
			continue
		}
		visible = append(visible, job)
	}
	return visible
}

func (s *Service) RunWorkerJobNow(ctx context.Context, name string) (WorkerJobRun, error) {
	if err := s.ensureDefaultWorkerJobs(ctx); err != nil {
		return WorkerJobRun{}, err
	}
	job, ok, err := s.store.GetWorkerJob(ctx, strings.TrimSpace(name))
	if err != nil {
		return WorkerJobRun{}, err
	}
	if !ok {
		return WorkerJobRun{}, fmt.Errorf("job %q not found", name)
	}
	return s.executeWorkerJob(ctx, job, "manual")
}

func (s *Service) QueueWorkerJobNow(ctx context.Context, name string) (WorkerJobRun, error) {
	if err := s.ensureDefaultWorkerJobs(ctx); err != nil {
		return WorkerJobRun{}, err
	}
	name = strings.TrimSpace(name)
	job, ok, err := s.store.GetWorkerJob(ctx, name)
	if err != nil {
		return WorkerJobRun{}, err
	}
	if !ok {
		return WorkerJobRun{}, fmt.Errorf("job %q not found", name)
	}
	if !job.Enabled {
		return WorkerJobRun{}, fmt.Errorf("job %q is disabled", name)
	}
	now := s.nowUTC()
	_, queued, err := s.store.QueueWorkerJob(ctx, name, name == WorkerJobRebuildAPIKeyRoutes, now)
	if err != nil {
		return WorkerJobRun{}, err
	}
	if !queued {
		return WorkerJobRun{}, fmt.Errorf("job %q is already running", name)
	}
	return WorkerJobRun{
		ID:         fmt.Sprintf("%s-queued-%d", job.Name, now.UnixNano()),
		JobName:    job.Name,
		Owner:      "manual",
		Status:     WorkerJobStatusQueued,
		StartedAt:  now,
		FinishedAt: now,
		Detail:     "queued for worker",
	}, nil
}

func (s *Service) ListWorkerJobRuns(ctx context.Context, name string, startedAtOrAfter time.Time, limit int) ([]WorkerJobRun, bool, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, false, nil
	}
	if err := s.ensureDefaultWorkerJobs(ctx); err != nil {
		return nil, false, err
	}
	if _, ok, err := s.store.GetWorkerJob(ctx, name); err != nil || !ok {
		return nil, ok, err
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	runs, err := s.store.ListWorkerJobRuns(ctx, WorkerJobRunListOptions{
		JobName: name, StartedAtOrAfter: startedAtOrAfter.UTC(), Limit: limit,
	})
	return runs, true, err
}

func (s *Service) RetryFailedBYOKSyncTasks(ctx context.Context, limit int) (int, error) {
	if limit <= 0 {
		limit = defaultBYOKSyncBatchSize
	}
	return s.store.RequeueFailedBYOKSyncTasks(ctx, limit, s.nowUTC())
}

func (s *Service) RunDueWorkerJobs(ctx context.Context, owner string, leaseTTL time.Duration) ([]WorkerJobRun, error) {
	if err := s.ensureDefaultWorkerJobs(ctx); err != nil {
		return nil, err
	}
	if leaseTTL <= 0 {
		leaseTTL = time.Minute
	}
	jobs, err := s.store.ListWorkerJobs(ctx, WorkerJobListOptions{EnabledOnly: true})
	if err != nil {
		return nil, err
	}
	now := s.nowUTC()
	runs := []WorkerJobRun{}
	for _, job := range jobs {
		if !job.NextRunAt.IsZero() && job.NextRunAt.After(now) {
			continue
		}
		leased, ok, err := s.store.TryAcquireWorkerJobLease(ctx, job.Name, owner, leaseTTL, now)
		if err != nil {
			return runs, err
		}
		if !ok {
			continue
		}
		run, err := s.executeWorkerJob(ctx, leased, owner)
		runs = append(runs, run)
		if err != nil {
			continue
		}
	}
	return runs, nil
}

func (s *Service) ensureDefaultWorkerJobs(ctx context.Context) error {
	for _, job := range defaultWorkerJobs {
		if existing, ok, err := s.store.GetWorkerJob(ctx, job.Name); err != nil {
			return err
		} else if ok {
			if shouldTuneDefaultWorkerJob(existing, job) {
				existing.Kind = firstNonEmpty(existing.Kind, job.Kind)
				existing.IntervalSeconds = job.IntervalSeconds
				existing.Enabled = job.Enabled
				if err := s.store.SaveWorkerJob(ctx, existing); err != nil {
					return err
				}
			}
			continue
		}
		job.Status = WorkerJobStatusIdle
		if job.NextRunAt.IsZero() {
			job.NextRunAt = s.nowUTC()
		}
		if err := s.store.SaveWorkerJob(ctx, job); err != nil {
			return err
		}
	}
	return nil
}

func shouldTuneDefaultWorkerJob(existing WorkerJob, desired WorkerJob) bool {
	if existing.Name != WorkerJobRetryBYOKSync {
		return false
	}
	return existing.IntervalSeconds != desired.IntervalSeconds || existing.Kind == "" || existing.Enabled != desired.Enabled
}

func (s *Service) executeWorkerJob(ctx context.Context, job WorkerJob, owner string) (WorkerJobRun, error) {
	job, run, err := s.runWorkerJobBodySafely(ctx, job, owner)
	_ = s.store.SaveWorkerJob(ctx, job)
	if saveErr := s.store.SaveWorkerJobRun(ctx, run); saveErr != nil && err == nil {
		err = saveErr
	}
	return run, err
}

func (s *Service) runWorkerJobBodySafely(ctx context.Context, job WorkerJob, owner string) (updated WorkerJob, run WorkerJobRun, err error) {
	start := s.nowUTC()
	run = WorkerJobRun{
		ID:        fmt.Sprintf("%s-%d", job.Name, start.UnixNano()),
		JobName:   job.Name,
		Owner:     owner,
		Status:    WorkerJobStatusSuccess,
		StartedAt: start,
	}
	var detail string
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				err = fmt.Errorf("worker job panic: %v", recovered)
			}
		}()
		detail, err = s.runWorkerJobBody(ctx, &job)
	}()
	run.Detail = detail
	run.FinishedAt = s.nowUTC()
	if err != nil {
		run.Status = WorkerJobStatusError
		run.Error = err.Error()
	}
	if job.IntervalSeconds > 0 {
		job.NextRunAt = run.FinishedAt.Add(time.Duration(job.IntervalSeconds) * time.Second)
	} else {
		job.NextRunAt = run.FinishedAt.Add(5 * time.Minute)
	}
	return job, run, err
}

func (s *Service) runWorkerJobBody(ctx context.Context, job *WorkerJob) (string, error) {
	switch job.Name {
	case WorkerJobRefreshTenantObservations:
		limit := s.options.WorkerObservationSeedBatch
		if limit <= 0 {
			limit = 1000
		}
		result, err := s.refreshTenantObservationsJob(ctx, job, limit)
		job.Cursor = result.nextCursor
		if result.wrapped {
			job.IntervalSeconds = 3600
		} else {
			job.IntervalSeconds = 1
		}
		return fmt.Sprintf("seeded=%d failed=%d next_cursor=%q wrapped=%t", result.refreshed, result.failed, result.nextCursor, result.wrapped), err
	case WorkerJobRefreshSetCapacity:
		sets, err := s.refreshSetCapacityProjectionJob(ctx)
		return fmt.Sprintf("sets=%d", sets), err
	case WorkerJobReconcileSetCapacity:
		if !s.options.WorkerSetCapacityEnabled {
			return "disabled", nil
		}
		result, err := s.ReconcileSetCapacity(ctx, s.options.WorkerSetCapacityPolicy)
		return fmt.Sprintf("ready_sets=%d ready_free=%d capacity_sets=%d capacity_free=%d required_free=%d inflight=%d created=%d deficit=%d", result.ReadySets, result.ReadyFreeUsers, result.CapacitySets, result.CapacityFreeUsers, result.RequiredFreeUsers, result.InflightRequests, result.CreatedRequests, result.DeficitUsers), err
	case WorkerJobCheckChannelDrift:
		checked, failed, err := s.checkChannelDriftJob(ctx, job)
		return fmt.Sprintf("checked=%d failed=%d", checked, failed), err
	case WorkerJobCheckSetAdmission:
		checked, passed, failed, err := s.checkSetAdmissionJob(ctx)
		return fmt.Sprintf("checked=%d passed=%d failed=%d", checked, passed, failed), err
	case WorkerJobCheckSetAdminHealth:
		checked, failed, err := s.checkSetAdminHealthJob(ctx, job)
		return fmt.Sprintf("checked=%d failed=%d", checked, failed), err
	case WorkerJobSyncPlans:
		synced, failed, err := s.syncPlansJob(ctx)
		return fmt.Sprintf("synced=%d failed=%d", synced, failed), err
	case WorkerJobReconcileSetFacts:
		result, err := s.ReconcileSetReconcileFacts(ctx, ReconcileSetReconcileFactsInput{Limit: 25})
		return fmt.Sprintf("scanned=%d managed=%d failed=%d", result.Scanned, result.Managed, result.Failed), err
	case WorkerJobRetryBYOKSync:
		synced, failed, err := s.retryBYOKSyncJob(ctx, job.LeaseOwner)
		return fmt.Sprintf("synced=%d failed=%d", synced, failed), err
	case WorkerJobReconcileGroupRatios:
		synced, failed, err := s.reconcileGroupRatiosJob(ctx, job)
		return fmt.Sprintf("synced=%d failed=%d", synced, failed), err
	case WorkerJobCleanupPending:
		cleaned, err := s.cleanupPendingJob(ctx)
		return fmt.Sprintf("cleaned=%d", cleaned), err
	case WorkerJobRefreshTenantStatistics:
		refreshCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		committed, err := s.store.RefreshTenantStatistics(refreshCtx, job.Name, job.LeaseOwner, s.nowUTC())
		if err != nil {
			return "", err
		}
		if !committed {
			return "", fmt.Errorf("tenant statistics worker job lease lost")
		}
		stats, ok, err := s.store.GetTenantStatistics(refreshCtx)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", fmt.Errorf("tenant statistics snapshot missing after refresh")
		}
		return fmt.Sprintf("total=%d new=%d pending=%d active=%d disabled=%d deleted=%d", stats.Total, stats.NewTotal, stats.PendingTotal, stats.ActiveTotal, stats.DisabledTotal, stats.DeletedTotal), nil
	case WorkerJobReconcileShardExpansions:
		result, err := s.ReconcileShardExpansions(ctx, 25)
		return fmt.Sprintf("scanned=%d advanced=%d failed=%d", result.Scanned, result.Advanced, result.Failed), err
	case WorkerJobPublishAPIKeyRoutes:
		published, failed, err := s.publishAPIKeyRoutesJob(ctx, 200)
		return fmt.Sprintf("published=%d failed=%d", published, failed), err
	case WorkerJobRebuildAPIKeyRoutes:
		result, err := s.rebuildAPIKeyRoutesJob(ctx, job, s.options.WorkerKeyRouteRebuildBatch)
		return fmt.Sprintf("restored=%d runtime_restored=%d completed=%t after_key_id=%q", result.Restored, result.RuntimeRestored, result.Completed, result.AfterKeyID), err
	case WorkerJobReconcileReleaseCampaigns:
		soaks, soakErr := s.ReconcileReleaseRolloutSoaks(ctx, 50)
		campaigns, campaignErr := s.ReconcileReleaseCampaigns(ctx, 25)
		if soakErr != nil {
			return fmt.Sprintf("soaks=%d campaigns=%d", soaks, campaigns), soakErr
		}
		return fmt.Sprintf("soaks=%d campaigns=%d", soaks, campaigns), campaignErr
	default:
		return "", fmt.Errorf("unknown worker job %q", job.Name)
	}
}

func (s *Service) publishAPIKeyRoutesJob(ctx context.Context, limit int) (int, int, error) {
	if s.options.KeyRouteCache == nil {
		return 0, 0, fmt.Errorf("key route cache is required")
	}
	bindings, err := s.store.ListAPIKeyBindingsByStatus(ctx, APIKeyStatusRoutePending, limit)
	if err != nil {
		return 0, 0, err
	}
	published := 0
	failed := 0
	var firstErr error
	for _, binding := range bindings {
		set, ok, publishErr := s.store.GetSet(ctx, binding.SetID)
		if publishErr == nil && !ok {
			publishErr = fmt.Errorf("set %q not found", binding.SetID)
		}
		if publishErr == nil {
			publishErr = s.cacheTrafficRouteSnapshotForBinding(ctx, binding, set)
		}
		if publishErr != nil {
			failed++
			_, _ = s.store.TransitionAPIKeyBinding(context.WithoutCancel(ctx), binding.ExternalKeyID,
				APIKeyStatusRoutePending, APIKeyStatusRoutePending, "", 0, publishErr.Error(), s.nowUTC())
			if firstErr == nil {
				firstErr = publishErr
			}
			continue
		}
		if _, transitionErr := s.store.TransitionAPIKeyBinding(ctx, binding.ExternalKeyID,
			APIKeyStatusRoutePending, APIKeyStatusActive, "", 0, "", s.nowUTC()); transitionErr != nil {
			failed++
			if firstErr == nil {
				firstErr = transitionErr
			}
			continue
		}
		published++
	}
	return published, failed, firstErr
}

func (s *Service) reconcileGroupRatiosJob(ctx context.Context, job *WorkerJob) (int, int, error) {
	const batchSize = 25
	states, err := s.store.ListGroupRatioApplyStates(ctx, GroupRatioApplyStateListOptions{
		Statuses:   []string{GroupRatioApplyStatusPending, GroupRatioApplyStatusError},
		AfterSetID: strings.TrimSpace(job.Cursor),
		Limit:      batchSize,
	})
	if err != nil {
		return 0, 0, err
	}
	if len(states) == 0 && strings.TrimSpace(job.Cursor) != "" {
		job.Cursor = ""
		states, err = s.store.ListGroupRatioApplyStates(ctx, GroupRatioApplyStateListOptions{
			Statuses: []string{GroupRatioApplyStatusPending, GroupRatioApplyStatusError},
			Limit:    batchSize,
		})
		if err != nil {
			return 0, 0, err
		}
	}
	synced, failed := 0, 0
	var firstErr error
	for _, state := range states {
		job.Cursor = state.SetID
		set, ok, err := s.store.GetSet(ctx, state.SetID)
		if err == nil && !ok {
			err = fmt.Errorf("set %q not found", state.SetID)
		}
		if err == nil && (set.Status != SetStatusActive || !set.Setup || set.AdminUserID <= 0 || set.AdminAccessToken == "") {
			continue
		}
		if err == nil {
			_, err = s.reconcileSetGroupRatios(ctx, set)
		}
		if err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		synced++
	}
	if len(states) < batchSize {
		job.Cursor = ""
	}
	return synced, failed, firstErr
}

func (s *Service) checkSetAdminHealthJob(ctx context.Context, job *WorkerJob) (int, int, error) {
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return 0, 0, err
	}
	sort.Slice(sets, func(i, j int) bool { return sets[i].ID < sets[j].ID })
	cursor := strings.TrimSpace(job.Cursor)
	start := sort.Search(len(sets), func(i int) bool { return sets[i].ID > cursor })
	limit := s.options.WorkerSetAdminHealthBatch
	if limit <= 0 {
		limit = 25
	}
	timeout := s.options.WorkerSetAdminHealthTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	checked, failed := 0, 0
	var firstErr error
	processed := 0
	for i := start; i < len(sets) && processed < limit; i++ {
		set := sets[i]
		job.Cursor = set.ID
		if set.Status != SetStatusActive || !set.Setup || set.AdminUserID <= 0 || set.AdminAccessToken == "" {
			continue
		}
		processed++
		checked++
		probeCtx, cancel := context.WithTimeout(ctx, timeout)
		_, probeErr := s.newAPIClient(set.BaseURL).FindUser(probeCtx, adminAuthForSet(set), set.AdminUsername)
		cancel()
		now := s.nowUTC()
		set.AdminHealthCheckedAt = now
		if probeErr == nil {
			set.AdminHealthStatus = SetAdminHealthHealthy
			set.AdminHealthConsecutiveFailures = 0
			set.AdminHealthError = ""
			set.AdminHealthLastSuccessAt = now
		} else {
			failed++
			set.AdminHealthConsecutiveFailures++
			set.AdminHealthError = probeErr.Error()
			set.AdminHealthStatus = SetAdminHealthDegraded
			if set.AdminHealthConsecutiveFailures >= 2 {
				set.AdminHealthStatus = SetAdminHealthUnhealthy
			}
			if firstErr == nil {
				firstErr = fmt.Errorf("set %s admin database health: %w", set.ID, probeErr)
			}
		}
		if err := s.store.SaveSet(ctx, set); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if start >= len(sets) || start+processed >= len(sets) {
		job.Cursor = ""
	}
	return checked, failed, firstErr
}

func (s *Service) checkSetAdmissionJob(ctx context.Context) (int, int, int, error) {
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return 0, 0, 0, err
	}
	checked, passed, failed := 0, 0, 0
	var firstErr error
	for _, set := range sets {
		if set.Status != SetStatusActive || !set.Setup {
			continue
		}
		managed, err := s.setProvisionRuntimeManaged(ctx, set.ID)
		if err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if !managed {
			continue
		}
		checked++
		result, err := s.CheckSetAdmission(ctx, set.ID)
		if err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if result.Status == SetAdmissionStatusPassed {
			passed++
		}
	}
	return checked, passed, failed, firstErr
}

type tenantObservationJobResult struct {
	refreshed  int
	failed     int
	nextCursor string
	wrapped    bool
}

func (s *Service) refreshTenantObservationsJob(ctx context.Context, job *WorkerJob, limit int) (tenantObservationJobResult, error) {
	result := tenantObservationJobResult{}
	if limit <= 0 {
		limit = 1000
	}
	cursor := ""
	if job != nil {
		cursor = strings.TrimSpace(job.Cursor)
	}
	tenants, err := s.store.ListTenantObservationSeedTenants(ctx, cursor, limit+1)
	if err != nil {
		return result, err
	}
	if len(tenants) == 0 && cursor != "" {
		cursor = ""
		tenants, err = s.store.ListTenantObservationSeedTenants(ctx, cursor, limit+1)
		if err != nil {
			return result, err
		}
	}
	hasMore := len(tenants) > limit
	if hasMore {
		tenants = tenants[:limit]
	}
	result.wrapped = !hasMore
	if hasMore && len(tenants) > 0 {
		result.nextCursor = tenants[len(tenants)-1].ExternalUserID
	}
	var firstErr error
	for _, tenant := range tenants {
		if _, err := s.store.SeedTenantObservationTask(ctx, TenantObservationTask{
			ExternalUserID: tenant.ExternalUserID,
			SetID:          tenant.SetID,
			Priority:       TenantObservationPriorityPeriodic,
			NextRunAt:      s.nowUTC(),
		}); err != nil {
			result.failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		result.refreshed++
	}
	return result, firstErr
}

func (s *Service) refreshSetCapacityProjectionJob(ctx context.Context) (int, error) {
	return s.capacityPicker().RefreshObservedCounts(ctx)
}

type channelDriftWorkItem struct {
	bundleID string
	setID    string
}

type channelDriftCursor struct {
	Version  int    `json:"v"`
	BundleID string `json:"bundle_id"`
	SetID    string `json:"set_id"`
}

func encodeChannelDriftCursor(item channelDriftWorkItem) string {
	raw, err := json.Marshal(channelDriftCursor{Version: 1, BundleID: item.bundleID, SetID: item.setID})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeChannelDriftCursor(value string) (channelDriftCursor, bool) {
	if strings.TrimSpace(value) == "" {
		return channelDriftCursor{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return channelDriftCursor{}, false
	}
	var cursor channelDriftCursor
	if err := json.Unmarshal(raw, &cursor); err != nil || cursor.Version != 1 || cursor.BundleID == "" || cursor.SetID == "" {
		return channelDriftCursor{}, false
	}
	return cursor, true
}

func (s *Service) checkChannelDriftJob(ctx context.Context, job *WorkerJob) (int, int, error) {
	bundles, err := s.desiredChannelBundles(ctx)
	if err != nil {
		return 0, 0, err
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return 0, 0, err
	}
	sort.Slice(bundles, func(i, j int) bool { return bundles[i].ID < bundles[j].ID })
	sort.Slice(sets, func(i, j int) bool { return sets[i].ID < sets[j].ID })
	items := make([]channelDriftWorkItem, 0, len(bundles)*len(sets))
	for _, bundle := range bundles {
		for _, set := range sets {
			if set.Status == SetStatusActive && set.Setup {
				items = append(items, channelDriftWorkItem{bundleID: bundle.ID, setID: set.ID})
			}
		}
	}
	if len(items) == 0 {
		job.Cursor = ""
		return 0, 0, nil
	}
	start := 0
	if cursor, ok := decodeChannelDriftCursor(job.Cursor); ok {
		start = sort.Search(len(items), func(i int) bool {
			return items[i].bundleID > cursor.BundleID || (items[i].bundleID == cursor.BundleID && items[i].setID > cursor.SetID)
		})
		if start >= len(items) {
			job.Cursor = ""
			return 0, 0, nil
		}
	} else if job.Cursor != "" {
		job.Cursor = ""
	}
	limit := s.options.WorkerChannelDriftBatch
	if limit <= 0 {
		limit = defaultChannelDriftBatchSize
	}
	timeout := s.options.WorkerChannelDriftTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	end := start + limit
	if end > len(items) {
		end = len(items)
	}
	checked, failed := 0, 0
	var firstErr error
	for _, item := range items[start:end] {
		checked++
		itemCtx, cancel := context.WithTimeout(ctx, timeout)
		_, itemErr := s.PlanChannelBundleForSet(itemCtx, item.bundleID, item.setID, ChannelBundlePlanOptions{})
		cancel()
		job.Cursor = encodeChannelDriftCursor(item)
		if itemErr != nil {
			failed++
			if firstErr == nil {
				firstErr = itemErr
			}
		}
	}
	if end == len(items) {
		job.Cursor = ""
	}
	return checked, failed, firstErr
}

func (s *Service) retryBYOKSyncJob(ctx context.Context, owner string) (int, int, error) {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		owner = "worker"
	}
	now := s.nowUTC()
	limit := s.options.WorkerBYOKSyncBatchSize
	if limit <= 0 {
		limit = defaultBYOKSyncBatchSize
	}
	tasks, err := s.store.ListBYOKSyncTasks(ctx, BYOKSyncTaskListOptions{Status: BYOKSyncTaskStatusPending, Now: now, Limit: limit})
	if err != nil {
		return 0, 0, err
	}
	if len(tasks) < limit {
		errorTasks, err := s.store.ListBYOKSyncTasks(ctx, BYOKSyncTaskListOptions{Status: BYOKSyncTaskStatusError, Now: now, Limit: limit - len(tasks)})
		if err != nil {
			return 0, 0, err
		}
		tasks = append(tasks, errorTasks...)
	}
	synced, failed := 0, 0
	var firstErr error
	for _, item := range tasks {
		task, acquired, err := s.store.TryAcquireBYOKSyncTask(ctx, item.ExternalUserID, owner, 5*time.Minute, s.nowUTC())
		if err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if !acquired {
			continue
		}
		if _, err := s.SyncUserLLMSettings(ctx, task.ExternalUserID); err != nil {
			_, _ = s.store.CompleteBYOKSyncTask(ctx, task, false, err.Error(), s.nowUTC())
			failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if _, err := s.store.CompleteBYOKSyncTask(ctx, task, true, "", s.nowUTC()); err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		synced++
	}
	return synced, failed, firstErr
}

func hasProviderSyncError(providers []UserLLMProvider) bool {
	for _, provider := range providers {
		if provider.Enabled && (provider.SyncStatus == LLMProviderSyncPending || provider.SyncStatus == LLMProviderSyncError || provider.LastSyncError != "") {
			return true
		}
	}
	return false
}

func (s *Service) cleanupPendingJob(ctx context.Context) (int, error) {
	requests, err := s.store.ListSetProvisionRequests(ctx, SetProvisionRequestListOptions{Status: SetProvisionStatusPending, Limit: 100})
	if err != nil {
		return 0, err
	}
	now := s.nowUTC()
	cleaned := 0
	for _, request := range requests {
		if request.UpdatedAt.IsZero() || now.Sub(request.UpdatedAt) < time.Hour {
			continue
		}
		request.Status = SetProvisionStatusError
		request.LastError = "pending request timed out"
		request.LastStatusAt = now
		if err := s.store.SaveSetProvisionRequest(ctx, request); err != nil {
			return cleaned, err
		}
		cleaned++
	}
	released, err := s.store.CleanupStaleSetRuntimeLeases(ctx)
	if err != nil {
		return cleaned, err
	}
	cleaned += released
	return cleaned, nil
}

func (s *Service) ListChannelBundleRevisions(ctx context.Context, bundleID string) ([]ChannelBundleRevision, error) {
	return s.store.ListChannelBundleRevisions(ctx, strings.TrimSpace(bundleID))
}

func (s *Service) ListChannelBundleReleases(ctx context.Context, bundleID string) ([]ChannelBundleReleaseRun, error) {
	return s.store.ListChannelBundleReleases(ctx, strings.TrimSpace(bundleID))
}

func (s *Service) RollbackChannelBundleToRevision(ctx context.Context, bundleID string, revisionID string) (ChannelBundle, error) {
	bundleID = strings.TrimSpace(bundleID)
	owner, err := s.acquireChannelBundleOperationLock(ctx, bundleID, "rollback")
	if err != nil {
		return ChannelBundle{}, err
	}
	defer s.releaseChannelBundleOperationLock(bundleID, owner)
	revision, ok, err := s.store.GetChannelBundleRevision(ctx, strings.TrimSpace(bundleID), strings.TrimSpace(revisionID))
	if err != nil {
		return ChannelBundle{}, err
	}
	if !ok {
		return ChannelBundle{}, fmt.Errorf("channel bundle revision %q not found", revisionID)
	}
	current, currentOK, err := s.store.GetChannelBundle(ctx, revision.BundleID)
	if err != nil {
		return ChannelBundle{}, err
	}
	var currentSpec ChannelBundleSpec
	if currentOK {
		currentSpec = current.Spec
	}
	spec, err := restoreChannelBundleRevisionSecrets(revision.Spec, currentSpec)
	if err != nil {
		return ChannelBundle{}, err
	}
	return s.upsertChannelBundle(ctx, ChannelBundle{
		ID:          revision.BundleID,
		Name:        revision.Name,
		Description: revision.Description,
		SourceSetID: revision.SourceSetID,
		Spec:        spec,
	}, true)
}

func (s *Service) CreateChannelBundleRelease(ctx context.Context, input ChannelBundleReleaseInput) (result ChannelBundleReleaseRun, err error) {
	input.BundleID = strings.TrimSpace(input.BundleID)
	ctx, span := s.startTelemetrySpan(ctx, observability.ScopeConfigConsistency, "llmgateway.config.release",
		attribute.String("llmgateway.channel_bundle.id", input.BundleID),
		attribute.Int("llmgateway.target_set.count", len(input.SetIDs)),
		attribute.Bool("llmgateway.stop_on_failure", input.StopOnFailure),
	)
	defer func() { observability.FinishSpan(span, err, "channel_bundle_release_failed", s.telemetrySanitizer) }()
	if input.BundleID == "" {
		return ChannelBundleReleaseRun{}, fmt.Errorf("bundle_id is required")
	}
	owner, err := s.acquireChannelBundleOperationLock(ctx, input.BundleID, "release")
	if err != nil {
		return ChannelBundleReleaseRun{}, err
	}
	defer s.releaseChannelBundleOperationLock(input.BundleID, owner)
	bundle, ok, err := s.store.GetChannelBundle(ctx, input.BundleID)
	if err != nil {
		return ChannelBundleReleaseRun{}, err
	}
	if !ok {
		return ChannelBundleReleaseRun{}, ErrChannelBundleNotFound
	}
	revisionID := strings.TrimSpace(input.RevisionID)
	if revisionID != "" {
		revision, ok, err := s.store.GetChannelBundleRevision(ctx, bundle.ID, revisionID)
		if err != nil {
			return ChannelBundleReleaseRun{}, err
		}
		if !ok {
			return ChannelBundleReleaseRun{}, fmt.Errorf("channel bundle revision %q not found", revisionID)
		}
		spec, err := restoreChannelBundleRevisionSecrets(revision.Spec, bundle.Spec)
		if err != nil {
			return ChannelBundleReleaseRun{}, err
		}
		bundle.Spec = spec
		bundle.Fingerprint = revision.Fingerprint
	}
	setIDs := normalizedReleaseSetIDs(input.SetIDs)
	if len(setIDs) == 0 {
		sets, err := s.store.ListSets(ctx)
		if err != nil {
			return ChannelBundleReleaseRun{}, err
		}
		for _, set := range sets {
			if set.Status == SetStatusActive && set.Setup {
				setIDs = append(setIDs, set.ID)
			}
		}
	}
	if len(setIDs) == 0 {
		return ChannelBundleReleaseRun{}, fmt.Errorf("no target sets")
	}
	now := s.nowUTC()
	run := ChannelBundleReleaseRun{
		ID:            fmt.Sprintf("rel-%s-%d", bundle.ID, now.UnixNano()),
		BundleID:      bundle.ID,
		RevisionID:    revisionID,
		Fingerprint:   bundle.Fingerprint,
		Status:        ChannelBundleReleaseStatusRunning,
		ForceDrift:    input.ForceDrift,
		StopOnFailure: input.StopOnFailure,
		TriggeredBy:   input.TriggeredBy,
		CreatedAt:     now,
		StartedAt:     now,
	}
	if err := s.store.SaveChannelBundleRelease(ctx, run); err != nil {
		return ChannelBundleReleaseRun{}, err
	}
	s.emitCommittedTransition(ctx, observability.ScopeConfigConsistency, "llmgateway.config.state_changed",
		"channel_bundle_release", run.ID, "", run.Status,
		attribute.String("llmgateway.channel_bundle.id", run.BundleID),
		attribute.String("llmgateway.channel_bundle.revision.id", run.RevisionID),
		attribute.String("llmgateway.channel_bundle.revision.fingerprint", run.Fingerprint),
		attribute.String("llmgateway.release.run.id", run.ID),
		attribute.Bool("llmgateway.stop_on_failure", run.StopOnFailure),
	)
	for _, setID := range setIDs {
		item := ChannelBundleReleaseItem{RunID: run.ID, BundleID: bundle.ID, SetID: setID, Status: ChannelBundleReleaseStatusRunning, StartedAt: s.nowUTC()}
		itemCtx, itemSpan := s.startTelemetrySpan(ctx, observability.ScopeConfigConsistency, "llmgateway.config.apply_set",
			attribute.String("llmgateway.channel_bundle.id", bundle.ID),
			attribute.String("llmgateway.release.run.id", run.ID),
			attribute.String("llmgateway.set.id", setID),
		)
		state, applyErr := s.applyChannelBundleSnapshotToSet(itemCtx, bundle, setID, ChannelBundleApplyOptions{ForceDrift: input.ForceDrift})
		observability.FinishSpan(itemSpan, applyErr, "channel_bundle_apply_failed", s.telemetrySanitizer)
		item.FinishedAt = s.nowUTC()
		if applyErr != nil {
			item.Status = ChannelBundleReleaseStatusError
			item.LastError = applyErr.Error()
		} else {
			item.Status = releaseStatusFromSyncState(state)
			item.LastError = state.LastError
		}
		run.Items = append(run.Items, item)
		if input.StopOnFailure && item.Status == ChannelBundleReleaseStatusError {
			run.LastError = item.LastError
			break
		}
	}
	run.FinishedAt = s.nowUTC()
	run.Status = summarizeChannelBundleReleaseStatus(run.Items)
	if run.Status == ChannelBundleReleaseStatusError && run.LastError == "" {
		for _, item := range run.Items {
			if item.LastError != "" {
				run.LastError = item.LastError
				break
			}
		}
	}
	if err := s.store.SaveChannelBundleRelease(ctx, run); err != nil {
		return ChannelBundleReleaseRun{}, err
	}
	for _, item := range run.Items {
		s.emitCommittedTransition(ctx, observability.ScopeConfigConsistency, "llmgateway.config.state_changed",
			"channel_bundle_release_item", run.ID+"/"+item.SetID, ChannelBundleReleaseStatusRunning, item.Status,
			attribute.String("llmgateway.channel_bundle.id", run.BundleID),
			attribute.String("llmgateway.release.run.id", run.ID),
			attribute.String("llmgateway.set.id", item.SetID),
			attribute.String("llmgateway.release.item.status", item.Status),
		)
	}
	s.emitCommittedTransition(ctx, observability.ScopeConfigConsistency, "llmgateway.config.state_changed",
		"channel_bundle_release", run.ID, ChannelBundleReleaseStatusRunning, run.Status,
		attribute.String("llmgateway.channel_bundle.id", run.BundleID),
		attribute.String("llmgateway.channel_bundle.revision.id", run.RevisionID),
		attribute.String("llmgateway.channel_bundle.revision.fingerprint", run.Fingerprint),
		attribute.String("llmgateway.release.run.id", run.ID),
		attribute.Bool("llmgateway.stop_on_failure", run.StopOnFailure),
	)
	span.SetAttributes(attribute.String("llmgateway.release.run.id", run.ID), attribute.String("llmgateway.outcome", run.Status))
	if run.Status == ChannelBundleReleaseStatusError || run.Status == ChannelBundleReleaseStatusPartial {
		s.emitOperationFailure(ctx, observability.ScopeConfigConsistency, "llmgateway.config.operation_failed", "channel_bundle_release_failed",
			attribute.String("llmgateway.channel_bundle.id", run.BundleID),
			attribute.String("llmgateway.release.run.id", run.ID),
		)
	}
	return run, nil
}

func (s *Service) GetChannelBundleRelease(ctx context.Context, id string) (ChannelBundleReleaseRun, error) {
	run, ok, err := s.store.GetChannelBundleRelease(ctx, strings.TrimSpace(id))
	if err != nil {
		return ChannelBundleReleaseRun{}, err
	}
	if !ok {
		return ChannelBundleReleaseRun{}, fmt.Errorf("channel bundle release %q not found", id)
	}
	return run, nil
}

func (s *Service) GetTenantDetail(ctx context.Context, userID string) (TenantDetail, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return TenantDetail{}, fmt.Errorf("user id is required")
	}
	tenant, ok, err := s.store.GetTenant(ctx, userID)
	if err != nil {
		return TenantDetail{}, err
	}
	if !ok {
		tenant = Tenant{ExternalUserID: userID, Backend: UserBackendPending, Status: TenantStatusActive, Source: "default"}
	}
	binding, bindingOK, err := s.store.GetUserBinding(ctx, userID)
	if err != nil {
		return TenantDetail{}, err
	}
	assignment, assignmentOK, err := s.store.GetUserAssignment(ctx, userID)
	if err != nil {
		return TenantDetail{}, err
	}
	observation, observationOK, err := s.store.GetTenantObservation(ctx, userID)
	if err != nil {
		return TenantDetail{}, err
	}
	settings, settingsOK, err := s.store.GetUserLLMSettings(ctx, userID)
	if err != nil {
		return TenantDetail{}, err
	}
	keys, err := s.store.ListAPIKeyBindingsByUser(ctx, userID)
	if err != nil {
		return TenantDetail{}, err
	}
	keySummaries := make([]APIKeySummary, 0, len(keys))
	for _, key := range keys {
		keySummaries = append(keySummaries, apiKeySummary(key))
	}
	keyCount := len(keySummaries)
	summary := buildTenantSummary(tenant, binding, assignment, observation, keyCount)
	detail := TenantDetail{Tenant: summary, Keys: keySummaries}
	if bindingOK {
		copy := binding
		detail.Binding = &copy
	}
	if assignmentOK {
		copy := assignment
		detail.Assignment = &copy
	}
	if observationOK {
		copy := observation
		detail.Observation = &copy
	}
	if settingsOK {
		settings = normalizeUserLLMSettings(settings, settings)
		copy := settings
		detail.LLMSettings = &copy
	}
	detail.RecentErrors = tenantDetailErrors(binding, settings, observation)
	return detail, nil
}

func (s *Service) DisableTenant(ctx context.Context, userID string) (TenantDetail, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return TenantDetail{}, fmt.Errorf("user id is required")
	}
	tenant, ok, err := s.store.GetTenant(ctx, userID)
	if err != nil {
		return TenantDetail{}, err
	}
	if !ok {
		tenant = Tenant{ExternalUserID: userID, Backend: UserBackendPending, Status: TenantStatusDisabled, Source: "admin"}
	} else {
		tenant.Status = TenantStatusDisabled
	}
	if err := s.store.SaveTenant(ctx, tenant); err != nil {
		return TenantDetail{}, err
	}
	if err := s.deleteUserTrafficRoutes(ctx, userID); err != nil {
		return TenantDetail{}, err
	}
	return s.GetTenantDetail(ctx, userID)
}

func tenantDetailErrors(binding UserBinding, settings UserLLMSettings, observation TenantObservation) []OperatorError {
	errors := []OperatorError{}
	if binding.LastProvisionError != "" {
		errors = append(errors, OperatorError{Kind: "provision", Message: binding.LastProvisionError, At: binding.UpdatedAt})
	}
	if settings.LastSyncError != "" {
		errors = append(errors, OperatorError{Kind: "byok_sync", Message: settings.LastSyncError, At: settings.UpdatedAt})
	}
	if observation.CreditError != "" {
		errors = append(errors, OperatorError{Kind: "credit", Message: observation.CreditError, At: observation.ObservedAt})
	}
	return errors
}

func apiKeySummary(binding APIKeyBinding) APIKeySummary {
	prefix := binding.ExternalKeyHash
	if prefix == "" && binding.ExternalKey != "" {
		prefix = hashExternalKey(binding.ExternalKey)
	}
	if len(prefix) > 12 {
		prefix = prefix[:12]
	}
	return APIKeySummary{
		ExternalKeyID: binding.ExternalKeyID,
		SetID:         binding.SetID,
		UserID:        binding.UserID,
		UpstreamKeyID: binding.UpstreamKeyID,
		KeyHashPrefix: prefix,
		CreatedAt:     binding.CreatedAt,
	}
}

func normalizedReleaseSetIDs(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func releaseStatusFromSyncState(state ChannelBundleSyncState) string {
	switch state.Status {
	case ChannelSyncStatusSynced:
		return ChannelBundleReleaseStatusSuccess
	case ChannelSyncStatusSkipped:
		return ChannelBundleReleaseStatusSkipped
	case ChannelSyncStatusError, ChannelSyncStatusConflict:
		return ChannelBundleReleaseStatusError
	default:
		return ChannelBundleReleaseStatusPartial
	}
}

func summarizeChannelBundleReleaseStatus(items []ChannelBundleReleaseItem) string {
	if len(items) == 0 {
		return ChannelBundleReleaseStatusSkipped
	}
	success, skipped, failed := 0, 0, 0
	for _, item := range items {
		switch item.Status {
		case ChannelBundleReleaseStatusSuccess:
			success++
		case ChannelBundleReleaseStatusSkipped:
			skipped++
		case ChannelBundleReleaseStatusError:
			failed++
		default:
			return ChannelBundleReleaseStatusPartial
		}
	}
	if failed > 0 {
		return ChannelBundleReleaseStatusError
	}
	if success == len(items) {
		return ChannelBundleReleaseStatusSuccess
	}
	if skipped == len(items) {
		return ChannelBundleReleaseStatusSkipped
	}
	return ChannelBundleReleaseStatusPartial
}
