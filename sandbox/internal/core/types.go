package core

import (
	"errors"
	"time"
)

// InstanceState represents lifecycle stages of a VM in the pool.
type InstanceState string

type PoolStatus string
type PoolCapacityState string
type TemplateClassStatus string
type ResolutionMode string
type SKURolloutState string
type PoolBindingRole string
type BindingAdmissionState string
type CapacityBundleStatus string
type VPCShardState string
type VPCShardSubnetRole string
type VPCShardSubnetReservationState string
type VPCShardCleanupState string
type VPCShardCleanupResourceType string

const (
	StateCreating  InstanceState = "CREATING"
	StateClean     InstanceState = "CLEAN"
	StateAllocated InstanceState = "ALLOCATED"
	StateDry       InstanceState = "DRY"
	// StateResetting indicates the instance is being reset/reinstalled by workers (in-flight).
	StateResetting InstanceState = "RESETTING"
	// StateReinstalling is kept for backward compatibility with old persisted data.
	// New code should use StateResetting.
	StateReinstalling InstanceState = "REINSTALLING"
	StateDeleting     InstanceState = "DELETING"
	StateFailed       InstanceState = "FAILED"
	StateDeleted      InstanceState = "DELETED"

	PoolStatusActive PoolStatus = "active"
	PoolStatusPaused PoolStatus = "paused"

	PoolCapacityStateActive      PoolCapacityState = "active"
	PoolCapacityStateDraining    PoolCapacityState = "draining"
	PoolCapacityStatePaused      PoolCapacityState = "paused"
	PoolCapacityStateQuarantined PoolCapacityState = "quarantined"
	PoolCapacityStateRetiring    PoolCapacityState = "retiring"

	TemplateClassStatusActive TemplateClassStatus = "active"
	TemplateClassStatusPaused TemplateClassStatus = "paused"

	ResolutionModeLegacy         ResolutionMode = "legacy"
	ResolutionModeShadow         ResolutionMode = "shadow"
	ResolutionModeSandboxPrimary ResolutionMode = "sandbox_primary"

	SKURolloutStateStable   SKURolloutState = "stable"
	SKURolloutStateRolling  SKURolloutState = "rolling"
	SKURolloutStateBlocked  SKURolloutState = "blocked"
	SKURolloutStateDegraded SKURolloutState = "degraded"

	PoolBindingRolePrimary  PoolBindingRole = "primary"
	PoolBindingRoleFallback PoolBindingRole = "fallback"
	PoolBindingRoleBurst    PoolBindingRole = "burst"

	BindingAdmissionStateActive      BindingAdmissionState = "active"
	BindingAdmissionStateDraining    BindingAdmissionState = "draining"
	BindingAdmissionStatePaused      BindingAdmissionState = "paused"
	BindingAdmissionStateQuarantined BindingAdmissionState = "quarantined"

	CapacityBundleStatusProvisioning CapacityBundleStatus = "provisioning"
	CapacityBundleStatusWarm         CapacityBundleStatus = "warm"
	CapacityBundleStatusActive       CapacityBundleStatus = "active"
	CapacityBundleStatusExhausted    CapacityBundleStatus = "exhausted"
	CapacityBundleStatusManualReview CapacityBundleStatus = "manual-review"

	VPCShardStateProvisioning   VPCShardState = "provisioning"
	VPCShardStateActive         VPCShardState = "active"
	VPCShardStateFailed         VPCShardState = "failed"
	VPCShardStateCleanupPending VPCShardState = "cleanup_pending"

	VPCShardSubnetRoleSupport  VPCShardSubnetRole = "support"
	VPCShardSubnetRoleWorkload VPCShardSubnetRole = "workload"

	VPCShardSubnetReservationAvailable VPCShardSubnetReservationState = "available"
	VPCShardSubnetReservationReserved  VPCShardSubnetReservationState = "reserved"
	VPCShardSubnetReservationActive    VPCShardSubnetReservationState = "active"
	VPCShardSubnetReservationExhausted VPCShardSubnetReservationState = "exhausted"

	VPCShardCleanupStateNone    VPCShardCleanupState = ""
	VPCShardCleanupStatePending VPCShardCleanupState = "pending"
	VPCShardCleanupStateDone    VPCShardCleanupState = "done"

	VPCShardCleanupResourceTypeVPC           VPCShardCleanupResourceType = "vpc"
	VPCShardCleanupResourceTypeSubnet        VPCShardCleanupResourceType = "subnet"
	VPCShardCleanupResourceTypeNATGateway    VPCShardCleanupResourceType = "nat_gateway"
	VPCShardCleanupResourceTypeRouteTable    VPCShardCleanupResourceType = "route_table"
	VPCShardCleanupResourceTypeSecurityGroup VPCShardCleanupResourceType = "security_group"
)

// Pool is a logical group of instances.
type Pool struct {
	ID                        string     `json:"id"`
	Name                      string     `json:"name"`
	Description               string     `json:"description,omitempty"`
	BaseImage                 string     `json:"base_image"`
	DesiredCap                int        `json:"desired_capacity"`
	InstanceType              string     `json:"instance_type"`
	Status                    PoolStatus `json:"status"`
	PauseReason               string     `json:"pause_reason,omitempty"`
	ConsecutiveRefillFailures int        `json:"consecutive_refill_failures,omitempty"`
	LastRefillErrorCode       string     `json:"last_refill_error_code,omitempty"`
	LastRefillError           string     `json:"last_refill_error,omitempty"`
	VpcID                     string     `json:"vpc_id"`
	SubnetID                  string     `json:"subnet_id"`
	Zone                      string     `json:"zone"`
	// SecurityGroups lists security group IDs applied when provisioning instances for the pool.
	SecurityGroups       []string          `json:"security_groups,omitempty"`
	TemplateClassID      string            `json:"template_class_id,omitempty"`
	SKUID                string            `json:"sku_id,omitempty"`
	CapacityState        PoolCapacityState `json:"capacity_state,omitempty"`
	MaxCapacity          int               `json:"max_capacity,omitempty"`
	CapacityBundleID     string            `json:"capacity_bundle_id,omitempty"`
	AutoscaleGeneration  int64             `json:"autoscale_generation,omitempty"`
	LastAutoscaleAction  string            `json:"last_autoscale_action,omitempty"`
	LastHealthTransition *time.Time        `json:"last_health_transition_at,omitempty"`
	CreatedAt            time.Time         `json:"created_at"`
}

type TemplateClass struct {
	ID                         string              `json:"id"`
	Name                       string              `json:"name"`
	Description                string              `json:"description,omitempty"`
	WorkloadType               string              `json:"workload_type,omitempty"`
	Region                     string              `json:"region,omitempty"`
	DefaultPoolSelectionPolicy string              `json:"default_pool_selection_policy,omitempty"`
	ResolutionMode             ResolutionMode      `json:"resolution_mode"`
	Status                     TemplateClassStatus `json:"status"`
	ImportGeneration           int64               `json:"import_generation,omitempty"`
	DivergenceMessage          string              `json:"divergence_message,omitempty"`
	CreatedAt                  time.Time           `json:"created_at"`
	UpdatedAt                  time.Time           `json:"updated_at"`
}

type TemplatePoolBinding struct {
	TemplateClassID string                `json:"template_class_id"`
	PoolID          string                `json:"pool_id"`
	Priority        int                   `json:"priority"`
	Weight          int                   `json:"weight"`
	Role            PoolBindingRole       `json:"role"`
	AdmissionState  BindingAdmissionState `json:"admission_state"`
	Reason          string                `json:"reason,omitempty"`
	CreatedAt       time.Time             `json:"created_at"`
	UpdatedAt       time.Time             `json:"updated_at"`
}

type SKU struct {
	ID                          string          `json:"id"`
	Name                        string          `json:"name"`
	Description                 string          `json:"description,omitempty"`
	TemplateClassID             string          `json:"template_class_id"`
	BaseImage                   string          `json:"base_image"`
	DesiredImageID              string          `json:"desired_image_id"`
	StableImageID               string          `json:"stable_image_id,omitempty"`
	InstanceType                string          `json:"instance_type"`
	NetworkTemplateID           string          `json:"network_template_id,omitempty"`
	SecurityGroupRuleTemplateID string          `json:"security_group_rule_template_id,omitempty"`
	AutoscalePolicyID           string          `json:"autoscale_policy_id,omitempty"`
	DefaultDesiredCapacity      int             `json:"default_desired_capacity,omitempty"`
	RolloutState                SKURolloutState `json:"rollout_state"`
	RolloutCursorPoolID         string          `json:"rollout_cursor_pool_id,omitempty"`
	Generation                  int64           `json:"generation,omitempty"`
	ConvergedPoolCount          int             `json:"converged_pool_count,omitempty"`
	TotalPoolCount              int             `json:"total_pool_count,omitempty"`
	PoolsPendingRollout         int             `json:"pools_pending_rollout,omitempty"`
	LastRolloutStartedAt        *time.Time      `json:"last_rollout_started_at,omitempty"`
	LastRolloutError            string          `json:"last_rollout_error,omitempty"`
	CreatedAt                   time.Time       `json:"created_at"`
	UpdatedAt                   time.Time       `json:"updated_at"`
}

type TemplateSkuBinding struct {
	TemplateClassID    string    `json:"template_class_id"`
	SKUID              string    `json:"sku_id"`
	Priority           int       `json:"priority"`
	Weight             int       `json:"weight"`
	AdmissionState     string    `json:"admission_state,omitempty"`
	RegionAffinity     string    `json:"region_affinity,omitempty"`
	RolloutEligibility bool      `json:"rollout_eligibility"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type PoolAutoscalePolicy struct {
	TemplateClassID          string    `json:"template_class_id"`
	MinPoolCount             int       `json:"min_pool_count"`
	MaxPoolCount             int       `json:"max_pool_count"`
	MinCleanPerPool          int       `json:"min_clean_per_pool"`
	TargetCleanPerPool       int       `json:"target_clean_per_pool"`
	MaxCleanPerPool          int       `json:"max_clean_per_pool"`
	WarmBundleTarget         int       `json:"warm_bundle_target"`
	SlowHorizonTarget        int       `json:"slow_horizon_target"`
	ScaleOutCooldownSeconds  int       `json:"scale_out_cooldown_seconds"`
	ScaleInCooldownSeconds   int       `json:"scale_in_cooldown_seconds"`
	RefillFailureThreshold   int       `json:"refill_failure_threshold"`
	ZoneFailureThreshold     int       `json:"zone_failure_threshold"`
	CapacityPressureLimitPct int       `json:"capacity_pressure_limit_pct"`
	CreatedAt                time.Time `json:"created_at"`
	UpdatedAt                time.Time `json:"updated_at"`
}

type CapacityBundle struct {
	ID                   string               `json:"id"`
	Region               string               `json:"region"`
	Zone                 string               `json:"zone"`
	VpcID                string               `json:"vpc_id"`
	SubnetID             string               `json:"subnet_id"`
	SecurityGroupIDs     []string             `json:"security_group_ids,omitempty"`
	NetworkTemplateID    string               `json:"network_template_id,omitempty"`
	Status               CapacityBundleStatus `json:"status"`
	BootstrapGeneration  int                  `json:"bootstrap_generation"`
	LineageTags          map[string]string    `json:"lineage_tags,omitempty"`
	LastValidationResult string               `json:"last_validation_result,omitempty"`
	CreatedAt            time.Time            `json:"created_at"`
	UpdatedAt            time.Time            `json:"updated_at"`
}

type VPCShard struct {
	ID                   string               `json:"id"`
	BlueprintSnapshotID  string               `json:"blueprint_snapshot_id,omitempty"`
	BlueprintFingerprint string               `json:"blueprint_fingerprint"`
	TemplateClassID      string               `json:"template_class_id"`
	SKUID                string               `json:"sku_id"`
	NetworkTemplateID    string               `json:"network_template_id"`
	Region               string               `json:"region"`
	VpcID                string               `json:"vpc_id"`
	State                VPCShardState        `json:"state"`
	ActiveSubnetMemberID string               `json:"active_subnet_member_id,omitempty"`
	LastSwitchAt         *time.Time           `json:"last_switch_at,omitempty"`
	LastWaterlineReason  string               `json:"last_waterline_reason,omitempty"`
	CleanupState         VPCShardCleanupState `json:"cleanup_state,omitempty"`
	CleanupStartedAt     *time.Time           `json:"cleanup_started_at,omitempty"`
	CleanupLastError     string               `json:"cleanup_last_error,omitempty"`
	CreatedAt            time.Time            `json:"created_at"`
	UpdatedAt            time.Time            `json:"updated_at"`
}

type VPCShardSubnet struct {
	ID               string                         `json:"id"`
	VPCShardID       string                         `json:"vpc_shard_id"`
	SubnetID         string                         `json:"subnet_id"`
	Zone             string                         `json:"zone"`
	Role             VPCShardSubnetRole             `json:"role"`
	Ordinal          int                            `json:"ordinal"`
	ReservationState VPCShardSubnetReservationState `json:"reservation_state"`
	NearWaterline    bool                           `json:"near_waterline"`
	CreatedAt        time.Time                      `json:"created_at"`
	UpdatedAt        time.Time                      `json:"updated_at"`
}

type VPCShardCleanupResource struct {
	ID           string                      `json:"id"`
	VPCShardID   string                      `json:"vpc_shard_id"`
	ResourceType VPCShardCleanupResourceType `json:"resource_type"`
	ResourceID   string                      `json:"resource_id"`
	CreatedAt    time.Time                   `json:"created_at"`
}

type VPCShardCreateLock struct {
	ID                   string    `json:"id"`
	BlueprintFingerprint string    `json:"blueprint_fingerprint"`
	Region               string    `json:"region"`
	CreatedAt            time.Time `json:"created_at"`
}

type VPCShardBlueprintSnapshot struct {
	ID                   string    `json:"id"`
	SchemaVersion        string    `json:"schema_version"`
	SourceRegion         string    `json:"source_region"`
	NetworkTemplateID    string    `json:"network_template_id,omitempty"`
	BlueprintFingerprint string    `json:"blueprint_fingerprint"`
	TopologyJSON         string    `json:"topology_json"`
	ValidationState      string    `json:"validation_state,omitempty"`
	CreatedAt            time.Time `json:"created_at"`
}

type VPCShardProvisionProgressStatus string

const (
	VPCShardProvisionProgressStatusRunning   VPCShardProvisionProgressStatus = "running"
	VPCShardProvisionProgressStatusFailed    VPCShardProvisionProgressStatus = "failed"
	VPCShardProvisionProgressStatusCompleted VPCShardProvisionProgressStatus = "completed"
)

type VPCShardProvisionProgress struct {
	ID                   string                          `json:"id"`
	VPCShardID           string                          `json:"vpc_shard_id"`
	BlueprintSnapshotID  string                          `json:"blueprint_snapshot_id"`
	BlueprintFingerprint string                          `json:"blueprint_fingerprint"`
	Status               VPCShardProvisionProgressStatus `json:"status"`
	LastStep             string                          `json:"last_step,omitempty"`
	LastError            string                          `json:"last_error,omitempty"`
	StartedAt            time.Time                       `json:"started_at"`
	UpdatedAt            time.Time                       `json:"updated_at"`
	CompletedAt          *time.Time                      `json:"completed_at,omitempty"`
}

// Instance tracks a single VM and its lifecycle.
type Instance struct {
	ID        string        `json:"id"`
	PoolID    string        `json:"pool_id"`
	State     InstanceState `json:"state"`
	CloudID   string        `json:"cloud_id,omitempty"`
	Address   string        `json:"address,omitempty"`
	CreatedAt time.Time     `json:"created_at"`
	UpdatedAt time.Time     `json:"updated_at"`
}

// Sandbox keeps client-facing sandbox metadata mapped to an allocated instance.
type Sandbox struct {
	ID                   string            `json:"sandbox_id"`
	InstanceID           string            `json:"instance_id"`
	PoolID               string            `json:"pool_id"`
	TemplateClassID      string            `json:"template_class_id,omitempty"`
	ResolutionMode       ResolutionMode    `json:"resolution_mode,omitempty"`
	ResolutionSource     string            `json:"resolution_source,omitempty"`
	ResolutionDivergence string            `json:"resolution_divergence,omitempty"`
	Region               string            `json:"region,omitempty"`
	Metadata             map[string]string `json:"metadata,omitempty"`
	EnvVars              map[string]string `json:"env_vars,omitempty"`
	TimeoutSeconds       int32             `json:"timeout_seconds"`
	AutoPause            bool              `json:"auto_pause"`
	Secure               bool              `json:"secure"`
	AllowInternetAccess  bool              `json:"allow_internet_access"`
	CreatedAt            time.Time         `json:"created_at"`
	UpdatedAt            time.Time         `json:"updated_at"`
}

// Domain errors shared across layers.
var (
	ErrPoolNotFound                      = errors.New("pool not found")
	ErrInstanceNotFound                  = errors.New("instance not found")
	ErrNoCleanInstance                   = errors.New("no CLEAN instance available")
	ErrInvalidTransition                 = errors.New("invalid state transition")
	ErrInvalidRequestState               = errors.New("invalid requested state")
	ErrSandboxNotFound                   = errors.New("sandbox not found")
	ErrTemplateClassNotFound             = errors.New("template class not found")
	ErrSKUNotFound                       = errors.New("sku not found")
	ErrPoolAutoscalePolicyNotFound       = errors.New("pool autoscale policy not found")
	ErrCapacityBundleNotFound            = errors.New("capacity bundle not found")
	ErrVPCShardNotFound                  = errors.New("vpc shard not found")
	ErrVPCShardSubnetNotFound            = errors.New("vpc shard subnet not found")
	ErrVPCShardBlueprintSnapshotNotFound = errors.New("vpc shard blueprint snapshot not found")
	ErrVPCShardProvisionProgressNotFound = errors.New("vpc shard provision progress not found")
)
