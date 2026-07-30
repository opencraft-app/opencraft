package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

type Store interface {
	SaveSet(context.Context, Set) error
	GetSet(context.Context, string) (Set, bool, error)
	ListSets(context.Context) ([]Set, error)
	SetAdminWritesPaused(context.Context, string, bool, string, time.Time) error
	IncrementSetObservedUserCount(context.Context, string, int) error
	TryReserveSetUserSlot(context.Context, string) (bool, error)
	SaveShard(context.Context, Shard) error
	GetShard(context.Context, string) (Shard, bool, error)
	ListShards(context.Context) ([]Shard, error)
	CreateShardExpansion(context.Context, ShardExpansion) (ShardExpansion, bool, error)
	GetShardExpansion(context.Context, string) (ShardExpansion, bool, error)
	GetShardExpansionByIdempotencyKey(context.Context, string) (ShardExpansion, bool, error)
	ListShardExpansions(context.Context, ShardExpansionListOptions) ([]ShardExpansion, error)
	UpdateShardExpansion(context.Context, ShardExpansion, int64) (ShardExpansion, bool, error)
	TryAcquireSetOperationLease(context.Context, string, string, string, int, time.Duration, time.Time) (SetOperationLease, bool, error)
	RenewSetOperationLease(context.Context, SetOperationLease, time.Duration, time.Time) (bool, error)
	ReleaseSetOperationLease(context.Context, SetOperationLease) (bool, error)
	SaveSetReconcileFact(context.Context, SetReconcileFact) error
	GetSetReconcileFact(context.Context, string, string, string, string) (SetReconcileFact, bool, error)
	ListSetReconcileFacts(context.Context, SetReconcileFactListOptions) ([]SetReconcileFact, error)
	SaveSetProvisionRequest(context.Context, SetProvisionRequest) error
	GetSetProvisionRequest(context.Context, string) (SetProvisionRequest, bool, error)
	ListSetProvisionRequests(context.Context, SetProvisionRequestListOptions) ([]SetProvisionRequest, error)
	ClaimSetProvisionRequest(context.Context, setProvisionClaimStoreInput) (SetProvisionRequest, bool, error)
	RenewSetProvisionClaim(context.Context, setProvisionLeaseStoreInput) (SetProvisionRequest, bool, error)
	ReleaseSetProvisionClaim(context.Context, setProvisionLeaseStoreInput) (SetProvisionRequest, bool, error)
	CommitSetProvisionFact(context.Context, setProvisionFactCommitStoreInput) (SetProvisionRequest, bool, error)
	AdvanceSetProvisionRequestForFact(context.Context, setProvisionFactAdvanceStoreInput) (SetProvisionRequest, bool, error)
	SaveSetRuntimeLease(context.Context, SetRuntimeLease) error
	ListSetRuntimeLeases(context.Context, SetRuntimeLeaseListOptions) ([]SetRuntimeLease, error)
	CleanupStaleSetRuntimeLeases(context.Context) (int, error)
	SaveSetRuntime(context.Context, SetRuntime) error
	InitializeSetRuntime(context.Context, string, int64, string, string, time.Time) (SetRuntimeRouteSnapshot, bool, error)
	GetSetRuntime(context.Context, string, int64) (SetRuntime, bool, error)
	ListSetRuntimes(context.Context, string) ([]SetRuntime, error)
	TransitionSetTrafficState(context.Context, string, string, time.Time) (Set, SetRuntimeRouteSnapshot, error)
	SaveNewAPIRelease(context.Context, NewAPIRelease) error
	GetNewAPIRelease(context.Context, string) (NewAPIRelease, bool, error)
	ListNewAPIReleases(context.Context) ([]NewAPIRelease, error)
	SaveReleaseRing(context.Context, ReleaseRing) error
	GetReleaseRing(context.Context, string) (ReleaseRing, bool, error)
	ListReleaseRings(context.Context) ([]ReleaseRing, error)
	SaveReleaseRollout(context.Context, ReleaseRollout) error
	GetReleaseRollout(context.Context, string) (ReleaseRollout, bool, error)
	GetReleaseRolloutByCampaignStep(context.Context, string, int) (ReleaseRollout, bool, error)
	ListReleaseRollouts(context.Context, string, int) ([]ReleaseRollout, error)
	SaveReleaseRolloutAndRing(context.Context, ReleaseRollout, ReleaseRing) error
	CreateReleaseRolloutPlan(context.Context, ReleaseRing, ReleaseRollout, SetUpgradeBatch) error
	CreateReleaseCampaign(context.Context, ReleaseCampaign, []ReleaseCampaignRing) error
	GetReleaseCampaign(context.Context, string) (ReleaseCampaign, bool, error)
	ListReleaseCampaigns(context.Context, int) ([]ReleaseCampaign, error)
	SaveReleaseCampaign(context.Context, ReleaseCampaign, ReleaseCampaignRing) error
	ResumeReleaseCampaign(context.Context, ReleaseCampaign, ReleaseCampaignRing, ReleaseRollout, ReleaseRing) error
	CreateSetUpgradeBatch(context.Context, SetUpgradeBatch) error
	GetSetUpgradeBatch(context.Context, string) (SetUpgradeBatch, bool, error)
	GetSetUpgradeRun(context.Context, string) (SetUpgradeRun, bool, error)
	ListSetUpgradeRuns(context.Context, string, []string, int) ([]SetUpgradeRun, error)
	TryAcquireSetUpgradeRun(context.Context, string, string, time.Duration, time.Time) (SetUpgradeRun, bool, error)
	CompleteSetUpgradeCompatibility(context.Context, SetUpgradeRun, bool, string, time.Time) (SetUpgradeRun, error)
	PrepareSetUpgradeRuntime(context.Context, SetUpgradeRun, SetRuntime, time.Time) (SetUpgradeRun, error)
	RecordSetUpgradeProbe(context.Context, SetUpgradeRun, bool, string, time.Time) (SetUpgradeRun, error)
	RecordSetUpgradePostSwitchProbe(context.Context, SetUpgradeRun, bool, string, time.Time) (SetUpgradeRun, bool, error)
	SwitchSetUpgradeRuntime(context.Context, SetUpgradeRun, time.Time) (SetUpgradeRun, SetRuntimeRouteSnapshot, error)
	RollbackSetUpgradeRuntime(context.Context, SetUpgradeRun, time.Time, string) (SetUpgradeRun, SetRuntimeRouteSnapshot, error)
	ConfirmSetRuntimeRoutePublished(context.Context, string, int64, time.Time) (SetUpgradeRun, bool, error)
	AdvanceSetUpgradeAfterDrain(context.Context, SetUpgradeRun, time.Time) (SetUpgradeRun, error)
	CompleteSetUpgradeMaster(context.Context, SetUpgradeRun, bool, string, time.Time) (SetUpgradeRun, error)
	RequestSetUpgradeRollback(context.Context, string, string, time.Time) (SetUpgradeRun, error)
	RetrySetUpgradeRun(context.Context, string, time.Time) (SetUpgradeRun, error)
	ListSetRuntimeRouteOutbox(context.Context, string, int) ([]SetRuntimeRouteOutbox, error)
	CompleteSetRuntimeRouteOutbox(context.Context, string, bool, string, time.Time) error
	SaveTenant(context.Context, Tenant) error
	GetTenant(context.Context, string) (Tenant, bool, error)
	SaveUserBinding(context.Context, UserBinding) error
	GetUserBinding(context.Context, string) (UserBinding, bool, error)
	CountUserBindingsBySet(context.Context) (map[string]int, error)
	ListTenants(context.Context, TenantListOptions) (TenantListResult, error)
	GetTenantStatistics(context.Context) (TenantStatistics, bool, error)
	RefreshTenantStatistics(context.Context, string, string, time.Time) (bool, error)
	SaveTenantObservation(context.Context, TenantObservation) error
	GetTenantObservation(context.Context, string) (TenantObservation, bool, error)
	ListTenantObservationSeedTenants(context.Context, string, int) ([]Tenant, error)
	SeedTenantObservationTask(context.Context, TenantObservationTask) (TenantObservationTask, error)
	EnqueueTenantObservationTask(context.Context, TenantObservationTask) (TenantObservationTask, error)
	GetTenantObservationTask(context.Context, string) (TenantObservationTask, bool, error)
	ListTenantObservationTasks(context.Context, TenantObservationTaskListOptions) ([]TenantObservationTask, error)
	GetTenantObservationTaskStats(context.Context, time.Time) (TenantObservationQueueStats, error)
	TryAcquireTenantObservationTask(context.Context, string, string, time.Duration, time.Time) (TenantObservationTask, bool, error)
	RenewTenantObservationTaskLease(context.Context, TenantObservationTask, time.Duration, time.Time) (bool, error)
	ReleaseTenantObservationTaskLease(context.Context, TenantObservationTask, time.Time) (bool, error)
	CompleteTenantObservationTask(context.Context, TenantObservationTask, TenantObservationTaskCompletion, time.Time) (TenantObservationTask, error)
	SaveAPIKeyBinding(context.Context, APIKeyBinding) error
	ReserveAPIKeyBinding(context.Context, APIKeyBinding) error
	TransitionAPIKeyBinding(context.Context, string, string, string, string, int, string, time.Time) (APIKeyBinding, error)
	ListAPIKeyBindingsByStatus(context.Context, string, int) ([]APIKeyBinding, error)
	GetAPIKeyRouteRecoveryWatermark(context.Context) (string, error)
	ListAPIKeyRouteRecoveryRecords(context.Context, string, string, int) ([]TrafficRouteRecoveryRecord, error)
	GetAPIKeyBindingByExternalKey(context.Context, string) (APIKeyBinding, bool, error)
	GetAPIKeyBindingByExternalKeyID(context.Context, string) (APIKeyBinding, bool, error)
	GetAPIKeyBindingByUserPurpose(context.Context, string, string) (APIKeyBinding, bool, error)
	ListAPIKeyBindingsByUser(context.Context, string) ([]APIKeyBinding, error)
	ListAPIKeyBindingsBySet(context.Context, string) ([]APIKeyBinding, error)
	DeleteAPIKeyBindingByExternalKeyID(context.Context, string) error
	SaveUserLLMSettings(context.Context, UserLLMSettings) error
	GetUserLLMSettings(context.Context, string) (UserLLMSettings, bool, error)
	ListUserLLMSettings(context.Context) ([]UserLLMSettings, error)
	EnqueueBYOKSyncTask(context.Context, BYOKSyncTask) (BYOKSyncTask, error)
	GetBYOKSyncTask(context.Context, string) (BYOKSyncTask, bool, error)
	ListBYOKSyncTasks(context.Context, BYOKSyncTaskListOptions) ([]BYOKSyncTask, error)
	GetBYOKSyncTaskStats(context.Context, time.Time) (BYOKSyncQueueStats, error)
	TryAcquireBYOKSyncTask(context.Context, string, string, time.Duration, time.Time) (BYOKSyncTask, bool, error)
	RenewBYOKSyncTaskLease(context.Context, BYOKSyncTask, time.Duration, time.Time) (bool, error)
	ReleaseBYOKSyncTaskLease(context.Context, BYOKSyncTask, time.Time) (bool, error)
	CompleteBYOKSyncTask(context.Context, BYOKSyncTask, bool, string, time.Time) (BYOKSyncTask, error)
	RequeueFailedBYOKSyncTasks(context.Context, int, time.Time) (int, error)
	SaveBYOKSyncIntent(context.Context, BYOKSyncIntent) (BYOKSyncTask, error)
	ReplacePlatformGroupRatios(context.Context, string, string, map[string]float64) (GroupRatioApplyState, error)
	GetGroupRatioSnapshot(context.Context, string) (GroupRatioSnapshot, error)
	GetGroupRatioApplyState(context.Context, string) (GroupRatioApplyState, bool, error)
	ListGroupRatioApplyStates(context.Context, GroupRatioApplyStateListOptions) ([]GroupRatioApplyState, error)
	CompleteGroupRatioApply(context.Context, GroupRatioApplyCompletion) (GroupRatioApplyState, error)
	SavePlanMapping(context.Context, PlanMapping) error
	GetPlanMapping(context.Context, string) (PlanMapping, bool, error)
	ListPlanMappings(context.Context) ([]PlanMapping, error)
	SavePlan(context.Context, Plan) error
	RetirePlan(context.Context, string, time.Time) error
	GetPlan(context.Context, string) (Plan, bool, error)
	ListPlans(context.Context) ([]Plan, error)
	SaveSetPlan(context.Context, SetPlan) error
	GetSetPlan(context.Context, string, string) (SetPlan, bool, error)
	ListSetPlans(context.Context, SetPlanListOptions) ([]SetPlan, error)
	SavePlanPeriod(context.Context, PlanPeriod) error
	GetPlanPeriod(context.Context, string, int, string) (PlanPeriod, bool, error)
	ListPlanPeriods(context.Context, string) ([]PlanPeriod, error)
	SaveSetPlanPeriod(context.Context, SetPlanPeriod) error
	GetSetPlanPeriod(context.Context, string, int, string, string) (SetPlanPeriod, bool, error)
	ListSetPlanPeriods(context.Context, SetPlanPeriodListOptions) ([]SetPlanPeriod, error)
	SaveSubscriptionPeriodOverlay(context.Context, SubscriptionPeriodOverlay) error
	GetSubscriptionPeriodOverlay(context.Context, string) (SubscriptionPeriodOverlay, bool, error)
	DeleteSubscriptionPeriodOverlay(context.Context, string) error
	SaveSubscriptionProjection(context.Context, SubscriptionProjection) error
	ListSubscriptionProjections(context.Context, string) ([]SubscriptionProjection, error)
	DeleteSubscriptionProjections(context.Context, string) error
	TryBeginSubscriptionIdempotency(context.Context, SubscriptionIdempotency) (SubscriptionIdempotency, bool, error)
	FinishSubscriptionIdempotency(context.Context, string, int, string, time.Time) error
	EnqueueAdminCommand(context.Context, AdminCommand) (AdminCommand, bool, error)
	GetAdminCommand(context.Context, string) (AdminCommand, bool, error)
	ListAdminCommands(context.Context, AdminCommandListOptions) ([]AdminCommand, error)
	TryAcquireAdminCommand(context.Context, string, string, time.Duration, time.Time) (AdminCommand, bool, error)
	ReleaseAdminCommand(context.Context, AdminCommand, time.Time) (bool, error)
	CompleteAdminCommand(context.Context, AdminCommand, string, string, string, time.Time, time.Time) (AdminCommand, error)
	SaveUserAssignment(context.Context, UserAssignment) error
	GetUserAssignment(context.Context, string) (UserAssignment, bool, error)
	SaveChannelSpec(context.Context, ChannelSpec) error
	GetChannelSpec(context.Context, string) (ChannelSpec, bool, error)
	ListChannelSpecs(context.Context) ([]ChannelSpec, error)
	SaveChannelSyncState(context.Context, ChannelSyncState) error
	GetChannelSyncState(context.Context, string, string) (ChannelSyncState, bool, error)
	ListChannelSyncStates(context.Context, string) ([]ChannelSyncState, error)
	SaveChannelBundle(context.Context, ChannelBundle) error
	GetChannelBundle(context.Context, string) (ChannelBundle, bool, error)
	ListChannelBundles(context.Context) ([]ChannelBundle, error)
	SaveChannelBundleRevision(context.Context, ChannelBundleRevision) error
	GetChannelBundleRevision(context.Context, string, string) (ChannelBundleRevision, bool, error)
	ListChannelBundleRevisions(context.Context, string) ([]ChannelBundleRevision, error)
	SaveChannelBundleSyncState(context.Context, ChannelBundleSyncState) error
	GetChannelBundleSyncState(context.Context, string, string) (ChannelBundleSyncState, bool, error)
	ListChannelBundleSyncStates(context.Context, string) ([]ChannelBundleSyncState, error)
	SaveChannelBundleRelease(context.Context, ChannelBundleReleaseRun) error
	GetChannelBundleRelease(context.Context, string) (ChannelBundleReleaseRun, bool, error)
	ListChannelBundleReleases(context.Context, string) ([]ChannelBundleReleaseRun, error)
	TryAcquireChannelBundleLock(context.Context, string, string, string, time.Duration, time.Time) (ChannelBundleLock, bool, error)
	ReleaseChannelBundleLock(context.Context, string, string) error
	SaveWorkerJob(context.Context, WorkerJob) error
	GetWorkerJob(context.Context, string) (WorkerJob, bool, error)
	ListWorkerJobs(context.Context, WorkerJobListOptions) ([]WorkerJob, error)
	QueueWorkerJob(context.Context, string, bool, time.Time) (WorkerJob, bool, error)
	TryAcquireWorkerJobLease(context.Context, string, string, time.Duration, time.Time) (WorkerJob, bool, error)
	RenewWorkerJobLease(context.Context, string, string, time.Duration, time.Time) (bool, error)
	CompleteWorkerJobRun(context.Context, WorkerJob, WorkerJobRun) (bool, error)
	SaveWorkerJobRun(context.Context, WorkerJobRun) error
	ListWorkerJobRuns(context.Context, WorkerJobRunListOptions) ([]WorkerJobRun, error)
	CreateTenantDeletionJob(context.Context, TenantDeletionJob, []TenantDeletionTarget) error
	MaterializeTenantDeletionJob(context.Context, string, int, time.Time) (TenantDeletionJob, error)
	StartTenantDeletionJob(context.Context, string, TenantDeletionStartInput, time.Time) (TenantDeletionJob, error)
	ClaimTenantDeletionJob(context.Context, string, int, time.Time) (TenantDeletionJob, error)
	AcquireTenantDeletionTarget(context.Context, string, time.Duration, time.Time) (TenantDeletionTarget, bool, error)
	FailTenantDeletionTarget(context.Context, TenantDeletionTarget, string, time.Time) error
	PurgeTenantDeletionTarget(context.Context, TenantDeletionTarget, time.Time) (TenantDeletionJob, error)
	GetTenantDeletionJob(context.Context, string) (TenantDeletionJob, bool, error)
	ListTenantDeletionJobs(context.Context, TenantDeletionJobListOptions) ([]TenantDeletionJob, error)
	ListTenantDeletionTargets(context.Context, string, TenantDeletionTargetListOptions) ([]TenantDeletionTarget, error)
	GetSetDecommissionPreview(context.Context, string, time.Time) (SetDecommissionPreview, error)
	StartSetDecommission(context.Context, SetDecommissionStartInput, string, time.Time) (SetDecommissionJob, error)
	AcquireSetDecommissionCascade(context.Context, string, time.Duration, time.Time) (SetDecommissionJob, bool, error)
	CompleteSetDecommissionCascade(context.Context, string, string, time.Time) (SetDecommissionJob, error)
	FailSetDecommissionCascade(context.Context, string, string, string, time.Time) error
	ClaimSetDecommission(context.Context, SetDecommissionClaimInput, time.Time) (SetDecommissionJob, SetRuntimeCleanupPayload, error)
	CancelSetDecommission(context.Context, SetDecommissionCancelInput, time.Time) (SetDecommissionJob, error)
	RetrySetDecommission(context.Context, SetDecommissionRetryInput, time.Time) (SetDecommissionJob, error)
	FailSetDecommission(context.Context, SetDecommissionFailInput, time.Time) (SetDecommissionJob, error)
	FinalizeSetDecommission(context.Context, SetDecommissionFinalizeInput, time.Time) (SetDecommissionJob, error)
	AcknowledgeSetDecommission(context.Context, string, int, time.Time) (SetDecommissionJob, error)
	GetSetDecommissionJob(context.Context, string) (SetDecommissionJob, bool, error)
	ListSetDecommissionJobs(context.Context, SetDecommissionJobListOptions) ([]SetDecommissionJob, error)
}

type MemoryStore struct {
	mu                        sync.RWMutex
	sets                      map[string]Set
	shards                    map[string]Shard
	shardExpansions           map[string]ShardExpansion
	shardExpansionIdempotency map[string]string
	activeShardExpansions     map[string]string
	setFacts                  map[string]SetReconcileFact
	setRequests               map[string]SetProvisionRequest
	runtimeLeases             map[string]SetRuntimeLease
	tenants                   map[string]Tenant
	users                     map[string]UserBinding
	apiKeysByHash             map[string]APIKeyBinding
	apiKeysByID               map[string]APIKeyBinding
	llmSettings               map[string]UserLLMSettings
	byokSyncTasks             map[string]BYOKSyncTask
	groupRatioDesired         map[string]GroupRatioDesired
	groupRatioByUser          map[string]string
	groupRatioStates          map[string]GroupRatioApplyState
	entitlementPlans          map[string]Plan
	setPlans                  map[string]SetPlan
	planPeriods               map[string]PlanPeriod
	setPlanPeriods            map[string]SetPlanPeriod
	periodEnds                map[string]SubscriptionPeriodOverlay
	subscriptionProjections   map[string]SubscriptionProjection
	subscriptionIdem          map[string]SubscriptionIdempotency
	adminCommands             map[string]AdminCommand
	adminCommandDedupe        map[string]string
	assignments               map[string]UserAssignment
	observations              map[string]TenantObservation
	observationTasks          map[string]TenantObservationTask
	channels                  map[string]ChannelSpec
	channelStates             map[string]ChannelSyncState
	bundles                   map[string]ChannelBundle
	bundleStates              map[string]ChannelBundleSyncState
	bundleRevisions           map[string]ChannelBundleRevision
	bundleReleases            map[string]ChannelBundleReleaseRun
	bundleLocks               map[string]ChannelBundleLock
	workerJobs                map[string]WorkerJob
	workerRuns                map[string]WorkerJobRun
	tenantStatistics          TenantStatistics
	hasTenantStatistics       bool
	setOperationLeases        map[string]SetOperationLease
	tenantDeletionJobs        map[string]TenantDeletionJob
	tenantDeletionTargets     map[string]TenantDeletionTarget
	tenantDeletionClaims      map[string]string
	setDecommissionJobs       map[string]SetDecommissionJob
	setRuntimes               map[string]SetRuntime
	newAPIReleases            map[string]NewAPIRelease
	releaseRings              map[string]ReleaseRing
	releaseRollouts           map[string]ReleaseRollout
	releaseCampaigns          map[string]ReleaseCampaign
	releaseCampaignRings      map[string]ReleaseCampaignRing
	setUpgradeBatches         map[string]SetUpgradeBatch
	setUpgradeRuns            map[string]SetUpgradeRun
	setRuntimeRouteOutbox     map[string]SetRuntimeRouteOutbox
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		sets:                      map[string]Set{},
		shards:                    map[string]Shard{},
		shardExpansions:           map[string]ShardExpansion{},
		shardExpansionIdempotency: map[string]string{},
		activeShardExpansions:     map[string]string{},
		setFacts:                  map[string]SetReconcileFact{},
		setRequests:               map[string]SetProvisionRequest{},
		runtimeLeases:             map[string]SetRuntimeLease{},
		tenants:                   map[string]Tenant{},
		users:                     map[string]UserBinding{},
		apiKeysByHash:             map[string]APIKeyBinding{},
		apiKeysByID:               map[string]APIKeyBinding{},
		llmSettings:               map[string]UserLLMSettings{},
		byokSyncTasks:             map[string]BYOKSyncTask{},
		groupRatioDesired:         map[string]GroupRatioDesired{},
		groupRatioByUser:          map[string]string{},
		groupRatioStates:          map[string]GroupRatioApplyState{},
		entitlementPlans:          map[string]Plan{},
		setPlans:                  map[string]SetPlan{},
		planPeriods:               map[string]PlanPeriod{},
		setPlanPeriods:            map[string]SetPlanPeriod{},
		periodEnds:                map[string]SubscriptionPeriodOverlay{},
		subscriptionProjections:   map[string]SubscriptionProjection{},
		subscriptionIdem:          map[string]SubscriptionIdempotency{},
		adminCommands:             map[string]AdminCommand{},
		adminCommandDedupe:        map[string]string{},
		assignments:               map[string]UserAssignment{},
		observations:              map[string]TenantObservation{},
		observationTasks:          map[string]TenantObservationTask{},
		channels:                  map[string]ChannelSpec{},
		channelStates:             map[string]ChannelSyncState{},
		bundles:                   map[string]ChannelBundle{},
		bundleStates:              map[string]ChannelBundleSyncState{},
		bundleRevisions:           map[string]ChannelBundleRevision{},
		bundleReleases:            map[string]ChannelBundleReleaseRun{},
		bundleLocks:               map[string]ChannelBundleLock{},
		workerJobs:                map[string]WorkerJob{},
		workerRuns:                map[string]WorkerJobRun{},
		setOperationLeases:        map[string]SetOperationLease{},
		tenantDeletionJobs:        map[string]TenantDeletionJob{},
		tenantDeletionTargets:     map[string]TenantDeletionTarget{},
		tenantDeletionClaims:      map[string]string{},
		setDecommissionJobs:       map[string]SetDecommissionJob{},
		setRuntimes:               map[string]SetRuntime{},
		newAPIReleases:            map[string]NewAPIRelease{},
		releaseRings:              map[string]ReleaseRing{},
		releaseRollouts:           map[string]ReleaseRollout{},
		releaseCampaigns:          map[string]ReleaseCampaign{},
		releaseCampaignRings:      map[string]ReleaseCampaignRing{},
		setUpgradeBatches:         map[string]SetUpgradeBatch{},
		setUpgradeRuns:            map[string]SetUpgradeRun{},
		setRuntimeRouteOutbox:     map[string]SetRuntimeRouteOutbox{},
	}
}

func (s *MemoryStore) TryAcquireSetOperationLease(_ context.Context, setID string, operation string, owner string, slots int, ttl time.Duration, now time.Time) (SetOperationLease, bool, error) {
	setID = strings.TrimSpace(setID)
	operation = strings.TrimSpace(operation)
	owner = strings.TrimSpace(owner)
	if setID == "" || operation == "" || owner == "" || slots <= 0 || ttl <= 0 {
		return SetOperationLease{}, false, fmt.Errorf("set operation lease requires set, operation, owner, slots and ttl")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	set, ok := s.sets[setID]
	if !ok || !setReadyForOperationLease(set, operation) {
		return SetOperationLease{}, false, nil
	}
	for slot := 0; slot < slots; slot++ {
		key := setOperationLeaseKey(setID, operation, slot)
		current, ok := s.setOperationLeases[key]
		if ok && current.Owner != owner && current.LeaseUntil.After(now) {
			continue
		}
		lease := SetOperationLease{
			SetID: setID, Operation: operation, Slot: slot, Owner: owner,
			LifecycleGeneration: set.LifecycleGeneration,
			LeaseUntil:          now.Add(ttl), UpdatedAt: now,
		}
		s.setOperationLeases[key] = lease
		return lease, true, nil
	}
	return SetOperationLease{}, false, nil
}

func (s *MemoryStore) RenewSetOperationLease(_ context.Context, lease SetOperationLease, ttl time.Duration, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := setOperationLeaseKey(lease.SetID, lease.Operation, lease.Slot)
	current, ok := s.setOperationLeases[key]
	if !ok || current.Owner != lease.Owner {
		return false, nil
	}
	set, ok := s.sets[lease.SetID]
	if !ok || !setReadyForOperationLease(set, lease.Operation) || set.LifecycleGeneration != lease.LifecycleGeneration {
		return false, nil
	}
	current.LeaseUntil = now.Add(ttl)
	current.UpdatedAt = now
	s.setOperationLeases[key] = current
	return true, nil
}

func (s *MemoryStore) ReleaseSetOperationLease(_ context.Context, lease SetOperationLease) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := setOperationLeaseKey(lease.SetID, lease.Operation, lease.Slot)
	current, ok := s.setOperationLeases[key]
	if !ok || current.Owner != lease.Owner {
		return false, nil
	}
	delete(s.setOperationLeases, key)
	return true, nil
}

func setOperationLeaseKey(setID string, operation string, slot int) string {
	return setID + "\x00" + operation + "\x00" + fmt.Sprintf("%d", slot)
}

func setReadyForOperationLease(set Set, operation string) bool {
	if !setOperationAllowedBeforeAdmission(operation) {
		return setReadyForServing(set)
	}
	return set.Status == SetStatusActive && set.Setup && set.AdminUserID > 0 && set.AdminAccessToken != "" &&
		set.AdminHealthStatus != SetAdminHealthUnhealthy
}

func setOperationAllowedBeforeAdmission(operation string) bool {
	return operation == SetOperationGroupRatioWrite ||
		strings.HasPrefix(operation, SetOperationPlanSync+"_")
}

func (s *MemoryStore) SaveSet(_ context.Context, set Set) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if existing, ok := s.sets[set.ID]; ok {
		set.CreatedAt = existing.CreatedAt
		if !set.Setup && set.AdminUserID == 0 && set.AdminAccessToken == "" {
			set.Setup = existing.Setup
			set.AdminUserID = existing.AdminUserID
			set.AdminUsername = existing.AdminUsername
			set.AdminRole = existing.AdminRole
			set.AdminStatus = existing.AdminStatus
			set.AdminGroup = existing.AdminGroup
			set.AdminAccessToken = existing.AdminAccessToken
		}
		if set.AdminTOTPSecret == "" {
			set.AdminTOTPSecret = existing.AdminTOTPSecret
		}
		if set.CapacityUpdatedAt.IsZero() && set.ObservedUserCount == 0 && !existing.CapacityUpdatedAt.IsZero() {
			set.ObservedUserCount = existing.ObservedUserCount
			set.CapacityUpdatedAt = existing.CapacityUpdatedAt
		}
		if set.ShardID == "" {
			set.ShardID = existing.ShardID
		}
		if set.NewAPIReplicas == 0 {
			set.NewAPIReplicas = existing.NewAPIReplicas
		}
		if set.SQLMaxOpenConns == 0 {
			set.SQLMaxOpenConns = existing.SQLMaxOpenConns
		}
		if set.SQLMaxIdleConns == 0 {
			set.SQLMaxIdleConns = existing.SQLMaxIdleConns
		}
		if set.SQLMaxLifetimeSeconds == 0 {
			set.SQLMaxLifetimeSeconds = existing.SQLMaxLifetimeSeconds
		}
		if set.TrafficSQLMaxOpenConns == 0 {
			set.TrafficSQLMaxOpenConns = existing.TrafficSQLMaxOpenConns
		}
		if set.TrafficSQLMaxIdleConns == 0 {
			set.TrafficSQLMaxIdleConns = existing.TrafficSQLMaxIdleConns
		}
		if set.TrafficSQLMaxLifetimeSeconds == 0 {
			set.TrafficSQLMaxLifetimeSeconds = existing.TrafficSQLMaxLifetimeSeconds
		}
		if set.SubscriptionWriteConcurrency == 0 {
			set.SubscriptionWriteConcurrency = existing.SubscriptionWriteConcurrency
		}
		if set.ReleaseRingID == "" {
			set.ReleaseRingID = existing.ReleaseRingID
		}
		if set.CurrentReleaseID == "" {
			set.CurrentReleaseID = existing.CurrentReleaseID
		}
		if set.TargetReleaseID == "" {
			set.TargetReleaseID = existing.TargetReleaseID
		}
		healthExplicit := set.AdminHealthStatus != "" || !set.AdminHealthCheckedAt.IsZero()
		if !healthExplicit {
			set.AdminHealthStatus = existing.AdminHealthStatus
			set.AdminHealthConsecutiveFailures = existing.AdminHealthConsecutiveFailures
			set.AdminHealthError = existing.AdminHealthError
			set.AdminHealthCheckedAt = existing.AdminHealthCheckedAt
			set.AdminHealthLastSuccessAt = existing.AdminHealthLastSuccessAt
		}
		set.AdminWritesPaused = existing.AdminWritesPaused
		set.AdminWritesPauseReason = existing.AdminWritesPauseReason
		set.AdminWritesPausedAt = existing.AdminWritesPausedAt
		if set.TrafficBaseURL == "" {
			set.TrafficBaseURL = existing.TrafficBaseURL
		}
		if set.AdmissionStatus == "" {
			set.AdmissionStatus = existing.AdmissionStatus
		}
		admissionExplicit := set.AdmissionStatus != "" || !set.AdmissionCheckedAt.IsZero()
		if set.AdmissionError == "" && !admissionExplicit {
			set.AdmissionError = existing.AdmissionError
		}
		if set.AdmissionCheckedAt.IsZero() {
			set.AdmissionCheckedAt = existing.AdmissionCheckedAt
		}
		set.LifecycleGeneration = existing.LifecycleGeneration
		if set.AdminImage == "" {
			set.AdminImage = existing.AdminImage
		}
		set.ActiveRuntimeGeneration = existing.ActiveRuntimeGeneration
		set.LastRuntimeGeneration = existing.LastRuntimeGeneration
		set.RouteRevision = existing.RouteRevision
	} else if set.CreatedAt.IsZero() {
		set.CreatedAt = now
	}
	set.UpdatedAt = now
	s.sets[set.ID] = set
	return nil
}

func (s *MemoryStore) SetAdminWritesPaused(_ context.Context, setID string, paused bool, reason string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	set, ok := s.sets[strings.TrimSpace(setID)]
	if !ok {
		return fmt.Errorf("set %q not found", setID)
	}
	set.AdminWritesPaused = paused
	set.AdminWritesPauseReason = strings.TrimSpace(reason)
	if paused {
		set.AdminWritesPausedAt = now.UTC()
	} else {
		set.AdminWritesPauseReason = ""
		set.AdminWritesPausedAt = time.Time{}
	}
	set.UpdatedAt = now.UTC()
	s.sets[set.ID] = set
	return nil
}

func (s *MemoryStore) SaveShard(_ context.Context, shard Shard) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if existing, ok := s.shards[shard.ID]; ok {
		shard.CreatedAt = existing.CreatedAt
	} else if shard.CreatedAt.IsZero() {
		shard.CreatedAt = now
	}
	shard.UpdatedAt = now
	s.shards[shard.ID] = shard
	return nil
}

func (s *MemoryStore) GetShard(_ context.Context, id string) (Shard, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	shard, ok := s.shards[id]
	return shard, ok, nil
}

func (s *MemoryStore) ListShards(_ context.Context) ([]Shard, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	shards := make([]Shard, 0, len(s.shards))
	for _, shard := range s.shards {
		shards = append(shards, shard)
	}
	sort.Slice(shards, func(i, j int) bool { return shards[i].ID < shards[j].ID })
	return shards, nil
}

func (s *MemoryStore) GetSet(_ context.Context, id string) (Set, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	set, ok := s.sets[id]
	return set, ok, nil
}

func (s *MemoryStore) ListSets(_ context.Context) ([]Set, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sets := make([]Set, 0, len(s.sets))
	for _, set := range s.sets {
		sets = append(sets, set)
	}
	sort.Slice(sets, func(i, j int) bool { return sets[i].ID < sets[j].ID })
	return sets, nil
}

func (s *MemoryStore) IncrementSetObservedUserCount(_ context.Context, setID string, delta int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	set, ok := s.sets[setID]
	if !ok {
		return fmt.Errorf("set %q not found", setID)
	}
	next := set.ObservedUserCount + delta
	if next < 0 {
		next = 0
	}
	now := time.Now().UTC()
	set.ObservedUserCount = next
	set.CapacityUpdatedAt = now
	set.UpdatedAt = now
	s.sets[set.ID] = set
	return nil
}

func (s *MemoryStore) TryReserveSetUserSlot(_ context.Context, setID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	set, ok := s.sets[setID]
	if !ok {
		return false, fmt.Errorf("set %q not found", setID)
	}
	if !setReadyForServing(set) {
		return false, nil
	}
	capacity := setCapacitySnapshot(set, set.ObservedUserCount, 0)
	if !capacity.AcceptingNewUsers {
		return false, nil
	}
	now := time.Now().UTC()
	set.ObservedUserCount++
	set.CapacityUpdatedAt = now
	set.UpdatedAt = now
	s.sets[set.ID] = set
	return true, nil
}

func (s *MemoryStore) SaveSetReconcileFact(_ context.Context, fact SetReconcileFact) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	key := setReconcileFactKey(fact.Source, fact.Namespace, fact.Fleet, fact.SetID)
	if existing, ok := s.setFacts[key]; ok {
		fact.CreatedAt = existing.CreatedAt
	} else if fact.CreatedAt.IsZero() {
		fact.CreatedAt = now
	}
	if fact.LastObservedAt.IsZero() {
		fact.LastObservedAt = now
	}
	fact.UpdatedAt = now
	s.setFacts[key] = fact
	return nil
}

func (s *MemoryStore) GetSetReconcileFact(_ context.Context, source string, namespace string, fleet string, setID string) (SetReconcileFact, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	fact, ok := s.setFacts[setReconcileFactKey(source, namespace, fleet, setID)]
	return fact, ok, nil
}

func (s *MemoryStore) ListSetReconcileFacts(_ context.Context, opts SetReconcileFactListOptions) ([]SetReconcileFact, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	facts := make([]SetReconcileFact, 0, len(s.setFacts))
	for _, fact := range s.setFacts {
		if !setReconcileFactMatchesOptions(fact, opts) {
			continue
		}
		facts = append(facts, fact)
	}
	sort.Slice(facts, func(i, j int) bool {
		if facts[i].Source != facts[j].Source {
			return facts[i].Source < facts[j].Source
		}
		if facts[i].Namespace != facts[j].Namespace {
			return facts[i].Namespace < facts[j].Namespace
		}
		if facts[i].Fleet != facts[j].Fleet {
			return facts[i].Fleet < facts[j].Fleet
		}
		return facts[i].SetID < facts[j].SetID
	})
	if opts.Limit > 0 && len(facts) > opts.Limit {
		facts = facts[:opts.Limit]
	}
	return facts, nil
}

func (s *MemoryStore) SaveSetProvisionRequest(_ context.Context, request SetProvisionRequest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if setRuntimeLeaseComplete(request) {
		if err := validateSetRuntimeLease(s.runtimeLeases, SetRuntimeLeaseFromProvisionRequest(request)); err != nil {
			return err
		}
	}
	now := time.Now().UTC()
	if request.RuntimeBackend == "" {
		request.RuntimeBackend = SetRuntimeBackendLLMFleet
	}
	if request.WriterEpoch <= 0 {
		request.WriterEpoch = 1
	}
	if request.LifecycleRevision <= 0 {
		request.LifecycleRevision = 1
	}
	if request.Version <= 0 {
		request.Version = 1
	}
	if existing, ok := s.setRequests[request.ID]; ok {
		request.CreatedAt = existing.CreatedAt
	} else if request.CreatedAt.IsZero() {
		request.CreatedAt = now
	}
	if request.LastStatusAt.IsZero() {
		request.LastStatusAt = now
	}
	request.UpdatedAt = now
	if setRuntimeLeaseComplete(request) {
		lease := SetRuntimeLeaseFromProvisionRequest(request)
		lease.CreatedAt = request.CreatedAt
		lease.UpdatedAt = request.UpdatedAt
		s.runtimeLeases[setRuntimeLeaseKey(lease)] = lease
	}
	s.setRequests[request.ID] = request
	if !setProvisionStatusRequiresRuntimeLease(request.Status) {
		s.cleanupStaleSetRuntimeLeasesLocked()
	}
	return nil
}

func (s *MemoryStore) SaveSetRuntimeLease(_ context.Context, lease SetRuntimeLease) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !setRuntimeLeaseStructComplete(lease) {
		return nil
	}
	if err := validateSetRuntimeLease(s.runtimeLeases, lease); err != nil {
		return err
	}
	now := time.Now().UTC()
	key := setRuntimeLeaseKey(lease)
	if existing, ok := s.runtimeLeases[key]; ok {
		lease.CreatedAt = existing.CreatedAt
	} else if lease.CreatedAt.IsZero() {
		lease.CreatedAt = now
	}
	if lease.UpdatedAt.IsZero() {
		lease.UpdatedAt = now
	}
	s.runtimeLeases[key] = lease
	return nil
}

func (s *MemoryStore) ListSetRuntimeLeases(_ context.Context, opts SetRuntimeLeaseListOptions) ([]SetRuntimeLease, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	leases := make([]SetRuntimeLease, 0, len(s.runtimeLeases))
	for _, lease := range s.runtimeLeases {
		if opts.Source != "" && lease.Source != opts.Source {
			continue
		}
		if opts.Namespace != "" && lease.Namespace != opts.Namespace {
			continue
		}
		if opts.Fleet != "" && lease.Fleet != opts.Fleet {
			continue
		}
		leases = append(leases, lease)
	}
	sort.Slice(leases, func(i, j int) bool {
		if leases[i].Source != leases[j].Source {
			return leases[i].Source < leases[j].Source
		}
		if leases[i].Namespace != leases[j].Namespace {
			return leases[i].Namespace < leases[j].Namespace
		}
		if leases[i].Fleet != leases[j].Fleet {
			return leases[i].Fleet < leases[j].Fleet
		}
		return leases[i].SetID < leases[j].SetID
	})
	return leases, nil
}

func (s *MemoryStore) CleanupStaleSetRuntimeLeases(_ context.Context) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cleanupStaleSetRuntimeLeasesLocked(), nil
}

func (s *MemoryStore) cleanupStaleSetRuntimeLeasesLocked() int {
	cleaned := 0
	for key, lease := range s.runtimeLeases {
		_, managedSetExists := s.sets[lease.SetID]
		anyRequest := false
		openRequest := false
		for _, request := range s.setRequests {
			if request.Source != lease.Source || request.Namespace != lease.Namespace || request.Fleet != lease.Fleet || request.SetID != lease.SetID {
				continue
			}
			anyRequest = true
			if setProvisionStatusRequiresRuntimeLease(request.Status) {
				openRequest = true
			}
		}
		if openRequest || (managedSetExists && !anyRequest) {
			continue
		}
		delete(s.runtimeLeases, key)
		cleaned++
	}
	return cleaned
}

func SetRuntimeLeaseFromProvisionRequest(request SetProvisionRequest) SetRuntimeLease {
	return SetRuntimeLease{
		Source:       request.Source,
		Namespace:    request.Namespace,
		Fleet:        request.Fleet,
		SetID:        request.SetID,
		ShardRef:     request.ShardRef,
		DatabaseName: request.DatabaseName,
		RedisDB:      request.RedisDB,
		CreatedAt:    request.CreatedAt,
		UpdatedAt:    request.UpdatedAt,
	}
}

func validateSetRuntimeLease(existing map[string]SetRuntimeLease, lease SetRuntimeLease) error {
	if !setRuntimeLeaseStructComplete(lease) {
		return nil
	}
	for _, item := range existing {
		if !sameSetRuntimeScope(item, lease) || item.SetID == lease.SetID {
			continue
		}
		if strings.TrimSpace(item.ShardRef) == strings.TrimSpace(lease.ShardRef) &&
			strings.TrimSpace(item.RedisDB) == strings.TrimSpace(lease.RedisDB) &&
			strings.TrimSpace(item.RedisDB) != "" {
			return fmt.Errorf("redis db %s on shard %s is already leased by set %s", lease.RedisDB, lease.ShardRef, item.SetID)
		}
		if strings.TrimSpace(item.DatabaseName) == strings.TrimSpace(lease.DatabaseName) &&
			strings.TrimSpace(item.DatabaseName) != "" {
			return fmt.Errorf("database %s is already leased by set %s", lease.DatabaseName, item.SetID)
		}
	}
	return nil
}

func setRuntimeLeaseComplete(request SetProvisionRequest) bool {
	if !setProvisionStatusRequiresRuntimeLease(request.Status) {
		return false
	}
	return strings.TrimSpace(request.Source) != "" &&
		strings.TrimSpace(request.Namespace) != "" &&
		strings.TrimSpace(request.Fleet) != "" &&
		strings.TrimSpace(request.SetID) != "" &&
		strings.TrimSpace(request.ShardRef) != "" &&
		strings.TrimSpace(request.RedisDB) != "" &&
		strings.TrimSpace(request.DatabaseName) != ""
}

func setRuntimeLeaseStructComplete(lease SetRuntimeLease) bool {
	return strings.TrimSpace(lease.Source) != "" &&
		strings.TrimSpace(lease.Namespace) != "" &&
		strings.TrimSpace(lease.Fleet) != "" &&
		strings.TrimSpace(lease.SetID) != "" &&
		strings.TrimSpace(lease.ShardRef) != "" &&
		strings.TrimSpace(lease.RedisDB) != "" &&
		strings.TrimSpace(lease.DatabaseName) != ""
}

func setRuntimeLeaseKey(lease SetRuntimeLease) string {
	return strings.Join([]string{lease.Source, lease.Namespace, lease.Fleet, lease.SetID}, "\x00")
}

func setProvisionStatusRequiresRuntimeLease(status string) bool {
	switch strings.TrimSpace(strings.ToLower(status)) {
	case SetProvisionStatusError, SetProvisionStatusCancelled:
		return false
	default:
		return true
	}
}

func sameSetRuntimeScope(left SetRuntimeLease, right SetRuntimeLease) bool {
	return strings.TrimSpace(left.Source) == strings.TrimSpace(right.Source) &&
		strings.TrimSpace(left.Namespace) == strings.TrimSpace(right.Namespace) &&
		strings.TrimSpace(left.Fleet) == strings.TrimSpace(right.Fleet)
}

func (s *MemoryStore) GetSetProvisionRequest(_ context.Context, id string) (SetProvisionRequest, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	request, ok := s.setRequests[id]
	return request, ok, nil
}

func (s *MemoryStore) ListSetProvisionRequests(_ context.Context, opts SetProvisionRequestListOptions) ([]SetProvisionRequest, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	requests := make([]SetProvisionRequest, 0, len(s.setRequests))
	for _, request := range s.setRequests {
		if !setProvisionRequestMatchesOptions(request, opts) {
			continue
		}
		requests = append(requests, request)
	}
	sort.Slice(requests, func(i, j int) bool {
		if !requests[i].UpdatedAt.Equal(requests[j].UpdatedAt) {
			return requests[i].UpdatedAt.After(requests[j].UpdatedAt)
		}
		if requests[i].Source != requests[j].Source {
			return requests[i].Source < requests[j].Source
		}
		if requests[i].Namespace != requests[j].Namespace {
			return requests[i].Namespace < requests[j].Namespace
		}
		if requests[i].Fleet != requests[j].Fleet {
			return requests[i].Fleet < requests[j].Fleet
		}
		return requests[i].SetID < requests[j].SetID
	})
	if opts.Limit > 0 && len(requests) > opts.Limit {
		requests = requests[:opts.Limit]
	}
	return requests, nil
}

func (s *MemoryStore) SaveTenant(_ context.Context, tenant Tenant) error {
	rawStatus := tenant.Status
	rawSource := tenant.Source
	rawDisplayName := tenant.DisplayName
	tenant, err := normalizeTenant(tenant)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if existing, ok := s.tenants[tenant.ExternalUserID]; ok {
		if existing.Status == TenantStatusDeleting || existing.Status == TenantStatusDeleted {
			return fmt.Errorf("%w: tenant %s is %s", ErrTenantInactive, existing.ExternalUserID, existing.Status)
		}
		tenant.CreatedAt = existing.CreatedAt
		if strings.TrimSpace(rawStatus) == "" {
			tenant.Status = existing.Status
		}
		if strings.TrimSpace(rawSource) == "" {
			tenant.Source = existing.Source
		}
		if strings.TrimSpace(rawDisplayName) == "" {
			tenant.DisplayName = existing.DisplayName
		}
	} else if tenant.CreatedAt.IsZero() {
		tenant.CreatedAt = now
	}
	tenant.UpdatedAt = now
	s.tenants[tenant.ExternalUserID] = tenant
	return nil
}

func (s *MemoryStore) GetTenant(_ context.Context, externalUserID string) (Tenant, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	tenant, ok := s.tenants[externalUserID]
	return tenant, ok, nil
}

func (s *MemoryStore) SaveUserBinding(_ context.Context, binding UserBinding) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.rejectInactiveTenantWriteLocked(binding.ExternalUserID); err != nil {
		return err
	}
	now := time.Now().UTC()
	if existing, ok := s.users[binding.ExternalUserID]; ok {
		binding.CreatedAt = existing.CreatedAt
		if strings.TrimSpace(binding.ProvisionStatus) == "" {
			binding.ProvisionStatus = existing.ProvisionStatus
		}
	} else if binding.CreatedAt.IsZero() {
		binding.CreatedAt = now
	}
	binding.UpdatedAt = now
	binding = normalizeUserBinding(binding)
	s.users[binding.ExternalUserID] = binding
	return nil
}

func (s *MemoryStore) GetUserBinding(_ context.Context, externalUserID string) (UserBinding, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	binding, ok := s.users[externalUserID]
	return binding, ok, nil
}

func (s *MemoryStore) CountUserBindingsBySet(_ context.Context) (map[string]int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	counts := map[string]int{}
	for _, binding := range s.users {
		if binding.SetID == "" {
			continue
		}
		counts[binding.SetID]++
	}
	return counts, nil
}

func (s *MemoryStore) ListTenants(_ context.Context, opts TenantListOptions) (TenantListResult, error) {
	opts = normalizeTenantListOptions(opts)
	if err := validateTenantListOptions(opts); err != nil {
		return TenantListResult{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	keyCounts := map[string]int{}
	for _, binding := range s.apiKeysByID {
		keyCounts[binding.UserID]++
	}

	items := make([]TenantSummary, 0, len(s.tenants))
	for id, tenant := range s.tenants {
		item := buildTenantSummary(tenant, s.users[id], s.assignments[id], s.observations[id], keyCounts[id])
		if !tenantMatchesOptions(item, opts) {
			continue
		}
		items = append(items, item)
	}
	if opts.Keyword == "" {
		sort.Slice(items, func(i, j int) bool {
			if !items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
				return items[i].UpdatedAt.After(items[j].UpdatedAt)
			}
			return items[i].UserID > items[j].UserID
		})
	} else {
		userIDMatches := make([]TenantSummary, 0, len(items))
		usernameMatches := make([]TenantSummary, 0, len(items))
		for _, item := range items {
			if tenantValueMatchesSearch(item.UserID, opts.Keyword) {
				userIDMatches = append(userIDMatches, item)
				continue
			}
			if tenantValueMatchesSearch(item.Username, opts.Keyword) {
				usernameMatches = append(usernameMatches, item)
			}
		}
		sort.Slice(userIDMatches, func(i, j int) bool { return userIDMatches[i].UserID < userIDMatches[j].UserID })
		sort.Slice(usernameMatches, func(i, j int) bool {
			if usernameMatches[i].Username != usernameMatches[j].Username {
				return usernameMatches[i].Username < usernameMatches[j].Username
			}
			return usernameMatches[i].UserID < usernameMatches[j].UserID
		})
		items = append(userIDMatches, usernameMatches...)
	}
	itemCount := len(items)
	var total *int
	if opts.IncludeTotal {
		exact := itemCount
		total = &exact
	}
	start := opts.Offset
	if opts.Cursor != "" {
		cursor, err := decodeTenantCursor(opts.Cursor, opts)
		if err != nil {
			return TenantListResult{}, err
		}
		if opts.Keyword == "" {
			cursorUpdatedAt, _ := cursor.inventoryUpdatedAt()
			start = 0
			for start < itemCount && !tenantAfterInventoryCursor(items[start], cursorUpdatedAt, cursor.UserID) {
				start++
			}
		} else {
			start = itemCount
			for index, item := range items {
				if cursor.Phase == tenantSearchPhaseUserID {
					if tenantValueMatchesSearch(item.UserID, opts.Keyword) && item.UserID > cursor.UserID {
						start = index
						break
					}
					if !tenantValueMatchesSearch(item.UserID, opts.Keyword) {
						start = index
						break
					}
					continue
				}
				if tenantValueMatchesSearch(item.UserID, opts.Keyword) {
					continue
				}
				if item.Username > cursor.Username || (item.Username == cursor.Username && item.UserID > cursor.UserID) {
					start = index
					break
				}
			}
		}
	}
	if start > itemCount {
		start = itemCount
	}
	end := start + opts.Limit
	hasMore := end < itemCount
	if end > itemCount {
		end = itemCount
	}
	page := items[start:end]
	nextCursor := ""
	if hasMore && len(page) > 0 {
		if opts.Keyword == "" {
			nextCursor = encodeTenantInventoryCursor(page[len(page)-1], opts)
		} else {
			nextCursor = encodeTenantSearchCursor(page[len(page)-1], opts)
		}
	}
	return TenantListResult{
		Items:      page,
		Total:      total,
		Limit:      opts.Limit,
		Offset:     opts.Offset,
		NextCursor: nextCursor,
		HasMore:    hasMore,
	}, nil
}

func (s *MemoryStore) GetTenantStatistics(_ context.Context) (TenantStatistics, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tenantStatistics, s.hasTenantStatistics, nil
}

func (s *MemoryStore) RefreshTenantStatistics(_ context.Context, jobName string, owner string, generatedAt time.Time) (bool, error) {
	jobName = strings.TrimSpace(jobName)
	owner = strings.TrimSpace(owner)
	if jobName == "" || owner == "" {
		return false, fmt.Errorf("tenant statistics job and owner are required")
	}
	if generatedAt.IsZero() {
		generatedAt = time.Now().UTC()
	}
	generatedAt = generatedAt.UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.workerJobs[jobName]
	if !ok || job.Status != WorkerJobStatusRunning || job.LeaseOwner != owner || !job.LeaseUntil.After(generatedAt) {
		return false, nil
	}
	stats := TenantStatistics{GeneratedAt: generatedAt, UpdatedAt: generatedAt}
	for _, tenant := range s.tenants {
		if tenant.Status == TenantStatusDeleted {
			stats.DeletedTotal++
			continue
		}
		stats.Total++
		switch tenant.Backend {
		case UserBackendNew:
			stats.NewTotal++
		case UserBackendPending:
			stats.PendingTotal++
		}
		switch tenant.Status {
		case TenantStatusActive:
			stats.ActiveTotal++
		case TenantStatusDisabled:
			stats.DisabledTotal++
		}
	}
	s.tenantStatistics = stats
	s.hasTenantStatistics = true
	return true, nil
}

func (s *MemoryStore) SaveTenantObservation(_ context.Context, observation TenantObservation) error {
	if observation.ExternalUserID == "" {
		return fmt.Errorf("external user id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.rejectInactiveTenantWriteLocked(observation.ExternalUserID); err != nil {
		return err
	}
	now := time.Now().UTC()
	if existing, ok := s.observations[observation.ExternalUserID]; ok {
		observation.CreatedAt = existing.CreatedAt
	} else if observation.CreatedAt.IsZero() {
		observation.CreatedAt = now
	}
	if observation.ObservedAt.IsZero() {
		observation.ObservedAt = now
	}
	observation.UpdatedAt = now
	s.observations[observation.ExternalUserID] = observation
	return nil
}

func (s *MemoryStore) GetTenantObservation(_ context.Context, externalUserID string) (TenantObservation, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	observation, ok := s.observations[externalUserID]
	return observation, ok, nil
}

func (s *MemoryStore) SaveAPIKeyBinding(_ context.Context, binding APIKeyBinding) error {
	if binding.ExternalKey == "" {
		return fmt.Errorf("external key is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.rejectInactiveTenantWriteLocked(binding.UserID); err != nil {
		return err
	}
	now := time.Now().UTC()
	lookup := parseTrafficRouteLookup(binding.ExternalKey)
	if lookup.Valid {
		binding.ExternalKeyID = lookup.ExternalKeyID
		binding.ExternalKeyHash = lookup.ExternalKeyHash
		binding.SecretHash = lookup.SecretHash
		binding.KeyVersion = lookup.Version
		binding.RouteSlot = lookup.RouteSlot
	}
	if binding.Status == "" {
		binding.Status = APIKeyStatusActive
	}
	binding.Purpose = canonicalAPIKeyPurpose(binding.Purpose)
	if binding.CreatedAt.IsZero() {
		if existing, ok := s.apiKeysByID[binding.ExternalKeyID]; ok && !existing.CreatedAt.IsZero() {
			binding.CreatedAt = existing.CreatedAt
		} else {
			binding.CreatedAt = now
		}
	}
	if binding.UpdatedAt.IsZero() {
		binding.UpdatedAt = now
	}
	hash := hashExternalKey(binding.ExternalKey)
	binding.ExternalKeyHash = hash
	if existing, ok := s.apiKeysByHash[hash]; ok && existing.ExternalKeyID != "" && existing.ExternalKeyID != binding.ExternalKeyID {
		delete(s.apiKeysByID, existing.ExternalKeyID)
	}
	if binding.ExternalKeyID != "" {
		if existing, ok := s.apiKeysByID[binding.ExternalKeyID]; ok {
			if existing.ExternalKeyHash != "" {
				delete(s.apiKeysByHash, existing.ExternalKeyHash)
			} else if existing.ExternalKey != "" {
				delete(s.apiKeysByHash, hashExternalKey(existing.ExternalKey))
			}
		}
		s.apiKeysByID[binding.ExternalKeyID] = binding
	}
	s.apiKeysByHash[hash] = binding
	return nil
}

func (s *MemoryStore) ReserveAPIKeyBinding(_ context.Context, binding APIKeyBinding) error {
	var err error
	binding, err = prepareAPIKeyReservation(binding)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.rejectInactiveTenantWriteLocked(binding.UserID); err != nil {
		return err
	}
	if binding.Purpose != "" {
		for _, existing := range s.apiKeysByID {
			if existing.UserID == binding.UserID && existing.Purpose == binding.Purpose {
				return fmt.Errorf("%w: user=%s purpose=%s", ErrAPIKeyPurposeConflict, binding.UserID, binding.Purpose)
			}
		}
	}
	if _, exists := s.apiKeysByID[binding.ExternalKeyID]; exists {
		return fmt.Errorf("%w: external_key_id", ErrAPIKeyRandomCollision)
	}
	if _, exists := s.apiKeysByHash[binding.ExternalKeyHash]; exists {
		return fmt.Errorf("%w: external_key_hash", ErrAPIKeyRandomCollision)
	}
	now := time.Now().UTC()
	if binding.CreatedAt.IsZero() {
		binding.CreatedAt = now
	}
	if binding.UpdatedAt.IsZero() {
		binding.UpdatedAt = now
	}
	s.apiKeysByID[binding.ExternalKeyID] = binding
	s.apiKeysByHash[binding.ExternalKeyHash] = binding
	return nil
}

func (s *MemoryStore) TransitionAPIKeyBinding(_ context.Context, keyID, expectedStatus, nextStatus, upstreamKey string, upstreamKeyID int, lastError string, updatedAt time.Time) (APIKeyBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.apiKeysByID[keyID]
	if !ok || binding.Status != expectedStatus {
		return APIKeyBinding{}, fmt.Errorf("%w: key=%s expected=%s", ErrAPIKeyStateConflict, keyID, expectedStatus)
	}
	if upstreamKey != "" {
		binding.UpstreamKey = upstreamKey
	}
	if upstreamKeyID > 0 {
		binding.UpstreamKeyID = upstreamKeyID
	}
	binding.Status = nextStatus
	binding.LastError = lastError
	if updatedAt.IsZero() {
		updatedAt = time.Now().UTC()
	}
	binding.UpdatedAt = updatedAt
	s.apiKeysByID[keyID] = binding
	s.apiKeysByHash[binding.ExternalKeyHash] = binding
	return binding, nil
}

func (s *MemoryStore) ListAPIKeyBindingsByStatus(_ context.Context, status string, limit int) ([]APIKeyBinding, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	bindings := make([]APIKeyBinding, 0)
	for _, binding := range s.apiKeysByID {
		if binding.Status == status {
			bindings = append(bindings, binding)
		}
	}
	sort.Slice(bindings, func(i, j int) bool {
		if !bindings[i].UpdatedAt.Equal(bindings[j].UpdatedAt) {
			return bindings[i].UpdatedAt.Before(bindings[j].UpdatedAt)
		}
		return bindings[i].ExternalKeyID < bindings[j].ExternalKeyID
	})
	if limit > 0 && len(bindings) > limit {
		bindings = bindings[:limit]
	}
	return bindings, nil
}

func (s *MemoryStore) GetAPIKeyRouteRecoveryWatermark(_ context.Context) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	watermark := ""
	for _, binding := range s.apiKeysByID {
		if binding.Status == APIKeyStatusActive && binding.ExternalKeyID > watermark {
			watermark = binding.ExternalKeyID
		}
	}
	return watermark, nil
}

func (s *MemoryStore) ListAPIKeyRouteRecoveryRecords(_ context.Context, afterKeyID, throughKeyID string, limit int) ([]TrafficRouteRecoveryRecord, error) {
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	records := make([]TrafficRouteRecoveryRecord, 0)
	for _, binding := range s.apiKeysByID {
		if binding.Status != APIKeyStatusActive || binding.ExternalKeyID <= afterKeyID || (throughKeyID != "" && binding.ExternalKeyID > throughKeyID) {
			continue
		}
		record := TrafficRouteRecoveryRecord{Binding: binding}
		if tenant, ok := s.tenants[binding.UserID]; ok {
			record.TenantBackend = tenant.Backend
			record.TenantStatus = tenant.Status
		}
		if settings, ok := s.llmSettings[binding.UserID]; ok {
			record.BYOKRoutingMode = settings.Routing.Mode
			record.BYOKUpstreamKey = settings.BYOKUpstreamKey
			record.BYOKUpstreamKeyID = settings.BYOKUpstreamKeyID
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool {
		return records[i].Binding.ExternalKeyID < records[j].Binding.ExternalKeyID
	})
	if len(records) > limit {
		records = records[:limit]
	}
	return records, nil
}

func (s *MemoryStore) GetAPIKeyBindingByExternalKey(_ context.Context, externalKey string) (APIKeyBinding, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	binding, ok := s.apiKeysByHash[hashExternalKey(externalKey)]
	return binding, ok, nil
}

func (s *MemoryStore) GetAPIKeyBindingByExternalKeyID(_ context.Context, keyID string) (APIKeyBinding, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	binding, ok := s.apiKeysByID[keyID]
	return binding, ok, nil
}

func (s *MemoryStore) GetAPIKeyBindingByUserPurpose(_ context.Context, userID, purpose string) (APIKeyBinding, bool, error) {
	userID = strings.TrimSpace(userID)
	purpose = canonicalAPIKeyPurpose(purpose)
	if userID == "" || purpose == "" {
		return APIKeyBinding{}, false, nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, binding := range s.apiKeysByID {
		if binding.UserID == userID && canonicalAPIKeyPurpose(binding.Purpose) == purpose {
			return binding, true, nil
		}
	}
	return APIKeyBinding{}, false, nil
}

func (s *MemoryStore) ListAPIKeyBindingsByUser(_ context.Context, userID string) ([]APIKeyBinding, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	bindings := make([]APIKeyBinding, 0)
	for _, binding := range s.apiKeysByID {
		if userID == "" || binding.UserID == userID {
			bindings = append(bindings, binding)
		}
	}
	sort.Slice(bindings, func(i, j int) bool {
		if !bindings[i].CreatedAt.Equal(bindings[j].CreatedAt) {
			return bindings[i].CreatedAt.After(bindings[j].CreatedAt)
		}
		return bindings[i].ExternalKeyID < bindings[j].ExternalKeyID
	})
	return bindings, nil
}

func (s *MemoryStore) ListAPIKeyBindingsBySet(_ context.Context, setID string) ([]APIKeyBinding, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	bindings := make([]APIKeyBinding, 0)
	for _, binding := range s.apiKeysByID {
		if setID == "" || binding.SetID == setID {
			bindings = append(bindings, binding)
		}
	}
	sort.Slice(bindings, func(i, j int) bool {
		if !bindings[i].CreatedAt.Equal(bindings[j].CreatedAt) {
			return bindings[i].CreatedAt.After(bindings[j].CreatedAt)
		}
		return bindings[i].ExternalKeyID < bindings[j].ExternalKeyID
	})
	return bindings, nil
}

func (s *MemoryStore) DeleteAPIKeyBindingByExternalKeyID(_ context.Context, keyID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.apiKeysByID[keyID]
	if !ok {
		return nil
	}
	delete(s.apiKeysByID, keyID)
	if binding.ExternalKeyHash != "" {
		delete(s.apiKeysByHash, binding.ExternalKeyHash)
	} else if binding.ExternalKey != "" {
		delete(s.apiKeysByHash, hashExternalKey(binding.ExternalKey))
	}
	return nil
}

func (s *MemoryStore) SaveUserLLMSettings(_ context.Context, settings UserLLMSettings) error {
	if strings.TrimSpace(settings.ExternalUserID) == "" {
		return fmt.Errorf("external user id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.rejectInactiveTenantWriteLocked(settings.ExternalUserID); err != nil {
		return err
	}
	s.saveUserLLMSettingsLocked(settings, time.Now().UTC())
	return nil
}

func (s *MemoryStore) saveUserLLMSettingsLocked(settings UserLLMSettings, now time.Time) {
	if existing, ok := s.llmSettings[settings.ExternalUserID]; ok {
		settings.CreatedAt = existing.CreatedAt
	} else if settings.CreatedAt.IsZero() {
		settings.CreatedAt = now
	}
	settings.UpdatedAt = now
	s.llmSettings[settings.ExternalUserID] = settings
}

func (s *MemoryStore) GetUserLLMSettings(_ context.Context, externalUserID string) (UserLLMSettings, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	settings, ok := s.llmSettings[externalUserID]
	return settings, ok, nil
}

func (s *MemoryStore) ListUserLLMSettings(_ context.Context) ([]UserLLMSettings, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	settings := make([]UserLLMSettings, 0, len(s.llmSettings))
	for _, item := range s.llmSettings {
		settings = append(settings, item)
	}
	sort.Slice(settings, func(i, j int) bool { return settings[i].ExternalUserID < settings[j].ExternalUserID })
	return settings, nil
}

func (s *MemoryStore) EnqueueBYOKSyncTask(_ context.Context, task BYOKSyncTask) (BYOKSyncTask, error) {
	if strings.TrimSpace(task.ExternalUserID) == "" {
		return BYOKSyncTask{}, fmt.Errorf("external user id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enqueueBYOKSyncTaskLocked(task, time.Now().UTC()), nil
}

func (s *MemoryStore) enqueueBYOKSyncTaskLocked(task BYOKSyncTask, now time.Time) BYOKSyncTask {
	existing, ok := s.byokSyncTasks[task.ExternalUserID]
	if ok {
		runningWithLiveLease := existing.Status == BYOKSyncTaskStatusRunning && existing.LeaseUntil.After(now)
		task.CreatedAt = existing.CreatedAt
		task.RequestedVersion = existing.RequestedVersion + 1
		task.AppliedVersion = existing.AppliedVersion
		task.ProcessingVersion = existing.ProcessingVersion
		task.Attempts = existing.Attempts
		task.LeaseOwner = existing.LeaseOwner
		task.LeaseUntil = existing.LeaseUntil
		if runningWithLiveLease {
			task.Status = existing.Status
			task.NextRunAt = existing.NextRunAt
		} else {
			task.Status = BYOKSyncTaskStatusPending
			task.LeaseOwner = ""
			task.LeaseUntil = time.Time{}
		}
	} else {
		if task.CreatedAt.IsZero() {
			task.CreatedAt = now
		}
		task.RequestedVersion = 1
	}
	if strings.TrimSpace(task.Status) == "" {
		task.Status = BYOKSyncTaskStatusPending
	}
	if task.NextRunAt.IsZero() {
		task.NextRunAt = now
	}
	task.LastError = ""
	task.UpdatedAt = now
	s.byokSyncTasks[task.ExternalUserID] = task
	return task
}

func (s *MemoryStore) SaveBYOKSyncIntent(_ context.Context, intent BYOKSyncIntent) (BYOKSyncTask, error) {
	userID := strings.TrimSpace(intent.Settings.ExternalUserID)
	setID := strings.TrimSpace(intent.Task.SetID)
	groupName := strings.TrimSpace(intent.GroupName)
	if userID == "" || strings.TrimSpace(intent.Task.ExternalUserID) != userID || setID == "" {
		return BYOKSyncTask{}, fmt.Errorf("BYOK sync intent requires matching user settings, task, and Set")
	}
	if intent.Enabled && !isBYOKGroup(groupName) {
		return BYOKSyncTask{}, fmt.Errorf("BYOK group %q must use reserved %s prefix", groupName, byokGroupPrefix)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	existingKey := s.groupRatioByUser[userID]
	existing, exists := s.groupRatioDesired[existingKey]
	if intent.Enabled {
		key := groupRatioDesiredKey(setID, groupName)
		if collision, ok := s.groupRatioDesired[key]; ok && collision.ExternalUserID != userID {
			return BYOKSyncTask{}, fmt.Errorf("GroupRatio group %q already belongs to %q", groupName, collision.SourceID)
		}
	}

	now := time.Now().UTC()
	affected := map[string]bool{}
	changed := false
	if intent.Enabled {
		next := GroupRatioDesired{
			SetID:          setID,
			GroupName:      groupName,
			Ratio:          0,
			SourceType:     GroupRatioSourceBYOK,
			SourceID:       userID,
			ExternalUserID: userID,
			CreatedAt:      now,
			UpdatedAt:      now,
		}
		if exists {
			next.CreatedAt = existing.CreatedAt
			if existing.SetID != next.SetID || existing.GroupName != next.GroupName {
				delete(s.groupRatioDesired, existingKey)
				affected[existing.SetID] = true
				changed = true
			}
		}
		key := groupRatioDesiredKey(next.SetID, next.GroupName)
		if !exists || existing.SetID != next.SetID || existing.GroupName != next.GroupName || existing.Ratio != next.Ratio {
			changed = true
		}
		s.groupRatioDesired[key] = next
		s.groupRatioByUser[userID] = key
		if changed {
			affected[next.SetID] = true
		}
	} else if exists {
		delete(s.groupRatioDesired, existingKey)
		delete(s.groupRatioByUser, userID)
		affected[existing.SetID] = true
		changed = true
	}

	s.saveUserLLMSettingsLocked(intent.Settings, now)
	task := s.enqueueBYOKSyncTaskLocked(intent.Task, now)
	if changed {
		affectedSetIDs := make([]string, 0, len(affected))
		for affectedSetID := range affected {
			affectedSetIDs = append(affectedSetIDs, affectedSetID)
		}
		sort.Strings(affectedSetIDs)
		for _, affectedSetID := range affectedSetIDs {
			if _, err := s.markGroupRatioDesiredChangedLocked(affectedSetID, now); err != nil {
				return BYOKSyncTask{}, err
			}
		}
	}
	return task, nil
}

func (s *MemoryStore) ReplacePlatformGroupRatios(_ context.Context, setID string, sourceID string, ratios map[string]float64) (GroupRatioApplyState, error) {
	setID = strings.TrimSpace(setID)
	sourceID = strings.TrimSpace(sourceID)
	if setID == "" || sourceID == "" {
		return GroupRatioApplyState{}, fmt.Errorf("platform GroupRatio requires Set and source")
	}
	for group := range ratios {
		if strings.TrimSpace(group) == "" || isBYOKGroup(group) {
			return GroupRatioApplyState{}, fmt.Errorf("platform GroupRatio contains invalid group %q", group)
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	current := map[string]float64{}
	for _, entry := range s.groupRatioDesired {
		if entry.SetID == setID && entry.SourceType == GroupRatioSourcePlatform {
			current[entry.GroupName] = entry.Ratio
		}
	}
	changed := comparableChannelBundleOptionValue(current) != comparableChannelBundleOptionValue(ratios)
	now := time.Now().UTC()
	for key, entry := range s.groupRatioDesired {
		if entry.SetID == setID && entry.SourceType == GroupRatioSourcePlatform {
			delete(s.groupRatioDesired, key)
		}
	}
	for group, ratio := range ratios {
		entry := GroupRatioDesired{
			SetID:      setID,
			GroupName:  group,
			Ratio:      ratio,
			SourceType: GroupRatioSourcePlatform,
			SourceID:   sourceID,
			CreatedAt:  now,
			UpdatedAt:  now,
		}
		s.groupRatioDesired[groupRatioDesiredKey(setID, group)] = entry
	}
	if changed {
		return s.markGroupRatioDesiredChangedLocked(setID, now)
	}
	state, ok := s.groupRatioStates[setID]
	if !ok {
		state = GroupRatioApplyState{SetID: setID, Status: GroupRatioApplyStatusSynced, CreatedAt: now, UpdatedAt: now}
		s.groupRatioStates[setID] = state
	}
	return state, nil
}

func (s *MemoryStore) GetGroupRatioSnapshot(_ context.Context, setID string) (GroupRatioSnapshot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entries := s.groupRatioEntriesLocked(strings.TrimSpace(setID))
	state := s.groupRatioStates[strings.TrimSpace(setID)]
	return GroupRatioSnapshot{State: state, Entries: entries}, nil
}

func (s *MemoryStore) GetGroupRatioApplyState(_ context.Context, setID string) (GroupRatioApplyState, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, ok := s.groupRatioStates[strings.TrimSpace(setID)]
	return state, ok, nil
}

func (s *MemoryStore) ListGroupRatioApplyStates(_ context.Context, opts GroupRatioApplyStateListOptions) ([]GroupRatioApplyState, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	allowed := map[string]bool{}
	for _, status := range opts.Statuses {
		allowed[strings.TrimSpace(status)] = true
	}
	states := make([]GroupRatioApplyState, 0, len(s.groupRatioStates))
	for _, state := range s.groupRatioStates {
		if state.SetID <= strings.TrimSpace(opts.AfterSetID) || len(allowed) > 0 && !allowed[state.Status] {
			continue
		}
		states = append(states, state)
	}
	sort.Slice(states, func(i, j int) bool { return states[i].SetID < states[j].SetID })
	if opts.Limit > 0 && len(states) > opts.Limit {
		states = states[:opts.Limit]
	}
	return states, nil
}

func (s *MemoryStore) CompleteGroupRatioApply(_ context.Context, completion GroupRatioApplyCompletion) (GroupRatioApplyState, error) {
	setID := strings.TrimSpace(completion.SetID)
	if setID == "" || completion.Version < 0 {
		return GroupRatioApplyState{}, fmt.Errorf("GroupRatio apply completion requires Set and version")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.groupRatioStates[setID]
	if !ok {
		return GroupRatioApplyState{}, fmt.Errorf("GroupRatio apply state for Set %q not found", setID)
	}
	now := completion.AppliedAt.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if completion.Error != "" {
		state.LastError = completion.Error
		if state.DesiredVersion == completion.Version {
			state.Status = GroupRatioApplyStatusError
		} else {
			state.Status = GroupRatioApplyStatusPending
		}
	} else {
		state.AppliedVersion = completion.Version
		state.AppliedFingerprint = completion.Fingerprint
		state.LastAppliedAt = now
		state.LastError = ""
		if state.DesiredVersion == completion.Version {
			state.DesiredFingerprint = completion.Fingerprint
		}
		if state.DesiredVersion == completion.Version && state.DesiredFingerprint == completion.Fingerprint {
			state.Status = GroupRatioApplyStatusSynced
		} else {
			state.Status = GroupRatioApplyStatusPending
		}
	}
	state.UpdatedAt = now
	s.groupRatioStates[setID] = state
	return state, nil
}

func (s *MemoryStore) markGroupRatioDesiredChangedLocked(setID string, now time.Time) (GroupRatioApplyState, error) {
	state, ok := s.groupRatioStates[setID]
	if !ok {
		state = GroupRatioApplyState{SetID: setID, CreatedAt: now}
	}
	state.DesiredVersion++
	state.DesiredFingerprint = ""
	state.Status = GroupRatioApplyStatusPending
	state.LastError = ""
	state.UpdatedAt = now
	s.groupRatioStates[setID] = state
	return state, nil
}

func (s *MemoryStore) groupRatioEntriesLocked(setID string) []GroupRatioDesired {
	entries := []GroupRatioDesired{}
	for _, entry := range s.groupRatioDesired {
		if entry.SetID == setID {
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].GroupName < entries[j].GroupName })
	return entries
}

func groupRatioDesiredKey(setID string, groupName string) string {
	return strings.TrimSpace(setID) + "\x00" + strings.TrimSpace(groupName)
}

func (s *MemoryStore) GetBYOKSyncTask(_ context.Context, externalUserID string) (BYOKSyncTask, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	task, ok := s.byokSyncTasks[strings.TrimSpace(externalUserID)]
	return task, ok, nil
}

func (s *MemoryStore) ListBYOKSyncTasks(_ context.Context, opts BYOKSyncTaskListOptions) ([]BYOKSyncTask, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tasks := make([]BYOKSyncTask, 0, len(s.byokSyncTasks))
	for _, task := range s.byokSyncTasks {
		if opts.Status != "" && task.Status != opts.Status {
			continue
		}
		if taskSetExcluded(task.SetID, opts.ExcludeSetIDs) {
			continue
		}
		claimable := false
		switch task.Status {
		case BYOKSyncTaskStatusPending, BYOKSyncTaskStatusError:
			claimable = task.NextRunAt.IsZero() || !task.NextRunAt.After(now)
		case BYOKSyncTaskStatusRunning:
			claimable = task.LeaseUntil.IsZero() || !task.LeaseUntil.After(now)
		}
		if !claimable {
			continue
		}
		tasks = append(tasks, task)
	}
	sort.Slice(tasks, func(i, j int) bool {
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

func (s *MemoryStore) GetBYOKSyncTaskStats(_ context.Context, now time.Time) (BYOKSyncQueueStats, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	stats := BYOKSyncQueueStats{LastCalculatedAt: now}
	var oldestPending time.Time
	var oldestError time.Time
	for _, task := range s.byokSyncTasks {
		at := task.NextRunAt
		if at.IsZero() {
			at = task.CreatedAt
		}
		switch task.Status {
		case BYOKSyncTaskStatusPending:
			stats.Pending++
			if oldestPending.IsZero() || (!at.IsZero() && at.Before(oldestPending)) {
				oldestPending = at
			}
		case BYOKSyncTaskStatusRunning:
			stats.Running++
			if !task.LeaseUntil.IsZero() && !task.LeaseUntil.After(now) {
				stats.ExpiredRunningLeases++
			}
		case BYOKSyncTaskStatusError:
			stats.Error++
			if oldestError.IsZero() || (!at.IsZero() && at.Before(oldestError)) {
				oldestError = at
			}
		case BYOKSyncTaskStatusSucceeded:
			stats.Succeeded++
		}
		if task.AppliedVersion > 0 && task.LastError == "" && task.LastFinishedAt.After(stats.LastSuccessAt) {
			stats.LastSuccessAt = task.LastFinishedAt
		}
		if task.LastError != "" && task.LastFinishedAt.After(stats.LastFailureAt) {
			stats.LastFailureAt = task.LastFinishedAt
		}
	}
	stats.TotalOpen = stats.Pending + stats.Running + stats.Error
	if !oldestPending.IsZero() {
		stats.OldestPendingAt = oldestPending
		stats.OldestPendingAgeSeconds = nonNegativeSeconds(now.Sub(oldestPending))
	}
	if !oldestError.IsZero() {
		stats.OldestErrorAt = oldestError
		stats.OldestErrorAgeSeconds = nonNegativeSeconds(now.Sub(oldestError))
	}
	return stats, nil
}

func (s *MemoryStore) TryAcquireBYOKSyncTask(_ context.Context, externalUserID string, owner string, ttl time.Duration, now time.Time) (BYOKSyncTask, bool, error) {
	if strings.TrimSpace(externalUserID) == "" || strings.TrimSpace(owner) == "" {
		return BYOKSyncTask{}, false, fmt.Errorf("external user id and owner are required")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.byokSyncTasks[strings.TrimSpace(externalUserID)]
	if !ok {
		return BYOKSyncTask{}, false, nil
	}
	if task.Status == BYOKSyncTaskStatusRunning && task.LeaseUntil.After(now) && task.LeaseOwner != owner {
		return task, false, nil
	}
	if task.Status == BYOKSyncTaskStatusSucceeded && task.AppliedVersion >= task.RequestedVersion {
		return task, false, nil
	}
	if !task.NextRunAt.IsZero() && task.NextRunAt.After(now) {
		return task, false, nil
	}
	task.Status = BYOKSyncTaskStatusRunning
	task.LeaseOwner = owner
	task.LeaseUntil = now.Add(ttl)
	task.ProcessingVersion = task.RequestedVersion
	task.LastStartedAt = now
	task.UpdatedAt = now
	s.byokSyncTasks[task.ExternalUserID] = task
	return task, true, nil
}

func (s *MemoryStore) RenewBYOKSyncTaskLease(_ context.Context, task BYOKSyncTask, ttl time.Duration, now time.Time) (bool, error) {
	if strings.TrimSpace(task.ExternalUserID) == "" || strings.TrimSpace(task.LeaseOwner) == "" || ttl <= 0 {
		return false, fmt.Errorf("byok sync task renewal requires user, owner and ttl")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.byokSyncTasks[task.ExternalUserID]
	if !ok || current.Status != BYOKSyncTaskStatusRunning || current.LeaseOwner != task.LeaseOwner || current.ProcessingVersion != task.ProcessingVersion || !current.LeaseUntil.After(now) {
		return false, nil
	}
	current.LeaseUntil = now.Add(ttl)
	current.UpdatedAt = now
	s.byokSyncTasks[current.ExternalUserID] = current
	return true, nil
}

func (s *MemoryStore) ReleaseBYOKSyncTaskLease(_ context.Context, task BYOKSyncTask, now time.Time) (bool, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.byokSyncTasks[task.ExternalUserID]
	if !ok || current.Status != BYOKSyncTaskStatusRunning || current.LeaseOwner != task.LeaseOwner || current.ProcessingVersion != task.ProcessingVersion {
		return false, nil
	}
	current.Status = BYOKSyncTaskStatusPending
	current.LeaseOwner = ""
	current.LeaseUntil = time.Time{}
	current.NextRunAt = now
	current.UpdatedAt = now
	s.byokSyncTasks[current.ExternalUserID] = current
	return true, nil
}

func (s *MemoryStore) CompleteBYOKSyncTask(_ context.Context, task BYOKSyncTask, success bool, message string, now time.Time) (BYOKSyncTask, error) {
	if strings.TrimSpace(task.ExternalUserID) == "" {
		return BYOKSyncTask{}, fmt.Errorf("external user id is required")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.byokSyncTasks[task.ExternalUserID]
	if !ok {
		return BYOKSyncTask{}, fmt.Errorf("byok sync task for user %q not found", task.ExternalUserID)
	}
	if current.Status != BYOKSyncTaskStatusRunning || current.LeaseOwner != task.LeaseOwner || current.ProcessingVersion != task.ProcessingVersion || !current.LeaseUntil.After(now) {
		return current, ErrBYOKSyncTaskLeaseLost
	}
	current.LastFinishedAt = now
	current.LeaseOwner = ""
	current.LeaseUntil = time.Time{}
	if success {
		current.AppliedVersion = task.ProcessingVersion
		current.LastError = ""
		if current.RequestedVersion > task.ProcessingVersion {
			current.Status = BYOKSyncTaskStatusPending
			current.NextRunAt = now
		} else {
			current.Status = BYOKSyncTaskStatusSucceeded
			current.NextRunAt = time.Time{}
		}
	} else {
		current.Attempts++
		current.LastError = message
		if current.RequestedVersion > task.ProcessingVersion {
			current.Status = BYOKSyncTaskStatusPending
			current.NextRunAt = now
		} else {
			current.Status = BYOKSyncTaskStatusError
			current.NextRunAt = now.Add(byokSyncBackoff(current.Attempts))
		}
	}
	current.UpdatedAt = now
	s.byokSyncTasks[current.ExternalUserID] = current
	return current, nil
}

func (s *MemoryStore) RequeueFailedBYOKSyncTasks(_ context.Context, limit int, now time.Time) (int, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if limit <= 0 {
		limit = defaultBYOKSyncBatchSize
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	requeued := 0
	for userID, task := range s.byokSyncTasks {
		if task.Status != BYOKSyncTaskStatusError {
			continue
		}
		task.Status = BYOKSyncTaskStatusPending
		task.NextRunAt = now
		task.UpdatedAt = now
		s.byokSyncTasks[userID] = task
		requeued++
		if requeued >= limit {
			break
		}
	}
	return requeued, nil
}

func (s *MemoryStore) SavePlanMapping(_ context.Context, plan PlanMapping) error {
	if plan.ID == "" {
		return fmt.Errorf("plan id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if existing, ok := s.entitlementPlans[plan.ID]; ok {
		plan.CreatedAt = existing.CreatedAt
	} else if plan.CreatedAt.IsZero() {
		plan.CreatedAt = now
	}
	if plan.PeriodValue == 0 {
		plan.PeriodValue = 1
	}
	if plan.PeriodUnit == "" {
		plan.PeriodUnit = "months"
	}
	plan.UpdatedAt = now
	entitlement, err := normalizePlan(Plan{
		ID:            plan.ID,
		Name:          plan.Name,
		MonthlyTokens: plan.MonthlyTokens,
		PeriodValue:   plan.PeriodValue,
		PeriodUnit:    plan.PeriodUnit,
		IsActive:      plan.IsActive,
	})
	if err != nil {
		return err
	}
	entitlement.CreatedAt = plan.CreatedAt
	entitlement.UpdatedAt = plan.UpdatedAt
	s.entitlementPlans[entitlement.ID] = entitlement
	for setID, upstreamPlanID := range plan.UpstreamPlanIDs {
		if upstreamPlanID <= 0 {
			continue
		}
		s.setPlans[setPlanKey(plan.ID, setID)] = SetPlan{
			PlanID: plan.ID, SetID: setID, UpstreamPlanID: upstreamPlanID,
			AppliedFingerprint: entitlement.Fingerprint,
			Status:             SetPlanStatusReady, SyncedAt: now, CreatedAt: now, UpdatedAt: now,
		}
	}
	if plan.UpstreamPlanID > 0 && plan.SetID != "" {
		s.setPlans[setPlanKey(plan.ID, plan.SetID)] = SetPlan{
			PlanID: plan.ID, SetID: plan.SetID, UpstreamPlanID: plan.UpstreamPlanID,
			AppliedFingerprint: entitlement.Fingerprint,
			Status:             SetPlanStatusReady, SyncedAt: now, CreatedAt: now, UpdatedAt: now,
		}
	}
	return nil
}

func (s *MemoryStore) GetPlanMapping(_ context.Context, id string) (PlanMapping, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	plan, ok := s.entitlementPlans[id]
	if !ok {
		return PlanMapping{}, false, nil
	}
	mapping := PlanMapping{
		ID: plan.ID, Name: plan.Name, MonthlyTokens: plan.MonthlyTokens,
		PeriodValue: plan.PeriodValue, PeriodUnit: plan.PeriodUnit, IsActive: plan.IsActive,
		UpstreamPlanIDs: map[string]int{}, CreatedAt: plan.CreatedAt, UpdatedAt: plan.UpdatedAt,
	}
	for _, state := range s.setPlans {
		if state.PlanID == id && state.Status == SetPlanStatusReady && state.UpstreamPlanID > 0 {
			mapping.UpstreamPlanIDs[state.SetID] = state.UpstreamPlanID
		}
	}
	return mapping, true, nil
}

func (s *MemoryStore) ListPlanMappings(_ context.Context) ([]PlanMapping, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	plans := make([]PlanMapping, 0, len(s.entitlementPlans))
	for _, plan := range s.entitlementPlans {
		mapping := PlanMapping{
			ID: plan.ID, Name: plan.Name, MonthlyTokens: plan.MonthlyTokens,
			PeriodValue: plan.PeriodValue, PeriodUnit: plan.PeriodUnit, IsActive: plan.IsActive,
			UpstreamPlanIDs: map[string]int{}, CreatedAt: plan.CreatedAt, UpdatedAt: plan.UpdatedAt,
		}
		for _, state := range s.setPlans {
			if state.PlanID == plan.ID && state.Status == SetPlanStatusReady && state.UpstreamPlanID > 0 {
				mapping.UpstreamPlanIDs[state.SetID] = state.UpstreamPlanID
			}
		}
		plans = append(plans, mapping)
	}
	sort.Slice(plans, func(i, j int) bool { return plans[i].ID < plans[j].ID })
	return plans, nil
}

func (s *MemoryStore) SavePlan(_ context.Context, plan Plan) error {
	var err error
	plan, err = normalizePlan(plan)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if existing, ok := s.entitlementPlans[plan.ID]; ok {
		if existing.Fingerprint != plan.Fingerprint {
			return ErrPlanImmutableConflict
		}
		return nil
	} else if plan.CreatedAt.IsZero() {
		plan.CreatedAt = now
	}
	plan.UpdatedAt = now
	s.entitlementPlans[plan.ID] = plan
	return nil
}

func (s *MemoryStore) RetirePlan(_ context.Context, planID string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.entitlementPlans[planID]
	if !ok {
		return ErrPlanNotFound
	}
	if !existing.IsActive {
		return nil
	}
	existing.IsActive = false
	existing.UpdatedAt = now.UTC()
	s.entitlementPlans[planID] = existing
	return nil
}

func (s *MemoryStore) GetPlan(_ context.Context, id string) (Plan, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	plan, ok := s.entitlementPlans[id]
	return plan, ok, nil
}

func (s *MemoryStore) ListPlans(_ context.Context) ([]Plan, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	plans := make([]Plan, 0, len(s.entitlementPlans))
	for _, plan := range s.entitlementPlans {
		plans = append(plans, plan)
	}
	sort.Slice(plans, func(i, j int) bool { return plans[i].ID < plans[j].ID })
	return plans, nil
}

func setPlanKey(planID string, setID string) string {
	return planID + "\x00" + setID
}

func (s *MemoryStore) SaveSetPlan(_ context.Context, state SetPlan) error {
	if state.PlanID == "" || state.SetID == "" {
		return fmt.Errorf("plan id and set id are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	key := setPlanKey(state.PlanID, state.SetID)
	if existing, ok := s.setPlans[key]; ok {
		state.CreatedAt = existing.CreatedAt
	} else if state.CreatedAt.IsZero() {
		state.CreatedAt = now
	}
	if state.Status == "" {
		state.Status = SetPlanStatusPending
	}
	state.UpdatedAt = now
	s.setPlans[key] = state
	return nil
}

func (s *MemoryStore) GetSetPlan(_ context.Context, planID string, setID string) (SetPlan, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, ok := s.setPlans[setPlanKey(planID, setID)]
	return state, ok, nil
}

func (s *MemoryStore) ListSetPlans(_ context.Context, options SetPlanListOptions) ([]SetPlan, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	allowed := make(map[string]struct{}, len(options.Statuses))
	for _, status := range options.Statuses {
		allowed[status] = struct{}{}
	}
	states := make([]SetPlan, 0, len(s.setPlans))
	for _, state := range s.setPlans {
		if options.PlanID != "" && state.PlanID != options.PlanID {
			continue
		}
		if options.SetID != "" && state.SetID != options.SetID {
			continue
		}
		if len(allowed) > 0 {
			if _, ok := allowed[state.Status]; !ok {
				continue
			}
		}
		states = append(states, state)
	}
	sort.Slice(states, func(i, j int) bool {
		if states[i].PlanID == states[j].PlanID {
			return states[i].SetID < states[j].SetID
		}
		return states[i].PlanID < states[j].PlanID
	})
	if options.Limit > 0 && len(states) > options.Limit {
		states = states[:options.Limit]
	}
	return states, nil
}

func planPeriodKey(planID string, periodValue int, periodUnit string) string {
	return fmt.Sprintf("%s\x00%d\x00%s", planID, periodValue, normalizePeriodUnit(periodUnit))
}

func setPlanPeriodKey(planID string, periodValue int, periodUnit string, setID string) string {
	return planPeriodKey(planID, periodValue, periodUnit) + "\x00" + setID
}

func normalizePlanPeriod(period PlanPeriod) (PlanPeriod, error) {
	period.PlanID = strings.TrimSpace(period.PlanID)
	period.PeriodUnit = normalizePeriodUnit(period.PeriodUnit)
	if period.PlanID == "" || period.PeriodValue <= 0 || period.PeriodUnit == "" {
		return PlanPeriod{}, fmt.Errorf("plan id and positive period are required")
	}
	switch period.PeriodUnit {
	case "days", "months", "years":
	default:
		return PlanPeriod{}, fmt.Errorf("unsupported plan period unit %q", period.PeriodUnit)
	}
	return period, nil
}

func (s *MemoryStore) SavePlanPeriod(_ context.Context, period PlanPeriod) error {
	period, err := normalizePlanPeriod(period)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	key := planPeriodKey(period.PlanID, period.PeriodValue, period.PeriodUnit)
	if existing, ok := s.planPeriods[key]; ok {
		period.CreatedAt = existing.CreatedAt
	} else if period.CreatedAt.IsZero() {
		period.CreatedAt = now
	}
	period.UpdatedAt = now
	s.planPeriods[key] = period
	return nil
}

func (s *MemoryStore) GetPlanPeriod(_ context.Context, planID string, periodValue int, periodUnit string) (PlanPeriod, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	period, ok := s.planPeriods[planPeriodKey(planID, periodValue, periodUnit)]
	return period, ok, nil
}

func (s *MemoryStore) ListPlanPeriods(_ context.Context, planID string) ([]PlanPeriod, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	periods := make([]PlanPeriod, 0)
	for _, period := range s.planPeriods {
		if planID == "" || period.PlanID == planID {
			periods = append(periods, period)
		}
	}
	sort.Slice(periods, func(i, j int) bool {
		if periods[i].PlanID != periods[j].PlanID {
			return periods[i].PlanID < periods[j].PlanID
		}
		if periods[i].PeriodUnit != periods[j].PeriodUnit {
			return periods[i].PeriodUnit < periods[j].PeriodUnit
		}
		return periods[i].PeriodValue < periods[j].PeriodValue
	})
	return periods, nil
}

func (s *MemoryStore) SaveSetPlanPeriod(_ context.Context, state SetPlanPeriod) error {
	period, err := normalizePlanPeriod(PlanPeriod{PlanID: state.PlanID, PeriodValue: state.PeriodValue, PeriodUnit: state.PeriodUnit})
	if err != nil || strings.TrimSpace(state.SetID) == "" {
		return fmt.Errorf("plan id, positive period, and set id are required")
	}
	state.PlanID, state.PeriodValue, state.PeriodUnit = period.PlanID, period.PeriodValue, period.PeriodUnit
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	key := setPlanPeriodKey(state.PlanID, state.PeriodValue, state.PeriodUnit, state.SetID)
	if existing, ok := s.setPlanPeriods[key]; ok {
		state.CreatedAt = existing.CreatedAt
	} else if state.CreatedAt.IsZero() {
		state.CreatedAt = now
	}
	if state.Status == "" {
		state.Status = SetPlanStatusPending
	}
	state.UpdatedAt = now
	s.setPlanPeriods[key] = state
	return nil
}

func (s *MemoryStore) GetSetPlanPeriod(_ context.Context, planID string, periodValue int, periodUnit string, setID string) (SetPlanPeriod, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, ok := s.setPlanPeriods[setPlanPeriodKey(planID, periodValue, periodUnit, setID)]
	return state, ok, nil
}

func (s *MemoryStore) ListSetPlanPeriods(_ context.Context, options SetPlanPeriodListOptions) ([]SetPlanPeriod, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	allowed := map[string]struct{}{}
	for _, status := range options.Statuses {
		allowed[status] = struct{}{}
	}
	states := make([]SetPlanPeriod, 0)
	for _, state := range s.setPlanPeriods {
		if options.PlanID != "" && state.PlanID != options.PlanID {
			continue
		}
		if options.SetID != "" && state.SetID != options.SetID {
			continue
		}
		if len(allowed) > 0 {
			if _, ok := allowed[state.Status]; !ok {
				continue
			}
		}
		states = append(states, state)
	}
	sort.Slice(states, func(i, j int) bool {
		return setPlanPeriodKey(states[i].PlanID, states[i].PeriodValue, states[i].PeriodUnit, states[i].SetID) < setPlanPeriodKey(states[j].PlanID, states[j].PeriodValue, states[j].PeriodUnit, states[j].SetID)
	})
	if options.Limit > 0 && len(states) > options.Limit {
		states = states[:options.Limit]
	}
	return states, nil
}

func (s *MemoryStore) SaveSubscriptionPeriodOverlay(_ context.Context, overlay SubscriptionPeriodOverlay) error {
	if overlay.ExternalUserID == "" {
		return fmt.Errorf("external user id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.rejectInactiveTenantWriteLocked(overlay.ExternalUserID); err != nil {
		return err
	}
	now := time.Now().UTC()
	if existing, ok := s.periodEnds[overlay.ExternalUserID]; ok {
		overlay.CreatedAt = existing.CreatedAt
	} else if overlay.CreatedAt.IsZero() {
		overlay.CreatedAt = now
	}
	overlay.UpdatedAt = now
	s.periodEnds[overlay.ExternalUserID] = overlay
	return nil
}

func (s *MemoryStore) GetSubscriptionPeriodOverlay(_ context.Context, externalUserID string) (SubscriptionPeriodOverlay, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	overlay, ok := s.periodEnds[externalUserID]
	return overlay, ok, nil
}

func (s *MemoryStore) DeleteSubscriptionPeriodOverlay(_ context.Context, externalUserID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.periodEnds, externalUserID)
	return nil
}

func subscriptionProjectionKey(externalUserID string, upstreamSubscriptionID int) string {
	return strings.TrimSpace(externalUserID) + "\x00" + fmt.Sprint(upstreamSubscriptionID)
}

func (s *MemoryStore) SaveSubscriptionProjection(_ context.Context, projection SubscriptionProjection) error {
	projection.ExternalUserID = strings.TrimSpace(projection.ExternalUserID)
	projection.SetID = strings.TrimSpace(projection.SetID)
	projection.SubscriptionName = strings.TrimSpace(projection.SubscriptionName)
	projection.PlanID = strings.TrimSpace(projection.PlanID)
	if projection.ExternalUserID == "" || projection.UpstreamSubscriptionID <= 0 {
		return fmt.Errorf("external user id and upstream subscription id are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.rejectInactiveTenantWriteLocked(projection.ExternalUserID); err != nil {
		return err
	}
	now := time.Now().UTC()
	key := subscriptionProjectionKey(projection.ExternalUserID, projection.UpstreamSubscriptionID)
	if existing, ok := s.subscriptionProjections[key]; ok {
		projection.CreatedAt = existing.CreatedAt
	} else if projection.CreatedAt.IsZero() {
		projection.CreatedAt = now
	}
	projection.UpdatedAt = now
	s.subscriptionProjections[key] = projection
	return nil
}

func (s *MemoryStore) ListSubscriptionProjections(_ context.Context, externalUserID string) ([]SubscriptionProjection, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	s.mu.RLock()
	defer s.mu.RUnlock()
	projections := make([]SubscriptionProjection, 0)
	for _, projection := range s.subscriptionProjections {
		if projection.ExternalUserID == externalUserID {
			projections = append(projections, projection)
		}
	}
	sort.Slice(projections, func(i, j int) bool {
		return projections[i].UpstreamSubscriptionID < projections[j].UpstreamSubscriptionID
	})
	return projections, nil
}

func (s *MemoryStore) DeleteSubscriptionProjections(_ context.Context, externalUserID string) error {
	externalUserID = strings.TrimSpace(externalUserID)
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, projection := range s.subscriptionProjections {
		if projection.ExternalUserID == externalUserID {
			delete(s.subscriptionProjections, key)
		}
	}
	return nil
}

func (s *MemoryStore) SaveUserAssignment(_ context.Context, assignment UserAssignment) error {
	assignment.ExternalUserID = strings.TrimSpace(assignment.ExternalUserID)
	assignment.Backend = strings.TrimSpace(strings.ToLower(assignment.Backend))
	assignment.SetID = strings.TrimSpace(assignment.SetID)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.rejectInactiveTenantWriteLocked(assignment.ExternalUserID); err != nil {
		return err
	}
	now := time.Now().UTC()
	if existing, ok := s.assignments[assignment.ExternalUserID]; ok {
		assignment.CreatedAt = existing.CreatedAt
	} else if assignment.CreatedAt.IsZero() {
		assignment.CreatedAt = now
	}
	assignment.UpdatedAt = now
	tenant := Tenant{
		ExternalUserID: assignment.ExternalUserID,
		Backend:        assignment.Backend,
		SetID:          assignment.SetID,
		Status:         TenantStatusActive,
		Source:         "assignment",
		CreatedAt:      assignment.CreatedAt,
		UpdatedAt:      assignment.UpdatedAt,
	}
	tenant, err := normalizeTenant(tenant)
	if err != nil {
		return err
	}
	assignment.Backend = tenant.Backend
	assignment.SetID = tenant.SetID

	s.assignments[assignment.ExternalUserID] = assignment
	if existing, ok := s.tenants[assignment.ExternalUserID]; ok {
		tenant.CreatedAt = existing.CreatedAt
		if existing.Status != "" {
			tenant.Status = existing.Status
		}
		tenant.Source = firstNonEmpty(existing.Source, tenant.Source)
		tenant.DisplayName = existing.DisplayName
	}
	s.tenants[tenant.ExternalUserID] = tenant
	return nil
}

func (s *MemoryStore) rejectInactiveTenantWriteLocked(externalUserID string) error {
	tenant, ok := s.tenants[strings.TrimSpace(externalUserID)]
	if !ok || (tenant.Status != TenantStatusDeleting && tenant.Status != TenantStatusDeleted) {
		return nil
	}
	return fmtInactiveTenant(tenant)
}

func normalizeUserBinding(binding UserBinding) UserBinding {
	binding.ExternalUserID = strings.TrimSpace(binding.ExternalUserID)
	binding.SetID = strings.TrimSpace(binding.SetID)
	binding.Username = strings.TrimSpace(binding.Username)
	binding.ProvisionStatus = strings.TrimSpace(strings.ToLower(binding.ProvisionStatus))
	binding.LastProvisionError = strings.TrimSpace(binding.LastProvisionError)
	if binding.ProvisionStatus == "" {
		binding.ProvisionStatus = BindingProvisionStatusAllocated
	}
	switch binding.ProvisionStatus {
	case BindingProvisionStatusAllocated, BindingProvisionStatusUserReady, BindingProvisionStatusTokenReady, BindingProvisionStatusFailed:
	default:
		binding.ProvisionStatus = BindingProvisionStatusAllocated
	}
	if binding.ProvisionStatus != BindingProvisionStatusFailed {
		binding.LastProvisionError = ""
	}
	if binding.UpstreamUserID > 0 && binding.ProvisionStatus == BindingProvisionStatusAllocated {
		binding.ProvisionStatus = BindingProvisionStatusUserReady
	}
	return binding
}

func (s *MemoryStore) GetUserAssignment(_ context.Context, externalUserID string) (UserAssignment, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	assignment, ok := s.assignments[externalUserID]
	return assignment, ok, nil
}

func (s *MemoryStore) SaveChannelSpec(_ context.Context, spec ChannelSpec) error {
	if spec.ID == "" {
		return fmt.Errorf("channel id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if existing, ok := s.channels[spec.ID]; ok {
		spec.CreatedAt = existing.CreatedAt
	} else if spec.CreatedAt.IsZero() {
		spec.CreatedAt = now
	}
	spec.UpdatedAt = now
	s.channels[spec.ID] = spec
	return nil
}

func (s *MemoryStore) GetChannelSpec(_ context.Context, id string) (ChannelSpec, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	spec, ok := s.channels[id]
	return spec, ok, nil
}

func (s *MemoryStore) ListChannelSpecs(_ context.Context) ([]ChannelSpec, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	specs := make([]ChannelSpec, 0, len(s.channels))
	for _, spec := range s.channels {
		specs = append(specs, spec)
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].ID < specs[j].ID })
	return specs, nil
}

func (s *MemoryStore) SaveChannelSyncState(_ context.Context, state ChannelSyncState) error {
	if state.ChannelID == "" || state.SetID == "" {
		return fmt.Errorf("channel id and set id are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	key := channelSyncStateKey(state.ChannelID, state.SetID)
	if existing, ok := s.channelStates[key]; ok {
		state.CreatedAt = existing.CreatedAt
	} else if state.CreatedAt.IsZero() {
		state.CreatedAt = now
	}
	state.UpdatedAt = now
	s.channelStates[key] = state
	return nil
}

func (s *MemoryStore) GetChannelSyncState(_ context.Context, channelID string, setID string) (ChannelSyncState, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, ok := s.channelStates[channelSyncStateKey(channelID, setID)]
	return state, ok, nil
}

func (s *MemoryStore) ListChannelSyncStates(_ context.Context, channelID string) ([]ChannelSyncState, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	states := make([]ChannelSyncState, 0)
	for _, state := range s.channelStates {
		if channelID == "" || state.ChannelID == channelID {
			states = append(states, state)
		}
	}
	sort.Slice(states, func(i, j int) bool {
		if states[i].ChannelID != states[j].ChannelID {
			return states[i].ChannelID < states[j].ChannelID
		}
		return states[i].SetID < states[j].SetID
	})
	return states, nil
}

func (s *MemoryStore) SaveChannelBundle(_ context.Context, bundle ChannelBundle) error {
	if bundle.ID == "" {
		return fmt.Errorf("channel bundle id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if existing, ok := s.bundles[bundle.ID]; ok {
		bundle.CreatedAt = existing.CreatedAt
	} else if bundle.CreatedAt.IsZero() {
		bundle.CreatedAt = now
	}
	bundle.UpdatedAt = now
	s.bundles[bundle.ID] = bundle
	return nil
}

func (s *MemoryStore) GetChannelBundle(_ context.Context, id string) (ChannelBundle, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	bundle, ok := s.bundles[id]
	return bundle, ok, nil
}

func (s *MemoryStore) ListChannelBundles(_ context.Context) ([]ChannelBundle, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	bundles := make([]ChannelBundle, 0, len(s.bundles))
	for _, bundle := range s.bundles {
		bundles = append(bundles, bundle)
	}
	sort.Slice(bundles, func(i, j int) bool { return bundles[i].ID < bundles[j].ID })
	return bundles, nil
}

func (s *MemoryStore) SaveChannelBundleRevision(_ context.Context, revision ChannelBundleRevision) error {
	if revision.BundleID == "" || revision.RevisionID == "" {
		return fmt.Errorf("bundle id and revision id are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if revision.CreatedAt.IsZero() {
		revision.CreatedAt = time.Now().UTC()
	}
	if revision.Version == 0 {
		revision.Version = s.nextChannelBundleRevisionVersionLocked(revision.BundleID)
	}
	s.bundleRevisions[channelBundleRevisionKey(revision.BundleID, revision.RevisionID)] = revision
	return nil
}

func (s *MemoryStore) GetChannelBundleRevision(_ context.Context, bundleID string, revisionID string) (ChannelBundleRevision, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	revision, ok := s.bundleRevisions[channelBundleRevisionKey(bundleID, revisionID)]
	return revision, ok, nil
}

func (s *MemoryStore) ListChannelBundleRevisions(_ context.Context, bundleID string) ([]ChannelBundleRevision, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	revisions := make([]ChannelBundleRevision, 0)
	for _, revision := range s.bundleRevisions {
		if bundleID == "" || revision.BundleID == bundleID {
			revisions = append(revisions, revision)
		}
	}
	sort.Slice(revisions, func(i, j int) bool {
		if revisions[i].Version != revisions[j].Version {
			return revisions[i].Version > revisions[j].Version
		}
		return revisions[i].RevisionID > revisions[j].RevisionID
	})
	return revisions, nil
}

func (s *MemoryStore) nextChannelBundleRevisionVersionLocked(bundleID string) int {
	version := 0
	for _, revision := range s.bundleRevisions {
		if revision.BundleID == bundleID && revision.Version > version {
			version = revision.Version
		}
	}
	return version + 1
}

func (s *MemoryStore) SaveChannelBundleSyncState(_ context.Context, state ChannelBundleSyncState) error {
	if state.BundleID == "" || state.SetID == "" {
		return fmt.Errorf("channel bundle id and set id are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	key := channelBundleSyncStateKey(state.BundleID, state.SetID)
	if existing, ok := s.bundleStates[key]; ok {
		state.CreatedAt = existing.CreatedAt
	} else if state.CreatedAt.IsZero() {
		state.CreatedAt = now
	}
	state.UpdatedAt = now
	s.bundleStates[key] = state
	return nil
}

func (s *MemoryStore) GetChannelBundleSyncState(_ context.Context, bundleID string, setID string) (ChannelBundleSyncState, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, ok := s.bundleStates[channelBundleSyncStateKey(bundleID, setID)]
	return state, ok, nil
}

func (s *MemoryStore) ListChannelBundleSyncStates(_ context.Context, bundleID string) ([]ChannelBundleSyncState, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	states := make([]ChannelBundleSyncState, 0)
	for _, state := range s.bundleStates {
		if bundleID == "" || state.BundleID == bundleID {
			states = append(states, state)
		}
	}
	sort.Slice(states, func(i, j int) bool {
		if states[i].BundleID != states[j].BundleID {
			return states[i].BundleID < states[j].BundleID
		}
		return states[i].SetID < states[j].SetID
	})
	return states, nil
}

func (s *MemoryStore) SaveChannelBundleRelease(_ context.Context, run ChannelBundleReleaseRun) error {
	if run.ID == "" {
		return fmt.Errorf("release run id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if run.CreatedAt.IsZero() {
		run.CreatedAt = time.Now().UTC()
	}
	s.bundleReleases[run.ID] = run
	return nil
}

func (s *MemoryStore) GetChannelBundleRelease(_ context.Context, id string) (ChannelBundleReleaseRun, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	run, ok := s.bundleReleases[id]
	return run, ok, nil
}

func (s *MemoryStore) ListChannelBundleReleases(_ context.Context, bundleID string) ([]ChannelBundleReleaseRun, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	runs := make([]ChannelBundleReleaseRun, 0)
	for _, run := range s.bundleReleases {
		if bundleID == "" || run.BundleID == bundleID {
			runs = append(runs, run)
		}
	}
	sort.Slice(runs, func(i, j int) bool {
		if !runs[i].CreatedAt.Equal(runs[j].CreatedAt) {
			return runs[i].CreatedAt.After(runs[j].CreatedAt)
		}
		return runs[i].ID > runs[j].ID
	})
	return runs, nil
}

func (s *MemoryStore) TryAcquireChannelBundleLock(_ context.Context, bundleID string, owner string, purpose string, ttl time.Duration, now time.Time) (ChannelBundleLock, bool, error) {
	bundleID = strings.TrimSpace(bundleID)
	owner = strings.TrimSpace(owner)
	purpose = strings.TrimSpace(purpose)
	if bundleID == "" || owner == "" {
		return ChannelBundleLock{}, false, fmt.Errorf("channel bundle lock bundle id and owner are required")
	}
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	now = now.UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.bundleLocks[bundleID]
	if ok && existing.LeaseUntil.After(now) && existing.Owner != owner {
		return existing, false, nil
	}
	lock := ChannelBundleLock{
		BundleID:   bundleID,
		Owner:      owner,
		Purpose:    purpose,
		LeaseUntil: now.Add(ttl),
		UpdatedAt:  now,
	}
	if ok {
		lock.CreatedAt = existing.CreatedAt
	} else {
		lock.CreatedAt = now
	}
	s.bundleLocks[bundleID] = lock
	return lock, true, nil
}

func (s *MemoryStore) ReleaseChannelBundleLock(_ context.Context, bundleID string, owner string) error {
	bundleID = strings.TrimSpace(bundleID)
	owner = strings.TrimSpace(owner)
	if bundleID == "" || owner == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.bundleLocks[bundleID]; ok && existing.Owner == owner {
		delete(s.bundleLocks, bundleID)
	}
	return nil
}

func (s *MemoryStore) SaveWorkerJob(_ context.Context, job WorkerJob) error {
	if job.Name == "" {
		return fmt.Errorf("job name is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if existing, ok := s.workerJobs[job.Name]; ok {
		job.CreatedAt = existing.CreatedAt
		if job.Status == "" {
			job.Status = existing.Status
		}
	} else if job.CreatedAt.IsZero() {
		job.CreatedAt = now
	}
	if job.Status == "" {
		job.Status = WorkerJobStatusIdle
	}
	job.UpdatedAt = now
	s.workerJobs[job.Name] = job
	return nil
}

func (s *MemoryStore) GetWorkerJob(_ context.Context, name string) (WorkerJob, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	job, ok := s.workerJobs[name]
	return job, ok, nil
}

func (s *MemoryStore) ListWorkerJobs(_ context.Context, opts WorkerJobListOptions) ([]WorkerJob, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	jobs := make([]WorkerJob, 0, len(s.workerJobs))
	for _, job := range s.workerJobs {
		if opts.EnabledOnly && !job.Enabled {
			continue
		}
		jobs = append(jobs, job)
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].Name < jobs[j].Name })
	return jobs, nil
}

func (s *MemoryStore) QueueWorkerJob(_ context.Context, name string, resetCursor bool, now time.Time) (WorkerJob, bool, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return WorkerJob{}, false, fmt.Errorf("job name is required")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.workerJobs[name]
	if !ok || !job.Enabled {
		return job, false, nil
	}
	if job.Status == WorkerJobStatusRunning && job.LeaseUntil.After(now) {
		return job, false, nil
	}
	if resetCursor {
		job.Cursor = ""
	}
	job.NextRunAt = now
	job.UpdatedAt = now
	s.workerJobs[name] = job
	return job, true, nil
}

func (s *MemoryStore) TryAcquireWorkerJobLease(_ context.Context, name string, owner string, ttl time.Duration, now time.Time) (WorkerJob, bool, error) {
	if name == "" || owner == "" {
		return WorkerJob{}, false, fmt.Errorf("job name and owner are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.workerJobs[name]
	if !ok {
		return WorkerJob{}, false, nil
	}
	if !job.Enabled {
		return job, false, nil
	}
	if !job.LeaseUntil.IsZero() && job.LeaseUntil.After(now) && job.LeaseOwner != owner {
		return job, false, nil
	}
	job.LeaseOwner = owner
	job.LeaseUntil = now.Add(ttl)
	job.Status = WorkerJobStatusRunning
	job.LastStartedAt = now
	job.UpdatedAt = now
	s.workerJobs[name] = job
	return job, true, nil
}

func (s *MemoryStore) RenewWorkerJobLease(_ context.Context, name string, owner string, ttl time.Duration, now time.Time) (bool, error) {
	if name == "" || owner == "" {
		return false, fmt.Errorf("job name and owner are required")
	}
	if ttl <= 0 {
		return false, fmt.Errorf("job lease ttl must be positive")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.workerJobs[name]
	if !ok || job.Status != WorkerJobStatusRunning || job.LeaseOwner != owner || !job.LeaseUntil.After(now) {
		return false, nil
	}
	job.LeaseUntil = now.Add(ttl)
	job.UpdatedAt = now
	s.workerJobs[name] = job
	return true, nil
}

func (s *MemoryStore) CompleteWorkerJobRun(_ context.Context, job WorkerJob, run WorkerJobRun) (bool, error) {
	if job.Name == "" || run.ID == "" || run.JobName != job.Name || run.Owner == "" {
		return false, fmt.Errorf("job, run id, and owner are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.workerJobs[job.Name]
	if !ok || current.Status != WorkerJobStatusRunning || current.LeaseOwner != run.Owner {
		return false, nil
	}
	current.Cursor = job.Cursor
	current.NextRunAt = job.NextRunAt
	current.Status = run.Status
	current.LastFinishedAt = run.FinishedAt
	current.LastError = run.Error
	if run.Status == WorkerJobStatusSuccess {
		current.LastSuccessAt = run.FinishedAt
	} else if run.Status == WorkerJobStatusError {
		current.FailureCount++
	}
	current.LeaseOwner = ""
	current.LeaseUntil = time.Time{}
	current.UpdatedAt = run.FinishedAt
	s.workerJobs[job.Name] = current
	s.workerRuns[run.ID] = run
	return true, nil
}

func (s *MemoryStore) SaveWorkerJobRun(_ context.Context, run WorkerJobRun) error {
	if run.ID == "" || run.JobName == "" {
		return fmt.Errorf("job run id and name are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.workerRuns[run.ID] = run
	job := s.workerJobs[run.JobName]
	job.Name = run.JobName
	if job.CreatedAt.IsZero() {
		job.CreatedAt = run.StartedAt
	}
	job.Status = run.Status
	job.LastFinishedAt = run.FinishedAt
	job.LastError = run.Error
	if run.Status == WorkerJobStatusSuccess {
		job.LastSuccessAt = run.FinishedAt
	} else if run.Status == WorkerJobStatusError {
		job.FailureCount++
	}
	job.LeaseOwner = ""
	job.LeaseUntil = time.Time{}
	job.UpdatedAt = time.Now().UTC()
	s.workerJobs[run.JobName] = job
	return nil
}

func (s *MemoryStore) ListWorkerJobRuns(_ context.Context, opts WorkerJobRunListOptions) ([]WorkerJobRun, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	runs := make([]WorkerJobRun, 0)
	for _, run := range s.workerRuns {
		if opts.JobName != "" && run.JobName != opts.JobName {
			continue
		}
		if !opts.StartedAtOrAfter.IsZero() && run.StartedAt.Before(opts.StartedAtOrAfter) {
			continue
		}
		runs = append(runs, run)
	}
	sort.Slice(runs, func(i, j int) bool {
		if !runs[i].StartedAt.Equal(runs[j].StartedAt) {
			return runs[i].StartedAt.After(runs[j].StartedAt)
		}
		return runs[i].ID > runs[j].ID
	})
	if opts.Limit > 0 && len(runs) > opts.Limit {
		runs = runs[:opts.Limit]
	}
	return runs, nil
}

func channelSyncStateKey(channelID string, setID string) string {
	return channelID + "\x00" + setID
}

func channelBundleRevisionKey(bundleID string, revisionID string) string {
	return bundleID + "\x00" + revisionID
}

func channelBundleSyncStateKey(bundleID string, setID string) string {
	return bundleID + "\x00" + setID
}

func hashExternalKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}
