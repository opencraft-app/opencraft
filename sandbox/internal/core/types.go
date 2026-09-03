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
	// StatePausing / StatePaused implement Q26-D 修订版 + Q29=E5 + Q32=b 拍板（2026-05-14）：
	// trade pass isolation 走"关机保留数据"路径，而不是历史的"释放 + 重装"。
	// 状态机增量：StateAllocated → StatePausing → StatePaused（→ StateDeleting → StateDeleted）。
	StatePausing InstanceState = "PAUSING"
	StatePaused  InstanceState = "PAUSED"

	// StateResuming implements R-F（2026-05-15，对偶 R-A trade 续费链路）：
	// trade pass renew 走"开机恢复数据"路径，对偶 Pause 侧 PAUSED → RESUMING → ALLOCATED。
	// 失败回滚 RESUMING → PAUSED 让 ctl 子 task 重投。详见
	// .tmp/trade-pass-renew-design.md §10 R-F。
	StateResuming InstanceState = "RESUMING"

	// StateModifying 承载 trade pass 同 SP 升配链路（启航 → 巡游 / 启航 AI → 巡游 AI）。
	// 状态机增量：ALLOCATED → MODIFYING → ALLOCATED。
	//
	// 系统盘扩容不可逆，因此本状态**没有回滚边**：失败时实例停留在 MODIFYING，由
	// modify operation 账本记录已完成步骤，worker 前滚重试直到收敛。stale 清理规则
	// 也刻意不覆盖 MODIFYING —— 把已付费实例扫成 FAILED 会让用户资源被回收。
	//
	// 容量语义上 MODIFYING 与 ALLOCATED 同类（实例已被用户占用），因此既不计入 CLEAN
	// 库存，也不计入 refill 的 inflight 在途容量。
	StateModifying InstanceState = "MODIFYING"

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
	TemplateClassID      string            `json:"template_class_id"`
	SKUID                string            `json:"sku_id"`
	CapacityState        PoolCapacityState `json:"capacity_state,omitempty"`
	MaxCapacity          int               `json:"max_capacity,omitempty"`
	CapacityBundleID     string            `json:"capacity_bundle_id,omitempty"`
	AutoscaleGeneration  int64             `json:"autoscale_generation,omitempty"`
	LastAutoscaleAction  string            `json:"last_autoscale_action,omitempty"`
	LastHealthTransition *time.Time        `json:"last_health_transition_at,omitempty"`
	// SystemDiskSize 系统盘大小（GB）。设计稿 .tmp/bundle-instance-spec-design.md §10 Q11=a：
	// >0 时 tencent.go::CreateInstance 在 RunInstances 请求中设
	// req.SystemDisk = &cvm.SystemDisk{DiskSize: int64(SystemDiskSize)}；0 时走腾讯云默认 50G。
	SystemDiskSize int       `json:"system_disk_size,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
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
	SystemDiskSize              int             `json:"system_disk_size,omitempty"`
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

// ModifyOperationStatus 是单实例升配操作的账本状态。
type ModifyOperationStatus string

const (
	ModifyOperationStatusRunning   ModifyOperationStatus = "running"
	ModifyOperationStatusCompleted ModifyOperationStatus = "completed"
	ModifyOperationStatusFailed    ModifyOperationStatus = "failed"
)

// 升配步骤。步骤成功后持久化到 modify_operations.current_step，进程重启或请求超时后
// 从该步骤续跑；已完成的不可逆步骤（尤其是磁盘扩容）不会重复执行。
const (
	ModifyStepStopInstance   = "stop_instance"
	ModifyStepResizeCompute  = "resize_compute"
	ModifyStepResizeDisk     = "resize_disk"
	ModifyStepStartInstance  = "start_instance"
	ModifyStepVerifyDelivery = "verify_delivery"
	ModifyStepRebindPool     = "rebind_pool"
	ModifyStepDone           = "done"
)

// ModifyOperation 是 Sandbox 侧云操作账本：只承载停机、计算规格升级、磁盘扩容、开机
// 和目标 Pool 重绑等云侧步骤的持久化、幂等与续跑，不保存 Trade flow，也不是第二套业务流程。
//
// TargetInstanceType / TargetSystemDiskSize 在创建 operation 时从目标 SKU 解析并冻结，
// 后续步骤只读这份快照，避免运营中途改 SKU 导致同一次升配前后目标规格漂移。
type ModifyOperation struct {
	ID             string `json:"operation_id"`
	IdempotencyKey string `json:"idempotency_key"`
	SandboxID      string `json:"sandbox_id"`
	InstanceID     string `json:"instance_id"`
	SourcePoolID   string `json:"source_pool_id"`
	TargetPoolID   string `json:"target_pool_id"`
	TargetSKUID    string `json:"target_sku_id"`
	// TargetTemplateClassID 与 TargetPoolID 一起决定重绑后的路由归属；4C8G 使用独立
	// template class，缺失会让后续分配把用户漂到源规格池。
	TargetTemplateClassID string                `json:"target_template_class_id"`
	TargetInstanceType    string                `json:"target_instance_type"`
	TargetSystemDiskSize  int                   `json:"target_system_disk_size"`
	Status                ModifyOperationStatus `json:"status"`
	CurrentStep           string                `json:"current_step"`
	LastError             string                `json:"last_error,omitempty"`
	StartedAt             time.Time             `json:"started_at"`
	UpdatedAt             time.Time             `json:"updated_at"`
	CompletedAt           *time.Time            `json:"completed_at,omitempty"`
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
	ErrInvalidPoolSKUBinding             = errors.New("invalid pool sku binding")
	ErrPoolAutoscalePolicyNotFound       = errors.New("pool autoscale policy not found")
	ErrCapacityBundleNotFound            = errors.New("capacity bundle not found")
	ErrVPCShardNotFound                  = errors.New("vpc shard not found")
	ErrVPCShardSubnetNotFound            = errors.New("vpc shard subnet not found")
	ErrVPCShardBlueprintSnapshotNotFound = errors.New("vpc shard blueprint snapshot not found")
	ErrVPCShardProvisionProgressNotFound = errors.New("vpc shard provision progress not found")
	ErrModifyOperationNotFound           = errors.New("modify operation not found")
	// ErrModifyOperationConflict 表示同一 idempotency_key 被用于不同的升配目标；
	// 这是调用方 bug 而不是重试，必须拒绝而不是覆盖原 operation。
	ErrModifyOperationConflict = errors.New("modify operation idempotency key reused with different target")
	// ErrModifyTargetNotUpgrade 表示目标规格低于当前规格。系统盘只能扩容，
	// 计算规格降配也不在支持范围内。这类请求重试永远不会成功。
	ErrModifyTargetNotUpgrade = errors.New("modify target is not an upgrade of the current spec")
	// ErrModifyTargetAlreadyApplied 表示实例已经就在目标规格和目标池上。
	// 与 ErrModifyTargetNotUpgrade 分开是因为调用方的处置完全相反：这个是
	// "已经收敛，无事可做"，按成功处理；那个是配置错，必须失败。
	// 会走到这个分支的典型场景是上一份账本已经收尾但调用方的子 task 已超时重派。
	ErrModifyTargetAlreadyApplied = errors.New("modify target spec is already applied to the instance")
)
