package store

import (
	"context"
	"time"

	"cvm-mock-e2b/internal/core"
)

// Store abstracts persistence for pools and instances.
type Store interface {
	CreatePool(ctx context.Context, pool core.Pool) (core.Pool, error)
	UpdatePool(ctx context.Context, pool core.Pool) (core.Pool, error)
	GetPool(ctx context.Context, id string) (core.Pool, error)
	ListPools(ctx context.Context) ([]core.Pool, error)
	ListPoolsByIDs(ctx context.Context, ids []string) ([]core.Pool, error)
	AddInstances(ctx context.Context, poolID string, instances []core.Instance) ([]core.Instance, error)
	ListInstances(ctx context.Context, poolID string) ([]core.Instance, error)
	ListInstancesByStates(ctx context.Context, poolID string, states []core.InstanceState, limit int) ([]core.Instance, error)
	GetInstance(ctx context.Context, id string) (core.Instance, error)
	// ClaimCleanInstance atomically finds a CLEAN instance and marks it ALLOCATED.
	ClaimCleanInstance(ctx context.Context, poolID string) (core.Instance, error)
	// UpdateInstanceState updates state when the current state matches expected.
	UpdateInstanceState(ctx context.Context, id string, expected core.InstanceState, target core.InstanceState) (core.Instance, error)
	// UpdateInstanceCloudAndState updates cloud/address and state when expected state matches.
	UpdateInstanceCloudAndState(ctx context.Context, id string, expected core.InstanceState, target core.InstanceState, address, cloudID string) (core.Instance, error)
	DeleteInstance(ctx context.Context, id string) error
	// RebindAllocatedInstance atomically moves a checked-out instance to a target pool.
	// It only rewrites ownership metadata on the instance and sandbox rows; the CVM,
	// its data, IP, VPC, subnet and security groups are untouched.
	RebindAllocatedInstance(ctx context.Context, in RebindInstanceInput) (core.Instance, error)

	// Sandbox mapping
	CreateSandbox(ctx context.Context, sb core.Sandbox) (core.Sandbox, error)
	GetSandbox(ctx context.Context, id string) (core.Sandbox, error)
	ListSandboxes(ctx context.Context) ([]core.Sandbox, error)
	DeleteSandbox(ctx context.Context, id string) error

	// Template classes and bindings.
	UpsertTemplateClass(ctx context.Context, templateClass core.TemplateClass) (core.TemplateClass, error)
	GetTemplateClass(ctx context.Context, id string) (core.TemplateClass, error)
	ListTemplateClasses(ctx context.Context) ([]core.TemplateClass, error)
	UpsertSKU(ctx context.Context, sku core.SKU) (core.SKU, error)
	GetSKU(ctx context.Context, id string) (core.SKU, error)
	ListSKUs(ctx context.Context) ([]core.SKU, error)
	UpsertTemplateSkuBinding(ctx context.Context, binding core.TemplateSkuBinding) (core.TemplateSkuBinding, error)
	ReplaceTemplateSkuBindings(ctx context.Context, templateClassID string, bindings []core.TemplateSkuBinding) ([]core.TemplateSkuBinding, error)
	ListTemplateSkuBindings(ctx context.Context, templateClassID string) ([]core.TemplateSkuBinding, error)
	UpsertTemplatePoolBinding(ctx context.Context, binding core.TemplatePoolBinding) (core.TemplatePoolBinding, error)
	ReplaceTemplatePoolBindings(ctx context.Context, templateClassID string, bindings []core.TemplatePoolBinding) ([]core.TemplatePoolBinding, error)
	UpdateTemplatePoolBindingAdmission(ctx context.Context, templateClassID string, poolID string, admissionState core.BindingAdmissionState, reason string) (core.TemplatePoolBinding, error)
	ListTemplatePoolBindings(ctx context.Context, templateClassID string) ([]core.TemplatePoolBinding, error)
	DeleteTemplatePoolBinding(ctx context.Context, templateClassID string, poolID string) error

	// Autoscale policies.
	UpsertPoolAutoscalePolicy(ctx context.Context, policy core.PoolAutoscalePolicy) (core.PoolAutoscalePolicy, error)
	GetPoolAutoscalePolicy(ctx context.Context, templateClassID string) (core.PoolAutoscalePolicy, error)

	// Capacity bundles.
	UpsertCapacityBundle(ctx context.Context, bundle core.CapacityBundle) (core.CapacityBundle, error)
	GetCapacityBundle(ctx context.Context, id string) (core.CapacityBundle, error)
	ListCapacityBundles(ctx context.Context) ([]core.CapacityBundle, error)
	ReserveCapacityBundleForPool(ctx context.Context, bundleID string, templateClassID string, skuID string, poolID string) (core.CapacityBundle, error)
	TryStartPoolSGShardRecovery(ctx context.Context, poolID string) (core.Pool, bool, error)

	// VPC shards.
	UpsertVPCShard(ctx context.Context, shard core.VPCShard) (core.VPCShard, error)
	GetVPCShard(ctx context.Context, id string) (core.VPCShard, error)
	ListVPCShards(ctx context.Context) ([]core.VPCShard, error)
	ReplaceVPCShardSubnets(ctx context.Context, shardID string, subnets []core.VPCShardSubnet) ([]core.VPCShardSubnet, error)
	ListVPCShardSubnets(ctx context.Context, shardID string) ([]core.VPCShardSubnet, error)
	ReserveNextVPCShardSubnet(ctx context.Context, shardID string) (core.VPCShard, core.VPCShardSubnet, error)
	ActivateVPCShardSubnet(ctx context.Context, shardID string, subnetMemberID string, switchedAt time.Time, waterlineReason string) (core.VPCShard, error)
	UpsertVPCShardBlueprintSnapshot(ctx context.Context, snapshot core.VPCShardBlueprintSnapshot) (core.VPCShardBlueprintSnapshot, error)
	GetVPCShardBlueprintSnapshot(ctx context.Context, id string) (core.VPCShardBlueprintSnapshot, error)
	ListVPCShardBlueprintSnapshots(ctx context.Context) ([]core.VPCShardBlueprintSnapshot, error)
	UpsertVPCShardProvisionProgress(ctx context.Context, progress core.VPCShardProvisionProgress) (core.VPCShardProvisionProgress, error)
	GetVPCShardProvisionProgress(ctx context.Context, shardID string) (core.VPCShardProvisionProgress, error)
	TryStartVPCShardCreate(ctx context.Context, blueprintFingerprint string, region string) (core.VPCShardCreateLock, bool, error)
	DeleteVPCShardCreateLock(ctx context.Context, blueprintFingerprint string, region string) error
	ReplaceVPCShardCleanupResources(ctx context.Context, shardID string, resources []core.VPCShardCleanupResource) ([]core.VPCShardCleanupResource, error)
	ListVPCShardCleanupResources(ctx context.Context, shardID string) ([]core.VPCShardCleanupResource, error)
	DeleteVPCShardCleanupResource(ctx context.Context, id string) error

	// SKU rollout.
	BeginSKUPoolRollout(ctx context.Context, skuID string, poolID string, desiredImage string, startedAt time.Time) (core.SKU, core.Pool, error)

	// Modify operations ledger (同 SP 升配的 Sandbox 侧云操作账本).
	//
	// CreateModifyOperation returns created=false when the idempotency key already
	// exists, so a retrying caller resumes the original operation instead of
	// re-running irreversible cloud steps. Reusing a key for a different target is
	// rejected with core.ErrModifyOperationConflict.
	CreateModifyOperation(ctx context.Context, op core.ModifyOperation) (operation core.ModifyOperation, created bool, err error)
	GetModifyOperation(ctx context.Context, id string) (core.ModifyOperation, error)
	// GetRunningModifyOperationByInstance 返回该实例当前在跑的账本，found=false 表示没有。
	// 用于把换了幂等键的重派收敛回同一份账本，而不是并行开出第二份。
	GetRunningModifyOperationByInstance(ctx context.Context, instanceID string) (operation core.ModifyOperation, found bool, err error)
	UpdateModifyOperationProgress(ctx context.Context, in ModifyOperationProgress) (core.ModifyOperation, error)
	ListModifyOperationsByStatus(ctx context.Context, status core.ModifyOperationStatus, limit int) ([]core.ModifyOperation, error)
}

// RebindInstanceInput describes an atomic pool ownership move for one instance.
type RebindInstanceInput struct {
	InstanceID string
	// ExpectedState guards the rebind so a concurrent release or pause cannot interleave.
	ExpectedState   core.InstanceState
	TargetPoolID    string
	TemplateClassID string
	// ResolutionSource records why the sandbox now points at TargetPoolID, replacing
	// the stale allocation-time provenance.
	ResolutionSource string
}

// ModifyOperationProgress is a step checkpoint written after each cloud step succeeds.
type ModifyOperationProgress struct {
	ID          string
	Status      core.ModifyOperationStatus
	CurrentStep string
	LastError   string
	CompletedAt *time.Time
}
