package service

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"cvm-mock-e2b/internal/blueprint"
	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/store"
)

type fakeVPCShardProvisioner struct {
	result provider.VPCShardProvisionResult
	err    error
}

func (f fakeVPCShardProvisioner) ProvisionVPCShard(context.Context, provider.VPCShardProvisionRequest) (provider.VPCShardProvisionResult, error) {
	return f.result, f.err
}

func writeStaticBlueprint(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "vpc-shard-blueprint.yaml")
	content := `
schema_version: v1alpha1
source_region: ap-beijing
network_template_id: net-a
vpc_cidr: 10.0.0.0/16
support_subnet:
  name: support
  cidr: 10.0.0.0/24
  zone: ap-beijing-8
  role: support
  ordinal: 0
workload_subnets:
  - name: workload-a
    cidr: 10.0.1.0/24
    zone: ap-beijing-8
    role: workload
    ordinal: 1
nat_shape:
  mode: single
  gateways:
    - name: nat-main
      zone: ap-beijing-8
      subnet: support
route_shape:
  route_tables:
    - name: rt-main
      main: true
      associations:
        - target: support
        - target: workload:1
      routes:
        - destination: 10.0.0.0/16
          next_hop_type: LOCAL
          next_hop_ref: local
          enabled: true
        - destination: 0.0.0.0/0
          next_hop_type: NAT
          next_hop_ref: nat-main
          enabled: true
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write blueprint yaml: %v", err)
	}
	return path
}

func TestEnsureVPCShardBlueprintSnapshotUsesStaticBlueprint(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	path := writeStaticBlueprint(t, t.TempDir())

	snapshot, err := svc.EnsureVPCShardBlueprintSnapshot(ctx, path)
	if err != nil {
		t.Fatalf("EnsureVPCShardBlueprintSnapshot: %v", err)
	}
	if snapshot.SchemaVersion != "v1alpha1" || snapshot.SourceRegion != "ap-beijing" {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	if snapshot.BlueprintFingerprint == "" || snapshot.TopologyJSON == "" {
		t.Fatalf("expected persisted normalized blueprint snapshot, got %+v", snapshot)
	}
}

func TestBuildVPCShardProvisionRequestFromSnapshot(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	path := writeStaticBlueprint(t, t.TempDir())
	snapshot, err := svc.EnsureVPCShardBlueprintSnapshot(ctx, path)
	if err != nil {
		t.Fatalf("EnsureVPCShardBlueprintSnapshot: %v", err)
	}
	req, err := svc.BuildVPCShardProvisionRequest(snapshot, "tc-1", core.SKU{
		ID:                          "sku-1",
		NetworkTemplateID:           "net-a",
		SecurityGroupRuleTemplateID: "",
	})
	if err != nil {
		t.Fatalf("BuildVPCShardProvisionRequest: %v", err)
	}
	if req.BlueprintSnapshotID != snapshot.ID || req.BlueprintFingerprint != snapshot.BlueprintFingerprint {
		t.Fatalf("unexpected snapshot linkage in request: %+v", req)
	}
	if req.SupportSubnet.CIDR != "10.0.0.0/24" || len(req.WorkloadSubnets) != 1 {
		t.Fatalf("unexpected subnet projection: %+v", req)
	}
}

func TestVPCShardRoundTripViaService(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	snapshot, err := svc.UpsertVPCShardBlueprintSnapshot(ctx, core.VPCShardBlueprintSnapshot{
		ID:                   "snap-1",
		SchemaVersion:        "v1alpha1",
		SourceRegion:         "ap-beijing",
		BlueprintFingerprint: "fp-1",
		TopologyJSON:         `{"schema_version":"v1alpha1","source_region":"ap-beijing","network_template_id":"net-a","vpc_cidr":"10.0.0.0/16","support_subnet":{"cidr":"10.0.0.0/24","zone":"ap-beijing-8","role":"support"},"workload_subnets":[{"cidr":"10.0.1.0/24","zone":"ap-beijing-8","role":"workload","ordinal":1}],"nat_shape":{"mode":"single","gateways":[{"name":"nat-main"}]},"route_shape":{"route_tables":[{"name":"rt-main","routes":[{"destination":"10.0.0.0/16","next_hop_type":"LOCAL","next_hop_ref":"local","enabled":true}]}]}}`,
		ValidationState:      "valid",
		CreatedAt:            time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("UpsertVPCShardBlueprintSnapshot: %v", err)
	}
	shard, err := svc.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  snapshot.ID,
		BlueprintFingerprint: snapshot.BlueprintFingerprint,
		TemplateClassID:      "tc-1",
		SKUID:                "sku-1",
		NetworkTemplateID:    "net-a",
		Region:               "ap-beijing",
		State:                core.VPCShardStateProvisioning,
	})
	if err != nil {
		t.Fatalf("UpsertVPCShard: %v", err)
	}
	subnets, err := svc.ReplaceVPCShardSubnets(ctx, shard.ID, []core.VPCShardSubnet{
		{
			SubnetID:         "subnet-support",
			Zone:             "ap-beijing-8",
			Role:             core.VPCShardSubnetRoleSupport,
			Ordinal:          0,
			ReservationState: core.VPCShardSubnetReservationAvailable,
		},
		{
			SubnetID:         "subnet-workload-a",
			Zone:             "ap-beijing-8",
			Role:             core.VPCShardSubnetRoleWorkload,
			Ordinal:          1,
			ReservationState: core.VPCShardSubnetReservationAvailable,
		},
	})
	if err != nil {
		t.Fatalf("ReplaceVPCShardSubnets: %v", err)
	}
	if len(subnets) != 2 {
		t.Fatalf("expected 2 shard subnets, got %d", len(subnets))
	}
	gotShard, err := svc.GetVPCShard(ctx, shard.ID)
	if err != nil {
		t.Fatalf("GetVPCShard: %v", err)
	}
	if gotShard.BlueprintSnapshotID != "snap-1" || gotShard.BlueprintFingerprint != "fp-1" {
		t.Fatalf("unexpected shard linkage: %+v", gotShard)
	}
}

func TestReserveAndActivateVPCShardSubnet(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	shard, err := svc.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  "snap-2",
		BlueprintFingerprint: "fp-2",
		TemplateClassID:      "tc-2",
		SKUID:                "sku-2",
		NetworkTemplateID:    "net-b",
		Region:               "ap-beijing",
		State:                core.VPCShardStateActive,
	})
	if err != nil {
		t.Fatalf("UpsertVPCShard: %v", err)
	}
	_, err = svc.ReplaceVPCShardSubnets(ctx, shard.ID, []core.VPCShardSubnet{
		{SubnetID: "subnet-workload-a", Zone: "ap-beijing-8", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 2, ReservationState: core.VPCShardSubnetReservationAvailable},
		{SubnetID: "subnet-workload-b", Zone: "ap-beijing-8", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 1, ReservationState: core.VPCShardSubnetReservationAvailable},
	})
	if err != nil {
		t.Fatalf("ReplaceVPCShardSubnets: %v", err)
	}
	_, reserved, err := svc.ReserveNextVPCShardSubnet(ctx, shard.ID)
	if err != nil {
		t.Fatalf("ReserveNextVPCShardSubnet: %v", err)
	}
	if reserved.SubnetID != "subnet-workload-b" || reserved.ReservationState != core.VPCShardSubnetReservationReserved {
		t.Fatalf("unexpected reserved subnet: %+v", reserved)
	}
	activated, err := svc.ActivateVPCShardSubnet(ctx, shard.ID, reserved.ID, time.Now().UTC(), "waterline")
	if err != nil {
		t.Fatalf("ActivateVPCShardSubnet: %v", err)
	}
	if activated.ActiveSubnetMemberID != reserved.ID {
		t.Fatalf("unexpected active subnet member: %+v", activated)
	}
}

func TestPersistProvisionedVPCShardStoresSubnetsAndCleanupResources(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	persisted, err := svc.PersistProvisionedVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  "snap-3",
		BlueprintFingerprint: "fp-3",
		TemplateClassID:      "tc-3",
		SKUID:                "sku-3",
		NetworkTemplateID:    "net-c",
		Region:               "ap-beijing",
		VpcID:                "vpc-3",
		State:                core.VPCShardStateProvisioning,
	}, core.VPCShardSubnet{
		SubnetID:         "subnet-support",
		Zone:             "ap-beijing-8",
		Role:             core.VPCShardSubnetRoleSupport,
		Ordinal:          0,
		ReservationState: core.VPCShardSubnetReservationAvailable,
	}, []core.VPCShardSubnet{
		{SubnetID: "subnet-workload-a", Zone: "ap-beijing-8", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 1, ReservationState: core.VPCShardSubnetReservationAvailable},
	}, []core.VPCShardCleanupResource{
		{ResourceType: core.VPCShardCleanupResourceTypeVPC, ResourceID: "vpc-3"},
	})
	if err != nil {
		t.Fatalf("PersistProvisionedVPCShard: %v", err)
	}
	gotCleanup, err := svc.ListVPCShardCleanupResources(ctx, persisted.ID)
	if err != nil {
		t.Fatalf("ListVPCShardCleanupResources: %v", err)
	}
	if len(gotCleanup) != 1 || gotCleanup[0].ResourceID != "vpc-3" {
		t.Fatalf("unexpected cleanup resources: %+v", gotCleanup)
	}
}

func TestMarkVPCShardCleanupPending(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	shard, err := svc.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  "snap-4",
		BlueprintFingerprint: "fp-4",
		TemplateClassID:      "tc-4",
		SKUID:                "sku-4",
		NetworkTemplateID:    "net-d",
		Region:               "ap-beijing",
		State:                core.VPCShardStateFailed,
	})
	if err != nil {
		t.Fatalf("UpsertVPCShard: %v", err)
	}
	updated, err := svc.MarkVPCShardCleanupPending(ctx, shard.ID, "cleanup failed", time.Now().UTC())
	if err != nil {
		t.Fatalf("MarkVPCShardCleanupPending: %v", err)
	}
	if updated.CleanupState != core.VPCShardCleanupStatePending || updated.State != core.VPCShardStateCleanupPending {
		t.Fatalf("unexpected cleanup pending shard: %+v", updated)
	}
}

func TestPersistProvisionedVPCShardFromRequest(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	persisted, err := svc.PersistProvisionedVPCShardFromRequest(ctx, provider.VPCShardProvisionRequest{
		BlueprintSnapshotID:  "snap-req",
		BlueprintFingerprint: "fp-req",
		TemplateClassID:      "tc-req",
		SKUID:                "sku-req",
		NetworkTemplateID:    "net-req",
		Region:               "ap-beijing",
	}, provider.VPCShardProvisionResult{
		VpcID: "vpc-req",
		SupportSubnet: core.VPCShardSubnet{
			SubnetID:         "subnet-support",
			Zone:             "ap-beijing-8",
			Role:             core.VPCShardSubnetRoleSupport,
			Ordinal:          0,
			ReservationState: core.VPCShardSubnetReservationAvailable,
		},
		WorkloadSubnets: []core.VPCShardSubnet{
			{
				SubnetID:         "subnet-workload-a",
				Zone:             "ap-beijing-8",
				Role:             core.VPCShardSubnetRoleWorkload,
				Ordinal:          1,
				ReservationState: core.VPCShardSubnetReservationAvailable,
			},
		},
	})
	if err != nil {
		t.Fatalf("PersistProvisionedVPCShardFromRequest: %v", err)
	}
	if persisted.BlueprintSnapshotID != "snap-req" || persisted.BlueprintFingerprint != "fp-req" || persisted.VpcID != "vpc-req" {
		t.Fatalf("unexpected persisted shard: %+v", persisted)
	}
}

func TestTryStartVPCShardCreateDedupesByBlueprintAndRegion(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	lock, acquired, err := svc.TryStartVPCShardCreate(ctx, "fp-lock", "ap-beijing")
	if err != nil {
		t.Fatalf("TryStartVPCShardCreate first: %v", err)
	}
	if !acquired {
		t.Fatalf("expected first create lock acquisition")
	}
	if lock.BlueprintFingerprint != "fp-lock" || lock.Region != "ap-beijing" {
		t.Fatalf("unexpected lock: %+v", lock)
	}
	lock2, acquired, err := svc.TryStartVPCShardCreate(ctx, "fp-lock", "ap-beijing")
	if err != nil {
		t.Fatalf("TryStartVPCShardCreate second: %v", err)
	}
	if acquired {
		t.Fatalf("expected second create lock attempt to be rejected, got %+v", lock2)
	}
}

func TestReconcileVPCShardHeadroomCreatesInitialShard(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	path := writeStaticBlueprint(t, t.TempDir())
	shard, created, err := svc.ReconcileVPCShardHeadroom(ctx, provider.NewMockCloudProvider(), core.TemplateClass{
		ID:     "tc-10",
		Region: "ap-beijing",
	}, AutoscaleTarget{
		TemplateClass: core.TemplateClass{ID: "tc-10", Region: "ap-beijing"},
		SKU:           core.SKU{ID: "sku-10", NetworkTemplateID: "net-a"},
	}, path)
	if err != nil {
		t.Fatalf("ReconcileVPCShardHeadroom: %v", err)
	}
	if !created {
		t.Fatalf("expected initial shard creation")
	}
	if shard.ActiveSubnetMemberID == "" || shard.BlueprintSnapshotID == "" || shard.VpcID == "" {
		t.Fatalf("unexpected created shard: %+v", shard)
	}
	lock, acquired, err := svc.TryStartVPCShardCreate(ctx, shard.BlueprintFingerprint, "ap-beijing")
	if err != nil {
		t.Fatalf("TryStartVPCShardCreate after initial create: %v", err)
	}
	if !acquired {
		t.Fatalf("expected create lock to be released after reconcile, got %+v", lock)
	}
}

func TestReconcileVPCShardHeadroomSwitchesSubnetBeforeCreatingNewShard(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	shard, err := svc.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  "snap-switch",
		BlueprintFingerprint: "fp-switch",
		TemplateClassID:      "tc-switch",
		SKUID:                "sku-switch",
		NetworkTemplateID:    "net-a",
		Region:               "ap-beijing",
		VpcID:                "vpc-existing",
		State:                core.VPCShardStateActive,
		ActiveSubnetMemberID: "subnet-active",
	})
	if err != nil {
		t.Fatalf("UpsertVPCShard: %v", err)
	}
	_, err = svc.ReplaceVPCShardSubnets(ctx, shard.ID, []core.VPCShardSubnet{
		{ID: "subnet-active", SubnetID: "subnet-a", Zone: "ap-beijing-8", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 1, ReservationState: core.VPCShardSubnetReservationActive, NearWaterline: true},
		{ID: "subnet-next", SubnetID: "subnet-b", Zone: "ap-beijing-7", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 2, ReservationState: core.VPCShardSubnetReservationAvailable},
	})
	if err != nil {
		t.Fatalf("ReplaceVPCShardSubnets: %v", err)
	}

	updated, created, err := svc.ReconcileVPCShardHeadroom(ctx, provider.NewMockCloudProvider(), core.TemplateClass{ID: "tc-switch", Region: "ap-beijing"}, AutoscaleTarget{
		TemplateClass: core.TemplateClass{ID: "tc-switch", Region: "ap-beijing"},
		SKU:           core.SKU{ID: "sku-switch", NetworkTemplateID: "net-a"},
	}, "")
	if err != nil {
		t.Fatalf("ReconcileVPCShardHeadroom: %v", err)
	}
	if created {
		t.Fatalf("expected subnet switch, not new shard create")
	}
	if updated.ID != shard.ID || updated.ActiveSubnetMemberID != "subnet-next" {
		t.Fatalf("expected active subnet to switch to subnet-next, got %+v", updated)
	}
}

func TestReconcileVPCShardHeadroomCreatesNewShardWhenAllSubnetsNearWaterline(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	path := writeStaticBlueprint(t, t.TempDir())
	shard, err := svc.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  "snap-exhausted",
		BlueprintFingerprint: "fp-exhausted",
		TemplateClassID:      "tc-exhausted",
		SKUID:                "sku-exhausted",
		NetworkTemplateID:    "net-a",
		Region:               "ap-beijing",
		VpcID:                "vpc-existing",
		State:                core.VPCShardStateActive,
		ActiveSubnetMemberID: "subnet-active",
	})
	if err != nil {
		t.Fatalf("UpsertVPCShard: %v", err)
	}
	_, err = svc.ReplaceVPCShardSubnets(ctx, shard.ID, []core.VPCShardSubnet{
		{ID: "subnet-active", SubnetID: "subnet-a", Zone: "ap-beijing-8", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 1, ReservationState: core.VPCShardSubnetReservationActive, NearWaterline: true},
		{ID: "subnet-exhausted", SubnetID: "subnet-b", Zone: "ap-beijing-7", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 2, ReservationState: core.VPCShardSubnetReservationExhausted, NearWaterline: true},
	})
	if err != nil {
		t.Fatalf("ReplaceVPCShardSubnets: %v", err)
	}

	newShard, created, err := svc.ReconcileVPCShardHeadroom(ctx, provider.NewMockCloudProvider(), core.TemplateClass{ID: "tc-exhausted", Region: "ap-beijing"}, AutoscaleTarget{
		TemplateClass: core.TemplateClass{ID: "tc-exhausted", Region: "ap-beijing"},
		SKU:           core.SKU{ID: "sku-exhausted", NetworkTemplateID: "net-a"},
	}, path)
	if err != nil {
		t.Fatalf("ReconcileVPCShardHeadroom: %v", err)
	}
	if !created {
		t.Fatalf("expected new shard creation")
	}
	if newShard.ID == shard.ID || newShard.ActiveSubnetMemberID == "" {
		t.Fatalf("expected a new active shard, got %+v", newShard)
	}
	lock, acquired, err := svc.TryStartVPCShardCreate(ctx, newShard.BlueprintFingerprint, "ap-beijing")
	if err != nil {
		t.Fatalf("TryStartVPCShardCreate after exhausted create: %v", err)
	}
	if !acquired {
		t.Fatalf("expected create lock to be released after exhausted-shard reconcile, got %+v", lock)
	}
}

func TestReconcileVPCShardHeadroomReleasesLockOnProvisionFailure(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	path := writeStaticBlueprint(t, t.TempDir())

	_, _, err := svc.ReconcileVPCShardHeadroom(ctx, fakeVPCShardProvisioner{
		err: &provider.VPCShardProvisionError{
			Err:      context.DeadlineExceeded,
			LastStep: "create_vpc",
		},
	}, core.TemplateClass{
		ID:     "tc-fail-lock",
		Region: "ap-beijing",
	}, AutoscaleTarget{
		TemplateClass: core.TemplateClass{ID: "tc-fail-lock", Region: "ap-beijing"},
		SKU:           core.SKU{ID: "sku-fail-lock", NetworkTemplateID: "net-a"},
	}, path)
	if err == nil {
		t.Fatalf("expected reconcile failure")
	}

	lock, acquired, lockErr := svc.TryStartVPCShardCreate(ctx, blueprint.StaticBlueprintFingerprint(mustLoadStaticBlueprintForTest(t, path)), "ap-beijing")
	if lockErr != nil {
		t.Fatalf("TryStartVPCShardCreate after failure: %v", lockErr)
	}
	if !acquired {
		t.Fatalf("expected lock to be released after failed provision, got %+v", lock)
	}
}

func TestProvisionAndPersistVPCShard(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	path := writeStaticBlueprint(t, t.TempDir())
	snapshot, err := svc.EnsureVPCShardBlueprintSnapshot(ctx, path)
	if err != nil {
		t.Fatalf("EnsureVPCShardBlueprintSnapshot: %v", err)
	}
	shard, err := svc.ProvisionAndPersistVPCShard(ctx, provider.NewMockCloudProvider(), snapshot, "tc-9", core.SKU{
		ID:                "sku-9",
		NetworkTemplateID: "net-a",
	})
	if err != nil {
		t.Fatalf("ProvisionAndPersistVPCShard: %v", err)
	}
	if shard.BlueprintSnapshotID != snapshot.ID || shard.BlueprintFingerprint != snapshot.BlueprintFingerprint {
		t.Fatalf("unexpected shard linkage after provision: %+v", shard)
	}
	if shard.VpcID == "" {
		t.Fatalf("expected persisted vpc id")
	}
	subnets, err := svc.ListVPCShardSubnets(ctx, shard.ID)
	if err != nil {
		t.Fatalf("ListVPCShardSubnets: %v", err)
	}
	if len(subnets) < 2 {
		t.Fatalf("expected support + workload subnets, got %d", len(subnets))
	}
	progress, err := svc.GetVPCShardProvisionProgress(ctx, shard.ID)
	if err != nil {
		t.Fatalf("GetVPCShardProvisionProgress: %v", err)
	}
	if progress.Status != core.VPCShardProvisionProgressStatusCompleted || progress.CompletedAt == nil {
		t.Fatalf("unexpected completed progress: %+v", progress)
	}
}

func mustLoadStaticBlueprintForTest(t *testing.T, path string) blueprint.StaticVPCShardBlueprint {
	t.Helper()
	bp, err := blueprint.LoadStaticVPCShardBlueprint(path)
	if err != nil {
		t.Fatalf("LoadStaticVPCShardBlueprint: %v", err)
	}
	return bp
}

func TestProvisionAndPersistVPCShardPersistsFailureProgressAndCleanupPending(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	path := writeStaticBlueprint(t, t.TempDir())
	snapshot, err := svc.EnsureVPCShardBlueprintSnapshot(ctx, path)
	if err != nil {
		t.Fatalf("EnsureVPCShardBlueprintSnapshot: %v", err)
	}
	_, err = svc.ProvisionAndPersistVPCShard(ctx, fakeVPCShardProvisioner{
		err: &provider.VPCShardProvisionError{
			Err:      context.DeadlineExceeded,
			LastStep: "create_support_subnet",
			PartialResult: provider.VPCShardProvisionResult{
				VpcID: "vpc-partial",
				SupportSubnet: core.VPCShardSubnet{
					SubnetID:         "subnet-support-partial",
					Zone:             "ap-beijing-8",
					Role:             core.VPCShardSubnetRoleSupport,
					Ordinal:          0,
					ReservationState: core.VPCShardSubnetReservationAvailable,
				},
				CleanupResources: []core.VPCShardCleanupResource{
					{ResourceType: core.VPCShardCleanupResourceTypeVPC, ResourceID: "vpc-partial"},
					{ResourceType: core.VPCShardCleanupResourceTypeSubnet, ResourceID: "subnet-support-partial"},
				},
			},
		},
	}, snapshot, "tc-fail", core.SKU{ID: "sku-fail", NetworkTemplateID: "net-a"})
	if err == nil {
		t.Fatalf("expected provision failure")
	}
	shards, err := svc.ListVPCShards(ctx)
	if err != nil {
		t.Fatalf("ListVPCShards: %v", err)
	}
	if len(shards) != 1 {
		t.Fatalf("expected one provisional shard, got %d", len(shards))
	}
	progress, err := svc.GetVPCShardProvisionProgress(ctx, shards[0].ID)
	if err != nil {
		t.Fatalf("GetVPCShardProvisionProgress: %v", err)
	}
	if progress.Status != core.VPCShardProvisionProgressStatusFailed || progress.LastStep != "create_support_subnet" {
		t.Fatalf("unexpected failed progress: %+v", progress)
	}
	shard, err := svc.GetVPCShard(ctx, shards[0].ID)
	if err != nil {
		t.Fatalf("GetVPCShard: %v", err)
	}
	if shard.State != core.VPCShardStateCleanupPending || shard.VpcID != "vpc-partial" {
		t.Fatalf("unexpected failed shard state: %+v", shard)
	}
	cleanup, err := svc.ListVPCShardCleanupResources(ctx, shard.ID)
	if err != nil {
		t.Fatalf("ListVPCShardCleanupResources: %v", err)
	}
	if len(cleanup) != 2 {
		t.Fatalf("expected partial cleanup resources, got %+v", cleanup)
	}
}

func TestActiveShardSubnetForSKUPrefersPersistedShardState(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	shard, err := svc.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  "snap-5",
		BlueprintFingerprint: "fp-5",
		TemplateClassID:      "tc-5",
		SKUID:                "sku-5",
		NetworkTemplateID:    "net-e",
		Region:               "ap-beijing",
		VpcID:                "vpc-shard",
		State:                core.VPCShardStateActive,
		ActiveSubnetMemberID: "subnet-member-b",
	})
	if err != nil {
		t.Fatalf("UpsertVPCShard: %v", err)
	}
	_, err = svc.ReplaceVPCShardSubnets(ctx, shard.ID, []core.VPCShardSubnet{
		{ID: "subnet-member-a", SubnetID: "subnet-a", Zone: "ap-beijing-8", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 1, ReservationState: core.VPCShardSubnetReservationAvailable},
		{ID: "subnet-member-b", SubnetID: "subnet-b", Zone: "ap-beijing-7", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 2, ReservationState: core.VPCShardSubnetReservationActive},
	})
	if err != nil {
		t.Fatalf("ReplaceVPCShardSubnets: %v", err)
	}
	gotShard, gotSubnet, ok, err := svc.ActiveShardSubnetForSKU(ctx, "tc-5", "sku-5")
	if err != nil {
		t.Fatalf("ActiveShardSubnetForSKU: %v", err)
	}
	if !ok {
		t.Fatalf("expected active shard subnet")
	}
	if gotShard.VpcID != "vpc-shard" || gotSubnet.SubnetID != "subnet-b" || gotSubnet.Zone != "ap-beijing-7" {
		t.Fatalf("unexpected shard/subnet result: shard=%+v subnet=%+v", gotShard, gotSubnet)
	}
}

func TestBuildWarmCapacityBundleProvisionRequestUsesActiveShardSubnet(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	shard, err := svc.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  "snap-6",
		BlueprintFingerprint: "fp-6",
		TemplateClassID:      "tc-6",
		SKUID:                "sku-6",
		NetworkTemplateID:    "net-f",
		Region:               "ap-beijing",
		VpcID:                "vpc-from-shard",
		State:                core.VPCShardStateActive,
		ActiveSubnetMemberID: "subnet-member-active",
	})
	if err != nil {
		t.Fatalf("UpsertVPCShard: %v", err)
	}
	_, err = svc.ReplaceVPCShardSubnets(ctx, shard.ID, []core.VPCShardSubnet{
		{
			ID:               "subnet-member-active",
			SubnetID:         "subnet-from-shard",
			Zone:             "ap-beijing-7",
			Role:             core.VPCShardSubnetRoleWorkload,
			Ordinal:          1,
			ReservationState: core.VPCShardSubnetReservationActive,
		},
	})
	if err != nil {
		t.Fatalf("ReplaceVPCShardSubnets: %v", err)
	}
	req, err := svc.BuildWarmCapacityBundleProvisionRequest(ctx, core.TemplateClass{ID: "tc-6", Region: "ap-beijing"}, AutoscaleTarget{
		TemplateClass: core.TemplateClass{ID: "tc-6", Region: "ap-beijing"},
		SKU:           core.SKU{ID: "sku-6", NetworkTemplateID: "net-f"},
	}, nil)
	if err != nil {
		t.Fatalf("BuildWarmCapacityBundleProvisionRequest: %v", err)
	}
	if req.SourceVpcID != "vpc-from-shard" || req.SourceSubnetID != "subnet-from-shard" || req.Zone != "ap-beijing-7" {
		t.Fatalf("expected request to use active shard subnet, got %+v", req)
	}
}

func TestEnsureWarmBundleFromActiveShardSubnetAddsShardLineage(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	shard, err := svc.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  "snap-7",
		BlueprintFingerprint: "fp-7",
		TemplateClassID:      "tc-7",
		SKUID:                "sku-7",
		NetworkTemplateID:    "net-g",
		Region:               "ap-beijing",
		VpcID:                "vpc-from-shard",
		State:                core.VPCShardStateActive,
		ActiveSubnetMemberID: "subnet-member-active",
	})
	if err != nil {
		t.Fatalf("UpsertVPCShard: %v", err)
	}
	_, err = svc.ReplaceVPCShardSubnets(ctx, shard.ID, []core.VPCShardSubnet{
		{
			ID:               "subnet-member-active",
			SubnetID:         "subnet-from-shard",
			Zone:             "ap-beijing-7",
			Role:             core.VPCShardSubnetRoleWorkload,
			Ordinal:          1,
			ReservationState: core.VPCShardSubnetReservationActive,
		},
	})
	if err != nil {
		t.Fatalf("ReplaceVPCShardSubnets: %v", err)
	}
	target := AutoscaleTarget{
		TemplateClass: core.TemplateClass{ID: "tc-7", Region: "ap-beijing"},
		SKU:           core.SKU{ID: "sku-7", NetworkTemplateID: "net-g"},
	}
	bundle, err := svc.EnsureWarmBundleFromActiveShardSubnet(ctx, target.TemplateClass, target, provider.NewMockCloudProvider(), nil)
	if err != nil {
		t.Fatalf("EnsureWarmBundleFromActiveShardSubnet: %v", err)
	}
	if bundle.LineageTags["vpc_shard_id"] != shard.ID || bundle.LineageTags["subnet_member_id"] != "subnet-member-active" || bundle.LineageTags["blueprint_snapshot_id"] != "snap-7" {
		t.Fatalf("unexpected shard lineage tags: %+v", bundle.LineageTags)
	}
}

func TestBuildWarmCapacityBundleProvisionRequestFallsBackWithoutActiveShard(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	req, err := svc.BuildWarmCapacityBundleProvisionRequest(ctx, core.TemplateClass{ID: "tc-8", Region: "ap-beijing"}, AutoscaleTarget{
		TemplateClass: core.TemplateClass{ID: "tc-8", Region: "ap-beijing"},
		SKU:           core.SKU{ID: "sku-8", NetworkTemplateID: "net-h"},
	}, []core.Pool{
		{
			ID:             "pool-1",
			VpcID:          "vpc-from-pool",
			SubnetID:       "subnet-from-pool",
			Zone:           "ap-beijing-8",
			SecurityGroups: []string{"sg-from-pool"},
		},
	})
	if err != nil {
		t.Fatalf("BuildWarmCapacityBundleProvisionRequest: %v", err)
	}
	if req.SourceVpcID != "vpc-from-pool" || req.SourceSubnetID != "subnet-from-pool" || req.Zone != "ap-beijing-8" {
		t.Fatalf("expected fallback pool-derived source network, got %+v", req)
	}
	if len(req.SourceSecurityGroupIDs) != 1 || req.SourceSecurityGroupIDs[0] != "sg-from-pool" {
		t.Fatalf("expected fallback pool-derived security groups, got %+v", req.SourceSecurityGroupIDs)
	}
}
