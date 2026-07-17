package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var (
	ErrSetUpgradeAlreadyActive = errors.New("set already has an active upgrade")
	digestPinnedImagePattern   = regexp.MustCompile(`^\S+@sha256:[a-fA-F0-9]{64}$`)
)

const setUpgradeProbeQuota = 100_000_000

func (s *Service) CreateSetUpgradeBatch(ctx context.Context, input CreateSetUpgradeBatchInput) (SetUpgradeBatch, error) {
	if !digestPinnedImagePattern.MatchString(strings.TrimSpace(input.TargetImage)) {
		return SetUpgradeBatch{}, fmt.Errorf("target_image must be pinned by sha256 digest")
	}
	setIDs := normalizedSetIDs(input.SetIDs)
	if len(setIDs) == 0 {
		return SetUpgradeBatch{}, fmt.Errorf("at least one set_id is required")
	}
	if input.MaxParallel <= 0 {
		input.MaxParallel = 1
	}
	if input.DrainTimeout <= 0 {
		input.DrainTimeout = 330 * time.Second
	}
	if input.RollbackWindow <= 0 {
		input.RollbackWindow = 300 * time.Second
	}
	if input.Source == "" {
		input.Source = "prod"
	}
	if input.Namespace == "" {
		input.Namespace = "llmgateway"
	}
	if input.Fleet == "" {
		input.Fleet = "prod"
	}
	now := s.nowUTC()
	batch := SetUpgradeBatch{
		ID: fmt.Sprintf("set-upgrade-%d", now.UnixNano()), TargetImage: input.TargetImage,
		RolloutID: input.RolloutID, RingID: input.RingID, TargetReleaseID: input.TargetReleaseID,
		Status: SetUpgradeBatchStatusPending, MaxParallel: input.MaxParallel,
		StopOnFailure: input.StopOnFailure, CreatedAt: now, UpdatedAt: now,
	}
	for index, setID := range setIDs {
		set, ok, err := s.store.GetSet(ctx, setID)
		if err != nil {
			return SetUpgradeBatch{}, err
		}
		if !ok || set.Status != SetStatusActive {
			return SetUpgradeBatch{}, fmt.Errorf("set %q is not active", setID)
		}
		batch.Runs = append(batch.Runs, SetUpgradeRun{
			ID: fmt.Sprintf("%s-%03d", batch.ID, index+1), BatchID: batch.ID, SetID: setID,
			Source: input.Source, Namespace: input.Namespace, Fleet: input.Fleet,
			TargetImage: input.TargetImage, FromGeneration: set.ActiveRuntimeGeneration,
			FromReleaseID: set.CurrentReleaseID, TargetReleaseID: input.TargetReleaseID, Sequence: index + 1,
			ToGeneration: set.ActiveRuntimeGeneration + 1, Status: SetUpgradeRunStatusPending,
			DrainTimeout: input.DrainTimeout, RollbackWindow: input.RollbackWindow,
			CreatedAt: now, UpdatedAt: now,
		})
	}
	if err := s.store.CreateSetUpgradeBatch(ctx, batch); err != nil {
		return SetUpgradeBatch{}, err
	}
	for _, run := range batch.Runs {
		s.emitSetUpgradeTransition(ctx, SetUpgradeRun{}, run)
	}
	return batch, nil
}

func orderedUniqueSetIDs(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func normalizedSetIDs(values []string) []string { return orderedUniqueSetIDs(values) }

func setUpgradeRunTerminal(status string) bool {
	switch status {
	case SetUpgradeRunStatusCompleted, SetUpgradeRunStatusFailed, SetUpgradeRunStatusRolledBack:
		return true
	default:
		return false
	}
}

func deriveSetUpgradeBatchStatus(runs []SetUpgradeRun, stopOnFailure bool) string {
	if len(runs) == 0 {
		return SetUpgradeBatchStatusPending
	}
	allPending := true
	allTerminal := true
	failed := false
	for _, run := range runs {
		allPending = allPending && run.Status == SetUpgradeRunStatusPending
		allTerminal = allTerminal && setUpgradeRunTerminal(run.Status)
		failed = failed || run.Status == SetUpgradeRunStatusFailed
	}
	if failed && stopOnFailure {
		return SetUpgradeBatchStatusFailed
	}
	if allTerminal {
		if failed {
			return SetUpgradeBatchStatusFailed
		}
		return SetUpgradeBatchStatusCompleted
	}
	if allPending {
		return SetUpgradeBatchStatusPending
	}
	return SetUpgradeBatchStatusRunning
}

func (s *Service) PublishPendingSetRuntimeRoutes(ctx context.Context, limit int) (int, int, error) {
	if s.options.KeyRouteCache == nil {
		return 0, 0, fmt.Errorf("key route cache is unavailable")
	}
	if limit <= 0 {
		limit = 100
	}
	items, err := s.store.ListSetRuntimeRouteOutbox(ctx, SetRuntimeRouteOutboxStatusPending, limit)
	if err != nil {
		return 0, 0, err
	}
	published, failed := 0, 0
	var result error
	for _, item := range items {
		applied, publishErr := s.options.KeyRouteCache.SetSetRuntime(ctx, item.Snapshot)
		if publishErr == nil && !applied {
			current, ok, getErr := s.options.KeyRouteCache.GetSetRuntime(ctx, item.SetID)
			if getErr != nil {
				publishErr = getErr
			} else if !ok || current.RouteRevision < item.RouteRevision {
				publishErr = fmt.Errorf("runtime route revision %d was not applied", item.RouteRevision)
			}
		}
		if publishErr != nil {
			failed++
			_ = s.store.CompleteSetRuntimeRouteOutbox(ctx, item.ID, false, publishErr.Error(), s.nowUTC())
			result = errors.Join(result, publishErr)
			continue
		}
		if _, _, err := s.store.ConfirmSetRuntimeRoutePublished(ctx, item.SetID, item.RouteRevision, s.nowUTC()); err != nil {
			failed++
			_ = s.store.CompleteSetRuntimeRouteOutbox(ctx, item.ID, false, err.Error(), s.nowUTC())
			result = errors.Join(result, err)
			continue
		}
		if err := s.store.CompleteSetRuntimeRouteOutbox(ctx, item.ID, true, "", s.nowUTC()); err != nil {
			failed++
			result = errors.Join(result, err)
			continue
		}
		published++
	}
	return published, failed, result
}

func (s *Service) BackfillLegacySetRuntimeRoutes(ctx context.Context, limit int) (int, error) {
	if s.options.KeyRouteCache == nil {
		return 0, fmt.Errorf("key route cache is unavailable")
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return 0, err
	}
	if limit <= 0 || limit > len(sets) {
		limit = len(sets)
	}
	backfilled := 0
	for _, set := range sets[:limit] {
		if set.Status != SetStatusActive {
			continue
		}
		baseURL := strings.TrimRight(strings.TrimSpace(set.TrafficBaseURL), "/")
		if baseURL == "" {
			baseURL = strings.TrimRight(strings.TrimSpace(set.BaseURL), "/")
		}
		if baseURL == "" {
			continue
		}
		if set.RouteRevision <= 0 {
			set.RouteRevision = 1
			if err := s.store.SaveSet(ctx, set); err != nil {
				return backfilled, err
			}
		}
		runtime, ok, err := s.store.GetSetRuntime(ctx, set.ID, set.ActiveRuntimeGeneration)
		if err != nil {
			return backfilled, err
		}
		if !ok {
			runtime = SetRuntime{
				SetID: set.ID, Generation: set.ActiveRuntimeGeneration, Image: firstNonEmpty(set.AdminImage, "legacy"),
				TrafficBaseURL: baseURL, Status: SetRuntimeStatusActive,
			}
			if err := s.store.SaveSetRuntime(ctx, runtime); err != nil {
				return backfilled, err
			}
		}
		if runtime.TrafficBaseURL == "" {
			runtime.TrafficBaseURL = baseURL
		}
		if _, err := s.options.KeyRouteCache.SetSetRuntime(ctx, SetRuntimeRouteSnapshot{
			SetID: set.ID, RuntimeGeneration: runtime.Generation, RouteRevision: set.RouteRevision,
			TrafficBaseURL: runtime.TrafficBaseURL, Enabled: true, SwitchedAt: set.UpdatedAt,
		}); err != nil {
			return backfilled, err
		}
		backfilled++
	}
	return backfilled, nil
}

func (s *Service) GetSetUpgradeBatch(ctx context.Context, id string) (SetUpgradeBatch, bool, error) {
	return s.store.GetSetUpgradeBatch(ctx, strings.TrimSpace(id))
}

func (s *Service) GetSetUpgradeRun(ctx context.Context, id string) (SetUpgradeRun, bool, error) {
	return s.store.GetSetUpgradeRun(ctx, strings.TrimSpace(id))
}

func (s *Service) ListSetUpgradeRuns(ctx context.Context, setID string, limit int) ([]SetUpgradeRun, error) {
	runs, err := s.store.ListSetUpgradeRuns(ctx, "", nil, 0)
	if err != nil {
		return nil, err
	}
	setID = strings.TrimSpace(setID)
	filtered := make([]SetUpgradeRun, 0, len(runs))
	for index := len(runs) - 1; index >= 0; index-- {
		if setID != "" && runs[index].SetID != setID {
			continue
		}
		filtered = append(filtered, runs[index])
		if limit > 0 && len(filtered) >= limit {
			break
		}
	}
	return filtered, nil
}

func (s *Service) RequestSetUpgradeRollback(ctx context.Context, id, reason string) (SetUpgradeRun, error) {
	previous, _, err := s.store.GetSetUpgradeRun(ctx, strings.TrimSpace(id))
	if err != nil {
		return SetUpgradeRun{}, err
	}
	run, err := s.store.RequestSetUpgradeRollback(ctx, strings.TrimSpace(id), reason, s.nowUTC())
	if err == nil {
		s.emitSetUpgradeTransition(ctx, previous, run)
	}
	return run, err
}

func (s *Service) RetrySetUpgradeRun(ctx context.Context, id string) (SetUpgradeRun, error) {
	previous, _, err := s.store.GetSetUpgradeRun(ctx, strings.TrimSpace(id))
	if err != nil {
		return SetUpgradeRun{}, err
	}
	run, err := s.store.RetrySetUpgradeRun(ctx, strings.TrimSpace(id), s.nowUTC())
	if err == nil {
		s.emitSetUpgradeTransition(ctx, previous, run)
		s.syncReleaseRolloutForRun(ctx, run)
	}
	return run, err
}

func (s *Service) ListActiveSetUpgradeRuns(ctx context.Context, limit int) ([]SetUpgradeRun, error) {
	statuses := []string{
		SetUpgradeRunStatusPending, SetUpgradeRunStatusUpgradingMaster,
		SetUpgradeRunStatusVerifyingCompatibility, SetUpgradeRunStatusPreparing, SetUpgradeRunStatusProbing,
		SetUpgradeRunStatusSwitching, SetUpgradeRunStatusDraining, SetUpgradeRunStatusRollbackSwitching,
		SetUpgradeRunStatusRollbackDraining,
	}
	return s.store.ListSetUpgradeRuns(ctx, "", statuses, limit)
}

func (s *Service) CompleteSetUpgradeCompatibility(ctx context.Context, id, owner string, success bool, lastError string) (SetUpgradeRun, error) {
	run, err := s.ownedSetUpgradeRun(ctx, id, owner)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	updated, err := s.store.CompleteSetUpgradeCompatibility(ctx, run, success, lastError, s.nowUTC())
	if err == nil {
		s.emitSetUpgradeTransition(ctx, run, updated)
		s.syncReleaseRolloutForRun(ctx, updated)
	}
	return updated, err
}

func (s *Service) ClaimSetUpgradeRun(ctx context.Context, id, owner string, ttl time.Duration) (SetUpgradeRun, bool, error) {
	previous, _, err := s.store.GetSetUpgradeRun(ctx, strings.TrimSpace(id))
	if err != nil {
		return SetUpgradeRun{}, false, err
	}
	run, acquired, err := s.store.TryAcquireSetUpgradeRun(ctx, strings.TrimSpace(id), strings.TrimSpace(owner), ttl, s.nowUTC())
	if err == nil && acquired {
		s.emitSetUpgradeTransition(ctx, previous, run)
	}
	return run, acquired, err
}

func (s *Service) PrepareSetUpgradeCandidate(ctx context.Context, id, owner, trafficBaseURL string) (SetUpgradeRun, error) {
	run, err := s.ownedSetUpgradeRun(ctx, id, owner)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	trafficBaseURL = strings.TrimRight(strings.TrimSpace(trafficBaseURL), "/")
	if parsed, err := url.ParseRequestURI(trafficBaseURL); err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return SetUpgradeRun{}, fmt.Errorf("invalid candidate traffic_base_url")
	}
	updated, err := s.store.PrepareSetUpgradeRuntime(ctx, run, SetRuntime{
		SetID: run.SetID, Generation: run.ToGeneration, Image: run.TargetImage,
		TrafficBaseURL: trafficBaseURL, Status: SetRuntimeStatusPreparing,
	}, s.nowUTC())
	if err == nil {
		s.emitSetUpgradeTransition(ctx, run, updated)
	}
	return updated, err
}

func (s *Service) RecordSetUpgradeProbe(ctx context.Context, id, owner string, success bool, lastError string) (SetUpgradeRun, error) {
	run, err := s.ownedSetUpgradeRun(ctx, id, owner)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	now := s.nowUTC()
	if run.Status == SetUpgradeRunStatusProbing {
		updated, recordErr := s.store.RecordSetUpgradeProbe(ctx, run, success, lastError, now)
		if recordErr == nil {
			s.emitSetUpgradeTransition(ctx, run, updated)
			s.syncReleaseRolloutForRun(ctx, updated)
		}
		return updated, recordErr
	}
	if run.Status != SetUpgradeRunStatusDraining {
		return SetUpgradeRun{}, fmt.Errorf("upgrade run %q is not probeable", id)
	}
	previous := run
	run, shouldRollback, err := s.store.RecordSetUpgradePostSwitchProbe(ctx, run, success, lastError, now)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if shouldRollback || run.RollbackRequested {
		reason := run.RollbackReason
		if reason == "" {
			reason = lastError
		}
		return s.executeSetUpgradeRollback(ctx, run, reason)
	}
	s.emitSetUpgradeTransition(ctx, previous, run)
	return run, nil
}

func (s *Service) SwitchSetUpgradeRun(ctx context.Context, id, owner string) (SetUpgradeRun, error) {
	run, err := s.ownedSetUpgradeRun(ctx, id, owner)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	run, _, err = s.store.SwitchSetUpgradeRuntime(ctx, run, s.nowUTC())
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if _, _, err := s.PublishPendingSetRuntimeRoutes(ctx, 100); err != nil {
		return run, err
	}
	updated, ok, err := s.store.GetSetUpgradeRun(ctx, run.ID)
	if err != nil || !ok {
		return run, err
	}
	s.emitSetUpgradeTransition(ctx, run, updated)
	return updated, nil
}

func (s *Service) RollbackSetUpgradeRun(ctx context.Context, id, owner, reason string) (SetUpgradeRun, error) {
	run, err := s.ownedSetUpgradeRun(ctx, id, owner)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	return s.executeSetUpgradeRollback(ctx, run, reason)
}

func (s *Service) executeSetUpgradeRollback(ctx context.Context, run SetUpgradeRun, reason string) (SetUpgradeRun, error) {
	previous := run
	run, _, err := s.store.RollbackSetUpgradeRuntime(ctx, run, s.nowUTC(), reason)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if _, _, err := s.PublishPendingSetRuntimeRoutes(ctx, 100); err != nil {
		return run, err
	}
	updated, ok, err := s.store.GetSetUpgradeRun(ctx, run.ID)
	if err != nil || !ok {
		return run, err
	}
	s.emitSetUpgradeTransition(ctx, previous, updated)
	return updated, nil
}

func (s *Service) AdvanceSetUpgradeAfterDrain(ctx context.Context, id, owner string) (SetUpgradeRun, error) {
	run, err := s.ownedSetUpgradeRun(ctx, id, owner)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	updated, err := s.store.AdvanceSetUpgradeAfterDrain(ctx, run, s.nowUTC())
	if err == nil {
		s.emitSetUpgradeTransition(ctx, run, updated)
		s.syncReleaseRolloutForRun(ctx, updated)
	}
	return updated, err
}

func (s *Service) CompleteSetUpgradeMaster(ctx context.Context, id, owner string, success bool, lastError string) (SetUpgradeRun, error) {
	run, err := s.ownedSetUpgradeRun(ctx, id, owner)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	updated, err := s.store.CompleteSetUpgradeMaster(ctx, run, success, lastError, s.nowUTC())
	if err == nil {
		s.emitSetUpgradeTransition(ctx, run, updated)
		s.syncReleaseRolloutForRun(ctx, updated)
	}
	return updated, err
}

func (s *Service) syncReleaseRolloutForRun(ctx context.Context, run SetUpgradeRun) {
	batch, ok, err := s.store.GetSetUpgradeBatch(ctx, run.BatchID)
	if err != nil || !ok || strings.TrimSpace(batch.RolloutID) == "" {
		return
	}
	_, _, _ = s.GetReleaseRollout(ctx, batch.RolloutID)
}

func (s *Service) GetOrCreateSetUpgradeProbeCredential(ctx context.Context, id, owner string) (SetUpgradeProbeCredential, error) {
	run, err := s.ownedSetUpgradeRun(ctx, id, owner)
	if err != nil {
		return SetUpgradeProbeCredential{}, err
	}
	set, ok, err := s.store.GetSet(ctx, run.SetID)
	if err != nil {
		return SetUpgradeProbeCredential{}, err
	}
	if !ok || set.AdminUserID == 0 || strings.TrimSpace(set.AdminAccessToken) == "" {
		return SetUpgradeProbeCredential{}, fmt.Errorf("set %q is not bootstrapped", run.SetID)
	}
	userID := "llmgw-upgrade-probe-" + hashExternalKey(run.SetID)[:16]
	if binding, ok, err := s.findTrafficProbeKey(ctx, userID); err != nil {
		return SetUpgradeProbeCredential{}, err
	} else if ok && binding.SetID == run.SetID {
		if err := s.ensureSetUpgradeProbeQuota(ctx, set, userID); err != nil {
			return SetUpgradeProbeCredential{}, err
		}
		return SetUpgradeProbeCredential{SetID: run.SetID, UpstreamKey: binding.UpstreamKey}, nil
	}
	if _, err := s.EnsureTenant(ctx, Tenant{
		ExternalUserID: userID, Backend: UserBackendNew, SetID: run.SetID,
		Status: TenantStatusActive, Source: "set_upgrade_probe",
	}); err != nil {
		return SetUpgradeProbeCredential{}, err
	}
	if binding, ok, err := s.store.GetUserBinding(ctx, userID); err != nil {
		return SetUpgradeProbeCredential{}, err
	} else if ok && binding.SetID != run.SetID {
		return SetUpgradeProbeCredential{}, fmt.Errorf("upgrade probe user is already bound to set %q", binding.SetID)
	} else if !ok {
		if err := s.store.SaveUserBinding(ctx, UserBinding{
			ExternalUserID: userID, SetID: run.SetID, Username: newAPIUsername(userID),
			Password: randomNewAPIPassword(), ProvisionStatus: BindingProvisionStatusAllocated,
		}); err != nil {
			return SetUpgradeProbeCredential{}, err
		}
	}
	binding, err := s.createExternalKey(ctx, userID, APIKeyPurposeTrafficProbe)
	if err != nil {
		return SetUpgradeProbeCredential{}, err
	}
	if err := s.ensureSetUpgradeProbeQuota(ctx, set, userID); err != nil {
		return SetUpgradeProbeCredential{}, err
	}
	return SetUpgradeProbeCredential{SetID: run.SetID, UpstreamKey: binding.UpstreamKey}, nil
}

func (s *Service) ensureSetUpgradeProbeQuota(ctx context.Context, set Set, userID string) error {
	binding, ok, err := s.store.GetUserBinding(ctx, userID)
	if err != nil {
		return err
	}
	if !ok || binding.UpstreamUserID <= 0 {
		return fmt.Errorf("upgrade probe user binding is not ready")
	}
	client := s.newAPIClient(set.BaseURL)
	auth := adminAuthForSet(set)
	if err := client.ManageQuota(ctx, auth, binding.UpstreamUserID, "override", setUpgradeProbeQuota); err != nil {
		return fmt.Errorf("grant upgrade probe quota: %w", err)
	}
	user, err := client.RefreshUserCache(ctx, auth, binding.UpstreamUserID)
	if err != nil {
		return fmt.Errorf("refresh upgrade probe user cache: %w", err)
	}
	if user.Quota != setUpgradeProbeQuota {
		return fmt.Errorf("upgrade probe user quota is %d, want %d", user.Quota, setUpgradeProbeQuota)
	}
	return nil
}

func (s *Service) ownedSetUpgradeRun(ctx context.Context, id, owner string) (SetUpgradeRun, error) {
	run, ok, err := s.store.GetSetUpgradeRun(ctx, strings.TrimSpace(id))
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if !ok {
		return SetUpgradeRun{}, fmt.Errorf("set upgrade run %q not found", id)
	}
	if run.LeaseOwner == "" || run.LeaseOwner != strings.TrimSpace(owner) {
		return SetUpgradeRun{}, fmt.Errorf("set upgrade run lease is not owned")
	}
	return run, nil
}
