package gateway

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

func setRuntimeStoreKey(setID string, generation int64) string {
	return fmt.Sprintf("%s\x00%d", setID, generation)
}

func (s *MemoryStore) SaveSetRuntime(_ context.Context, runtime SetRuntime) error {
	if strings.TrimSpace(runtime.SetID) == "" || runtime.Generation < 0 {
		return fmt.Errorf("set runtime requires set_id and non-negative generation")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	key := setRuntimeStoreKey(runtime.SetID, runtime.Generation)
	if existing, ok := s.setRuntimes[key]; ok {
		runtime.CreatedAt = existing.CreatedAt
	} else if runtime.CreatedAt.IsZero() {
		runtime.CreatedAt = now
	}
	runtime.UpdatedAt = now
	s.setRuntimes[key] = runtime
	return nil
}

func (s *MemoryStore) InitializeSetRuntime(_ context.Context, setID string, generation int64, image, trafficBaseURL string, now time.Time) (SetRuntimeRouteSnapshot, bool, error) {
	if strings.TrimSpace(setID) == "" || generation <= 0 || strings.TrimSpace(image) == "" || strings.TrimSpace(trafficBaseURL) == "" {
		return SetRuntimeRouteSnapshot{}, false, fmt.Errorf("initial set runtime requires set_id, positive generation, image and traffic url")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	set, ok := s.sets[setID]
	if !ok {
		return SetRuntimeRouteSnapshot{}, false, fmt.Errorf("set %q not found", setID)
	}
	if set.RouteRevision > 0 || set.ActiveRuntimeGeneration > 0 {
		runtime, runtimeOK := s.setRuntimes[setRuntimeStoreKey(setID, set.ActiveRuntimeGeneration)]
		if !runtimeOK {
			return SetRuntimeRouteSnapshot{}, false, fmt.Errorf("active runtime %d for set %q not found", set.ActiveRuntimeGeneration, setID)
		}
		return SetRuntimeRouteSnapshot{
			SetID: setID, RuntimeGeneration: runtime.Generation, RouteRevision: set.RouteRevision,
			TrafficBaseURL: runtime.TrafficBaseURL, Enabled: set.Status == SetStatusActive, SwitchedAt: set.UpdatedAt,
		}, false, nil
	}
	set.ActiveRuntimeGeneration = generation
	set.RouteRevision = 1
	set.AdminImage = image
	set.TrafficBaseURL = strings.TrimRight(trafficBaseURL, "/")
	set.UpdatedAt = now
	s.sets[setID] = set
	runtime := SetRuntime{
		SetID: setID, Generation: generation, Image: image, TrafficBaseURL: set.TrafficBaseURL,
		Status: SetRuntimeStatusActive, CreatedAt: now, UpdatedAt: now,
	}
	s.setRuntimes[setRuntimeStoreKey(setID, generation)] = runtime
	snapshot := SetRuntimeRouteSnapshot{
		SetID: setID, RuntimeGeneration: generation, RouteRevision: 1,
		TrafficBaseURL: set.TrafficBaseURL, Enabled: set.Status == SetStatusActive, SwitchedAt: now,
	}
	s.enqueueRuntimeRouteOutboxLocked(snapshot, now)
	return snapshot, true, nil
}

func (s *MemoryStore) GetSetRuntime(_ context.Context, setID string, generation int64) (SetRuntime, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	runtime, ok := s.setRuntimes[setRuntimeStoreKey(setID, generation)]
	return runtime, ok, nil
}

func (s *MemoryStore) ListSetRuntimes(_ context.Context, setID string) ([]SetRuntime, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]SetRuntime, 0)
	for _, runtime := range s.setRuntimes {
		if runtime.SetID == setID {
			result = append(result, runtime)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Generation < result[j].Generation })
	return result, nil
}

func (s *MemoryStore) CreateSetUpgradeBatch(_ context.Context, batch SetUpgradeBatch) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.setUpgradeBatches[batch.ID]; exists {
		return fmt.Errorf("set upgrade batch %q already exists", batch.ID)
	}
	for _, run := range batch.Runs {
		for _, existing := range s.setUpgradeRuns {
			if existing.SetID == run.SetID && !setUpgradeRunTerminal(existing.Status) {
				return ErrSetUpgradeAlreadyActive
			}
		}
	}
	stored := batch
	stored.Runs = nil
	s.setUpgradeBatches[batch.ID] = stored
	for _, run := range batch.Runs {
		s.setUpgradeRuns[run.ID] = run
	}
	return nil
}

func (s *MemoryStore) GetSetUpgradeBatch(_ context.Context, id string) (SetUpgradeBatch, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	batch, ok := s.setUpgradeBatches[id]
	if !ok {
		return SetUpgradeBatch{}, false, nil
	}
	for _, run := range s.setUpgradeRuns {
		if run.BatchID == id {
			batch.Runs = append(batch.Runs, run)
		}
	}
	sort.Slice(batch.Runs, func(i, j int) bool { return batch.Runs[i].ID < batch.Runs[j].ID })
	batch.Status = deriveSetUpgradeBatchStatus(batch.Runs, batch.StopOnFailure)
	return batch, true, nil
}

func (s *MemoryStore) GetSetUpgradeRun(_ context.Context, id string) (SetUpgradeRun, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	run, ok := s.setUpgradeRuns[id]
	return run, ok, nil
}

func (s *MemoryStore) ListSetUpgradeRuns(_ context.Context, batchID string, statuses []string, limit int) ([]SetUpgradeRun, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	wanted := map[string]struct{}{}
	for _, status := range statuses {
		wanted[status] = struct{}{}
	}
	result := make([]SetUpgradeRun, 0)
	for _, run := range s.setUpgradeRuns {
		if batchID != "" && run.BatchID != batchID {
			continue
		}
		if len(wanted) > 0 {
			if _, ok := wanted[run.Status]; !ok {
				continue
			}
		}
		result = append(result, run)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.Before(result[j].CreatedAt) })
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (s *MemoryStore) TryAcquireSetUpgradeRun(_ context.Context, id, owner string, ttl time.Duration, now time.Time) (SetUpgradeRun, bool, error) {
	if strings.TrimSpace(owner) == "" || ttl <= 0 {
		return SetUpgradeRun{}, false, fmt.Errorf("upgrade run lease requires owner and ttl")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.setUpgradeRuns[id]
	if !ok || setUpgradeRunTerminal(run.Status) {
		return SetUpgradeRun{}, false, nil
	}
	if run.LeaseOwner != "" && run.LeaseOwner != owner && run.LeaseUntil.After(now) {
		return SetUpgradeRun{}, false, nil
	}
	if run.Status == SetUpgradeRunStatusPending {
		batch, ok := s.setUpgradeBatches[run.BatchID]
		if !ok {
			return SetUpgradeRun{}, false, fmt.Errorf("upgrade batch %q not found", run.BatchID)
		}
		if rollout, ok := s.releaseRollouts[batch.RolloutID]; ok && rollout.CampaignID != "" {
			campaign, ok := s.releaseCampaigns[rollout.CampaignID]
			if !ok || campaign.Status == ReleaseCampaignStatusPaused || campaign.Status == ReleaseCampaignStatusCompleted {
				return SetUpgradeRun{}, false, nil
			}
		}
		active := 0
		for _, candidate := range s.setUpgradeRuns {
			if candidate.BatchID != run.BatchID || candidate.ID == run.ID {
				continue
			}
			if batch.StopOnFailure && candidate.Status == SetUpgradeRunStatusFailed {
				return SetUpgradeRun{}, false, nil
			}
			if !setUpgradeRunTerminal(candidate.Status) && candidate.Status != SetUpgradeRunStatusPending && candidate.LeaseUntil.After(now) {
				active++
			}
		}
		if batch.MaxParallel > 0 && active >= batch.MaxParallel {
			return SetUpgradeRun{}, false, nil
		}
	}
	run.LeaseOwner = owner
	run.LeaseUntil = now.Add(ttl)
	if run.Status == SetUpgradeRunStatusPending {
		run.Status = SetUpgradeRunStatusUpgradingMaster
		set, exists := s.sets[run.SetID]
		if !exists {
			return SetUpgradeRun{}, false, fmt.Errorf("set %q not found", run.SetID)
		}
		set.AdminWritesPaused = true
		set.AdminWritesPauseReason = "set upgrade " + run.ID
		set.AdminWritesPausedAt = now
		set.UpdatedAt = now
		s.sets[set.ID] = set
	}
	run.UpdatedAt = now
	s.setUpgradeRuns[id] = run
	return run, true, nil
}

func (s *MemoryStore) CompleteSetUpgradeCompatibility(_ context.Context, claimed SetUpgradeRun, success bool, lastError string, now time.Time) (SetUpgradeRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.claimedUpgradeRunLocked(claimed, SetUpgradeRunStatusVerifyingCompatibility, now)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	run.CompatibilityCheckedAt = now
	if success {
		run.Status = SetUpgradeRunStatusPreparing
		run.LastError = ""
	} else {
		run.Status = SetUpgradeRunStatusFailed
		run.LastError = strings.TrimSpace(lastError)
	}
	run.UpdatedAt = now
	s.setUpgradeRuns[run.ID] = run
	return run, nil
}

func (s *MemoryStore) PrepareSetUpgradeRuntime(_ context.Context, claimed SetUpgradeRun, runtime SetRuntime, now time.Time) (SetUpgradeRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.claimedUpgradeRunLocked(claimed, SetUpgradeRunStatusPreparing, now)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if runtime.SetID != run.SetID || runtime.Generation != run.ToGeneration || runtime.Image != run.TargetImage {
		return SetUpgradeRun{}, fmt.Errorf("candidate runtime does not match upgrade run")
	}
	runtime.ReleaseID = run.TargetReleaseID
	runtime.Status = SetRuntimeStatusPreparing
	runtime.CreatedAt = now
	runtime.UpdatedAt = now
	s.setRuntimes[setRuntimeStoreKey(runtime.SetID, runtime.Generation)] = runtime
	run.Status = SetUpgradeRunStatusProbing
	run.UpdatedAt = now
	s.setUpgradeRuns[run.ID] = run
	return run, nil
}

func (s *MemoryStore) RecordSetUpgradeProbe(_ context.Context, claimed SetUpgradeRun, success bool, lastError string, now time.Time) (SetUpgradeRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.claimedUpgradeRunLocked(claimed, SetUpgradeRunStatusProbing, now)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	key := setRuntimeStoreKey(run.SetID, run.ToGeneration)
	runtime := s.setRuntimes[key]
	if success {
		run.ConsecutiveProbeSuccesses++
		run.ConsecutiveProbeFailures = 0
		run.LastError = ""
		if run.ConsecutiveProbeSuccesses >= 3 {
			run.Status = SetUpgradeRunStatusSwitching
			runtime.Status = SetRuntimeStatusReady
		}
	} else {
		run.ConsecutiveProbeSuccesses = 0
		run.ConsecutiveProbeFailures++
		run.LastError = lastError
		if run.ConsecutiveProbeFailures >= 3 {
			run.Status = SetUpgradeRunStatusFailed
			runtime.Status = SetRuntimeStatusFailed
			set := s.sets[run.SetID]
			set.AdminWritesPaused = false
			set.AdminWritesPauseReason = ""
			set.AdminWritesPausedAt = time.Time{}
			set.UpdatedAt = now
			s.sets[set.ID] = set
		}
	}
	run.UpdatedAt = now
	runtime.UpdatedAt = now
	s.setRuntimes[key] = runtime
	s.setUpgradeRuns[run.ID] = run
	return run, nil
}

func (s *MemoryStore) RecordSetUpgradePostSwitchProbe(_ context.Context, claimed SetUpgradeRun, success bool, lastError string, now time.Time) (SetUpgradeRun, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.claimedUpgradeRunLocked(claimed, SetUpgradeRunStatusDraining, now)
	if err != nil {
		return SetUpgradeRun{}, false, err
	}
	if success {
		run.ConsecutiveProbeFailures = 0
		run.LastError = ""
	} else {
		run.ConsecutiveProbeFailures++
		run.LastError = lastError
	}
	run.UpdatedAt = now
	s.setUpgradeRuns[run.ID] = run
	return run, run.ConsecutiveProbeFailures >= 3, nil
}

func (s *MemoryStore) SwitchSetUpgradeRuntime(_ context.Context, claimed SetUpgradeRun, now time.Time) (SetUpgradeRun, SetRuntimeRouteSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.claimedUpgradeRunLocked(claimed, SetUpgradeRunStatusSwitching, now)
	if err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	set, ok := s.sets[run.SetID]
	if !ok || set.ActiveRuntimeGeneration != run.FromGeneration {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, fmt.Errorf("set active runtime changed during upgrade")
	}
	candidateKey := setRuntimeStoreKey(run.SetID, run.ToGeneration)
	candidate, ok := s.setRuntimes[candidateKey]
	if !ok || candidate.Status != SetRuntimeStatusReady {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, fmt.Errorf("candidate runtime is not ready")
	}
	if previous, ok := s.setRuntimes[setRuntimeStoreKey(run.SetID, run.FromGeneration)]; ok {
		previous.Status = SetRuntimeStatusDraining
		previous.UpdatedAt = now
		s.setRuntimes[setRuntimeStoreKey(run.SetID, run.FromGeneration)] = previous
	}
	candidate.Status = SetRuntimeStatusActive
	candidate.UpdatedAt = now
	s.setRuntimes[candidateKey] = candidate
	set.ActiveRuntimeGeneration = run.ToGeneration
	set.RouteRevision++
	if set.RouteRevision <= 0 {
		set.RouteRevision = 1
	}
	set.TrafficBaseURL = candidate.TrafficBaseURL
	set.UpdatedAt = now
	s.sets[set.ID] = set
	run.Status = SetUpgradeRunStatusSwitching
	run.SwitchedAt = now
	run.DrainDeadline = time.Time{}
	run.RollbackDeadline = time.Time{}
	run.UpdatedAt = now
	s.setUpgradeRuns[run.ID] = run
	snapshot := runtimeRouteSnapshotForSet(set, now)
	s.enqueueRuntimeRouteOutboxLocked(snapshot, now)
	return run, snapshot, nil
}

func (s *MemoryStore) RollbackSetUpgradeRuntime(_ context.Context, claimed SetUpgradeRun, now time.Time, reason string) (SetUpgradeRun, SetRuntimeRouteSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.claimedUpgradeRunLocked(claimed, SetUpgradeRunStatusDraining, now)
	if err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	if !run.RollbackDeadline.IsZero() && now.After(run.RollbackDeadline) {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, fmt.Errorf("rollback window expired")
	}
	set := s.sets[run.SetID]
	previousKey := setRuntimeStoreKey(run.SetID, run.FromGeneration)
	previous, ok := s.setRuntimes[previousKey]
	if !ok {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, fmt.Errorf("previous runtime is unavailable")
	}
	currentKey := setRuntimeStoreKey(run.SetID, run.ToGeneration)
	current := s.setRuntimes[currentKey]
	current.Status = SetRuntimeStatusDraining
	current.UpdatedAt = now
	s.setRuntimes[currentKey] = current
	previous.Status = SetRuntimeStatusActive
	previous.UpdatedAt = now
	s.setRuntimes[previousKey] = previous
	set.ActiveRuntimeGeneration = run.FromGeneration
	set.RouteRevision++
	set.TrafficBaseURL = previous.TrafficBaseURL
	set.UpdatedAt = now
	s.sets[set.ID] = set
	run.Status = SetUpgradeRunStatusRollbackSwitching
	run.DrainDeadline = time.Time{}
	run.LastError = reason
	run.UpdatedAt = now
	s.setUpgradeRuns[run.ID] = run
	snapshot := runtimeRouteSnapshotForSet(set, now)
	s.enqueueRuntimeRouteOutboxLocked(snapshot, now)
	return run, snapshot, nil
}

func (s *MemoryStore) ConfirmSetRuntimeRoutePublished(_ context.Context, setID string, routeRevision int64, now time.Time) (SetUpgradeRun, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	set, ok := s.sets[setID]
	if !ok || set.RouteRevision != routeRevision {
		return SetUpgradeRun{}, false, nil
	}
	for id, run := range s.setUpgradeRuns {
		if run.SetID != setID {
			continue
		}
		switch run.Status {
		case SetUpgradeRunStatusSwitching:
			if set.ActiveRuntimeGeneration != run.ToGeneration {
				continue
			}
			run.Status = SetUpgradeRunStatusDraining
			run.DrainDeadline = now.Add(run.DrainTimeout)
			run.RollbackDeadline = now.Add(run.RollbackWindow)
			set.AdminWritesPaused = false
			set.AdminWritesPauseReason = ""
			set.AdminWritesPausedAt = time.Time{}
			set.UpdatedAt = now
			s.sets[set.ID] = set
		case SetUpgradeRunStatusRollbackSwitching:
			if set.ActiveRuntimeGeneration != run.FromGeneration {
				continue
			}
			run.Status = SetUpgradeRunStatusRollbackDraining
			run.DrainDeadline = now.Add(run.DrainTimeout)
		default:
			continue
		}
		run.UpdatedAt = now
		s.setUpgradeRuns[id] = run
		return run, true, nil
	}
	return SetUpgradeRun{}, false, nil
}

func (s *MemoryStore) AdvanceSetUpgradeAfterDrain(_ context.Context, claimed SetUpgradeRun, now time.Time) (SetUpgradeRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.setUpgradeRuns[claimed.ID]
	if !ok || (run.Status != SetUpgradeRunStatusDraining && run.Status != SetUpgradeRunStatusRollbackDraining) {
		return SetUpgradeRun{}, fmt.Errorf("upgrade run %q is not draining", claimed.ID)
	}
	if run.LeaseOwner == "" || run.LeaseOwner != claimed.LeaseOwner || !run.LeaseUntil.After(now) {
		return SetUpgradeRun{}, fmt.Errorf("upgrade run lease is not owned or expired")
	}
	if now.Before(run.DrainDeadline) {
		return SetUpgradeRun{}, fmt.Errorf("drain deadline has not elapsed")
	}
	retiredGeneration := run.FromGeneration
	if run.Status == SetUpgradeRunStatusRollbackDraining {
		retiredGeneration = run.ToGeneration
		run.Status = SetUpgradeRunStatusRolledBack
	} else {
		run.Status = SetUpgradeRunStatusCompleted
	}
	if run.TargetReleaseID != "" {
		set := s.sets[run.SetID]
		if run.Status == SetUpgradeRunStatusCompleted {
			set.CurrentReleaseID = run.TargetReleaseID
		}
		set.TargetReleaseID = ""
		set.UpdatedAt = now
		s.sets[run.SetID] = set
	}
	key := setRuntimeStoreKey(run.SetID, retiredGeneration)
	runtime := s.setRuntimes[key]
	runtime.Status = SetRuntimeStatusRetired
	runtime.UpdatedAt = now
	s.setRuntimes[key] = runtime
	run.UpdatedAt = now
	s.setUpgradeRuns[run.ID] = run
	return run, nil
}

func (s *MemoryStore) CompleteSetUpgradeMaster(_ context.Context, claimed SetUpgradeRun, success bool, lastError string, now time.Time) (SetUpgradeRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.claimedUpgradeRunLocked(claimed, SetUpgradeRunStatusUpgradingMaster, now)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	set := s.sets[run.SetID]
	if success {
		run.Status = SetUpgradeRunStatusVerifyingCompatibility
		run.LastError = ""
		run.MasterUpgradedAt = now
		set.AdminImage = run.TargetImage
		set.AdminHealthStatus = SetAdminHealthHealthy
		set.AdminHealthConsecutiveFailures = 0
		set.AdminHealthError = ""
		set.AdminHealthCheckedAt = now
		set.AdminHealthLastSuccessAt = now
	} else {
		run.Status = SetUpgradeRunStatusFailed
		run.LastError = lastError
		set.AdminHealthStatus = SetAdminHealthUnhealthy
		set.AdminHealthError = lastError
	}
	set.UpdatedAt = now
	run.UpdatedAt = now
	s.sets[set.ID] = set
	s.setUpgradeRuns[run.ID] = run
	return run, nil
}

func (s *MemoryStore) RequestSetUpgradeRollback(_ context.Context, id, reason string, now time.Time) (SetUpgradeRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.setUpgradeRuns[id]
	if !ok {
		return SetUpgradeRun{}, fmt.Errorf("set upgrade run %q not found", id)
	}
	if run.Status != SetUpgradeRunStatusDraining {
		return SetUpgradeRun{}, fmt.Errorf("set upgrade run %q is not rollbackable", id)
	}
	if !run.RollbackDeadline.IsZero() && now.After(run.RollbackDeadline) {
		return SetUpgradeRun{}, fmt.Errorf("rollback window expired")
	}
	run.RollbackRequested = true
	run.RollbackReason = strings.TrimSpace(reason)
	run.UpdatedAt = now
	s.setUpgradeRuns[id] = run
	return run, nil
}

func (s *MemoryStore) RetrySetUpgradeRun(_ context.Context, id string, now time.Time) (SetUpgradeRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.setUpgradeRuns[id]
	if !ok {
		return SetUpgradeRun{}, fmt.Errorf("set upgrade run %q not found", id)
	}
	if run.Status != SetUpgradeRunStatusFailed {
		return SetUpgradeRun{}, fmt.Errorf("set upgrade run %q is not retryable", id)
	}
	set := s.sets[run.SetID]
	if set.ActiveRuntimeGeneration == run.FromGeneration {
		run.Status = SetUpgradeRunStatusPending
		run.ConsecutiveProbeFailures = 0
		run.ConsecutiveProbeSuccesses = 0
	} else if set.ActiveRuntimeGeneration == run.ToGeneration {
		run.Status = SetUpgradeRunStatusPreparing
	} else {
		return SetUpgradeRun{}, fmt.Errorf("set active runtime is inconsistent with upgrade run")
	}
	run.LeaseOwner = ""
	run.LeaseUntil = time.Time{}
	run.LastError = ""
	run.UpdatedAt = now
	s.setUpgradeRuns[id] = run
	return run, nil
}

func (s *MemoryStore) claimedUpgradeRunLocked(claimed SetUpgradeRun, expected string, now time.Time) (SetUpgradeRun, error) {
	run, ok := s.setUpgradeRuns[claimed.ID]
	if !ok || run.Status != expected {
		return SetUpgradeRun{}, fmt.Errorf("upgrade run %q is not in %s", claimed.ID, expected)
	}
	if run.LeaseOwner == "" || run.LeaseOwner != claimed.LeaseOwner || !run.LeaseUntil.After(now) {
		return SetUpgradeRun{}, fmt.Errorf("upgrade run lease is not owned or expired")
	}
	return run, nil
}

func runtimeRouteSnapshotForSet(set Set, now time.Time) SetRuntimeRouteSnapshot {
	return SetRuntimeRouteSnapshot{
		SetID: set.ID, RuntimeGeneration: set.ActiveRuntimeGeneration, RouteRevision: set.RouteRevision,
		TrafficBaseURL: set.TrafficBaseURL, Enabled: set.Status == SetStatusActive, SwitchedAt: now,
	}
}

func (s *MemoryStore) enqueueRuntimeRouteOutboxLocked(snapshot SetRuntimeRouteSnapshot, now time.Time) {
	id := fmt.Sprintf("%s-%d", snapshot.SetID, snapshot.RouteRevision)
	s.setRuntimeRouteOutbox[id] = SetRuntimeRouteOutbox{
		ID: id, SetID: snapshot.SetID, RouteRevision: snapshot.RouteRevision, Snapshot: snapshot,
		Status: SetRuntimeRouteOutboxStatusPending, CreatedAt: now, UpdatedAt: now,
	}
}

func (s *MemoryStore) ListSetRuntimeRouteOutbox(_ context.Context, status string, limit int) ([]SetRuntimeRouteOutbox, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]SetRuntimeRouteOutbox, 0)
	for _, item := range s.setRuntimeRouteOutbox {
		if status == "" || item.Status == status {
			result = append(result, item)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].RouteRevision < result[j].RouteRevision })
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (s *MemoryStore) CompleteSetRuntimeRouteOutbox(_ context.Context, id string, success bool, lastError string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.setRuntimeRouteOutbox[id]
	if !ok {
		return fmt.Errorf("runtime route outbox %q not found", id)
	}
	item.Attempts++
	item.LastError = lastError
	item.UpdatedAt = now
	if success {
		item.Status = SetRuntimeRouteOutboxStatusPublished
	}
	s.setRuntimeRouteOutbox[id] = item
	return nil
}
