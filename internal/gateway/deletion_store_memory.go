package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

func tenantDeletionTargetKey(jobID, externalUserID string) string {
	return jobID + "\x00" + externalUserID
}

func (s *MemoryStore) CreateTenantDeletionJob(_ context.Context, job TenantDeletionJob, targets []TenantDeletionTarget) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if strings.TrimSpace(job.ID) == "" {
		return fmt.Errorf("tenant deletion job id is required")
	}
	if _, exists := s.tenantDeletionJobs[job.ID]; exists {
		return fmt.Errorf("tenant deletion job %q already exists", job.ID)
	}
	now := time.Now().UTC()
	if job.CreatedAt.IsZero() {
		job.CreatedAt = now
	}
	if job.SnapshotAt.IsZero() {
		job.SnapshotAt = now
	}
	job.UpdatedAt = now
	s.tenantDeletionJobs[job.ID] = job
	for _, target := range targets {
		target.JobID = job.ID
		if target.Status == "" {
			target.Status = TenantDeletionTargetStatusPending
		}
		if target.CreatedAt.IsZero() {
			target.CreatedAt = now
		}
		target.UpdatedAt = now
		s.tenantDeletionTargets[tenantDeletionTargetKey(job.ID, target.ExternalUserID)] = target
	}
	return nil
}

func (s *MemoryStore) MaterializeTenantDeletionJob(_ context.Context, jobID string, batchSize int, now time.Time) (TenantDeletionJob, error) {
	if batchSize <= 0 {
		return TenantDeletionJob{}, fmt.Errorf("batch size must be positive")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.tenantDeletionJobs[jobID]
	if !ok {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job %q not found", jobID)
	}
	if job.Status != TenantDeletionStatusMaterializing {
		return job, nil
	}
	candidates := make([]Tenant, 0)
	userIDSet := make(map[string]struct{}, len(job.UserIDs))
	for _, id := range job.UserIDs {
		userIDSet[id] = struct{}{}
	}
	for _, tenant := range s.tenants {
		if tenant.Status == TenantStatusDeleted || tenant.ExternalUserID <= job.MaterializationCursor {
			continue
		}
		if !job.SnapshotAt.IsZero() && tenant.CreatedAt.After(job.SnapshotAt) {
			continue
		}
		matches := false
		switch job.SelectorType {
		case tenantDeletionSelectorUserIDs:
			_, matches = userIDSet[tenant.ExternalUserID]
		case tenantDeletionSelectorPrefix:
			matches = strings.HasPrefix(tenant.ExternalUserID, job.SelectorValue)
		case tenantDeletionSelectorSet:
			matches = tenant.SetID == job.SelectorValue
		}
		if matches {
			candidates = append(candidates, tenant)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].ExternalUserID < candidates[j].ExternalUserID
	})
	more := len(candidates) > batchSize
	if more {
		candidates = candidates[:batchSize]
	}
	for _, tenant := range candidates {
		target := TenantDeletionTarget{
			JobID: job.ID, ExternalUserID: tenant.ExternalUserID, SetID: tenant.SetID,
			Status: TenantDeletionTargetStatusPending, CreatedAt: now, UpdatedAt: now,
		}
		s.tenantDeletionTargets[tenantDeletionTargetKey(job.ID, tenant.ExternalUserID)] = target
		job.MaterializationCursor = tenant.ExternalUserID
	}
	if !more {
		targets := s.listTenantDeletionTargetsLocked(job.ID, TenantDeletionTargetListOptions{})
		job.TargetCount = len(targets)
		job.TargetDigest = tenantDeletionTargetDigest(targets)
		job.Status = TenantDeletionStatusPreviewed
	}
	job.Version++
	job.UpdatedAt = now
	s.tenantDeletionJobs[job.ID] = job
	return job, nil
}

func (s *MemoryStore) StartTenantDeletionJob(_ context.Context, jobID string, input TenantDeletionStartInput, now time.Time) (TenantDeletionJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.tenantDeletionJobs[jobID]
	if !ok {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job %q not found", jobID)
	}
	if job.IdempotencyKey != "" {
		if job.IdempotencyKey == input.IdempotencyKey && job.TargetCount == input.ExpectedTargetCount && job.TargetDigest == input.ExpectedTargetDigest {
			return job, nil
		}
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job already started with another request")
	}
	for _, existing := range s.tenantDeletionJobs {
		if existing.IdempotencyKey == input.IdempotencyKey && existing.ID != jobID {
			return TenantDeletionJob{}, fmt.Errorf("idempotency key already used by tenant deletion job %q", existing.ID)
		}
	}
	if job.Status != TenantDeletionStatusPreviewed {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job %q is not previewed", jobID)
	}
	if job.TargetCount != input.ExpectedTargetCount || job.TargetDigest != input.ExpectedTargetDigest {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion preview changed")
	}
	job.Status = TenantDeletionStatusClaiming
	job.IdempotencyKey = input.IdempotencyKey
	job.Version++
	job.UpdatedAt = now
	s.tenantDeletionJobs[job.ID] = job
	return job, nil
}

func (s *MemoryStore) ClaimTenantDeletionJob(_ context.Context, jobID string, batchSize int, now time.Time) (TenantDeletionJob, error) {
	if batchSize <= 0 {
		return TenantDeletionJob{}, fmt.Errorf("batch size must be positive")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.tenantDeletionJobs[jobID]
	if !ok {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job %q not found", jobID)
	}
	if job.Status != TenantDeletionStatusClaiming {
		return job, nil
	}
	targets := s.listTenantDeletionTargetsLocked(jobID, TenantDeletionTargetListOptions{})
	unclaimed := make([]TenantDeletionTarget, 0, batchSize)
	for _, target := range targets {
		if s.tenantDeletionClaims[target.ExternalUserID] == jobID {
			continue
		}
		if claimedBy := s.tenantDeletionClaims[target.ExternalUserID]; claimedBy != "" {
			for userID, ownerJobID := range s.tenantDeletionClaims {
				if ownerJobID == jobID {
					delete(s.tenantDeletionClaims, userID)
				}
			}
			job.Status = TenantDeletionStatusError
			job.ClaimedCount = 0
			job.LastError = fmt.Sprintf("tenant %s already claimed by deletion job %s", target.ExternalUserID, claimedBy)
			job.Version++
			job.UpdatedAt = now
			s.tenantDeletionJobs[job.ID] = job
			return job, fmt.Errorf("tenant %s is already claimed by deletion job %s", target.ExternalUserID, claimedBy)
		}
		unclaimed = append(unclaimed, target)
		if len(unclaimed) >= batchSize {
			break
		}
	}
	for _, target := range unclaimed {
		s.tenantDeletionClaims[target.ExternalUserID] = jobID
		if tenant, ok := s.tenants[target.ExternalUserID]; ok && tenant.Status != TenantStatusDeleted {
			tenant.Status = TenantStatusDeleting
			tenant.UpdatedAt = now
			s.tenants[target.ExternalUserID] = tenant
		}
	}
	claimed := 0
	for _, ownerJobID := range s.tenantDeletionClaims {
		if ownerJobID == jobID {
			claimed++
		}
	}
	job.ClaimedCount = claimed
	if claimed == job.TargetCount {
		job.Status = TenantDeletionStatusQueued
	}
	job.Version++
	job.UpdatedAt = now
	s.tenantDeletionJobs[job.ID] = job
	return job, nil
}

func (s *MemoryStore) AcquireTenantDeletionTarget(_ context.Context, owner string, ttl time.Duration, now time.Time) (TenantDeletionTarget, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	jobs := make([]TenantDeletionJob, 0)
	for _, job := range s.tenantDeletionJobs {
		if job.Status == TenantDeletionStatusQueued || job.Status == TenantDeletionStatusRunning || job.Status == TenantDeletionStatusPartial {
			jobs = append(jobs, job)
		}
	}
	sort.Slice(jobs, func(i, j int) bool {
		if !jobs[i].CreatedAt.Equal(jobs[j].CreatedAt) {
			return jobs[i].CreatedAt.Before(jobs[j].CreatedAt)
		}
		return jobs[i].ID < jobs[j].ID
	})
	for _, job := range jobs {
		targets := s.listTenantDeletionTargetsLocked(job.ID, TenantDeletionTargetListOptions{})
		for _, target := range targets {
			eligible := target.Status == TenantDeletionTargetStatusPending ||
				(target.Status == TenantDeletionTargetStatusError && target.Attempts < maxTenantDeletionAttempts && !target.UpdatedAt.Add(tenantDeletionRetryDelay).After(now)) ||
				(target.Status == TenantDeletionTargetStatusRunning && !target.LeaseUntil.After(now))
			if !eligible {
				continue
			}
			if s.tenantDeletionClaims[target.ExternalUserID] != job.ID {
				continue
			}
			tenant, ok := s.tenants[target.ExternalUserID]
			if ok && tenant.Status != TenantStatusDeleted {
				tenant.Status = TenantStatusDeleting
				tenant.UpdatedAt = now
				s.tenants[target.ExternalUserID] = tenant
			}
			target.Status = TenantDeletionTargetStatusRunning
			target.Attempts++
			target.LeaseOwner = owner
			target.LeaseUntil = now.Add(ttl)
			target.LastError = ""
			target.UpdatedAt = now
			s.tenantDeletionTargets[tenantDeletionTargetKey(job.ID, target.ExternalUserID)] = target
			job.Status = TenantDeletionStatusRunning
			job.Version++
			job.UpdatedAt = now
			s.tenantDeletionJobs[job.ID] = job
			return target, true, nil
		}
	}
	return TenantDeletionTarget{}, false, nil
}

func (s *MemoryStore) FailTenantDeletionTarget(_ context.Context, target TenantDeletionTarget, lastError string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := tenantDeletionTargetKey(target.JobID, target.ExternalUserID)
	current, ok := s.tenantDeletionTargets[key]
	if !ok || current.LeaseOwner != target.LeaseOwner {
		return fmt.Errorf("tenant deletion target lease was lost")
	}
	current.Status = TenantDeletionTargetStatusError
	current.LeaseOwner = ""
	current.LeaseUntil = time.Time{}
	current.LastError = strings.TrimSpace(lastError)
	current.UpdatedAt = now
	s.tenantDeletionTargets[key] = current
	job := s.tenantDeletionJobs[target.JobID]
	job.Status = TenantDeletionStatusPartial
	job.FailureCount = countTenantDeletionTargetsByStatus(s.tenantDeletionTargets, job.ID, TenantDeletionTargetStatusError)
	job.LastError = current.LastError
	job.Version++
	job.UpdatedAt = now
	s.tenantDeletionJobs[job.ID] = job
	return nil
}

func (s *MemoryStore) PurgeTenantDeletionTarget(_ context.Context, target TenantDeletionTarget, now time.Time) (TenantDeletionJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := tenantDeletionTargetKey(target.JobID, target.ExternalUserID)
	current, ok := s.tenantDeletionTargets[key]
	if !ok || current.LeaseOwner != target.LeaseOwner || current.Status != TenantDeletionTargetStatusRunning {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion target lease was lost")
	}
	binding, bindingDeleted := s.users[target.ExternalUserID]
	delete(s.users, target.ExternalUserID)
	for keyID, apiKey := range s.apiKeysByID {
		if apiKey.UserID != target.ExternalUserID {
			continue
		}
		delete(s.apiKeysByID, keyID)
		if apiKey.ExternalKeyHash != "" {
			delete(s.apiKeysByHash, apiKey.ExternalKeyHash)
		} else if apiKey.ExternalKey != "" {
			delete(s.apiKeysByHash, hashExternalKey(apiKey.ExternalKey))
		}
	}
	delete(s.assignments, target.ExternalUserID)
	delete(s.llmSettings, target.ExternalUserID)
	delete(s.byokSyncTasks, target.ExternalUserID)
	delete(s.observations, target.ExternalUserID)
	delete(s.observationTasks, target.ExternalUserID)
	delete(s.periodEnds, target.ExternalUserID)
	for id, command := range s.adminCommands {
		if command.ExternalUserID == target.ExternalUserID {
			delete(s.adminCommands, id)
			delete(s.adminCommandDedupe, command.DedupeKey)
		}
	}
	if desiredKey := s.groupRatioByUser[target.ExternalUserID]; desiredKey != "" {
		delete(s.groupRatioByUser, target.ExternalUserID)
		delete(s.groupRatioDesired, desiredKey)
		if state, ok := s.groupRatioStates[target.SetID]; ok {
			state.DesiredVersion++
			state.Status = GroupRatioApplyStatusPending
			state.UpdatedAt = now
			s.groupRatioStates[target.SetID] = state
		}
	}
	tenant := s.tenants[target.ExternalUserID]
	tenant.Status = TenantStatusDeleted
	tenant.UpdatedAt = now
	s.tenants[target.ExternalUserID] = tenant
	if bindingDeleted && binding.SetID != "" {
		set := s.sets[binding.SetID]
		if set.ObservedUserCount > 0 {
			set.ObservedUserCount--
		}
		set.CapacityUpdatedAt = now
		set.UpdatedAt = now
		s.sets[set.ID] = set
	}
	current.Status = TenantDeletionTargetStatusSucceeded
	current.LeaseOwner = ""
	current.LeaseUntil = time.Time{}
	current.LastError = ""
	current.UpdatedAt = now
	s.tenantDeletionTargets[key] = current
	delete(s.tenantDeletionClaims, target.ExternalUserID)
	job := s.tenantDeletionJobs[target.JobID]
	job.SuccessCount = countTenantDeletionTargetsByStatus(s.tenantDeletionTargets, job.ID, TenantDeletionTargetStatusSucceeded)
	job.FailureCount = countTenantDeletionTargetsByStatus(s.tenantDeletionTargets, job.ID, TenantDeletionTargetStatusError)
	if job.SuccessCount == job.TargetCount {
		job.Status = TenantDeletionStatusSucceeded
		job.LastError = ""
	} else if job.FailureCount > 0 {
		job.Status = TenantDeletionStatusPartial
	} else {
		job.Status = TenantDeletionStatusRunning
	}
	job.Version++
	job.UpdatedAt = now
	s.tenantDeletionJobs[job.ID] = job
	return job, nil
}

func countTenantDeletionTargetsByStatus(targets map[string]TenantDeletionTarget, jobID, status string) int {
	count := 0
	for _, target := range targets {
		if target.JobID == jobID && target.Status == status {
			count++
		}
	}
	return count
}

func (s *MemoryStore) GetTenantDeletionJob(_ context.Context, jobID string) (TenantDeletionJob, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	job, ok := s.tenantDeletionJobs[jobID]
	return job, ok, nil
}

func (s *MemoryStore) ListTenantDeletionJobs(_ context.Context, opts TenantDeletionJobListOptions) ([]TenantDeletionJob, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	jobs := make([]TenantDeletionJob, 0, len(s.tenantDeletionJobs))
	for _, job := range s.tenantDeletionJobs {
		if opts.Status != "" && job.Status != opts.Status {
			continue
		}
		jobs = append(jobs, job)
	}
	sort.Slice(jobs, func(i, j int) bool {
		if !jobs[i].CreatedAt.Equal(jobs[j].CreatedAt) {
			return jobs[i].CreatedAt.After(jobs[j].CreatedAt)
		}
		return jobs[i].ID < jobs[j].ID
	})
	if opts.Limit > 0 && len(jobs) > opts.Limit {
		jobs = jobs[:opts.Limit]
	}
	return jobs, nil
}

func (s *MemoryStore) ListTenantDeletionTargets(_ context.Context, jobID string, opts TenantDeletionTargetListOptions) ([]TenantDeletionTarget, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.listTenantDeletionTargetsLocked(jobID, opts), nil
}

func (s *MemoryStore) listTenantDeletionTargetsLocked(jobID string, opts TenantDeletionTargetListOptions) []TenantDeletionTarget {
	targets := make([]TenantDeletionTarget, 0)
	for _, target := range s.tenantDeletionTargets {
		if target.JobID != jobID || (opts.Status != "" && target.Status != opts.Status) {
			continue
		}
		targets = append(targets, target)
	}
	sort.Slice(targets, func(i, j int) bool {
		return targets[i].ExternalUserID < targets[j].ExternalUserID
	})
	if opts.Limit > 0 && len(targets) > opts.Limit {
		targets = targets[:opts.Limit]
	}
	return targets
}

func (s *MemoryStore) GetSetDecommissionPreview(_ context.Context, setID string, now time.Time) (SetDecommissionPreview, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.setDecommissionPreviewLocked(setID, now)
}

func (s *MemoryStore) setDecommissionPreviewLocked(setID string, now time.Time) (SetDecommissionPreview, error) {
	set, ok := s.sets[setID]
	if !ok {
		return SetDecommissionPreview{}, fmt.Errorf("set %q not found", setID)
	}
	var blockers SetDecommissionBlockers
	for _, tenant := range s.tenants {
		if tenant.SetID == setID && tenant.Status != TenantStatusDeleted {
			blockers.Tenants++
		}
	}
	for _, binding := range s.users {
		if binding.SetID == setID {
			blockers.UserBindings++
		}
	}
	for _, key := range s.apiKeysByID {
		if key.SetID == setID {
			blockers.APIKeys++
		}
	}
	for _, assignment := range s.assignments {
		if assignment.SetID == setID {
			blockers.Assignments++
		}
	}
	for userID := range s.llmSettings {
		if binding, ok := s.users[userID]; ok && binding.SetID == setID {
			blockers.BYOKSettings++
		}
	}
	for _, task := range s.byokSyncTasks {
		if task.SetID == setID {
			blockers.BYOKTasks++
		}
	}
	for _, observation := range s.observations {
		if observation.SetID == setID {
			blockers.Observations++
		}
	}
	for _, task := range s.observationTasks {
		if task.SetID == setID {
			blockers.ObservationTasks++
		}
	}
	for _, overlay := range s.periodEnds {
		if overlay.SetID == setID {
			blockers.SubscriptionOverlays++
		}
	}
	for _, command := range s.adminCommands {
		if command.SetID == setID && command.Status != AdminCommandStatusSucceeded {
			blockers.AdminCommands++
		}
	}
	for _, desired := range s.groupRatioDesired {
		if desired.SetID == setID && desired.ExternalUserID != "" {
			blockers.GroupRatioIntents++
		}
	}
	for _, target := range s.tenantDeletionTargets {
		if target.SetID == setID && target.Status != TenantDeletionTargetStatusSucceeded && target.Status != TenantDeletionTargetStatusAbandoned {
			blockers.DeletionTargets++
		}
	}
	for _, lease := range s.setOperationLeases {
		if lease.SetID == setID && lease.Owner != "" && lease.LeaseUntil.After(now) {
			blockers.ActiveOperationLeases++
		}
	}
	for _, lease := range s.runtimeLeases {
		if lease.SetID == setID {
			blockers.RuntimeLeases++
		}
	}
	return SetDecommissionPreview{
		SetID: setID, Empty: blockers.Total() == 0, Blockers: blockers,
		Digest: setDecommissionDigest(set, blockers),
	}, nil
}

func (s *MemoryStore) StartSetDecommission(_ context.Context, input SetDecommissionStartInput, jobID string, now time.Time) (SetDecommissionJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.setDecommissionJobs {
		if existing.IdempotencyKey == input.IdempotencyKey {
			if existing.SetID == input.SetID && existing.ExpectedDigest == input.ExpectedDigest &&
				existing.CascadeTenants == input.CascadeTenants && existing.AllowOrphan == input.AllowOrphan {
				return existing, nil
			}
			return SetDecommissionJob{}, fmt.Errorf("idempotency key already used with another set decommission request")
		}
	}
	preview, err := s.setDecommissionPreviewLocked(input.SetID, now)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if preview.Digest != input.ExpectedDigest {
		return SetDecommissionJob{}, fmt.Errorf("set decommission preview changed")
	}
	if !preview.Empty && !input.CascadeTenants {
		return SetDecommissionJob{}, fmt.Errorf("set %q is not empty", input.SetID)
	}
	if input.AllowOrphan && !input.CascadeTenants {
		return SetDecommissionJob{}, fmt.Errorf("orphan cleanup requires cascade_tenants")
	}
	if input.CascadeTenants && (preview.Blockers.ActiveOperationLeases > 0 || preview.Blockers.DeletionTargets > 0) {
		return SetDecommissionJob{}, fmt.Errorf("set %q has conflicting operations", input.SetID)
	}
	if preview.Blockers.RuntimeLeases == 0 && !input.AllowOrphan {
		return SetDecommissionJob{}, fmt.Errorf("set %q requires exactly one complete runtime lease", input.SetID)
	}
	if preview.Blockers.RuntimeLeases > 1 || (preview.Blockers.RuntimeLeases == 1 && input.AllowOrphan) {
		return SetDecommissionJob{}, fmt.Errorf("set %q runtime lease does not match orphan cleanup mode", input.SetID)
	}
	set := s.sets[input.SetID]
	if set.Status != SetStatusActive && set.Status != SetStatusDisabled {
		return SetDecommissionJob{}, fmt.Errorf("set %q cannot be decommissioned from status %q", input.SetID, set.Status)
	}
	if input.AllowOrphan && set.Status != SetStatusDisabled {
		return SetDecommissionJob{}, fmt.Errorf("orphan set %q must be disabled before cleanup", input.SetID)
	}
	previousStatus := set.Status
	set.Status = SetStatusDraining
	set.LifecycleGeneration++
	set.UpdatedAt = now
	s.sets[set.ID] = set
	status := SetDecommissionStatusPending
	if input.CascadeTenants && (!preview.Empty || input.AllowOrphan) {
		status = SetDecommissionStatusPurgingTenants
		for id, tenant := range s.tenants {
			if tenant.SetID == input.SetID && tenant.Status != TenantStatusDeleted {
				tenant.Status = TenantStatusDeleting
				tenant.UpdatedAt = now
				s.tenants[id] = tenant
			}
		}
	}
	job := SetDecommissionJob{
		ID: jobID, SetID: input.SetID, Status: status,
		PreviousSetStatus:   previousStatus,
		LifecycleGeneration: set.LifecycleGeneration, ExpectedDigest: input.ExpectedDigest,
		IdempotencyKey: input.IdempotencyKey, CascadeTenants: input.CascadeTenants, AllowOrphan: input.AllowOrphan,
		Version: 1, CreatedAt: now, UpdatedAt: now,
	}
	s.setDecommissionJobs[job.ID] = job
	return job, nil
}

func (s *MemoryStore) AcquireSetDecommissionCascade(_ context.Context, owner string, ttl time.Duration, now time.Time) (SetDecommissionJob, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	ids := make([]string, 0, len(s.setDecommissionJobs))
	for id := range s.setDecommissionJobs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		job := s.setDecommissionJobs[id]
		if job.Status != SetDecommissionStatusPurgingTenants ||
			(job.ClaimOwner != "" && job.ClaimLeaseUntil.After(now)) ||
			(job.LastError != "" && job.UpdatedAt.After(now.Add(-setCascadeRetryDelay))) {
			continue
		}
		set, ok := s.sets[job.SetID]
		if !ok || set.Status != SetStatusDraining || set.LifecycleGeneration != job.LifecycleGeneration {
			message := fmt.Sprintf("set %q lifecycle changed", job.SetID)
			job.Status = SetDecommissionStatusError
			job.ClaimOwner = ""
			job.ClaimToken = ""
			job.ClaimLeaseUntil = time.Time{}
			job.LastError = message
			job.Version++
			job.UpdatedAt = now
			s.setDecommissionJobs[id] = job
			return SetDecommissionJob{}, false, fmt.Errorf("%s", message)
		}
		job.ClaimOwner = owner
		job.ClaimToken = randomSecret()
		job.ClaimLeaseUntil = now.Add(ttl)
		job.LastError = ""
		job.Version++
		job.UpdatedAt = now
		s.setDecommissionJobs[id] = job
		return job, true, nil
	}
	return SetDecommissionJob{}, false, nil
}

func (s *MemoryStore) CompleteSetDecommissionCascade(_ context.Context, jobID, claimToken string, now time.Time) (SetDecommissionJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.setDecommissionJobs[jobID]
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", jobID)
	}
	if job.Status != SetDecommissionStatusPurgingTenants || job.ClaimToken == "" || job.ClaimToken != claimToken ||
		!job.ClaimLeaseUntil.After(now) {
		return SetDecommissionJob{}, fmt.Errorf("set decommission cascade lease was lost")
	}
	set, ok := s.sets[job.SetID]
	if !ok || set.Status != SetStatusDraining || set.LifecycleGeneration != job.LifecycleGeneration {
		return SetDecommissionJob{}, fmt.Errorf("set %q lifecycle changed", job.SetID)
	}
	s.purgeSetTenantStateLocked(job.SetID, now)
	job.ClaimOwner = ""
	job.ClaimToken = ""
	job.ClaimLeaseUntil = time.Time{}
	job.LastError = ""
	job.Version++
	job.UpdatedAt = now
	if job.AllowOrphan {
		s.finalizeLocalOrphanSetLocked(job.SetID, job.LifecycleGeneration, now)
		job.Status = SetDecommissionStatusSucceeded
	} else {
		job.Status = SetDecommissionStatusPending
	}
	s.setDecommissionJobs[job.ID] = job
	return job, nil
}

func (s *MemoryStore) FailSetDecommissionCascade(_ context.Context, jobID, claimToken, lastError string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.setDecommissionJobs[jobID]
	if !ok {
		return fmt.Errorf("set decommission job %q not found", jobID)
	}
	if job.Status != SetDecommissionStatusPurgingTenants || job.ClaimToken != claimToken {
		return fmt.Errorf("set decommission cascade lease was lost")
	}
	job.ClaimOwner = ""
	job.ClaimToken = ""
	job.ClaimLeaseUntil = time.Time{}
	job.LastError = strings.TrimSpace(lastError)
	job.Version++
	job.UpdatedAt = now
	s.setDecommissionJobs[job.ID] = job
	return nil
}

func (s *MemoryStore) purgeSetTenantStateLocked(setID string, now time.Time) {
	userIDs := map[string]bool{}
	for id, tenant := range s.tenants {
		if tenant.SetID == setID {
			userIDs[id] = true
			tenant.Status = TenantStatusDeleted
			tenant.UpdatedAt = now
			s.tenants[id] = tenant
		}
	}
	for id, binding := range s.users {
		if binding.SetID == setID {
			userIDs[id] = true
			delete(s.users, id)
		}
	}
	for id, binding := range s.apiKeysByID {
		if binding.SetID != setID {
			continue
		}
		delete(s.apiKeysByID, id)
		if binding.ExternalKeyHash != "" {
			delete(s.apiKeysByHash, binding.ExternalKeyHash)
		} else if binding.ExternalKey != "" {
			delete(s.apiKeysByHash, hashExternalKey(binding.ExternalKey))
		}
	}
	for userID := range userIDs {
		delete(s.llmSettings, userID)
		delete(s.groupRatioByUser, userID)
	}
	for id, task := range s.byokSyncTasks {
		if task.SetID == setID || userIDs[task.ExternalUserID] {
			delete(s.byokSyncTasks, id)
		}
	}
	for id, desired := range s.groupRatioDesired {
		if desired.SetID == setID && desired.ExternalUserID != "" {
			delete(s.groupRatioDesired, id)
		}
	}
	for id, overlay := range s.periodEnds {
		if overlay.SetID == setID || userIDs[overlay.ExternalUserID] {
			delete(s.periodEnds, id)
		}
	}
	for id, assignment := range s.assignments {
		if assignment.SetID == setID || userIDs[assignment.ExternalUserID] {
			delete(s.assignments, id)
		}
	}
	for id, observation := range s.observations {
		if observation.SetID == setID || userIDs[observation.ExternalUserID] {
			delete(s.observations, id)
		}
	}
	for id, task := range s.observationTasks {
		if task.SetID == setID || userIDs[task.ExternalUserID] {
			delete(s.observationTasks, id)
		}
	}
	for id, command := range s.adminCommands {
		if command.SetID == setID || userIDs[command.ExternalUserID] {
			delete(s.adminCommands, id)
			delete(s.adminCommandDedupe, command.DedupeKey)
		}
	}
	if set, ok := s.sets[setID]; ok {
		set.ObservedUserCount = 0
		set.CapacityUpdatedAt = now
		set.UpdatedAt = now
		s.sets[setID] = set
	}
}

func (s *MemoryStore) finalizeLocalOrphanSetLocked(setID string, generation int64, now time.Time) {
	set, ok := s.sets[setID]
	if !ok || set.Status != SetStatusDraining || set.LifecycleGeneration != generation {
		return
	}
	for id, request := range s.setRequests {
		if request.SetID == setID {
			request.Status = SetProvisionStatusCancelled
			request.UpdatedAt = now
			s.setRequests[id] = request
		}
	}
	for id, fact := range s.setFacts {
		if fact.SetID == setID {
			delete(s.setFacts, id)
		}
	}
	for id, lease := range s.setOperationLeases {
		if lease.SetID == setID {
			delete(s.setOperationLeases, id)
		}
	}
	for id, state := range s.groupRatioStates {
		if state.SetID == setID {
			delete(s.groupRatioStates, id)
		}
	}
	for id, state := range s.channelStates {
		if state.SetID == setID {
			delete(s.channelStates, id)
		}
	}
	for id, state := range s.bundleStates {
		if state.SetID == setID {
			delete(s.bundleStates, id)
		}
	}
	for id, bundle := range s.bundles {
		if bundle.SourceSetID == setID {
			bundle.SourceSetID = ""
			bundle.UpdatedAt = now
			s.bundles[id] = bundle
		}
	}
	delete(s.sets, setID)
}

func (s *MemoryStore) ClaimSetDecommission(_ context.Context, input SetDecommissionClaimInput, now time.Time) (SetDecommissionJob, SetRuntimeCleanupPayload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.setDecommissionJobs[input.JobID]
	if !ok {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, fmt.Errorf("set decommission job %q not found", input.JobID)
	}
	if input.Owner == "" || input.CapabilityHash == "" {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, fmt.Errorf("claim owner and cleanup capability hash are required")
	}
	if input.LeaseTTL <= 0 {
		input.LeaseTTL = time.Minute
	}
	if job.Status != SetDecommissionStatusPending && !(job.Status == SetDecommissionStatusRemovingRuntime && !job.ClaimLeaseUntil.After(now)) {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, fmt.Errorf("set decommission job %q cannot be claimed from status %q", job.ID, job.Status)
	}
	preview, err := s.setDecommissionPreviewLocked(job.SetID, now)
	if err != nil {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, err
	}
	if !preview.Empty || preview.Blockers.RuntimeLeases != 1 {
		message := fmt.Sprintf("set %q is no longer empty", job.SetID)
		job.Status = SetDecommissionStatusError
		job.LastError = message
		job.ClaimOwner = ""
		job.ClaimToken = ""
		job.ClaimLeaseUntil = time.Time{}
		job.LeaseFingerprint = ""
		job.CapabilityHash = ""
		job.Version++
		job.UpdatedAt = now
		s.setDecommissionJobs[job.ID] = job
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, fmt.Errorf("%s", message)
	}
	set := s.sets[job.SetID]
	if set.Status != SetStatusDraining || set.LifecycleGeneration != job.LifecycleGeneration {
		message := fmt.Sprintf("set %q lifecycle changed", job.SetID)
		job.Status = SetDecommissionStatusError
		job.LastError = message
		job.ClaimOwner = ""
		job.ClaimToken = ""
		job.ClaimLeaseUntil = time.Time{}
		job.LeaseFingerprint = ""
		job.CapabilityHash = ""
		job.Version++
		job.UpdatedAt = now
		s.setDecommissionJobs[job.ID] = job
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, fmt.Errorf("%s", message)
	}
	var runtimeLease SetRuntimeLease
	for _, lease := range s.runtimeLeases {
		if lease.SetID == job.SetID {
			runtimeLease = lease
			break
		}
	}
	if input.ClaimToken == "" {
		input.ClaimToken = randomSecret()
	}
	job.Status = SetDecommissionStatusRemovingRuntime
	job.Attempt++
	job.ClaimOwner = input.Owner
	job.ClaimToken = input.ClaimToken
	job.ClaimLeaseUntil = now.Add(input.LeaseTTL)
	job.LeaseFingerprint = setRuntimeLeaseFingerprint(runtimeLease)
	job.CapabilityHash = input.CapabilityHash
	job.Version++
	job.UpdatedAt = now
	s.setDecommissionJobs[job.ID] = job
	return job, setRuntimeCleanupPayload(job, runtimeLease), nil
}

func (s *MemoryStore) CancelSetDecommission(_ context.Context, input SetDecommissionCancelInput, now time.Time) (SetDecommissionJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.setDecommissionJobs[input.JobID]
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", input.JobID)
	}
	if job.Status == SetDecommissionStatusCancelled {
		return job, nil
	}
	if job.Status != SetDecommissionStatusPending || job.Version != input.ExpectedVersion {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q can only be cancelled before runtime removal", job.ID)
	}
	set, ok := s.sets[job.SetID]
	if !ok || set.Status != SetStatusDraining || set.LifecycleGeneration != job.LifecycleGeneration {
		return SetDecommissionJob{}, fmt.Errorf("set %q lifecycle changed", job.SetID)
	}
	set.Status = job.PreviousSetStatus
	set.UpdatedAt = now
	s.sets[set.ID] = set
	job.Status = SetDecommissionStatusCancelled
	job.Version++
	job.UpdatedAt = now
	s.setDecommissionJobs[job.ID] = job
	return job, nil
}

func (s *MemoryStore) RetrySetDecommission(_ context.Context, input SetDecommissionRetryInput, now time.Time) (SetDecommissionJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.setDecommissionJobs[input.JobID]
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", input.JobID)
	}
	if job.Status == SetDecommissionStatusPending {
		return job, nil
	}
	if job.Status != SetDecommissionStatusError || job.Version != input.ExpectedVersion {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q cannot be retried from status %q", job.ID, job.Status)
	}
	set, ok := s.sets[job.SetID]
	if !ok || set.Status != SetStatusDraining || set.LifecycleGeneration != job.LifecycleGeneration {
		return SetDecommissionJob{}, fmt.Errorf("set %q lifecycle changed", job.SetID)
	}
	retryStatus := SetDecommissionStatusPending
	if job.CascadeTenants {
		preview, err := s.setDecommissionPreviewLocked(job.SetID, now)
		if err != nil {
			return SetDecommissionJob{}, err
		}
		if !preview.Empty || job.AllowOrphan {
			retryStatus = SetDecommissionStatusPurgingTenants
			for id, tenant := range s.tenants {
				if tenant.SetID == job.SetID && tenant.Status != TenantStatusDeleted {
					tenant.Status = TenantStatusDeleting
					tenant.UpdatedAt = now
					s.tenants[id] = tenant
				}
			}
		}
	}
	job.Status = retryStatus
	job.ClaimOwner = ""
	job.ClaimToken = ""
	job.ClaimLeaseUntil = time.Time{}
	job.LeaseFingerprint = ""
	job.CapabilityHash = ""
	job.JobUID = ""
	job.LastError = ""
	job.Version++
	job.UpdatedAt = now
	s.setDecommissionJobs[job.ID] = job
	return job, nil
}

func (s *MemoryStore) FailSetDecommission(_ context.Context, input SetDecommissionFailInput, now time.Time) (SetDecommissionJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.setDecommissionJobs[input.JobID]
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", input.JobID)
	}
	if job.Status == SetDecommissionStatusError && job.Attempt == input.Attempt && job.JobUID == input.JobUID {
		return job, nil
	}
	if job.Status != SetDecommissionStatusRemovingRuntime || job.Attempt != input.Attempt ||
		job.ClaimToken != input.ClaimToken || job.LeaseFingerprint != input.LeaseFingerprint || input.JobUID == "" {
		return SetDecommissionJob{}, fmt.Errorf("cleanup failure evidence does not match current set decommission attempt")
	}
	job.Status = SetDecommissionStatusError
	job.JobUID = input.JobUID
	job.LastError = strings.TrimSpace(input.LastError)
	job.CapabilityHash = ""
	job.Version++
	job.UpdatedAt = now
	s.setDecommissionJobs[job.ID] = job
	return job, nil
}

func (s *MemoryStore) FinalizeSetDecommission(_ context.Context, input SetDecommissionFinalizeInput, now time.Time) (SetDecommissionJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.setDecommissionJobs[input.JobID]
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", input.JobID)
	}
	if job.Status == SetDecommissionStatusCleanupAckPending && job.Attempt == input.Attempt && job.JobUID == input.JobUID {
		return job, nil
	}
	if job.Status != SetDecommissionStatusRemovingRuntime || job.Attempt != input.Attempt ||
		job.ClaimToken != input.ClaimToken || job.LeaseFingerprint != input.LeaseFingerprint || input.JobUID == "" {
		return SetDecommissionJob{}, fmt.Errorf("cleanup evidence does not match current set decommission attempt")
	}
	for key, lease := range s.runtimeLeases {
		if lease.SetID == job.SetID {
			delete(s.runtimeLeases, key)
		}
	}
	for id, request := range s.setRequests {
		if request.SetID == job.SetID {
			request.Status = "cancelled"
			request.UpdatedAt = now
			s.setRequests[id] = request
		}
	}
	for key, fact := range s.setFacts {
		if fact.SetID == job.SetID {
			delete(s.setFacts, key)
		}
	}
	for key, setPlan := range s.setPlans {
		if setPlan.SetID == job.SetID {
			delete(s.setPlans, key)
		}
	}
	delete(s.sets, job.SetID)
	job.Status = SetDecommissionStatusCleanupAckPending
	job.JobUID = input.JobUID
	job.CapabilityHash = ""
	job.Version++
	job.UpdatedAt = now
	s.setDecommissionJobs[job.ID] = job
	return job, nil
}

func (s *MemoryStore) AcknowledgeSetDecommission(_ context.Context, jobID string, attempt int, now time.Time) (SetDecommissionJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.setDecommissionJobs[jobID]
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", jobID)
	}
	if job.Status == SetDecommissionStatusSucceeded && job.Attempt == attempt {
		return job, nil
	}
	if job.Status != SetDecommissionStatusCleanupAckPending || job.Attempt != attempt {
		return SetDecommissionJob{}, fmt.Errorf("set decommission acknowledgement does not match current attempt")
	}
	job.Status = SetDecommissionStatusSucceeded
	job.Version++
	job.UpdatedAt = now
	s.setDecommissionJobs[job.ID] = job
	return job, nil
}

func setRuntimeLeaseFingerprint(lease SetRuntimeLease) string {
	payload := strings.Join([]string{lease.Source, lease.Namespace, lease.Fleet, lease.SetID, lease.ShardRef, lease.DatabaseName, lease.RedisDB}, "\x00")
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

func setRuntimeCleanupPayload(job SetDecommissionJob, lease SetRuntimeLease) SetRuntimeCleanupPayload {
	return SetRuntimeCleanupPayload{
		CleanupID: job.ID, SetID: job.SetID, Attempt: job.Attempt,
		Source: lease.Source, Namespace: lease.Namespace, Fleet: lease.Fleet,
		ShardRef: lease.ShardRef, DatabaseName: lease.DatabaseName, RedisDB: lease.RedisDB,
		LeaseFingerprint: job.LeaseFingerprint, ClaimToken: job.ClaimToken,
	}
}

func (s *MemoryStore) GetSetDecommissionJob(_ context.Context, jobID string) (SetDecommissionJob, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	job, ok := s.setDecommissionJobs[jobID]
	return job, ok, nil
}

func (s *MemoryStore) ListSetDecommissionJobs(_ context.Context, opts SetDecommissionJobListOptions) ([]SetDecommissionJob, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	jobs := make([]SetDecommissionJob, 0, len(s.setDecommissionJobs))
	for _, job := range s.setDecommissionJobs {
		if opts.Status != "" && job.Status != opts.Status {
			continue
		}
		if opts.RuntimeOnly && job.Status != SetDecommissionStatusPending && job.Status != SetDecommissionStatusRemovingRuntime {
			continue
		}
		if opts.NonTerminal && (job.Status == SetDecommissionStatusSucceeded || job.Status == SetDecommissionStatusCancelled) {
			continue
		}
		jobs = append(jobs, job)
	}
	sort.Slice(jobs, func(i, j int) bool {
		if !jobs[i].CreatedAt.Equal(jobs[j].CreatedAt) {
			return jobs[i].CreatedAt.After(jobs[j].CreatedAt)
		}
		return jobs[i].ID < jobs[j].ID
	})
	if opts.Limit > 0 && len(jobs) > opts.Limit {
		jobs = jobs[:opts.Limit]
	}
	return jobs, nil
}
