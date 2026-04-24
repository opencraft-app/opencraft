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
}
