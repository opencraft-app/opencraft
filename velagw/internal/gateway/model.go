package gateway

import (
	"io"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
)

const (
	SetStatusActive   = "active"
	SetStatusDraining = "draining"
	SetStatusDisabled = "disabled"

	SetAdmissionStatusPending  = "pending"
	SetAdmissionStatusChecking = "checking"
	SetAdmissionStatusPassed   = "passed"
	SetAdmissionStatusFailed   = "failed"

	UserBackendPending = "pending"
	UserBackendNew     = "new"

	TenantStatusActive   = "active"
	TenantStatusDisabled = "disabled"
	TenantStatusDeleting = "deleting"
	TenantStatusDeleted  = "deleted"

	BindingProvisionStatusAllocated  = "allocated"
	BindingProvisionStatusUserReady  = "user_ready"
	BindingProvisionStatusTokenReady = "token_ready"
	BindingProvisionStatusFailed     = "failed"

	APIKeyStatusLegacyDisabled = "legacy_disabled"
	APIKeyStatusReserved       = "reserved"
	APIKeyStatusUpstreamReady  = "upstream_ready"
	APIKeyStatusRoutePending   = "route_pending"
	APIKeyStatusActive         = "active"
	APIKeyStatusError          = "error"

	ChannelSpecStatusEnabled  = "enabled"
	ChannelSpecStatusDisabled = "disabled"

	ChannelSyncStatusPending  = "pending"
	ChannelSyncStatusSynced   = "synced"
	ChannelSyncStatusDrift    = "drift"
	ChannelSyncStatusError    = "error"
	ChannelSyncStatusSkipped  = "skipped"
	ChannelSyncStatusConflict = "conflict"

	ChannelBundleKind              = "newapi-channel-bundle"
	ChannelBundleStepCreateChannel = "create_channel"
	ChannelBundleStepUpdateChannel = "update_channel"
	ChannelBundleStepUpdateOption  = "update_option"
	ChannelBundleStepNoop          = "noop"

	LLMRouteBYOKFirst     = "byok_first"
	LLMRoutePlatformFirst = "platform_first"

	LLMProviderProtocolOpenAICompatible = "openai_compatible"
	LLMProviderProtocolAnthropic        = "anthropic"

	LLMProviderSyncPending = "pending"
	LLMProviderSyncRunning = "running"
	LLMProviderSyncSynced  = "synced"
	LLMProviderSyncError   = "error"

	BYOKSyncTaskStatusPending   = "pending"
	BYOKSyncTaskStatusRunning   = "running"
	BYOKSyncTaskStatusSucceeded = "succeeded"
	BYOKSyncTaskStatusError     = "error"

	TenantObservationTaskStatusPending = "pending"
	TenantObservationTaskStatusRunning = "running"
	TenantObservationTaskStatusError   = "error"
	TenantObservationTaskStatusBlocked = "blocked"

	TenantObservationPriorityPeriodic = 10
	TenantObservationPriorityEvent    = 100

	SetReconcileStatusPending = "pending"
	SetReconcileStatusManaged = "managed"
	SetReconcileStatusError   = "error"

	SetProvisionStatusPending      = "pending"
	SetProvisionStatusProvisioning = "provisioning"
	SetProvisionStatusCreated      = "created"
	SetProvisionStatusConfigured   = "configured"
	SetProvisionStatusManaged      = "managed"
	SetProvisionStatusError        = "error"
	SetProvisionStatusCancelled    = "cancelled"

	WorkerJobStatusIdle    = "idle"
	WorkerJobStatusRunning = "running"
	WorkerJobStatusQueued  = "queued"
	WorkerJobStatusSuccess = "success"
	WorkerJobStatusError   = "error"

	WorkerJobRefreshTenantObservations = "refresh_tenant_observations"
	WorkerJobRefreshSetCapacity        = "refresh_set_capacity"
	WorkerJobReconcileSetCapacity      = "reconcile_set_capacity"
	WorkerJobCheckChannelDrift         = "check_channel_drift"
	WorkerJobCheckSetAdmission         = "check_set_admission"
	WorkerJobCheckSetAdminHealth       = "check_set_admin_health"
	WorkerJobSyncPlans                 = "sync_plans"
	WorkerJobReconcileSetFacts         = "reconcile_set_facts"
	WorkerJobRetryBYOKSync             = "retry_byok_sync"
	WorkerJobReconcileGroupRatios      = "reconcile_group_ratios"
	WorkerJobCleanupPending            = "cleanup_pending"
	WorkerJobRefreshTenantStatistics   = "refresh_tenant_statistics"
	WorkerJobPublishAPIKeyRoutes       = "publish_api_key_routes"
	WorkerJobReconcileShardExpansions  = "reconcile_shard_expansions"
	WorkerJobReconcileReleaseCampaigns = "reconcile_release_campaigns"

	GroupRatioSourcePlatform = "platform"
	GroupRatioSourceBYOK     = "byok"

	GroupRatioApplyStatusPending  = "pending"
	GroupRatioApplyStatusApplying = "applying"
	GroupRatioApplyStatusSynced   = "synced"
	GroupRatioApplyStatusError    = "error"

	ChannelBundleReleaseStatusRunning = "running"
	ChannelBundleReleaseStatusSuccess = "success"
	ChannelBundleReleaseStatusPartial = "partial"
	ChannelBundleReleaseStatusError   = "error"
	ChannelBundleReleaseStatusSkipped = "skipped"

	ShardKindMySQL = "mysql"

	ShardStatusActive   = "active"
	ShardStatusDisabled = "disabled"

	ShardCapacityUnknown  = "unknown"
	ShardCapacityOK       = "ok"
	ShardCapacityWarn     = "warn"
	ShardCapacityCritical = "critical"

	TenantDeletionStatusMaterializing = "materializing"
	TenantDeletionStatusPreviewed     = "previewed"
	TenantDeletionStatusClaiming      = "claiming"
	TenantDeletionStatusQueued        = "queued"
	TenantDeletionStatusRunning       = "running"
	TenantDeletionStatusPaused        = "paused"
	TenantDeletionStatusPartial       = "partial"
	TenantDeletionStatusError         = "error"
	TenantDeletionStatusSucceeded     = "succeeded"

	TenantDeletionTargetStatusPending   = "pending"
	TenantDeletionTargetStatusRunning   = "running"
	TenantDeletionTargetStatusError     = "error"
	TenantDeletionTargetStatusSucceeded = "succeeded"
	TenantDeletionTargetStatusAbandoned = "abandoned"

	SetDecommissionStatusPurgingTenants    = "purging_tenants"
	SetDecommissionStatusPending           = "pending"
	SetDecommissionStatusRemovingRuntime   = "removing_runtime"
	SetDecommissionStatusCleaningRuntime   = "cleaning_runtime"
	SetDecommissionStatusFinalizing        = "finalizing"
	SetDecommissionStatusCleanupAckPending = "cleanup_ack_pending"
	SetDecommissionStatusError             = "error"
	SetDecommissionStatusCancelled         = "cancelled"
	SetDecommissionStatusSucceeded         = "succeeded"
)

const (
	SetAdminHealthHealthy   = "healthy"
	SetAdminHealthDegraded  = "degraded"
	SetAdminHealthUnhealthy = "unhealthy"
)

const (
	SetRuntimeHAPending  = "pending"
	SetRuntimeHAHealthy  = "healthy"
	SetRuntimeHADegraded = "degraded"
)

type Set struct {
	ID                             string    `json:"id"`
	Name                           string    `json:"name"`
	BaseURL                        string    `json:"base_url"`
	TrafficBaseURL                 string    `json:"traffic_base_url,omitempty"`
	Status                         string    `json:"status"`
	Setup                          bool      `json:"setup"`
	AdminUserID                    int       `json:"admin_user_id"`
	AdminUsername                  string    `json:"admin_username,omitempty"`
	AdminRole                      int       `json:"admin_role,omitempty"`
	AdminStatus                    int       `json:"admin_status,omitempty"`
	AdminGroup                     string    `json:"admin_group,omitempty"`
	AdminAccessToken               string    `json:"-"`
	AdminTOTPSecret                string    `json:"-"`
	MaxUsers                       int       `json:"max_users,omitempty"`
	WarnUsers                      int       `json:"warn_users,omitempty"`
	ReservedUsers                  int       `json:"reserved_users,omitempty"`
	ObservedUserCount              int       `json:"observed_user_count,omitempty"`
	CapacityUpdatedAt              time.Time `json:"capacity_updated_at,omitempty"`
	ShardID                        string    `json:"shard_id,omitempty"`
	NewAPIReplicas                 int       `json:"newapi_replicas,omitempty"`
	SQLMaxOpenConns                int       `json:"sql_max_open_conns,omitempty"`
	SQLMaxIdleConns                int       `json:"sql_max_idle_conns,omitempty"`
	SQLMaxLifetimeSeconds          int       `json:"sql_max_lifetime_seconds,omitempty"`
	TrafficSQLMaxOpenConns         int       `json:"traffic_sql_max_open_conns,omitempty"`
	TrafficSQLMaxIdleConns         int       `json:"traffic_sql_max_idle_conns,omitempty"`
	TrafficSQLMaxLifetimeSeconds   int       `json:"traffic_sql_max_lifetime_seconds,omitempty"`
	SubscriptionWriteConcurrency   int       `json:"subscription_write_concurrency,omitempty"`
	RuntimeHAStatus                string    `json:"runtime_ha_status,omitempty"`
	RuntimeHADesiredReplicas       int       `json:"runtime_ha_desired_replicas,omitempty"`
	RuntimeHAReadyReplicas         int       `json:"runtime_ha_ready_replicas,omitempty"`
	RuntimeHAPDBHealthy            bool      `json:"runtime_ha_pdb_healthy,omitempty"`
	RuntimeHATopologyKey           string    `json:"runtime_ha_topology_key,omitempty"`
	RuntimeHAError                 string    `json:"runtime_ha_error,omitempty"`
	RuntimeHACheckedAt             time.Time `json:"runtime_ha_checked_at,omitempty"`
	AdminHealthStatus              string    `json:"admin_health_status,omitempty"`
	AdminHealthConsecutiveFailures int       `json:"admin_health_consecutive_failures,omitempty"`
	AdminHealthError               string    `json:"admin_health_error,omitempty"`
	AdminHealthCheckedAt           time.Time `json:"admin_health_checked_at,omitempty"`
	AdminHealthLastSuccessAt       time.Time `json:"admin_health_last_success_at,omitempty"`
	AdminWritesPaused              bool      `json:"admin_writes_paused,omitempty"`
	AdminWritesPauseReason         string    `json:"admin_writes_pause_reason,omitempty"`
	AdminWritesPausedAt            time.Time `json:"admin_writes_paused_at,omitempty"`
	AdmissionStatus                string    `json:"admission_status,omitempty"`
	AdmissionError                 string    `json:"admission_error,omitempty"`
	AdmissionCheckedAt             time.Time `json:"admission_checked_at,omitempty"`
	LifecycleGeneration            int64     `json:"lifecycle_generation"`
	AdminImage                     string    `json:"admin_image,omitempty"`
	ReleaseRingID                  string    `json:"release_ring_id,omitempty"`
	CurrentReleaseID               string    `json:"current_release_id,omitempty"`
	TargetReleaseID                string    `json:"target_release_id,omitempty"`
	ActiveRuntimeGeneration        int64     `json:"active_runtime_generation"`
	RouteRevision                  int64     `json:"route_revision"`
	CreatedAt                      time.Time `json:"created_at"`
	UpdatedAt                      time.Time `json:"updated_at"`
}

const (
	SetRuntimeStatusPreparing = "preparing"
	SetRuntimeStatusReady     = "ready"
	SetRuntimeStatusActive    = "active"
	SetRuntimeStatusDraining  = "draining"
	SetRuntimeStatusRetired   = "retired"
	SetRuntimeStatusFailed    = "failed"

	SetUpgradeBatchStatusPending   = "pending"
	SetUpgradeBatchStatusRunning   = "running"
	SetUpgradeBatchStatusCompleted = "completed"
	SetUpgradeBatchStatusFailed    = "failed"
	SetUpgradeBatchStatusStopped   = "stopped"

	SetUpgradeRunStatusPending                = "pending"
	SetUpgradeRunStatusUpgradingMaster        = "upgrading_master"
	SetUpgradeRunStatusVerifyingCompatibility = "verifying_compatibility"
	SetUpgradeRunStatusPreparing              = "preparing"
	SetUpgradeRunStatusProbing                = "probing"
	SetUpgradeRunStatusSwitching              = "switching"
	SetUpgradeRunStatusDraining               = "draining"
	SetUpgradeRunStatusRollbackSwitching      = "rollback_switching"
	SetUpgradeRunStatusRollbackDraining       = "rollback_draining"
	SetUpgradeRunStatusCompleted              = "completed"
	SetUpgradeRunStatusFailed                 = "failed"
	SetUpgradeRunStatusRolledBack             = "rolled_back"

	SetRuntimeRouteOutboxStatusPending   = "pending"
	SetRuntimeRouteOutboxStatusPublished = "published"
)

type SetRuntime struct {
	SetID          string    `json:"set_id"`
	Generation     int64     `json:"generation"`
	ReleaseID      string    `json:"release_id,omitempty"`
	Image          string    `json:"image"`
	TrafficBaseURL string    `json:"traffic_base_url"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type SetUpgradeBatch struct {
	ID              string          `json:"id"`
	RolloutID       string          `json:"rollout_id,omitempty"`
	RingID          string          `json:"ring_id,omitempty"`
	TargetReleaseID string          `json:"target_release_id,omitempty"`
	TargetImage     string          `json:"target_image"`
	Status          string          `json:"status"`
	MaxParallel     int             `json:"max_parallel"`
	StopOnFailure   bool            `json:"stop_on_failure"`
	Runs            []SetUpgradeRun `json:"runs,omitempty"`
	CreatedAt       time.Time       `json:"created_at"`
	UpdatedAt       time.Time       `json:"updated_at"`
}

type SetUpgradeRun struct {
	ID                        string        `json:"id"`
	BatchID                   string        `json:"batch_id"`
	SetID                     string        `json:"set_id"`
	Source                    string        `json:"source"`
	Namespace                 string        `json:"namespace"`
	Fleet                     string        `json:"fleet"`
	TargetImage               string        `json:"target_image"`
	FromReleaseID             string        `json:"from_release_id,omitempty"`
	TargetReleaseID           string        `json:"target_release_id,omitempty"`
	Sequence                  int           `json:"sequence,omitempty"`
	FromGeneration            int64         `json:"from_generation"`
	ToGeneration              int64         `json:"to_generation"`
	Status                    string        `json:"status"`
	ConsecutiveProbeSuccesses int           `json:"consecutive_probe_successes"`
	ConsecutiveProbeFailures  int           `json:"consecutive_probe_failures"`
	DrainTimeout              time.Duration `json:"drain_timeout"`
	RollbackWindow            time.Duration `json:"rollback_window"`
	LeaseOwner                string        `json:"lease_owner,omitempty"`
	LeaseUntil                time.Time     `json:"lease_until,omitempty"`
	SwitchedAt                time.Time     `json:"switched_at,omitempty"`
	DrainDeadline             time.Time     `json:"drain_deadline,omitempty"`
	RollbackDeadline          time.Time     `json:"rollback_deadline,omitempty"`
	RollbackRequested         bool          `json:"rollback_requested,omitempty"`
	RollbackReason            string        `json:"rollback_reason,omitempty"`
	MasterUpgradedAt          time.Time     `json:"master_upgraded_at,omitempty"`
	CompatibilityCheckedAt    time.Time     `json:"compatibility_checked_at,omitempty"`
	LastError                 string        `json:"last_error,omitempty"`
	CreatedAt                 time.Time     `json:"created_at"`
	UpdatedAt                 time.Time     `json:"updated_at"`
}

const (
	NewAPIReleaseStatusDraft    = "draft"
	NewAPIReleaseStatusVerified = "verified"
	NewAPIReleaseStatusStable   = "stable"
	NewAPIReleaseStatusBlocked  = "blocked"

	ReleaseRingStatusSteady   = "steady"
	ReleaseRingStatusRolling  = "rolling"
	ReleaseRingStatusSoaking  = "soaking"
	ReleaseRingStatusPaused   = "paused"
	ReleaseRingStatusDegraded = "degraded"

	ReleaseRolloutStatusPending   = "pending"
	ReleaseRolloutStatusRunning   = "running"
	ReleaseRolloutStatusSoaking   = "soaking"
	ReleaseRolloutStatusPaused    = "paused"
	ReleaseRolloutStatusCompleted = "completed"
	ReleaseRolloutStatusFailed    = "failed"

	ReleaseCampaignStatusPending   = "pending"
	ReleaseCampaignStatusRunning   = "running"
	ReleaseCampaignStatusSoaking   = "soaking"
	ReleaseCampaignStatusPaused    = "paused"
	ReleaseCampaignStatusCompleted = "completed"

	ReleaseCampaignRingStatusPending   = "pending"
	ReleaseCampaignRingStatusRunning   = "running"
	ReleaseCampaignRingStatusSoaking   = "soaking"
	ReleaseCampaignRingStatusPaused    = "paused"
	ReleaseCampaignRingStatusCompleted = "completed"
)

type NewAPIRelease struct {
	ID            string    `json:"id"`
	Source        string    `json:"source"`
	Namespace     string    `json:"namespace"`
	Fleet         string    `json:"fleet"`
	Version       string    `json:"version"`
	Image         string    `json:"image"`
	Compatibility string    `json:"compatibility"`
	Status        string    `json:"status"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type ReleaseRing struct {
	ID                  string         `json:"id"`
	Source              string         `json:"source"`
	Namespace           string         `json:"namespace"`
	Fleet               string         `json:"fleet"`
	Name                string         `json:"name"`
	Ordinal             int            `json:"ordinal"`
	ServingReleaseID    string         `json:"serving_release_id"`
	TargetReleaseID     string         `json:"target_release_id,omitempty"`
	Status              string         `json:"status"`
	AdmissionEnabled    bool           `json:"admission_enabled"`
	MaxParallel         int            `json:"max_parallel"`
	SoakDuration        time.Duration  `json:"-"`
	SoakSeconds         int            `json:"soak_seconds"`
	SetCount            int            `json:"set_count"`
	ReleaseDistribution map[string]int `json:"release_distribution,omitempty"`
	CreatedAt           time.Time      `json:"created_at"`
	UpdatedAt           time.Time      `json:"updated_at"`
}

type ReleaseRollout struct {
	ID                string          `json:"id"`
	RingID            string          `json:"ring_id"`
	TargetReleaseID   string          `json:"target_release_id"`
	BatchID           string          `json:"batch_id"`
	Status            string          `json:"status"`
	TotalSets         int             `json:"total_sets"`
	CompletedSets     int             `json:"completed_sets"`
	FailedSets        int             `json:"failed_sets"`
	CurrentSetID      string          `json:"current_set_id,omitempty"`
	CampaignID        string          `json:"campaign_id,omitempty"`
	CampaignSequence  int             `json:"campaign_sequence,omitempty"`
	SoakStartedAt     time.Time       `json:"soak_started_at,omitempty"`
	SoakDeadline      time.Time       `json:"soak_deadline,omitempty"`
	LastGateCheckedAt time.Time       `json:"last_gate_checked_at,omitempty"`
	LastGateError     string          `json:"last_gate_error,omitempty"`
	Batch             SetUpgradeBatch `json:"batch,omitempty"`
	CreatedAt         time.Time       `json:"created_at"`
	UpdatedAt         time.Time       `json:"updated_at"`
}

type ReleaseCampaign struct {
	ID               string                `json:"id"`
	Source           string                `json:"source"`
	Namespace        string                `json:"namespace"`
	Fleet            string                `json:"fleet"`
	TargetReleaseID  string                `json:"target_release_id"`
	Status           string                `json:"status"`
	CurrentRingID    string                `json:"current_ring_id,omitempty"`
	CurrentRolloutID string                `json:"current_rollout_id,omitempty"`
	TotalRings       int                   `json:"total_rings"`
	CompletedRings   int                   `json:"completed_rings"`
	LastError        string                `json:"last_error,omitempty"`
	Rings            []ReleaseCampaignRing `json:"rings,omitempty"`
	CreatedAt        time.Time             `json:"created_at"`
	UpdatedAt        time.Time             `json:"updated_at"`
}

type ReleaseCampaignRing struct {
	CampaignID string    `json:"campaign_id"`
	Sequence   int       `json:"sequence"`
	RingID     string    `json:"ring_id"`
	Status     string    `json:"status"`
	RolloutID  string    `json:"rollout_id,omitempty"`
	LastError  string    `json:"last_error,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type CreateReleaseCampaignInput struct {
	TargetReleaseID string `json:"target_release_id"`
}

type CreateNewAPIReleaseInput struct {
	ID            string `json:"id"`
	Source        string `json:"source,omitempty"`
	Namespace     string `json:"namespace,omitempty"`
	Fleet         string `json:"fleet,omitempty"`
	Version       string `json:"version"`
	Image         string `json:"image"`
	Compatibility string `json:"compatibility,omitempty"`
	Status        string `json:"status,omitempty"`
}

type UpsertReleaseRingInput struct {
	ID               string        `json:"id"`
	Source           string        `json:"source,omitempty"`
	Namespace        string        `json:"namespace,omitempty"`
	Fleet            string        `json:"fleet,omitempty"`
	Name             string        `json:"name"`
	Ordinal          int           `json:"ordinal"`
	ServingReleaseID string        `json:"serving_release_id"`
	AdmissionEnabled bool          `json:"admission_enabled"`
	MaxParallel      int           `json:"max_parallel,omitempty"`
	SoakDuration     time.Duration `json:"-"`
	SetIDs           []string      `json:"set_ids,omitempty"`
}

type CreateReleaseRolloutInput struct {
	RingID           string        `json:"ring_id"`
	TargetReleaseID  string        `json:"target_release_id"`
	DrainTimeout     time.Duration `json:"-"`
	RollbackWindow   time.Duration `json:"-"`
	CampaignID       string        `json:"-"`
	CampaignSequence int           `json:"-"`
}

type SetRuntimeRouteOutbox struct {
	ID            string                  `json:"id"`
	SetID         string                  `json:"set_id"`
	RouteRevision int64                   `json:"route_revision"`
	Snapshot      SetRuntimeRouteSnapshot `json:"snapshot"`
	Status        string                  `json:"status"`
	Attempts      int                     `json:"attempts"`
	LastError     string                  `json:"last_error,omitempty"`
	CreatedAt     time.Time               `json:"created_at"`
	UpdatedAt     time.Time               `json:"updated_at"`
}

type SetUpgradeProbeCredential struct {
	SetID       string `json:"set_id"`
	UpstreamKey string `json:"upstream_key"`
}

type CreateSetUpgradeBatchInput struct {
	SetIDs          []string      `json:"set_ids"`
	TargetImage     string        `json:"target_image"`
	Source          string        `json:"source,omitempty"`
	Namespace       string        `json:"namespace,omitempty"`
	Fleet           string        `json:"fleet,omitempty"`
	MaxParallel     int           `json:"max_parallel,omitempty"`
	StopOnFailure   bool          `json:"stop_on_failure"`
	DrainTimeout    time.Duration `json:"-"`
	RollbackWindow  time.Duration `json:"-"`
	RolloutID       string        `json:"-"`
	RingID          string        `json:"-"`
	TargetReleaseID string        `json:"-"`
}

type RegisterSetInput struct {
	ID                           string `json:"id"`
	Name                         string `json:"name"`
	BaseURL                      string `json:"base_url"`
	TrafficBaseURL               string `json:"traffic_base_url,omitempty"`
	Status                       string `json:"status"`
	MaxUsers                     *int   `json:"max_users,omitempty"`
	WarnUsers                    *int   `json:"warn_users,omitempty"`
	ReservedUsers                *int   `json:"reserved_users,omitempty"`
	ShardID                      string `json:"shard_id,omitempty"`
	NewAPIReplicas               *int   `json:"newapi_replicas,omitempty"`
	SQLMaxOpenConns              *int   `json:"sql_max_open_conns,omitempty"`
	SQLMaxIdleConns              *int   `json:"sql_max_idle_conns,omitempty"`
	SQLMaxLifetimeSeconds        *int   `json:"sql_max_lifetime_seconds,omitempty"`
	TrafficSQLMaxOpenConns       *int   `json:"traffic_sql_max_open_conns,omitempty"`
	TrafficSQLMaxIdleConns       *int   `json:"traffic_sql_max_idle_conns,omitempty"`
	TrafficSQLMaxLifetimeSeconds *int   `json:"traffic_sql_max_lifetime_seconds,omitempty"`
	SubscriptionWriteConcurrency *int   `json:"subscription_write_concurrency,omitempty"`
}

const (
	SetOperationSubscriptionWrite = "subscription_write"
	SetOperationGroupRatioWrite   = "group_ratio_write"
	SetOperationBYOKSync          = "byok_sync"
	SetOperationTenantObservation = "tenant_observation"
)

type SetOperationLease struct {
	SetID               string    `json:"set_id"`
	Operation           string    `json:"operation"`
	Slot                int       `json:"slot"`
	Owner               string    `json:"owner"`
	LifecycleGeneration int64     `json:"lifecycle_generation"`
	LeaseUntil          time.Time `json:"lease_until"`
	UpdatedAt           time.Time `json:"updated_at"`
}

type TenantDeletionPreviewInput struct {
	UserIDs      []string `json:"user_ids,omitempty"`
	UserIDPrefix string   `json:"user_id_prefix,omitempty"`
	SetID        string   `json:"set_id,omitempty"`
}

type TenantDeletionStartInput struct {
	ExpectedTargetCount  int    `json:"expected_target_count"`
	ExpectedTargetDigest string `json:"expected_target_digest"`
	IdempotencyKey       string `json:"idempotency_key"`
}

type TenantDeletionJob struct {
	ID                    string    `json:"id"`
	Status                string    `json:"status"`
	SelectorType          string    `json:"selector_type"`
	SelectorValue         string    `json:"selector_value,omitempty"`
	UserIDs               []string  `json:"user_ids,omitempty"`
	SnapshotAt            time.Time `json:"snapshot_at"`
	MaterializationCursor string    `json:"materialization_cursor,omitempty"`
	TargetCount           int       `json:"target_count"`
	TargetDigest          string    `json:"target_digest"`
	ClaimedCount          int       `json:"claimed_count,omitempty"`
	SuccessCount          int       `json:"success_count,omitempty"`
	FailureCount          int       `json:"failure_count,omitempty"`
	LastError             string    `json:"last_error,omitempty"`
	Version               int64     `json:"version"`
	IdempotencyKey        string    `json:"idempotency_key,omitempty"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
}

type TenantDeletionTarget struct {
	JobID          string    `json:"job_id"`
	ExternalUserID string    `json:"external_user_id"`
	SetID          string    `json:"set_id,omitempty"`
	Status         string    `json:"status"`
	Attempts       int       `json:"attempts,omitempty"`
	LeaseOwner     string    `json:"lease_owner,omitempty"`
	LeaseUntil     time.Time `json:"lease_until,omitempty"`
	LastError      string    `json:"last_error,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type TenantDeletionTargetListOptions struct {
	Status string
	Limit  int
}

type TenantDeletionJobListOptions struct {
	Status string
	Limit  int
}

type SetDecommissionBlockers struct {
	Tenants               int `json:"tenants"`
	UserBindings          int `json:"user_bindings"`
	APIKeys               int `json:"api_keys"`
	Assignments           int `json:"assignments"`
	BYOKSettings          int `json:"byok_settings"`
	BYOKTasks             int `json:"byok_tasks"`
	Observations          int `json:"observations"`
	ObservationTasks      int `json:"observation_tasks"`
	SubscriptionOverlays  int `json:"subscription_overlays"`
	AdminCommands         int `json:"admin_commands"`
	GroupRatioIntents     int `json:"group_ratio_intents"`
	DeletionTargets       int `json:"deletion_targets"`
	ActiveOperationLeases int `json:"active_operation_leases"`
	RuntimeLeases         int `json:"runtime_leases"`
}

func (b SetDecommissionBlockers) Total() int {
	return b.Tenants + b.UserBindings + b.APIKeys + b.Assignments + b.BYOKSettings +
		b.BYOKTasks + b.Observations + b.ObservationTasks + b.SubscriptionOverlays +
		b.AdminCommands + b.GroupRatioIntents + b.DeletionTargets + b.ActiveOperationLeases
}

type SetDecommissionPreview struct {
	SetID    string                  `json:"set_id"`
	Empty    bool                    `json:"empty"`
	Digest   string                  `json:"digest"`
	Blockers SetDecommissionBlockers `json:"blockers"`
}

type SetDecommissionStartInput struct {
	SetID          string `json:"set_id"`
	ExpectedDigest string `json:"expected_digest"`
	IdempotencyKey string `json:"idempotency_key"`
	CascadeTenants bool   `json:"cascade_tenants,omitempty"`
	AllowOrphan    bool   `json:"allow_orphan,omitempty"`
}

type SetDecommissionJob struct {
	ID                  string    `json:"id"`
	SetID               string    `json:"set_id"`
	Status              string    `json:"status"`
	PreviousSetStatus   string    `json:"previous_set_status,omitempty"`
	LifecycleGeneration int64     `json:"lifecycle_generation"`
	ExpectedDigest      string    `json:"expected_digest"`
	IdempotencyKey      string    `json:"idempotency_key"`
	CascadeTenants      bool      `json:"cascade_tenants,omitempty"`
	AllowOrphan         bool      `json:"allow_orphan,omitempty"`
	Attempt             int       `json:"attempt"`
	ClaimOwner          string    `json:"claim_owner,omitempty"`
	ClaimToken          string    `json:"-"`
	ClaimLeaseUntil     time.Time `json:"claim_lease_until,omitempty"`
	LeaseFingerprint    string    `json:"lease_fingerprint,omitempty"`
	CapabilityHash      string    `json:"-"`
	JobUID              string    `json:"job_uid,omitempty"`
	Version             int64     `json:"version"`
	LastError           string    `json:"last_error,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

type SetRuntimeCleanupPayload struct {
	CleanupID         string `json:"cleanup_id"`
	SetID             string `json:"set_id"`
	Attempt           int    `json:"attempt"`
	Source            string `json:"source"`
	Namespace         string `json:"namespace"`
	Fleet             string `json:"fleet"`
	ShardRef          string `json:"shard_ref"`
	DatabaseName      string `json:"database_name"`
	RedisDB           string `json:"redis_db"`
	LeaseFingerprint  string `json:"lease_fingerprint"`
	ClaimToken        string `json:"claim_token"`
	CleanupCapability string `json:"cleanup_capability,omitempty"`
}

type RuntimeCleanupAuthorizationInput struct {
	SetRuntimeCleanupPayload
	CleanupCapability string `json:"cleanup_capability"`
	RedisDBStart      int    `json:"redis_db_start"`
	RedisDBLimit      int    `json:"redis_db_limit"`
}

type RuntimeCleanupAuthorization struct {
	Authorized bool      `json:"authorized"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type SetDecommissionClaimInput struct {
	JobID          string
	Owner          string
	ClaimToken     string
	CapabilityHash string
	LeaseTTL       time.Duration
}

type SetDecommissionCancelInput struct {
	JobID           string `json:"-"`
	ExpectedVersion int64  `json:"expected_version"`
	IdempotencyKey  string `json:"idempotency_key"`
}

type SetDecommissionRetryInput struct {
	JobID           string `json:"-"`
	ExpectedVersion int64  `json:"expected_version"`
	IdempotencyKey  string `json:"idempotency_key"`
}

type SetDecommissionFailInput struct {
	JobID            string `json:"-"`
	Attempt          int    `json:"attempt"`
	ClaimToken       string `json:"claim_token"`
	LeaseFingerprint string `json:"lease_fingerprint"`
	JobUID           string `json:"job_uid"`
	LastError        string `json:"last_error"`
}

type SetDecommissionFinalizeInput struct {
	JobID            string `json:"-"`
	Attempt          int    `json:"attempt"`
	ClaimToken       string `json:"claim_token"`
	LeaseFingerprint string `json:"lease_fingerprint"`
	JobUID           string `json:"job_uid"`
}

type SetDecommissionJobListOptions struct {
	Status      string
	NonTerminal bool
	RuntimeOnly bool
	Limit       int
}

type Shard struct {
	ID                           string    `json:"id"`
	Name                         string    `json:"name"`
	Kind                         string    `json:"kind"`
	Endpoint                     string    `json:"endpoint,omitempty"`
	RedisEndpoint                string    `json:"redis_endpoint,omitempty"`
	SecretName                   string    `json:"secret_name,omitempty"`
	RedisDBStart                 int       `json:"redis_db_start,omitempty"`
	RedisDBLimit                 int       `json:"redis_db_limit,omitempty"`
	Status                       string    `json:"status"`
	MaxConnections               int       `json:"max_connections,omitempty"`
	ReservedConnections          int       `json:"reserved_connections,omitempty"`
	WarnRatio                    float64   `json:"warn_ratio,omitempty"`
	CriticalRatio                float64   `json:"critical_ratio,omitempty"`
	MaxSets                      int       `json:"max_sets,omitempty"`
	AdminSQLMaxOpenConns         int       `json:"admin_sql_max_open_conns,omitempty"`
	AdminSQLMaxIdleConns         int       `json:"admin_sql_max_idle_conns,omitempty"`
	AdminSQLMaxLifetimeSeconds   int       `json:"admin_sql_max_lifetime_seconds,omitempty"`
	TrafficSQLMaxOpenConns       int       `json:"traffic_sql_max_open_conns,omitempty"`
	TrafficSQLMaxIdleConns       int       `json:"traffic_sql_max_idle_conns,omitempty"`
	TrafficSQLMaxLifetimeSeconds int       `json:"traffic_sql_max_lifetime_seconds,omitempty"`
	SubscriptionWriteConcurrency int       `json:"subscription_write_concurrency,omitempty"`
	CreatedAt                    time.Time `json:"created_at"`
	UpdatedAt                    time.Time `json:"updated_at"`
}

type UpsertShardInput struct {
	ID                           string   `json:"id"`
	Name                         string   `json:"name"`
	Kind                         string   `json:"kind"`
	Endpoint                     string   `json:"endpoint,omitempty"`
	RedisEndpoint                string   `json:"redis_endpoint,omitempty"`
	SecretName                   string   `json:"secret_name,omitempty"`
	RedisDBStart                 *int     `json:"redis_db_start,omitempty"`
	RedisDBLimit                 *int     `json:"redis_db_limit,omitempty"`
	Status                       string   `json:"status"`
	MaxConnections               *int     `json:"max_connections,omitempty"`
	ReservedConnections          *int     `json:"reserved_connections,omitempty"`
	WarnRatio                    *float64 `json:"warn_ratio,omitempty"`
	CriticalRatio                *float64 `json:"critical_ratio,omitempty"`
	MaxSets                      *int     `json:"max_sets,omitempty"`
	AdminSQLMaxOpenConns         *int     `json:"admin_sql_max_open_conns,omitempty"`
	AdminSQLMaxIdleConns         *int     `json:"admin_sql_max_idle_conns,omitempty"`
	AdminSQLMaxLifetimeSeconds   *int     `json:"admin_sql_max_lifetime_seconds,omitempty"`
	TrafficSQLMaxOpenConns       *int     `json:"traffic_sql_max_open_conns,omitempty"`
	TrafficSQLMaxIdleConns       *int     `json:"traffic_sql_max_idle_conns,omitempty"`
	TrafficSQLMaxLifetimeSeconds *int     `json:"traffic_sql_max_lifetime_seconds,omitempty"`
	SubscriptionWriteConcurrency *int     `json:"subscription_write_concurrency,omitempty"`
}

type ShardSetBudget struct {
	SetID              string `json:"set_id"`
	Name               string `json:"name"`
	Status             string `json:"status"`
	Setup              bool   `json:"setup"`
	NewAPIReplicas     int    `json:"newapi_replicas"`
	SQLMaxOpenConns    int    `json:"sql_max_open_conns"`
	SQLMaxIdleConns    int    `json:"sql_max_idle_conns"`
	LogicalConnections int    `json:"logical_connections"`
	DatabaseName       string `json:"database_name,omitempty"`
	RedisDB            string `json:"redis_db,omitempty"`
}

type ShardDetail struct {
	Shard                  Shard            `json:"shard"`
	AllocatableConnections int              `json:"allocatable_connections"`
	LogicalConnections     int              `json:"logical_connections"`
	RemainingConnections   int              `json:"remaining_connections"`
	Utilization            float64          `json:"utilization"`
	CapacityStatus         string           `json:"capacity_status"`
	RedisDBAllocated       int              `json:"redis_db_allocated"`
	RedisDBAvailable       int              `json:"redis_db_available"`
	RedisDBUtilization     float64          `json:"redis_db_utilization"`
	Sets                   []ShardSetBudget `json:"sets"`
}

type SetReconcileFact struct {
	Source                       string    `json:"source"`
	Namespace                    string    `json:"namespace"`
	Fleet                        string    `json:"fleet"`
	SetID                        string    `json:"set_id"`
	Name                         string    `json:"name"`
	BaseURL                      string    `json:"base_url"`
	TrafficBaseURL               string    `json:"traffic_base_url,omitempty"`
	RuntimeGeneration            int64     `json:"runtime_generation,omitempty"`
	RuntimeImage                 string    `json:"runtime_image,omitempty"`
	ShardRef                     string    `json:"shard_ref,omitempty"`
	DatabaseName                 string    `json:"database_name,omitempty"`
	RedisDB                      string    `json:"redis_db,omitempty"`
	SQLMaxOpenConns              int       `json:"sql_max_open_conns,omitempty"`
	SQLMaxIdleConns              int       `json:"sql_max_idle_conns,omitempty"`
	SQLMaxLifetimeSeconds        int       `json:"sql_max_lifetime_seconds,omitempty"`
	TrafficSQLMaxOpenConns       int       `json:"traffic_sql_max_open_conns,omitempty"`
	TrafficSQLMaxIdleConns       int       `json:"traffic_sql_max_idle_conns,omitempty"`
	TrafficSQLMaxLifetimeSeconds int       `json:"traffic_sql_max_lifetime_seconds,omitempty"`
	SubscriptionWriteConcurrency int       `json:"subscription_write_concurrency,omitempty"`
	RuntimeHAStatus              string    `json:"runtime_ha_status,omitempty"`
	RuntimeHADesiredReplicas     int       `json:"runtime_ha_desired_replicas,omitempty"`
	RuntimeHAReadyReplicas       int       `json:"runtime_ha_ready_replicas,omitempty"`
	RuntimeHAPDBHealthy          bool      `json:"runtime_ha_pdb_healthy,omitempty"`
	RuntimeHATopologyKey         string    `json:"runtime_ha_topology_key,omitempty"`
	RuntimeHAError               string    `json:"runtime_ha_error,omitempty"`
	RuntimeHACheckedAt           time.Time `json:"runtime_ha_checked_at,omitempty"`
	DesiredHash                  string    `json:"desired_hash"`
	Status                       string    `json:"status"`
	LastError                    string    `json:"last_error,omitempty"`
	LastObservedAt               time.Time `json:"last_observed_at"`
	LastReconciledAt             time.Time `json:"last_reconciled_at,omitempty"`
	CreatedAt                    time.Time `json:"created_at"`
	UpdatedAt                    time.Time `json:"updated_at"`
}

type SetReconcileFactInput struct {
	SetID                        string    `json:"set_id"`
	Name                         string    `json:"name"`
	BaseURL                      string    `json:"base_url"`
	TrafficBaseURL               string    `json:"traffic_base_url,omitempty"`
	RuntimeGeneration            int64     `json:"runtime_generation,omitempty"`
	RuntimeImage                 string    `json:"runtime_image,omitempty"`
	ShardRef                     string    `json:"shard_ref,omitempty"`
	DatabaseName                 string    `json:"database_name,omitempty"`
	RedisDB                      string    `json:"redis_db,omitempty"`
	SQLMaxOpenConns              int       `json:"sql_max_open_conns,omitempty"`
	SQLMaxIdleConns              int       `json:"sql_max_idle_conns,omitempty"`
	SQLMaxLifetimeSeconds        int       `json:"sql_max_lifetime_seconds,omitempty"`
	TrafficSQLMaxOpenConns       int       `json:"traffic_sql_max_open_conns,omitempty"`
	TrafficSQLMaxIdleConns       int       `json:"traffic_sql_max_idle_conns,omitempty"`
	TrafficSQLMaxLifetimeSeconds int       `json:"traffic_sql_max_lifetime_seconds,omitempty"`
	SubscriptionWriteConcurrency int       `json:"subscription_write_concurrency,omitempty"`
	RuntimeHAStatus              string    `json:"runtime_ha_status,omitempty"`
	RuntimeHADesiredReplicas     int       `json:"runtime_ha_desired_replicas,omitempty"`
	RuntimeHAReadyReplicas       int       `json:"runtime_ha_ready_replicas,omitempty"`
	RuntimeHAPDBHealthy          bool      `json:"runtime_ha_pdb_healthy,omitempty"`
	RuntimeHATopologyKey         string    `json:"runtime_ha_topology_key,omitempty"`
	RuntimeHAError               string    `json:"runtime_ha_error,omitempty"`
	RuntimeHACheckedAt           time.Time `json:"runtime_ha_checked_at,omitempty"`
}

type RecordSetReconcileFactsInput struct {
	Source    string                  `json:"source"`
	Namespace string                  `json:"namespace"`
	Fleet     string                  `json:"fleet"`
	Sets      []SetReconcileFactInput `json:"sets"`
}

type RecordSetReconcileFactsResult struct {
	Recorded int                `json:"recorded"`
	Facts    []SetReconcileFact `json:"facts"`
}

type SetReconcileFactListOptions struct {
	Source    string
	Namespace string
	Fleet     string
	Status    string
	Limit     int
}

type ReconcileSetReconcileFactsInput struct {
	Source    string `json:"source,omitempty"`
	Namespace string `json:"namespace,omitempty"`
	Fleet     string `json:"fleet,omitempty"`
	Limit     int    `json:"limit,omitempty"`
}

type ReconcileSetReconcileFactsResult struct {
	Scanned int                `json:"scanned"`
	Managed int                `json:"managed"`
	Failed  int                `json:"failed"`
	Facts   []SetReconcileFact `json:"facts"`
}

type SetProvisionRequest struct {
	ID             string    `json:"id"`
	Source         string    `json:"source"`
	Namespace      string    `json:"namespace"`
	Fleet          string    `json:"fleet"`
	SetID          string    `json:"set_id"`
	ShardRef       string    `json:"shard_ref"`
	DatabaseName   string    `json:"database_name"`
	RedisDB        string    `json:"redis_db"`
	ReleaseRingID  string    `json:"release_ring_id,omitempty"`
	ReleaseID      string    `json:"release_id,omitempty"`
	ReleaseImage   string    `json:"release_image,omitempty"`
	Status         string    `json:"status"`
	Reason         string    `json:"reason,omitempty"`
	LastError      string    `json:"last_error,omitempty"`
	RequestedUsers int       `json:"requested_users"`
	MaxUsersPerSet int       `json:"max_users_per_set"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	LastStatusAt   time.Time `json:"last_status_at,omitempty"`
}

type SetRuntimeLease struct {
	Source       string    `json:"source"`
	Namespace    string    `json:"namespace"`
	Fleet        string    `json:"fleet"`
	SetID        string    `json:"set_id"`
	ShardRef     string    `json:"shard_ref"`
	DatabaseName string    `json:"database_name"`
	RedisDB      string    `json:"redis_db"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type SetRuntimeLeaseListOptions struct {
	Source    string
	Namespace string
	Fleet     string
}

type SetProvisionRequestListOptions struct {
	Source    string
	Namespace string
	Fleet     string
	SetID     string
	Status    string
	Limit     int
}

type SetCapacityPolicy struct {
	Source             string   `json:"source,omitempty"`
	Namespace          string   `json:"namespace"`
	Fleet              string   `json:"fleet"`
	ShardRefs          []string `json:"shard_refs,omitempty"`
	MaxUsersPerSet     int      `json:"max_users_per_set,omitempty"`
	TargetUtilization  float64  `json:"target_utilization,omitempty"`
	MinReadyFreeUsers  int      `json:"min_ready_free_users,omitempty"`
	MinWarmSets        int      `json:"min_warm_sets,omitempty"`
	MaxScaleUpPerCycle int      `json:"max_scale_up_per_cycle,omitempty"`
	SetIDPrefix        string   `json:"set_id_prefix,omitempty"`
	RedisDBStart       *int     `json:"redis_db_start,omitempty"`
	RedisDBLimit       *int     `json:"redis_db_limit,omitempty"`
}

type SetCapacitySetSnapshot struct {
	SetID             string `json:"set_id"`
	Status            string `json:"status"`
	Ready             bool   `json:"ready"`
	AcceptingNewUsers bool   `json:"accepting_new_users"`
	CapacityStatus    string `json:"capacity_status"`
	UserCount         int    `json:"user_count"`
	FreeUsers         int    `json:"free_users"`
	MaxUsers          int    `json:"max_users"`
	WarnUsers         int    `json:"warn_users,omitempty"`
	ReservedUsers     int    `json:"reserved_users,omitempty"`
	Utilization       string `json:"utilization"`
}

type SetCapacityResult struct {
	Policy            SetCapacityPolicy        `json:"policy"`
	ReadySets         int                      `json:"ready_sets"`
	ReadyFreeUsers    int                      `json:"ready_free_users"`
	RequiredFreeUsers int                      `json:"required_free_users"`
	InflightRequests  int                      `json:"inflight_requests"`
	InflightFreeUsers int                      `json:"inflight_free_users"`
	DeficitUsers      int                      `json:"deficit_users"`
	CreatedRequests   int                      `json:"created_requests"`
	Sets              []SetCapacitySetSnapshot `json:"sets"`
	Requests          []SetProvisionRequest    `json:"requests"`
}

type ChannelSpec struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	Type               int       `json:"type"`
	Key                string    `json:"-"`
	KeyHash            string    `json:"key_hash,omitempty"`
	BaseURL            string    `json:"base_url"`
	Models             string    `json:"models"`
	Group              string    `json:"group"`
	ModelMapping       string    `json:"model_mapping,omitempty"`
	Priority           int64     `json:"priority,omitempty"`
	Weight             uint      `json:"weight,omitempty"`
	Status             string    `json:"status"`
	Setting            string    `json:"setting,omitempty"`
	ParamOverride      string    `json:"param_override,omitempty"`
	HeaderOverride     string    `json:"header_override,omitempty"`
	Remark             string    `json:"remark,omitempty"`
	AutoBan            *int      `json:"auto_ban,omitempty"`
	Tag                string    `json:"tag,omitempty"`
	Other              string    `json:"other,omitempty"`
	StatusCodeMapping  string    `json:"status_code_mapping,omitempty"`
	OtherSettings      string    `json:"settings,omitempty"`
	OpenAIOrganization string    `json:"openai_organization,omitempty"`
	TestModel          string    `json:"test_model,omitempty"`
	IsMultiKey         bool      `json:"is_multi_key,omitempty"`
	MultiKeyMode       string    `json:"multi_key_mode,omitempty"`
	Fingerprint        string    `json:"fingerprint,omitempty"`
	DesiredRemoteName  string    `json:"desired_remote_name,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type ChannelSyncState struct {
	ChannelID          string    `json:"channel_id"`
	SetID              string    `json:"set_id"`
	RemoteChannelID    int       `json:"remote_channel_id,omitempty"`
	Status             string    `json:"status"`
	LastError          string    `json:"last_error,omitempty"`
	DesiredFingerprint string    `json:"desired_fingerprint,omitempty"`
	AppliedFingerprint string    `json:"applied_fingerprint,omitempty"`
	RemoteFingerprint  string    `json:"remote_fingerprint,omitempty"`
	LastAppliedKeyHash string    `json:"last_applied_key_hash,omitempty"`
	LastSyncedAt       time.Time `json:"last_synced_at,omitempty"`
	LastCheckedAt      time.Time `json:"last_checked_at,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type ChannelSyncOptions struct {
	ForceDrift bool `json:"force_drift,omitempty"`
	CheckOnly  bool `json:"check_only,omitempty"`
}

type ChannelSyncSummary struct {
	Spec   ChannelSpec        `json:"spec"`
	States []ChannelSyncState `json:"states"`
}

type ChannelModelFetchInput struct {
	Type    int    `json:"type"`
	BaseURL string `json:"base_url"`
	Key     string `json:"key"`
}

type ChannelBundle struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description,omitempty"`
	SourceSetID string            `json:"source_set_id,omitempty"`
	Spec        ChannelBundleSpec `json:"spec"`
	Fingerprint string            `json:"fingerprint,omitempty"`
	CreatedAt   time.Time         `json:"created_at"`
	UpdatedAt   time.Time         `json:"updated_at"`
}

type ChannelBundleRevision struct {
	RevisionID  string            `json:"revision_id"`
	BundleID    string            `json:"bundle_id"`
	Version     int               `json:"version"`
	Name        string            `json:"name"`
	Description string            `json:"description,omitempty"`
	SourceSetID string            `json:"source_set_id,omitempty"`
	Spec        ChannelBundleSpec `json:"spec"`
	Fingerprint string            `json:"fingerprint"`
	CreatedAt   time.Time         `json:"created_at"`
}

type ChannelBundleSpec struct {
	Version  int                    `json:"version"`
	Kind     string                 `json:"kind"`
	Options  []ChannelBundleOption  `json:"options,omitempty"`
	Channels []ChannelBundleChannel `json:"channels"`
}

type ChannelBundleOption struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
}

type ChannelBundleChannel struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Type               int    `json:"type"`
	Key                string `json:"-"`
	KeyHash            string `json:"key_hash,omitempty"`
	BaseURL            string `json:"base_url"`
	Models             string `json:"models"`
	Group              string `json:"group"`
	ModelMapping       string `json:"model_mapping,omitempty"`
	Priority           int64  `json:"priority,omitempty"`
	Weight             uint   `json:"weight,omitempty"`
	Status             string `json:"status"`
	Setting            string `json:"setting,omitempty"`
	ParamOverride      string `json:"param_override,omitempty"`
	HeaderOverride     string `json:"header_override,omitempty"`
	Remark             string `json:"remark,omitempty"`
	AutoBan            *int   `json:"auto_ban,omitempty"`
	Tag                string `json:"tag,omitempty"`
	Other              string `json:"other,omitempty"`
	StatusCodeMapping  string `json:"status_code_mapping,omitempty"`
	OtherSettings      string `json:"settings,omitempty"`
	OpenAIOrganization string `json:"openai_organization,omitempty"`
	TestModel          string `json:"test_model,omitempty"`
	IsMultiKey         bool   `json:"is_multi_key,omitempty"`
	MultiKeyMode       string `json:"multi_key_mode,omitempty"`
}

type ChannelBundleSyncState struct {
	BundleID            string    `json:"bundle_id"`
	SetID               string    `json:"set_id"`
	Status              string    `json:"status"`
	LastError           string    `json:"last_error,omitempty"`
	DesiredFingerprint  string    `json:"desired_fingerprint,omitempty"`
	ActualFingerprint   string    `json:"actual_fingerprint,omitempty"`
	AppliedFingerprint  string    `json:"applied_fingerprint,omitempty"`
	DiffJSON            string    `json:"diff_json,omitempty"`
	RemoteResourcesJSON string    `json:"remote_resources_json,omitempty"`
	LastSyncedAt        time.Time `json:"last_synced_at,omitempty"`
	LastCheckedAt       time.Time `json:"last_checked_at,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

const (
	ChannelDeliveryStatusEmpty     = "empty"
	ChannelDeliveryStatusSynced    = "synced"
	ChannelDeliveryStatusPending   = "pending"
	ChannelDeliveryStatusDrift     = "drift"
	ChannelDeliveryStatusError     = "error"
	ChannelDeliveryStatusUnchecked = "unchecked"
	ChannelDeliveryStatusStale     = "stale"
)

type ChannelBundleDeliveryCounts struct {
	Synced    int `json:"synced"`
	Pending   int `json:"pending"`
	Drift     int `json:"drift"`
	Error     int `json:"error"`
	Unchecked int `json:"unchecked"`
	Stale     int `json:"stale"`
}

type ChannelBundleDeliverySetStatus struct {
	SetID         string     `json:"set_id"`
	SetName       string     `json:"set_name"`
	Status        string     `json:"status"`
	LastCheckedAt *time.Time `json:"last_checked_at"`
	LastError     string     `json:"last_error,omitempty"`
	DiffJSON      string     `json:"diff_json,omitempty"`
}

type ChannelBundleDeliveryStatus struct {
	BundleID          string                           `json:"bundle_id"`
	Status            string                           `json:"status"`
	EligibleSets      int                              `json:"eligible_sets"`
	CheckedSets       int                              `json:"checked_sets"`
	CoverageCheckedAt *time.Time                       `json:"coverage_checked_at"`
	StaleAfterSeconds *int                             `json:"stale_after_seconds"`
	HasStaleResults   bool                             `json:"has_stale_results"`
	Counts            ChannelBundleDeliveryCounts      `json:"counts"`
	Sets              []ChannelBundleDeliverySetStatus `json:"sets"`
}

type ChannelBundlePlanOptions struct {
	ForceDrift bool `json:"force_drift,omitempty"`
}

type ChannelBundleReleaseInput struct {
	BundleID       string   `json:"bundle_id,omitempty"`
	RevisionID     string   `json:"revision_id,omitempty"`
	SetIDs         []string `json:"set_ids,omitempty"`
	ForceDrift     bool     `json:"force_drift,omitempty"`
	StopOnFailure  bool     `json:"stop_on_failure"`
	TriggeredBy    string   `json:"triggered_by,omitempty"`
	IdempotencyKey string   `json:"idempotency_key,omitempty"`
}

type ChannelBundleReleaseRun struct {
	ID            string                     `json:"id"`
	BundleID      string                     `json:"bundle_id"`
	RevisionID    string                     `json:"revision_id,omitempty"`
	Fingerprint   string                     `json:"fingerprint,omitempty"`
	Status        string                     `json:"status"`
	ForceDrift    bool                       `json:"force_drift,omitempty"`
	StopOnFailure bool                       `json:"stop_on_failure"`
	TriggeredBy   string                     `json:"triggered_by,omitempty"`
	LastError     string                     `json:"last_error,omitempty"`
	Items         []ChannelBundleReleaseItem `json:"items"`
	CreatedAt     time.Time                  `json:"created_at"`
	StartedAt     time.Time                  `json:"started_at,omitempty"`
	FinishedAt    time.Time                  `json:"finished_at,omitempty"`
}

type ChannelBundleReleaseItem struct {
	RunID      string    `json:"run_id"`
	BundleID   string    `json:"bundle_id"`
	SetID      string    `json:"set_id"`
	Status     string    `json:"status"`
	LastError  string    `json:"last_error,omitempty"`
	StartedAt  time.Time `json:"started_at,omitempty"`
	FinishedAt time.Time `json:"finished_at,omitempty"`
}

type ChannelBundleLock struct {
	BundleID   string    `json:"bundle_id"`
	Owner      string    `json:"owner"`
	Purpose    string    `json:"purpose"`
	LeaseUntil time.Time `json:"lease_until"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type ImportChannelBundleInput struct {
	SourceSetID     string `json:"source_set_id"`
	ID              string `json:"id"`
	Name            string `json:"name"`
	Description     string `json:"description,omitempty"`
	IncludeDisabled bool   `json:"include_disabled,omitempty"`
}

const (
	DesiredConfigAPIVersion = "llmgateway.io/v1alpha1"
	DesiredConfigKind       = "DesiredConfig"
)

// DesiredConfig is the portable, secret-bearing disaster recovery format.
// Unlike normal API responses, channel keys are intentionally serialized.
type DesiredConfig struct {
	APIVersion     string                       `json:"api_version"`
	Kind           string                       `json:"kind"`
	ExportedAt     time.Time                    `json:"exported_at"`
	SourceSetID    string                       `json:"source_set_id,omitempty"`
	GlobalOptions  []ChannelBundleOption        `json:"global_options,omitempty"`
	ChannelBundles []DesiredConfigChannelBundle `json:"channel_bundles"`
}

type DesiredConfigChannelBundle struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	Channels    []DesiredConfigChannel `json:"channels"`
}

type DesiredConfigChannel struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Type               int    `json:"type"`
	Key                string `json:"key"`
	KeyHash            string `json:"key_hash,omitempty"`
	BaseURL            string `json:"base_url"`
	Models             string `json:"models"`
	Group              string `json:"group"`
	ModelMapping       string `json:"model_mapping,omitempty"`
	Priority           int64  `json:"priority,omitempty"`
	Weight             uint   `json:"weight,omitempty"`
	Status             string `json:"status"`
	Setting            string `json:"setting,omitempty"`
	ParamOverride      string `json:"param_override,omitempty"`
	HeaderOverride     string `json:"header_override,omitempty"`
	Remark             string `json:"remark,omitempty"`
	AutoBan            *int   `json:"auto_ban,omitempty"`
	Tag                string `json:"tag,omitempty"`
	Other              string `json:"other,omitempty"`
	StatusCodeMapping  string `json:"status_code_mapping,omitempty"`
	OtherSettings      string `json:"settings,omitempty"`
	OpenAIOrganization string `json:"openai_organization,omitempty"`
	TestModel          string `json:"test_model,omitempty"`
	IsMultiKey         bool   `json:"is_multi_key,omitempty"`
	MultiKeyMode       string `json:"multi_key_mode,omitempty"`
}

type ChannelBundleApplyOptions struct {
	ForceDrift bool `json:"force_drift,omitempty"`
}

type ChannelBundlePlan struct {
	BundleID           string                 `json:"bundle_id"`
	SetID              string                 `json:"set_id"`
	Status             string                 `json:"status"`
	LastError          string                 `json:"last_error,omitempty"`
	DesiredFingerprint string                 `json:"desired_fingerprint,omitempty"`
	ActualFingerprint  string                 `json:"actual_fingerprint,omitempty"`
	Desired            ChannelBundleSpec      `json:"desired"`
	Actual             ChannelBundleSpec      `json:"actual"`
	Steps              []ChannelBundleStep    `json:"steps"`
	Diff               ChannelBundleDiff      `json:"diff"`
	State              ChannelBundleSyncState `json:"state"`
}

type ChannelBundleStep struct {
	Kind          string `json:"kind"`
	ResourceID    string `json:"resource_id"`
	RemoteID      int    `json:"remote_id,omitempty"`
	Action        string `json:"action"`
	RequiresForce bool   `json:"requires_force,omitempty"`
	Reason        string `json:"reason,omitempty"`
}

type ChannelBundleDiff struct {
	Added   []ChannelBundleResourceDiff `json:"added,omitempty"`
	Changed []ChannelBundleResourceDiff `json:"changed,omitempty"`
	Extra   []ChannelBundleResourceDiff `json:"extra,omitempty"`
	Synced  []ChannelBundleResourceDiff `json:"synced,omitempty"`
}

type ChannelBundleResourceDiff struct {
	ID         string `json:"id,omitempty"`
	Name       string `json:"name,omitempty"`
	RemoteID   int    `json:"remote_id,omitempty"`
	RemoteName string `json:"remote_name,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

type Tenant struct {
	ExternalUserID string    `json:"user_id"`
	Backend        string    `json:"backend"`
	SetID          string    `json:"set_id,omitempty"`
	Status         string    `json:"status"`
	Source         string    `json:"source,omitempty"`
	DisplayName    string    `json:"display_name,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type UserBinding struct {
	ExternalUserID        string    `json:"external_user_id"`
	SetID                 string    `json:"set_id"`
	UpstreamUserID        int       `json:"upstream_user_id"`
	Username              string    `json:"username"`
	Password              string    `json:"-"`
	LastPlanID            string    `json:"last_plan_id,omitempty"`
	LastExtendedPeriodEnd time.Time `json:"last_extended_period_end,omitempty"`
	ProvisionStatus       string    `json:"provision_status"`
	LastProvisionError    string    `json:"last_provision_error,omitempty"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
}

type APIKeyBinding struct {
	ExternalKey     string    `json:"-"`
	ExternalKeyHash string    `json:"-"`
	ExternalKeyID   string    `json:"external_key_id"`
	SecretHash      string    `json:"-"`
	KeyVersion      uint8     `json:"key_version"`
	RouteSlot       uint32    `json:"route_slot"`
	Purpose         string    `json:"purpose,omitempty"`
	SetID           string    `json:"set_id"`
	UserID          string    `json:"user_id"`
	UpstreamKey     string    `json:"-"`
	UpstreamKeyID   int       `json:"upstream_key_id"`
	Status          string    `json:"status"`
	LastError       string    `json:"last_error,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type UserLLMSettings struct {
	ExternalUserID    string            `json:"user_id"`
	Routing           UserLLMRouting    `json:"routing"`
	Providers         []UserLLMProvider `json:"providers"`
	BYOKGroup         string            `json:"byok_group,omitempty"`
	BYOKUpstreamKey   string            `json:"-"`
	BYOKUpstreamKeyID int               `json:"byok_upstream_key_id,omitempty"`
	LastSyncedAt      time.Time         `json:"last_synced_at,omitempty"`
	LastSyncError     string            `json:"last_sync_error,omitempty"`
	CreatedAt         time.Time         `json:"created_at"`
	UpdatedAt         time.Time         `json:"updated_at"`
}

type UserLLMRouting struct {
	Mode string `json:"mode"`
}

type UserLLMProvider struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Protocol        string            `json:"protocol"`
	BaseURL         string            `json:"base_url"`
	APIKey          string            `json:"api_key,omitempty"`
	KeyHash         string            `json:"key_hash,omitempty"`
	ModelMappings   map[string]string `json:"model_mappings"`
	Enabled         bool              `json:"enabled"`
	RemoteChannelID int               `json:"remote_channel_id,omitempty"`
	SyncStatus      string            `json:"sync_status,omitempty"`
	LastSyncError   string            `json:"last_sync_error,omitempty"`
}

type UserLLMSettingsSyncResult struct {
	UserID            string            `json:"user_id"`
	SetID             string            `json:"set_id"`
	BYOKGroup         string            `json:"byok_group"`
	BYOKUpstreamKeyID int               `json:"byok_upstream_key_id,omitempty"`
	Providers         []UserLLMProvider `json:"providers"`
	Status            string            `json:"status,omitempty"`
	RequestedVersion  int64             `json:"requested_version,omitempty"`
	LastSyncedAt      time.Time         `json:"last_synced_at"`
}

type BYOKSyncTask struct {
	ExternalUserID    string    `json:"user_id"`
	SetID             string    `json:"set_id"`
	Status            string    `json:"status"`
	RequestedVersion  int64     `json:"requested_version"`
	ProcessingVersion int64     `json:"processing_version,omitempty"`
	AppliedVersion    int64     `json:"applied_version,omitempty"`
	Attempts          int       `json:"attempts"`
	LeaseOwner        string    `json:"lease_owner,omitempty"`
	LeaseUntil        time.Time `json:"lease_until,omitempty"`
	NextRunAt         time.Time `json:"next_run_at,omitempty"`
	LastStartedAt     time.Time `json:"last_started_at,omitempty"`
	LastFinishedAt    time.Time `json:"last_finished_at,omitempty"`
	LastError         string    `json:"last_error,omitempty"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type BYOKSyncTaskListOptions struct {
	Status        string
	ExcludeSetIDs []string
	Now           time.Time
	Limit         int
}

type GroupRatioDesired struct {
	SetID          string    `json:"set_id"`
	GroupName      string    `json:"group_name"`
	Ratio          float64   `json:"ratio"`
	SourceType     string    `json:"source_type"`
	SourceID       string    `json:"source_id"`
	ExternalUserID string    `json:"external_user_id,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type GroupRatioApplyState struct {
	SetID              string    `json:"set_id"`
	DesiredVersion     int64     `json:"desired_version"`
	AppliedVersion     int64     `json:"applied_version"`
	DesiredFingerprint string    `json:"desired_fingerprint,omitempty"`
	AppliedFingerprint string    `json:"applied_fingerprint,omitempty"`
	Status             string    `json:"status"`
	LastError          string    `json:"last_error,omitempty"`
	LastAppliedAt      time.Time `json:"last_applied_at,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type GroupRatioSnapshot struct {
	State   GroupRatioApplyState `json:"state"`
	Entries []GroupRatioDesired  `json:"entries"`
}

type GroupRatioApplyCompletion struct {
	SetID       string
	Version     int64
	Fingerprint string
	Error       string
	AppliedAt   time.Time
}

type GroupRatioApplyStateListOptions struct {
	Statuses   []string
	AfterSetID string
	Limit      int
}

type BYOKSyncIntent struct {
	Settings  UserLLMSettings
	Task      BYOKSyncTask
	GroupName string
	Enabled   bool
}

type PlanMapping struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	MonthlyTokens   int64          `json:"monthly_tokens"`
	PeriodValue     int            `json:"period_value"`
	PeriodUnit      string         `json:"period_unit"`
	IsActive        bool           `json:"is_active"`
	SetID           string         `json:"set_id,omitempty"`
	UpstreamPlanID  int            `json:"upstream_plan_id,omitempty"`
	UpstreamPlanIDs map[string]int `json:"upstream_plan_ids,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

const (
	SetPlanStatusPending = "pending"
	SetPlanStatusSyncing = "syncing"
	SetPlanStatusReady   = "ready"
	SetPlanStatusError   = "error"
)

// Plan 是平台侧不可变的周期权益模板。模型路由、倍率和限流由 new-api 管理。
type Plan struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	MonthlyTokens int64     `json:"monthly_tokens"`
	PeriodValue   int       `json:"period_value"`
	PeriodUnit    string    `json:"period_unit"`
	IsActive      bool      `json:"is_active"`
	Fingerprint   string    `json:"fingerprint"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// SetPlan 记录权益模板在单个 Set 中对应的 new-api subscription plan。
type SetPlan struct {
	PlanID         string    `json:"plan_id"`
	SetID          string    `json:"set_id"`
	UpstreamPlanID int       `json:"upstream_plan_id,omitempty"`
	Status         string    `json:"status"`
	Attempts       int       `json:"attempts"`
	LastError      string    `json:"last_error,omitempty"`
	SyncedAt       time.Time `json:"synced_at,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// PlanPeriod 是业务 Plan 允许使用的非默认周期。默认周期仍由 Plan 自身承载。
type PlanPeriod struct {
	PlanID      string    `json:"plan_id"`
	PeriodValue int       `json:"period_value"`
	PeriodUnit  string    `json:"period_unit"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// SetPlanPeriod 记录周期变体在单个 Set 中对应的 new-api subscription plan。
type SetPlanPeriod struct {
	PlanID         string    `json:"plan_id"`
	PeriodValue    int       `json:"period_value"`
	PeriodUnit     string    `json:"period_unit"`
	SetID          string    `json:"set_id"`
	UpstreamPlanID int       `json:"upstream_plan_id,omitempty"`
	Status         string    `json:"status"`
	Attempts       int       `json:"attempts"`
	LastError      string    `json:"last_error,omitempty"`
	SyncedAt       time.Time `json:"synced_at,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type SetPlanPeriodListOptions struct {
	PlanID   string
	SetID    string
	Statuses []string
	Limit    int
}

type SetPlanListOptions struct {
	PlanID   string
	SetID    string
	Statuses []string
	Limit    int
}

type ApplySubscriptionRequest struct {
	IdempotencyKey string     `json:"idempotency_key"`
	UserID         string     `json:"user_id"`
	PlanID         string     `json:"plan_id"`
	Nickname       string     `json:"nickname,omitempty"`
	Phone          string     `json:"phone,omitempty"`
	PeriodStart    *time.Time `json:"period_start,omitempty"`
	PeriodValue    int        `json:"period_value,omitempty"`
	PeriodUnit     string     `json:"period_unit,omitempty"`
}

const (
	AdminCommandKindApplySubscription  = "apply_subscription"
	AdminCommandKindCancelSubscription = "cancel_subscription"
	AdminCommandKindExtendSubscription = "extend_subscription"
	AdminCommandKindCreateExternalKey  = "create_external_key"

	AdminCommandStatusPending   = "pending"
	AdminCommandStatusRunning   = "running"
	AdminCommandStatusSucceeded = "succeeded"
	AdminCommandStatusError     = "error"
	AdminCommandStatusUnknown   = "unknown"
)

// AdminCommand 是 admin master 暂停期间的类型化写入意图。Payload 和 Result
// 只允许由对应 kind 的处理器解释，不能作为任意 HTTP 请求重放。
type AdminCommand struct {
	ID             string    `json:"id"`
	DedupeKey      string    `json:"dedupe_key,omitempty"`
	SetID          string    `json:"set_id"`
	ExternalUserID string    `json:"user_id,omitempty"`
	Kind           string    `json:"kind"`
	Payload        string    `json:"-"`
	Status         string    `json:"status"`
	Attempts       int       `json:"attempts"`
	LeaseOwner     string    `json:"lease_owner,omitempty"`
	LeaseUntil     time.Time `json:"lease_until,omitempty"`
	NextRunAt      time.Time `json:"next_run_at,omitempty"`
	Result         string    `json:"result,omitempty"`
	LastError      string    `json:"last_error,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type AdminCommandListOptions struct {
	Statuses []string
	Now      time.Time
	Limit    int
}

type CancelSubscriptionRequest struct {
	UserID string `json:"user_id"`
}

type ExtendSubscriptionRequest struct {
	UserID       string    `json:"user_id"`
	NewPeriodEnd time.Time `json:"new_period_end"`
}

type ExtendSubscriptionResponse struct {
	Subscription *Subscription `json:"subscription"`
	Updated      bool          `json:"updated"`
}

type Subscription struct {
	ID           string `json:"id"`
	UserID       string `json:"user_id"`
	PlanID       string `json:"plan_id"`
	Status       string `json:"status"`
	TokenBalance int64  `json:"token_balance"`
	Unlimited    bool   `json:"unlimited,omitempty"`
	PeriodStart  string `json:"period_start"`
	PeriodEnd    string `json:"period_end"`
}

type UserCredit struct {
	UserID          string `json:"user_id"`
	Backend         string `json:"backend"`
	SetID           string `json:"set_id,omitempty"`
	PlanID          string `json:"plan_id,omitempty"`
	TokenBalance    int64  `json:"token_balance"`
	CreditAvailable int64  `json:"credit_available"`
	Unlimited       bool   `json:"unlimited,omitempty"`
	PeriodStart     string `json:"period_start,omitempty"`
	PeriodEnd       string `json:"period_end,omitempty"`
	Source          string `json:"source"`
}

type UserState struct {
	UserID                string `json:"user_id"`
	Backend               string `json:"backend"`
	SetID                 string `json:"set_id,omitempty"`
	UpstreamUserID        int    `json:"upstream_user_id,omitempty"`
	Username              string `json:"username,omitempty"`
	CurrentPlanID         string `json:"current_plan_id,omitempty"`
	LastAppliedPlanID     string `json:"last_applied_plan_id,omitempty"`
	SubscriptionStatus    string `json:"subscription_status,omitempty"`
	HasActiveSubscription bool   `json:"has_active_subscription"`
	TokenBalance          int64  `json:"token_balance"`
	CreditAvailable       int64  `json:"credit_available"`
	CreditStatus          string `json:"credit_status"`
	CreditError           string `json:"credit_error,omitempty"`
	Unlimited             bool   `json:"unlimited,omitempty"`
	PeriodStart           string `json:"period_start,omitempty"`
	PeriodEnd             string `json:"period_end,omitempty"`
	Source                string `json:"source"`
}

type TenantObservation struct {
	ExternalUserID        string    `json:"user_id"`
	Backend               string    `json:"backend"`
	SetID                 string    `json:"set_id,omitempty"`
	UpstreamUserID        int       `json:"upstream_user_id,omitempty"`
	Username              string    `json:"username,omitempty"`
	CurrentPlanID         string    `json:"current_plan_id,omitempty"`
	LastAppliedPlanID     string    `json:"last_applied_plan_id,omitempty"`
	SubscriptionStatus    string    `json:"subscription_status,omitempty"`
	HasActiveSubscription bool      `json:"has_active_subscription"`
	TokenBalance          int64     `json:"token_balance"`
	CreditAvailable       int64     `json:"credit_available"`
	CreditStatus          string    `json:"credit_status"`
	CreditError           string    `json:"credit_error,omitempty"`
	Unlimited             bool      `json:"unlimited,omitempty"`
	PeriodStart           string    `json:"period_start,omitempty"`
	PeriodEnd             string    `json:"period_end,omitempty"`
	Source                string    `json:"source"`
	ObservedAt            time.Time `json:"observed_at"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
}

type TenantObservationTask struct {
	ExternalUserID    string    `json:"user_id"`
	SetID             string    `json:"set_id,omitempty"`
	Status            string    `json:"status"`
	Priority          int       `json:"priority"`
	RequestedVersion  int64     `json:"requested_version"`
	ProcessingVersion int64     `json:"processing_version,omitempty"`
	AppliedVersion    int64     `json:"applied_version,omitempty"`
	Attempts          int       `json:"attempts"`
	LeaseOwner        string    `json:"lease_owner,omitempty"`
	LeaseUntil        time.Time `json:"lease_until,omitempty"`
	NextRunAt         time.Time `json:"next_run_at,omitempty"`
	LastStartedAt     time.Time `json:"last_started_at,omitempty"`
	LastFinishedAt    time.Time `json:"last_finished_at,omitempty"`
	LastError         string    `json:"last_error,omitempty"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type TenantObservationTaskListOptions struct {
	ExcludeSetIDs []string
	Now           time.Time
	Limit         int
}

type TenantObservationTaskCompletion struct {
	Succeeded bool
	Blocked   bool
	Message   string
	NextRunAt time.Time
}

type TenantObservationQueueStats struct {
	Pending              int       `json:"pending"`
	Due                  int       `json:"due"`
	Running              int       `json:"running"`
	Error                int       `json:"error"`
	Blocked              int       `json:"blocked"`
	ExpiredRunningLeases int       `json:"expired_running_leases"`
	OldestDueAt          time.Time `json:"oldest_due_at,omitempty"`
	OldestDueAgeSeconds  int64     `json:"oldest_due_age_seconds"`
	LastSuccessAt        time.Time `json:"last_success_at,omitempty"`
	LastFailureAt        time.Time `json:"last_failure_at,omitempty"`
	LastCalculatedAt     time.Time `json:"last_calculated_at"`
}

type TenantListOptions struct {
	Keyword      string `json:"keyword,omitempty"`
	Backend      string `json:"backend,omitempty"`
	SetID        string `json:"set_id,omitempty"`
	Status       string `json:"status,omitempty"`
	Cursor       string `json:"cursor,omitempty"`
	Limit        int    `json:"limit,omitempty"`
	Offset       int    `json:"offset,omitempty"`
	IncludeTotal bool   `json:"include_total,omitempty"`
}

type TenantListResult struct {
	Items      []TenantSummary `json:"items"`
	Total      *int            `json:"total"`
	Limit      int             `json:"limit"`
	Offset     int             `json:"offset"`
	NextCursor string          `json:"next_cursor,omitempty"`
	HasMore    bool            `json:"has_more"`
}

type TenantStatistics struct {
	Total         int64     `json:"total"`
	NewTotal      int64     `json:"new_total"`
	PendingTotal  int64     `json:"pending_total"`
	ActiveTotal   int64     `json:"active_total"`
	DisabledTotal int64     `json:"disabled_total"`
	DeletedTotal  int64     `json:"deleted_total"`
	GeneratedAt   time.Time `json:"generated_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type TenantStatisticsSnapshot struct {
	Ready         bool       `json:"ready"`
	Total         *int64     `json:"total"`
	NewTotal      *int64     `json:"new_total"`
	PendingTotal  *int64     `json:"pending_total"`
	ActiveTotal   *int64     `json:"active_total"`
	DisabledTotal *int64     `json:"disabled_total"`
	DeletedTotal  *int64     `json:"deleted_total"`
	GeneratedAt   *time.Time `json:"generated_at"`
	Stale         bool       `json:"stale"`
}

type TenantSummary struct {
	UserID                     string    `json:"user_id"`
	Backend                    string    `json:"backend"`
	SetID                      string    `json:"set_id,omitempty"`
	Status                     string    `json:"status"`
	Source                     string    `json:"source,omitempty"`
	DisplayName                string    `json:"display_name,omitempty"`
	UpstreamUserID             int       `json:"upstream_user_id,omitempty"`
	Username                   string    `json:"username,omitempty"`
	LastPlanID                 string    `json:"last_plan_id,omitempty"`
	ProvisionStatus            string    `json:"provision_status,omitempty"`
	LastProvisionError         string    `json:"last_provision_error,omitempty"`
	KeyCount                   int       `json:"key_count"`
	ObservedPlanID             string    `json:"observed_plan_id,omitempty"`
	ObservedCreditAvailable    int64     `json:"observed_credit_available,omitempty"`
	ObservedCreditStatus       string    `json:"observed_credit_status,omitempty"`
	ObservedSubscriptionStatus string    `json:"observed_subscription_status,omitempty"`
	ObservedAt                 time.Time `json:"observed_at,omitempty"`
	AssignmentStatus           string    `json:"assignment_status"`
	MigratedAt                 time.Time `json:"migrated_at,omitempty"`
	CreatedAt                  time.Time `json:"created_at"`
	UpdatedAt                  time.Time `json:"updated_at"`
}

type APIKeySummary struct {
	ExternalKeyID string    `json:"external_key_id"`
	SetID         string    `json:"set_id"`
	UserID        string    `json:"user_id"`
	UpstreamKeyID int       `json:"upstream_key_id"`
	KeyHashPrefix string    `json:"key_hash_prefix"`
	CreatedAt     time.Time `json:"created_at"`
}

type TenantDetail struct {
	Tenant       TenantSummary      `json:"tenant"`
	Assignment   *UserAssignment    `json:"assignment,omitempty"`
	Binding      *UserBinding       `json:"binding,omitempty"`
	Keys         []APIKeySummary    `json:"keys"`
	LLMSettings  *UserLLMSettings   `json:"llm_settings,omitempty"`
	Observation  *TenantObservation `json:"observation,omitempty"`
	RecentErrors []OperatorError    `json:"recent_errors,omitempty"`
}

type OperatorError struct {
	Kind      string    `json:"kind"`
	Message   string    `json:"message"`
	At        time.Time `json:"at,omitempty"`
	Reference string    `json:"reference,omitempty"`
}

type OperationalOverview struct {
	GeneratedAt    time.Time                 `json:"generated_at"`
	Totals         OperationalOverviewTotals `json:"totals"`
	Sets           []SetOverview             `json:"sets"`
	ChannelBundles []ChannelBundleOverview   `json:"channel_bundles"`
	Alerts         []OperationalAlert        `json:"alerts"`
	TrafficErrors  []TrafficErrorSummary     `json:"traffic_errors,omitempty"`
}

type OperationalOverviewTotals struct {
	Sets                  int `json:"sets"`
	ActiveSets            int `json:"active_sets"`
	ReadySets             int `json:"ready_sets"`
	Users                 int `json:"users"`
	AvailableUserSlots    int `json:"available_user_slots,omitempty"`
	FullSets              int `json:"full_sets,omitempty"`
	ChannelDrifts         int `json:"channel_drifts"`
	RuntimeHADegradedSets int `json:"runtime_ha_degraded_sets,omitempty"`
}

type BackgroundJobsOverview struct {
	GeneratedAt  time.Time                   `json:"generated_at"`
	Jobs         []WorkerJob                 `json:"jobs"`
	BYOKSync     BYOKSyncQueueStats          `json:"byok_sync"`
	Observations TenantObservationQueueStats `json:"observations"`
}

type SetOverview struct {
	ID                       string    `json:"id"`
	Name                     string    `json:"name"`
	Status                   string    `json:"status"`
	Setup                    bool      `json:"setup"`
	Ready                    bool      `json:"ready"`
	UserCount                int       `json:"user_count"`
	MaxUsers                 int       `json:"max_users,omitempty"`
	WarnUsers                int       `json:"warn_users,omitempty"`
	ReservedUsers            int       `json:"reserved_users,omitempty"`
	FreeUsers                int       `json:"free_users,omitempty"`
	AcceptingNewUsers        bool      `json:"accepting_new_users"`
	CapacityStatus           string    `json:"capacity_status,omitempty"`
	CapacityUpdatedAt        time.Time `json:"capacity_updated_at,omitempty"`
	AdmissionStatus          string    `json:"admission_status,omitempty"`
	AdmissionError           string    `json:"admission_error,omitempty"`
	AdmissionCheckedAt       time.Time `json:"admission_checked_at,omitempty"`
	AdminHealthStatus        string    `json:"admin_health_status,omitempty"`
	AdminHealthError         string    `json:"admin_health_error,omitempty"`
	AdminHealthCheckedAt     time.Time `json:"admin_health_checked_at,omitempty"`
	RuntimeHAStatus          string    `json:"runtime_ha_status,omitempty"`
	RuntimeHADesiredReplicas int       `json:"runtime_ha_desired_replicas,omitempty"`
	RuntimeHAReadyReplicas   int       `json:"runtime_ha_ready_replicas,omitempty"`
	RuntimeHAPDBHealthy      bool      `json:"runtime_ha_pdb_healthy,omitempty"`
	RuntimeHATopologyKey     string    `json:"runtime_ha_topology_key,omitempty"`
	RuntimeHAError           string    `json:"runtime_ha_error,omitempty"`
	RuntimeHACheckedAt       time.Time `json:"runtime_ha_checked_at,omitempty"`
	LastError                string    `json:"last_error,omitempty"`
	LastErrorAt              time.Time `json:"last_error_at,omitempty"`
	LastReconciledAt         time.Time `json:"last_reconciled_at,omitempty"`
	LastProvisionStatus      string    `json:"last_provision_status,omitempty"`
	UpdatedAt                time.Time `json:"updated_at,omitempty"`
}

type ChannelBundleOverview struct {
	BundleID      string    `json:"bundle_id"`
	Name          string    `json:"name"`
	Fingerprint   string    `json:"fingerprint,omitempty"`
	SyncedSets    int       `json:"synced_sets"`
	PendingSets   int       `json:"pending_sets"`
	DriftSets     int       `json:"drift_sets"`
	ErrorSets     int       `json:"error_sets"`
	SkippedSets   int       `json:"skipped_sets"`
	LastCheckedAt time.Time `json:"last_checked_at,omitempty"`
	LastError     string    `json:"last_error,omitempty"`
}

type OperationalAlert struct {
	Kind      string    `json:"kind"`
	Severity  string    `json:"severity"`
	Message   string    `json:"message"`
	SetID     string    `json:"set_id,omitempty"`
	BundleID  string    `json:"bundle_id,omitempty"`
	JobName   string    `json:"job_name,omitempty"`
	CreatedAt time.Time `json:"created_at,omitempty"`
}

type TrafficErrorSummary struct {
	SetID          string `json:"set_id,omitempty"`
	Status         int    `json:"status"`
	UpstreamStatus int    `json:"upstream_status"`
	ErrorType      string `json:"error_type"`
	Count          int64  `json:"count"`
}

type BYOKSyncQueueStats struct {
	Pending                 int       `json:"pending"`
	Running                 int       `json:"running"`
	Error                   int       `json:"error"`
	Succeeded               int       `json:"succeeded"`
	TotalOpen               int       `json:"total_open"`
	ExpiredRunningLeases    int       `json:"expired_running_leases,omitempty"`
	OldestPendingAt         time.Time `json:"oldest_pending_at,omitempty"`
	OldestPendingAgeSeconds int64     `json:"oldest_pending_age_seconds,omitempty"`
	OldestErrorAt           time.Time `json:"oldest_error_at,omitempty"`
	OldestErrorAgeSeconds   int64     `json:"oldest_error_age_seconds,omitempty"`
	LastSuccessAt           time.Time `json:"last_success_at,omitempty"`
	LastFailureAt           time.Time `json:"last_failure_at,omitempty"`
	LastCalculatedAt        time.Time `json:"last_calculated_at,omitempty"`
}

type WorkerJob struct {
	Name            string    `json:"name"`
	Kind            string    `json:"kind,omitempty"`
	Enabled         bool      `json:"enabled"`
	IntervalSeconds int       `json:"interval_seconds,omitempty"`
	Status          string    `json:"status"`
	LeaseOwner      string    `json:"lease_owner,omitempty"`
	LeaseUntil      time.Time `json:"lease_until,omitempty"`
	LastStartedAt   time.Time `json:"last_started_at,omitempty"`
	LastFinishedAt  time.Time `json:"last_finished_at,omitempty"`
	LastSuccessAt   time.Time `json:"last_success_at,omitempty"`
	NextRunAt       time.Time `json:"next_run_at,omitempty"`
	Cursor          string    `json:"cursor,omitempty"`
	LastError       string    `json:"last_error,omitempty"`
	FailureCount    int       `json:"failure_count,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type WorkerJobRun struct {
	ID         string    `json:"id"`
	JobName    string    `json:"job_name"`
	Owner      string    `json:"owner,omitempty"`
	Status     string    `json:"status"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at,omitempty"`
	Error      string    `json:"error,omitempty"`
	Detail     string    `json:"detail,omitempty"`
}

type WorkerJobListOptions struct {
	EnabledOnly bool
}

type WorkerJobRunListOptions struct {
	JobName          string
	StartedAtOrAfter time.Time
	Limit            int
}

type SubscriptionPeriodOverlay struct {
	ExternalUserID string    `json:"external_user_id"`
	SetID          string    `json:"set_id"`
	PeriodEnd      time.Time `json:"period_end"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

const (
	SubscriptionIdempotencyProcessing = iota
	SubscriptionIdempotencySucceeded
	SubscriptionIdempotencyFailed
	SubscriptionIdempotencyUnknown
)

type SubscriptionIdempotency struct {
	IdempotencyKey string
	RequestHash    string
	Status         int
	LastError      string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type UserAssignment struct {
	ExternalUserID string    `json:"user_id"`
	Backend        string    `json:"backend"`
	SetID          string    `json:"set_id,omitempty"`
	MigratedAt     time.Time `json:"migrated_at,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type MigrationRequest struct {
	UserID   string `json:"user_id"`
	SetID    string `json:"set_id"`
	PlanID   string `json:"plan_id"`
	IssueKey bool   `json:"issue_key,omitempty"`
	DryRun   bool   `json:"dry_run,omitempty"`
}

type MigrationResult struct {
	UserID          string         `json:"user_id"`
	Backend         string         `json:"backend"`
	SetID           string         `json:"set_id"`
	PlanID          string         `json:"plan_id"`
	UpstreamPlanID  int            `json:"upstream_plan_id"`
	UpstreamUserID  int            `json:"upstream_user_id,omitempty"`
	DryRun          bool           `json:"dry_run"`
	Migrated        bool           `json:"migrated"`
	AlreadyMigrated bool           `json:"already_migrated,omitempty"`
	APIKey          string         `json:"api_key,omitempty"`
	KeyID           string         `json:"key_id,omitempty"`
	KeyPrefix       string         `json:"key_prefix,omitempty"`
	Assignment      UserAssignment `json:"assignment,omitempty"`
}

type Options struct {
	RootUsername                string
	RootPassword                string
	AccessLogger                func(AccessLog)
	TelemetryEmitter            TelemetryEventEmitter
	TelemetrySanitizer          *observability.Sanitizer
	TelemetryCorrelator         *observability.Correlator
	KeyRouteCache               APIKeyRouteCache
	ExternalKeyRandom           io.Reader
	TrafficRouteCacheOnly       bool
	SetRuntimeRouteRequired     bool
	TrafficTransportManager     *TransportManager
	NewAPIClientTimeout         time.Duration
	WorkerSetCapacityEnabled    bool
	WorkerSetCapacityPolicy     SetCapacityPolicy
	WorkerBYOKSyncBatchSize     int
	WorkerObservationSeedBatch  int
	WorkerChannelDriftBatch     int
	WorkerChannelDriftTimeout   time.Duration
	WorkerSetAdminHealthBatch   int
	WorkerSetAdminHealthTimeout time.Duration
}

type TrafficRouteLookup struct {
	ExternalKeyHash string
	ExternalKeyID   string
	SecretHash      string
	Version         uint8
	RouteSlot       uint32
	Valid           bool
}

type TrafficRouteSnapshot struct {
	ExternalKeyHash string    `json:"external_key_hash,omitempty"`
	ExternalKeyID   string    `json:"external_key_id"`
	SecretHash      string    `json:"secret_hash,omitempty"`
	KeyVersion      uint8     `json:"key_version"`
	RouteSlot       uint32    `json:"route_slot"`
	SetID           string    `json:"set_id"`
	SetBaseURL      string    `json:"set_base_url"`
	UserID          string    `json:"user_id,omitempty"`
	UpstreamKey     string    `json:"upstream_key"`
	UpstreamKeyID   int       `json:"upstream_key_id,omitempty"`
	PlatformKey     string    `json:"platform_key,omitempty"`
	PlatformKeyID   int       `json:"platform_key_id,omitempty"`
	RouteMode       string    `json:"route_mode,omitempty"`
	Enabled         bool      `json:"enabled"`
	CreatedAt       time.Time `json:"created_at,omitempty"`
	UpdatedAt       time.Time `json:"updated_at,omitempty"`
}

type SetRuntimeRouteSnapshot struct {
	SetID             string    `json:"set_id"`
	RuntimeGeneration int64     `json:"runtime_generation"`
	RouteRevision     int64     `json:"route_revision"`
	TrafficBaseURL    string    `json:"traffic_base_url"`
	Enabled           bool      `json:"enabled"`
	SwitchedAt        time.Time `json:"switched_at,omitempty"`
}

type AccessLog struct {
	Time                  string `json:"time"`
	Event                 string `json:"event"`
	Method                string `json:"method"`
	Path                  string `json:"path"`
	ExternalKeyID         string `json:"external_key_id"`
	ExternalKeyHashPrefix string `json:"external_key_hash_prefix"`
	SetID                 string `json:"set_id"`
	Status                int    `json:"status"`
	UpstreamStatus        int    `json:"upstream_status"`
	DurationMS            int64  `json:"duration_ms"`
	Streaming             bool   `json:"streaming"`
	ErrorType             string `json:"error_type"`
}
