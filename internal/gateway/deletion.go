package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
)

const (
	tenantDeletionSelectorUserIDs = "user_ids"
	tenantDeletionSelectorPrefix  = "user_id_prefix"
	tenantDeletionSelectorSet     = "set_id"

	maxTenantDeletionUserIDs  = 1000
	minTenantDeletionPrefix   = 3
	maxTenantDeletionAttempts = 5
	tenantDeletionRetryDelay  = 30 * time.Second
	setCascadeRetryDelay      = 30 * time.Second
)

func (s *Service) PreviewTenantDeletion(ctx context.Context, input TenantDeletionPreviewInput) (TenantDeletionJob, error) {
	input.UserIDPrefix = strings.TrimSpace(input.UserIDPrefix)
	input.SetID = strings.TrimSpace(input.SetID)
	uniqueIDs := make(map[string]struct{}, len(input.UserIDs))
	userIDs := make([]string, 0, len(input.UserIDs))
	for _, raw := range input.UserIDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, exists := uniqueIDs[id]; exists {
			continue
		}
		uniqueIDs[id] = struct{}{}
		userIDs = append(userIDs, id)
	}
	sort.Strings(userIDs)
	selectors := 0
	if len(userIDs) > 0 {
		selectors++
	}
	if input.UserIDPrefix != "" {
		selectors++
	}
	if input.SetID != "" {
		selectors++
	}
	if selectors != 1 {
		return TenantDeletionJob{}, fmt.Errorf("exactly one selector is required: user_ids, user_id_prefix, or set_id")
	}
	if len(userIDs) > maxTenantDeletionUserIDs {
		return TenantDeletionJob{}, fmt.Errorf("user_ids exceeds maximum of %d", maxTenantDeletionUserIDs)
	}
	if input.UserIDPrefix != "" && len(input.UserIDPrefix) < minTenantDeletionPrefix {
		return TenantDeletionJob{}, fmt.Errorf("user_id_prefix must contain at least %d characters", minTenantDeletionPrefix)
	}
	if input.SetID != "" {
		if _, ok, err := s.store.GetSet(ctx, input.SetID); err != nil {
			return TenantDeletionJob{}, err
		} else if !ok {
			return TenantDeletionJob{}, fmt.Errorf("set %q not found", input.SetID)
		}
	}
	job := TenantDeletionJob{
		ID:         "tenant-delete-" + randomSecret(),
		Status:     TenantDeletionStatusMaterializing,
		UserIDs:    userIDs,
		SnapshotAt: s.nowUTC(),
		Version:    1,
	}
	switch {
	case len(userIDs) > 0:
		job.SelectorType = tenantDeletionSelectorUserIDs
	case input.UserIDPrefix != "":
		job.SelectorType = tenantDeletionSelectorPrefix
		job.SelectorValue = input.UserIDPrefix
	case input.SetID != "":
		job.SelectorType = tenantDeletionSelectorSet
		job.SelectorValue = input.SetID
	}
	if err := s.store.CreateTenantDeletionJob(ctx, job, nil); err != nil {
		return TenantDeletionJob{}, err
	}
	stored, _, err := s.store.GetTenantDeletionJob(ctx, job.ID)
	return stored, err
}

func (s *Service) RunTenantDeletionMaintenanceOnce(ctx context.Context, jobID string, batchSize int) (TenantDeletionJob, error) {
	if batchSize <= 0 {
		batchSize = 1000
	}
	jobID = strings.TrimSpace(jobID)
	job, ok, err := s.store.GetTenantDeletionJob(ctx, jobID)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	if !ok {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job %q not found", jobID)
	}
	switch job.Status {
	case TenantDeletionStatusMaterializing:
		return s.store.MaterializeTenantDeletionJob(ctx, jobID, batchSize, s.nowUTC())
	case TenantDeletionStatusClaiming:
		return s.store.ClaimTenantDeletionJob(ctx, jobID, batchSize, s.nowUTC())
	default:
		return job, nil
	}
}

func (s *Service) StartTenantDeletion(ctx context.Context, jobID string, input TenantDeletionStartInput) (TenantDeletionJob, error) {
	jobID = strings.TrimSpace(jobID)
	input.ExpectedTargetDigest = strings.TrimSpace(input.ExpectedTargetDigest)
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if jobID == "" || input.ExpectedTargetDigest == "" || input.IdempotencyKey == "" {
		return TenantDeletionJob{}, fmt.Errorf("job id, expected target digest and idempotency key are required")
	}
	return s.store.StartTenantDeletionJob(ctx, jobID, input, s.nowUTC())
}

func (s *Service) GetTenantDeletion(ctx context.Context, jobID string) (TenantDeletionJob, error) {
	job, ok, err := s.store.GetTenantDeletionJob(ctx, strings.TrimSpace(jobID))
	if err != nil {
		return TenantDeletionJob{}, err
	}
	if !ok {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job %q not found", jobID)
	}
	return job, nil
}

func (s *Service) ListTenantDeletions(ctx context.Context, opts TenantDeletionJobListOptions) ([]TenantDeletionJob, error) {
	return s.store.ListTenantDeletionJobs(ctx, opts)
}

func (s *Service) ListTenantDeletionFailures(ctx context.Context, jobID string, limit int) ([]TenantDeletionTarget, error) {
	return s.store.ListTenantDeletionTargets(ctx, strings.TrimSpace(jobID), TenantDeletionTargetListOptions{
		Status: TenantDeletionTargetStatusError,
		Limit:  limit,
	})
}

func (s *Service) ProcessTenantDeletionTargetOnce(ctx context.Context, owner string, leaseTTL time.Duration) (bool, error) {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return false, fmt.Errorf("tenant deletion worker owner is required")
	}
	if leaseTTL <= 0 {
		leaseTTL = 5 * time.Minute
	}
	target, acquired, err := s.store.AcquireTenantDeletionTarget(ctx, owner, leaseTTL, s.nowUTC())
	if err != nil || !acquired {
		return acquired, err
	}
	if err := s.deleteUserTrafficRoutes(ctx, target.ExternalUserID); err != nil {
		_ = s.store.FailTenantDeletionTarget(context.WithoutCancel(ctx), target, err.Error(), s.nowUTC())
		return true, err
	}
	if err := s.deleteTenantRemoteResources(ctx, target.ExternalUserID); err != nil {
		_ = s.store.FailTenantDeletionTarget(context.WithoutCancel(ctx), target, err.Error(), s.nowUTC())
		return true, err
	}
	if _, err := s.store.PurgeTenantDeletionTarget(ctx, target, s.nowUTC()); err != nil {
		_ = s.store.FailTenantDeletionTarget(context.WithoutCancel(ctx), target, err.Error(), s.nowUTC())
		return true, err
	}
	return true, nil
}

func (s *Service) RunMaintenanceWorker(ctx context.Context, owner string, pollInterval time.Duration, leaseTTL time.Duration, batchSize int) error {
	if pollInterval <= 0 {
		pollInterval = time.Second
	}
	if leaseTTL <= 0 {
		leaseTTL = 5 * time.Minute
	}
	if batchSize <= 0 {
		batchSize = 1000
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		if err := s.runMaintenanceCycle(ctx, owner, leaseTTL, batchSize); err != nil && ctx.Err() == nil {
			defaultAccessLogger.Printf("llmgateway maintenance cycle failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (s *Service) runMaintenanceCycle(ctx context.Context, owner string, leaseTTL time.Duration, batchSize int) error {
	if s.options.KeyRouteCache != nil {
		if _, err := s.BackfillLegacySetRuntimeRoutes(ctx, batchSize); err != nil {
			return fmt.Errorf("backfill set runtime routes: %w", err)
		}
		if _, _, err := s.PublishPendingSetRuntimeRoutes(ctx, batchSize); err != nil {
			return fmt.Errorf("publish set runtime routes: %w", err)
		}
	}
	jobs, err := s.store.ListTenantDeletionJobs(ctx, TenantDeletionJobListOptions{Limit: batchSize})
	if err != nil {
		return err
	}
	for _, job := range jobs {
		if job.Status != TenantDeletionStatusMaterializing && job.Status != TenantDeletionStatusClaiming {
			continue
		}
		if _, err := s.RunTenantDeletionMaintenanceOnce(ctx, job.ID, batchSize); err != nil {
			return err
		}
	}
	if _, err := s.ProcessSetDecommissionCascadeOnce(ctx, owner, leaseTTL); err != nil {
		return err
	}
	for processed := 0; processed < batchSize; processed++ {
		acquired, err := s.ProcessTenantDeletionTargetOnce(ctx, owner, leaseTTL)
		if err != nil {
			return err
		}
		if !acquired {
			break
		}
	}
	return nil
}

func (s *Service) deleteTenantRemoteResources(ctx context.Context, externalUserID string) error {
	tenant, ok, err := s.store.GetTenant(ctx, externalUserID)
	if err != nil || !ok {
		return err
	}
	if tenant.Backend != UserBackendNew {
		return nil
	}
	binding, ok, err := s.store.GetUserBinding(ctx, externalUserID)
	if err != nil || !ok {
		return err
	}
	set, ok, err := s.store.GetSet(ctx, binding.SetID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("set %q not found", binding.SetID)
	}
	adminClient := s.newAPIClient(set.BaseURL)
	auth := adminAuthForSet(set)
	if err := s.invalidateActiveSubscriptions(ctx, adminClient, auth, binding.UpstreamUserID); err != nil {
		return err
	}
	userClient := s.newAPIClient(set.BaseURL)
	if _, err := userClient.Login(ctx, binding.Username, binding.Password); err != nil {
		_, findErr := adminClient.FindUser(ctx, auth, binding.Username)
		if errors.Is(findErr, newapi.ErrNotFound) {
			return nil
		}
		return err
	}
	accessToken, err := userClient.GenerateAccessToken(ctx, binding.UpstreamUserID)
	if err != nil {
		return err
	}
	tokens := make([]newapi.UserToken, 0)
	for page := 1; ; page++ {
		items, total, err := userClient.ListUserTokens(ctx, binding.UpstreamUserID, accessToken, page, 100)
		if err != nil {
			return err
		}
		tokens = append(tokens, items...)
		if len(tokens) >= total || len(items) == 0 {
			break
		}
	}
	for _, token := range tokens {
		if err := userClient.DeleteUserToken(ctx, binding.UpstreamUserID, accessToken, token.ID); err != nil {
			return err
		}
	}
	settings, hasSettings, err := s.store.GetUserLLMSettings(ctx, externalUserID)
	if err != nil {
		return err
	}
	if hasSettings {
		seenChannels := map[int]bool{}
		for _, provider := range settings.Providers {
			if provider.RemoteChannelID <= 0 || seenChannels[provider.RemoteChannelID] {
				continue
			}
			seenChannels[provider.RemoteChannelID] = true
			if err := adminClient.DeleteChannel(ctx, auth, provider.RemoteChannelID); err != nil {
				return err
			}
		}
	}
	return adminClient.ManageUser(ctx, auth, binding.UpstreamUserID, "delete")
}

func (s *Service) PreviewSetDecommission(ctx context.Context, setID string) (SetDecommissionPreview, error) {
	setID = strings.TrimSpace(setID)
	if setID == "" {
		return SetDecommissionPreview{}, fmt.Errorf("set id is required")
	}
	return s.store.GetSetDecommissionPreview(ctx, setID, s.nowUTC())
}

func (s *Service) StartSetDecommission(ctx context.Context, input SetDecommissionStartInput) (SetDecommissionJob, error) {
	input.SetID = strings.TrimSpace(input.SetID)
	input.ExpectedDigest = strings.TrimSpace(input.ExpectedDigest)
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if input.SetID == "" || input.ExpectedDigest == "" || input.IdempotencyKey == "" {
		return SetDecommissionJob{}, fmt.Errorf("set_id, expected_digest and idempotency_key are required")
	}
	jobID := "set-decommission-" + randomSecret()
	job, err := s.store.StartSetDecommission(ctx, input, jobID, s.nowUTC())
	if err == nil && job.ID == jobID {
		s.emitSetDecommissionTransition(ctx, SetDecommissionJob{}, job)
	}
	return job, err
}

func (s *Service) ProcessSetDecommissionCascadeOnce(ctx context.Context, owner string, leaseTTL time.Duration) (bool, error) {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return false, fmt.Errorf("set decommission cascade worker owner is required")
	}
	if leaseTTL <= 0 {
		leaseTTL = 5 * time.Minute
	}
	job, acquired, err := s.store.AcquireSetDecommissionCascade(ctx, owner, leaseTTL, s.nowUTC())
	if err != nil || !acquired {
		return acquired, err
	}
	bindings, err := s.store.ListAPIKeyBindingsBySet(ctx, job.SetID)
	if err == nil {
		err = s.deleteCachedTrafficRoutes(ctx, bindings)
	}
	if err != nil {
		_ = s.store.FailSetDecommissionCascade(context.WithoutCancel(ctx), job.ID, job.ClaimToken, err.Error(), s.nowUTC())
		return true, err
	}
	completed, err := s.store.CompleteSetDecommissionCascade(ctx, job.ID, job.ClaimToken, s.nowUTC())
	if err != nil {
		_ = s.store.FailSetDecommissionCascade(context.WithoutCancel(ctx), job.ID, job.ClaimToken, err.Error(), s.nowUTC())
		return true, err
	}
	s.emitSetDecommissionTransition(ctx, job, completed)
	return true, nil
}

type apiKeyRouteBatchDeleter interface {
	DeleteRoutes(context.Context, []TrafficRouteLookup) error
}

func (s *Service) deleteCachedTrafficRoutes(ctx context.Context, bindings []APIKeyBinding) error {
	if len(bindings) == 0 {
		return nil
	}
	if s.options.KeyRouteCache == nil {
		return fmt.Errorf("route cache is required to revoke Set traffic")
	}
	lookups := make([]TrafficRouteLookup, 0, len(bindings))
	for _, binding := range bindings {
		lookup := parseTrafficRouteLookup(binding.ExternalKey)
		if !lookup.Valid {
			lookup = TrafficRouteLookup{
				ExternalKeyID: binding.ExternalKeyID,
				Version:       binding.KeyVersion,
				RouteSlot:     binding.RouteSlot,
				Valid:         binding.KeyVersion == externalKeyVersionV2 && binding.ExternalKeyID != "",
			}
		}
		if lookup.ExternalKeyHash == "" {
			lookup.ExternalKeyHash = binding.ExternalKeyHash
		}
		if lookup.Valid {
			lookups = append(lookups, lookup)
		}
	}
	if batch, ok := s.options.KeyRouteCache.(apiKeyRouteBatchDeleter); ok {
		return batch.DeleteRoutes(ctx, lookups)
	}
	for _, lookup := range lookups {
		if err := s.options.KeyRouteCache.DeleteRoute(ctx, lookup); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) GetSetDecommission(ctx context.Context, jobID string) (SetDecommissionJob, error) {
	job, ok, err := s.store.GetSetDecommissionJob(ctx, strings.TrimSpace(jobID))
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", jobID)
	}
	return job, nil
}

func (s *Service) ListSetDecommissions(ctx context.Context, opts SetDecommissionJobListOptions) ([]SetDecommissionJob, error) {
	return s.store.ListSetDecommissionJobs(ctx, opts)
}

func (s *Service) ClaimSetDecommission(ctx context.Context, jobID, owner string, leaseTTL time.Duration) (SetDecommissionJob, SetRuntimeCleanupPayload, error) {
	previous, _, previousErr := s.store.GetSetDecommissionJob(ctx, strings.TrimSpace(jobID))
	if previousErr != nil {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, previousErr
	}
	capability := randomSecret() + randomSecret()
	capabilityHash := sha256.Sum256([]byte(capability))
	job, payload, err := s.store.ClaimSetDecommission(ctx, SetDecommissionClaimInput{
		JobID: strings.TrimSpace(jobID), Owner: strings.TrimSpace(owner),
		ClaimToken: randomSecret(), CapabilityHash: hex.EncodeToString(capabilityHash[:]), LeaseTTL: leaseTTL,
	}, s.nowUTC())
	if err != nil {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, err
	}
	payload.CleanupCapability = capability
	s.emitSetDecommissionTransition(ctx, previous, job)
	return job, payload, nil
}

func (s *Service) CancelSetDecommission(ctx context.Context, input SetDecommissionCancelInput) (SetDecommissionJob, error) {
	input.JobID = strings.TrimSpace(input.JobID)
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if input.JobID == "" || input.ExpectedVersion <= 0 || input.IdempotencyKey == "" {
		return SetDecommissionJob{}, fmt.Errorf("job id, expected version and idempotency key are required")
	}
	previous, _, err := s.store.GetSetDecommissionJob(ctx, input.JobID)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	job, err := s.store.CancelSetDecommission(ctx, input, s.nowUTC())
	if err == nil {
		s.emitSetDecommissionTransition(ctx, previous, job)
	}
	return job, err
}

func (s *Service) RetrySetDecommission(ctx context.Context, input SetDecommissionRetryInput) (SetDecommissionJob, error) {
	input.JobID = strings.TrimSpace(input.JobID)
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if input.JobID == "" || input.ExpectedVersion <= 0 || input.IdempotencyKey == "" {
		return SetDecommissionJob{}, fmt.Errorf("job id, expected version and idempotency key are required")
	}
	previous, _, err := s.store.GetSetDecommissionJob(ctx, input.JobID)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	job, err := s.store.RetrySetDecommission(ctx, input, s.nowUTC())
	if err == nil {
		s.emitSetDecommissionTransition(ctx, previous, job)
	}
	return job, err
}

func (s *Service) FailSetDecommission(ctx context.Context, input SetDecommissionFailInput) (SetDecommissionJob, error) {
	input.JobID = strings.TrimSpace(input.JobID)
	input.ClaimToken = strings.TrimSpace(input.ClaimToken)
	input.LeaseFingerprint = strings.TrimSpace(input.LeaseFingerprint)
	input.JobUID = strings.TrimSpace(input.JobUID)
	input.LastError = strings.TrimSpace(input.LastError)
	if input.JobID == "" || input.Attempt <= 0 || input.ClaimToken == "" || input.LeaseFingerprint == "" || input.JobUID == "" || input.LastError == "" {
		return SetDecommissionJob{}, fmt.Errorf("cleanup failure evidence is incomplete")
	}
	previous, _, err := s.store.GetSetDecommissionJob(ctx, input.JobID)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	job, err := s.store.FailSetDecommission(ctx, input, s.nowUTC())
	if err == nil {
		s.emitSetDecommissionTransition(ctx, previous, job)
	}
	return job, err
}

func (s *Service) AuthorizeRuntimeCleanup(ctx context.Context, input RuntimeCleanupAuthorizationInput) (RuntimeCleanupAuthorization, error) {
	job, ok, err := s.store.GetSetDecommissionJob(ctx, strings.TrimSpace(input.CleanupID))
	if err != nil {
		return RuntimeCleanupAuthorization{}, err
	}
	if !ok || job.Status != SetDecommissionStatusRemovingRuntime {
		return RuntimeCleanupAuthorization{}, fmt.Errorf("runtime cleanup is not active")
	}
	capabilityHash := sha256.Sum256([]byte(input.CleanupCapability))
	if job.CapabilityHash == "" || job.CapabilityHash != hex.EncodeToString(capabilityHash[:]) ||
		job.SetID != input.SetID || job.Attempt != input.Attempt || job.ClaimToken != input.ClaimToken ||
		job.LeaseFingerprint != input.LeaseFingerprint || !job.ClaimLeaseUntil.After(s.nowUTC()) {
		return RuntimeCleanupAuthorization{}, fmt.Errorf("runtime cleanup capability does not match the current attempt")
	}
	leases, err := s.store.ListSetRuntimeLeases(ctx, SetRuntimeLeaseListOptions{Source: input.Source, Namespace: input.Namespace, Fleet: input.Fleet})
	if err != nil {
		return RuntimeCleanupAuthorization{}, err
	}
	matched := false
	for _, lease := range leases {
		if lease.SetID == input.SetID && lease.ShardRef == input.ShardRef && lease.DatabaseName == input.DatabaseName &&
			lease.RedisDB == input.RedisDB && setRuntimeLeaseFingerprint(lease) == input.LeaseFingerprint {
			matched = true
			break
		}
	}
	if !matched {
		return RuntimeCleanupAuthorization{}, fmt.Errorf("runtime lease no longer matches cleanup payload")
	}
	redisDB, err := strconv.Atoi(input.RedisDB)
	if err != nil || input.RedisDBLimit <= 0 || redisDB < input.RedisDBStart || redisDB >= input.RedisDBStart+input.RedisDBLimit {
		return RuntimeCleanupAuthorization{}, fmt.Errorf("redis db is outside the shard cleanup range")
	}
	return RuntimeCleanupAuthorization{Authorized: true, ExpiresAt: job.ClaimLeaseUntil}, nil
}

func (s *Service) FinalizeSetDecommission(ctx context.Context, input SetDecommissionFinalizeInput) (SetDecommissionJob, error) {
	previous, _, err := s.store.GetSetDecommissionJob(ctx, strings.TrimSpace(input.JobID))
	if err != nil {
		return SetDecommissionJob{}, err
	}
	job, err := s.store.FinalizeSetDecommission(ctx, input, s.nowUTC())
	if err == nil {
		s.emitSetDecommissionTransition(ctx, previous, job)
	}
	return job, err
}

func (s *Service) AcknowledgeSetDecommission(ctx context.Context, jobID string, attempt int) (SetDecommissionJob, error) {
	jobID = strings.TrimSpace(jobID)
	previous, _, err := s.store.GetSetDecommissionJob(ctx, jobID)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	job, err := s.store.AcknowledgeSetDecommission(ctx, jobID, attempt, s.nowUTC())
	if err == nil {
		s.emitSetDecommissionTransition(ctx, previous, job)
	}
	return job, err
}

func tenantDeletionTargetDigest(targets []TenantDeletionTarget) string {
	ids := make([]string, 0, len(targets))
	for _, target := range targets {
		ids = append(ids, target.ExternalUserID)
	}
	sort.Strings(ids)
	h := sha256.New()
	var length [8]byte
	for _, id := range ids {
		binary.BigEndian.PutUint64(length[:], uint64(len(id)))
		_, _ = h.Write(length[:])
		_, _ = h.Write([]byte(id))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func setDecommissionDigest(set Set, blockers SetDecommissionBlockers) string {
	payload := fmt.Sprintf(
		"%s\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d",
		set.ID, set.LifecycleGeneration, blockers.Tenants, blockers.UserBindings, blockers.APIKeys,
		blockers.Assignments, blockers.BYOKSettings, blockers.BYOKTasks, blockers.Observations,
		blockers.ObservationTasks, blockers.SubscriptionOverlays, blockers.AdminCommands, blockers.GroupRatioIntents,
		blockers.DeletionTargets, blockers.ActiveOperationLeases, blockers.RuntimeLeases,
	)
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}
