package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/store"
)

const (
	testVpcID                  = "vpc-test"
	testSubnetID               = "subnet-test"
	testZone                   = "ap-beijing-8"
	hermesFallbackInstanceType = "SA9.MEDIUM2"
)

var testSecurityGroups = []string{"sg-test"}

func TestLifecycleTransitions(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	pool, err := svc.CreatePool(ctx, "blue", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	instances, err := svc.RefillVerified(ctx, pool.ID, 2, nil, nil, verifyOK)
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	if len(instances) != 2 {
		t.Fatalf("expected 2 instances, got %d", len(instances))
	}
	inst, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if inst.State != core.StateAllocated {
		t.Fatalf("expected allocated state, got %s", inst.State)
	}

	inst, err = svc.Release(ctx, inst.ID)
	if err != nil {
		t.Fatalf("release: %v", err)
	}
	if inst.State != core.StateDry {
		t.Fatalf("expected DRY after release, got %s", inst.State)
	}

	inst, err = svc.AdvanceState(ctx, inst.ID, core.StateResetting)
	if err != nil {
		t.Fatalf("advance to resetting: %v", err)
	}
	inst, err = svc.AdvanceState(ctx, inst.ID, core.StateClean)
	if err != nil {
		t.Fatalf("advance to clean: %v", err)
	}
	if inst.State != core.StateClean {
		t.Fatalf("expected CLEAN after reset, got %s", inst.State)
	}
}

func TestAllocateWithoutInventory(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "empty", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	_, err = svc.Allocate(ctx, pool.ID)
	if err == nil {
		t.Fatalf("expected error when allocating with no inventory")
	}
	if err != core.ErrNoCleanInstance {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestAllocateAnyUsesAnyPoolWithCapacity(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	if _, err := svc.CreatePool(ctx, "empty", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups); err != nil {
		t.Fatalf("create empty pool: %v", err)
	}
	targetPool, err := svc.CreatePool(ctx, "target", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create target pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, targetPool.ID, 1, []string{"10.0.0.10"}, []string{"cloud-1"}, verifyOK); err != nil {
		t.Fatalf("refill target pool: %v", err)
	}

	pool, inst, err := svc.AllocateAny(ctx, 10)
	if err != nil {
		t.Fatalf("allocate any: %v", err)
	}
	if pool.ID != targetPool.ID {
		t.Fatalf("expected target pool %s, got %s", targetPool.ID, pool.ID)
	}
	if inst.State != core.StateAllocated {
		t.Fatalf("expected allocated instance, got %s", inst.State)
	}
}

func TestAllocateAnyWithoutCapacity(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	if _, err := svc.CreatePool(ctx, "empty-a", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups); err != nil {
		t.Fatalf("create pool a: %v", err)
	}
	if _, err := svc.CreatePool(ctx, "empty-b", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups); err != nil {
		t.Fatalf("create pool b: %v", err)
	}

	_, _, err := svc.AllocateAny(ctx, 10)
	if err != core.ErrNoCleanInstance {
		t.Fatalf("expected no clean instance, got %v", err)
	}
}

func TestInvalidReleaseTransition(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "bad", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 1, nil, nil, verifyOK)
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	if _, err := svc.Release(ctx, insts[0].ID); err == nil {
		t.Fatalf("expected invalid transition when releasing non-allocated")
	}
}

// TestReleasePausedToDry ensures Release accepts PAUSED → DRY so the trade pass
// destroy flow can release an isolated sandbox back into the reset pool. Without
// this transition, DeleteSandboxesSandboxID would leak the instance in PAUSED
// forever (the reset worker only sweeps DRY/RESETTING).
func TestReleasePausedToDry(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "paused-release", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, pool.ID, 1, nil, nil, verifyOK); err != nil {
		t.Fatalf("refill: %v", err)
	}
	alloc, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if _, err := svc.Pause(ctx, alloc.ID); err != nil {
		t.Fatalf("pause: %v", err)
	}
	paused, err := svc.MarkPaused(ctx, alloc.ID)
	if err != nil {
		t.Fatalf("mark paused: %v", err)
	}
	if paused.State != core.StatePaused {
		t.Fatalf("expected PAUSED before release, got %s", paused.State)
	}

	released, err := svc.Release(ctx, alloc.ID)
	if err != nil {
		t.Fatalf("release from paused: %v", err)
	}
	if released.State != core.StateDry {
		t.Fatalf("expected DRY after release from paused, got %s", released.State)
	}
}

// TestReleaseDryIdempotent ensures Release on a DRY instance is a no-op so
// callers retrying a partially-failed sandbox delete do not see spurious
// invalid-transition errors.
func TestReleaseDryIdempotent(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "dry-release", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, pool.ID, 1, nil, nil, verifyOK); err != nil {
		t.Fatalf("refill: %v", err)
	}
	alloc, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if _, err := svc.Release(ctx, alloc.ID); err != nil {
		t.Fatalf("first release: %v", err)
	}
	got, err := svc.Release(ctx, alloc.ID)
	if err != nil {
		t.Fatalf("second release on DRY should be idempotent, got %v", err)
	}
	if got.State != core.StateDry {
		t.Fatalf("expected DRY after idempotent release, got %s", got.State)
	}
}

// TestReleasePausingRejected ensures Release does not skip over the in-flight
// PAUSING state. PAUSING is a transient cloud-side stop window and must never
// be released directly; the caller has to settle into PAUSED (or roll back to
// ALLOCATED) first.
func TestReleasePausingRejected(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "pausing-release", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, pool.ID, 1, nil, nil, verifyOK); err != nil {
		t.Fatalf("refill: %v", err)
	}
	alloc, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if _, err := svc.Pause(ctx, alloc.ID); err != nil {
		t.Fatalf("pause: %v", err)
	}
	if _, err := svc.Release(ctx, alloc.ID); !errors.Is(err, core.ErrInvalidTransition) {
		t.Fatalf("expected ErrInvalidTransition releasing PAUSING, got %v", err)
	}
}

func TestAdvanceStateInvalidTransition(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "adv", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 1, nil, nil, verifyOK)
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	// CLEAN -> RESETTING is not allowed directly.
	if _, err := svc.AdvanceState(ctx, insts[0].ID, core.StateResetting); err == nil {
		t.Fatalf("expected invalid transition")
	}
}

func TestMultipleAllocationsConsumeInventory(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "multi", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, pool.ID, 1, nil, nil, verifyOK); err != nil {
		t.Fatalf("refill: %v", err)
	}
	if _, err := svc.Allocate(ctx, pool.ID); err != nil {
		t.Fatalf("first allocate: %v", err)
	}
	if _, err := svc.Allocate(ctx, pool.ID); err != core.ErrNoCleanInstance {
		t.Fatalf("expected no clean instance error, got %v", err)
	}
}

func TestRefillWithAddresses(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "addr", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	addresses := []string{"192.168.0.10", "192.168.0.11"}
	insts, err := svc.RefillVerified(ctx, pool.ID, 0, addresses, nil, verifyOK)
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	if insts[0].Address != addresses[0] || insts[1].Address != addresses[1] {
		t.Fatalf("addresses not applied")
	}
}

func TestRefillWithCloudIDs(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "cloud", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	cloudIDs := []string{"c-1", "c-2", "c-3"}
	insts, err := svc.RefillVerified(ctx, pool.ID, 0, nil, cloudIDs, verifyOK)
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	if len(insts) != len(cloudIDs) {
		t.Fatalf("expected %d instances", len(cloudIDs))
	}
	for i, inst := range insts {
		if inst.CloudID != cloudIDs[i] {
			t.Fatalf("cloudID mismatch at %d", i)
		}
	}
}

func TestCreatePoolRequiresNetworkConfig(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	if _, err := svc.CreatePool(ctx, "missing-net", "", "img-test", 0, "", testSubnetID, testZone, testSecurityGroups); err == nil {
		t.Fatalf("expected create pool to fail without vpc_id")
	}
}

func TestCreatePoolRequiresBaseImage(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	if _, err := svc.CreatePool(ctx, "missing-image", "", "", 0, testVpcID, testSubnetID, testZone, testSecurityGroups); err == nil {
		t.Fatalf("expected create pool to fail without base_image")
	}
}

func TestCreatePoolRequiresSecurityGroups(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	if _, err := svc.CreatePool(ctx, "missing-sg", "", "img-test", 0, testVpcID, testSubnetID, testZone, nil); err == nil {
		t.Fatalf("expected create pool to fail without security_groups")
	}
}

func TestAllocateForRequestUsesSandboxPrimaryBindings(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	poolA, err := svc.CreatePool(ctx, "pool-a", "", "img-a", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool a: %v", err)
	}
	poolA.TemplateClassID = "openclaw-default"
	if _, err := svc.UpdatePool(ctx, poolA); err != nil {
		t.Fatalf("update pool a: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, poolA.ID, 1, []string{"10.0.0.10"}, []string{"cloud-1"}, verifyOK); err != nil {
		t.Fatalf("refill pool a: %v", err)
	}

	templateClass, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	})
	if err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if templateClass.ResolutionMode != core.ResolutionModeSandboxPrimary {
		t.Fatalf("unexpected resolution mode: %s", templateClass.ResolutionMode)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: "openclaw-default",
		PoolID:          poolA.ID,
		AdmissionState:  core.BindingAdmissionStateActive,
	}); err != nil {
		t.Fatalf("upsert template pool binding: %v", err)
	}

	resolution, err := svc.AllocateForRequest(ctx, "openclaw-default", "", "")
	if err != nil {
		t.Fatalf("allocate for request: %v", err)
	}
	if resolution.Pool.ID != poolA.ID {
		t.Fatalf("expected resolved pool %s, got %s", poolA.ID, resolution.Pool.ID)
	}
	if resolution.ResolutionSource != "sandbox_binding" {
		t.Fatalf("expected sandbox_binding source, got %q", resolution.ResolutionSource)
	}
}

func TestResolveTemplateClassPoolsUsesSKUBindingsWhenPresent(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-default",
		Name:            "Default SKU",
		TemplateClassID: "openclaw-default",
		BaseImage:       "img-base",
		DesiredImageID:  "img-base",
		StableImageID:   "img-base",
		InstanceType:    hermesFallbackInstanceType,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	pool, err := svc.CreatePool(ctx, "pool-a", "", "img-base", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	pool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("update pool: %v", err)
	}
	if _, err := svc.UpsertTemplateSkuBinding(ctx, core.TemplateSkuBinding{
		TemplateClassID:    "openclaw-default",
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}); err != nil {
		t.Fatalf("upsert template sku binding: %v", err)
	}
	templateClass, bindings, pools, err := svc.ResolveTemplateClassPools(ctx, "openclaw-default")
	if err != nil {
		t.Fatalf("resolve template class pools: %v", err)
	}
	if templateClass.ID != "openclaw-default" {
		t.Fatalf("unexpected template class: %+v", templateClass)
	}
	if len(bindings) != 0 {
		t.Fatalf("expected no legacy pool bindings required, got %+v", bindings)
	}
	if len(pools) != 1 || pools[0].ID != pool.ID {
		t.Fatalf("expected pool resolved from SKU binding, got %+v", pools)
	}
}

func TestAllocateForRequestHermesDefaultsToLargeSKU(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             hermesTemplateClassID,
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-hermes-2c4g",
		Name:            "Hermes 2C4G",
		TemplateClassID: hermesTemplateClassID,
		BaseImage:       "img-small",
		DesiredImageID:  "img-small",
		StableImageID:   "img-small",
		InstanceType:    hermesFallbackInstanceType,
	}); err != nil {
		t.Fatalf("upsert small sku: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-hermes-4c8g",
		Name:            "Hermes 4C8G",
		TemplateClassID: hermesTemplateClassID,
		BaseImage:       "img-large",
		DesiredImageID:  "img-large",
		StableImageID:   "img-large",
		InstanceType:    hermesPreferredInstanceType,
	}); err != nil {
		t.Fatalf("upsert large sku: %v", err)
	}

	smallPool, err := svc.CreatePool(ctx, "hermes-small", "", "img-small", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create small pool: %v", err)
	}
	smallPool.SKUID = "sku-hermes-2c4g"
	if _, err := svc.UpdatePool(ctx, smallPool); err != nil {
		t.Fatalf("update small pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, smallPool.ID, 1, []string{"10.0.0.41"}, []string{"cloud-small"}, verifyOK); err != nil {
		t.Fatalf("refill small pool: %v", err)
	}

	largePool, err := svc.CreatePool(ctx, "hermes-large", "", "img-large", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create large pool: %v", err)
	}
	largePool.SKUID = "sku-hermes-4c8g"
	if _, err := svc.UpdatePool(ctx, largePool); err != nil {
		t.Fatalf("update large pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, largePool.ID, 1, []string{"10.0.0.42"}, []string{"cloud-large"}, verifyOK); err != nil {
		t.Fatalf("refill large pool: %v", err)
	}

	if _, err := svc.UpsertTemplateSkuBinding(ctx, core.TemplateSkuBinding{
		TemplateClassID:    hermesTemplateClassID,
		SKUID:              "sku-hermes-2c4g",
		Priority:           99,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}); err != nil {
		t.Fatalf("upsert small binding: %v", err)
	}
	if _, err := svc.UpsertTemplateSkuBinding(ctx, core.TemplateSkuBinding{
		TemplateClassID:    hermesTemplateClassID,
		SKUID:              "sku-hermes-4c8g",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}); err != nil {
		t.Fatalf("upsert large binding: %v", err)
	}

	resolution, err := svc.AllocateForRequest(ctx, hermesTemplateClassID, "", "")
	if err != nil {
		t.Fatalf("allocate for request: %v", err)
	}
	if resolution.Pool.ID != largePool.ID {
		t.Fatalf("expected hermes default pool %s, got %s", largePool.ID, resolution.Pool.ID)
	}
	if resolution.SKUID != "sku-hermes-4c8g" {
		t.Fatalf("expected hermes default sku sku-hermes-4c8g, got %q", resolution.SKUID)
	}

	fallback, err := svc.AllocateForRequest(ctx, hermesTemplateClassID, "", "")
	if err != nil {
		t.Fatalf("allocate fallback request: %v", err)
	}
	if fallback.Pool.ID != smallPool.ID {
		t.Fatalf("expected hermes fallback pool %s, got %s", smallPool.ID, fallback.Pool.ID)
	}
	if fallback.SKUID != "sku-hermes-2c4g" {
		t.Fatalf("expected hermes fallback sku sku-hermes-2c4g, got %q", fallback.SKUID)
	}
}

func TestAllocateForRequestRespectsRequestedSKU(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             hermesTemplateClassID,
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	for _, sku := range []core.SKU{
		{
			ID:              "sku-hermes-2c4g",
			Name:            "Hermes 2C4G",
			TemplateClassID: hermesTemplateClassID,
			BaseImage:       "img-small",
			DesiredImageID:  "img-small",
			StableImageID:   "img-small",
			InstanceType:    hermesFallbackInstanceType,
		},
		{
			ID:              "sku-hermes-4c8g",
			Name:            "Hermes 4C8G",
			TemplateClassID: hermesTemplateClassID,
			BaseImage:       "img-large",
			DesiredImageID:  "img-large",
			StableImageID:   "img-large",
			InstanceType:    hermesPreferredInstanceType,
		},
	} {
		if _, err := svc.UpsertSKU(ctx, sku); err != nil {
			t.Fatalf("upsert sku %s: %v", sku.ID, err)
		}
		if _, err := svc.UpsertTemplateSkuBinding(ctx, core.TemplateSkuBinding{
			TemplateClassID:    hermesTemplateClassID,
			SKUID:              sku.ID,
			Priority:           1,
			Weight:             1,
			AdmissionState:     "active",
			RolloutEligibility: true,
		}); err != nil {
			t.Fatalf("upsert binding %s: %v", sku.ID, err)
		}
	}

	smallPool, err := svc.CreatePool(ctx, "hermes-small", "", "img-small", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create small pool: %v", err)
	}
	smallPool.SKUID = "sku-hermes-2c4g"
	if _, err := svc.UpdatePool(ctx, smallPool); err != nil {
		t.Fatalf("update small pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, smallPool.ID, 1, []string{"10.0.0.51"}, []string{"cloud-small"}, verifyOK); err != nil {
		t.Fatalf("refill small pool: %v", err)
	}

	largePool, err := svc.CreatePool(ctx, "hermes-large", "", "img-large", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create large pool: %v", err)
	}
	largePool.SKUID = "sku-hermes-4c8g"
	if _, err := svc.UpdatePool(ctx, largePool); err != nil {
		t.Fatalf("update large pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, largePool.ID, 1, []string{"10.0.0.52"}, []string{"cloud-large"}, verifyOK); err != nil {
		t.Fatalf("refill large pool: %v", err)
	}

	resolution, err := svc.AllocateForRequest(ctx, hermesTemplateClassID, "", "sku-hermes-2c4g")
	if err != nil {
		t.Fatalf("allocate for request: %v", err)
	}
	if resolution.Pool.ID != smallPool.ID {
		t.Fatalf("expected requested sku pool %s, got %s", smallPool.ID, resolution.Pool.ID)
	}
	if resolution.SKUID != "sku-hermes-2c4g" {
		t.Fatalf("expected requested sku sku-hermes-2c4g, got %q", resolution.SKUID)
	}
}

func TestAllocateForRequestRequestedSKUWithoutBindingsFails(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             hermesTemplateClassID,
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-hermes-4c8g",
		Name:            "Hermes 4C8G",
		TemplateClassID: hermesTemplateClassID,
		BaseImage:       "img-large",
		DesiredImageID:  "img-large",
		StableImageID:   "img-large",
		InstanceType:    hermesPreferredInstanceType,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}

	_, err := svc.AllocateForRequest(ctx, hermesTemplateClassID, "", "sku-hermes-4c8g")
	if !errors.Is(err, core.ErrSKUNotFound) {
		t.Fatalf("expected requested sku without bindings to fail with ErrSKUNotFound, got %v", err)
	}
}

func TestAllocateForRequestSandboxPrimaryDoesNotFallbackToLegacyWhenSKUBindingsExistButNoEligiblePools(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-default",
		Name:            "Default SKU",
		TemplateClassID: "openclaw-default",
		BaseImage:       "img-base",
		DesiredImageID:  "img-base",
		StableImageID:   "img-base",
		InstanceType:    hermesFallbackInstanceType,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	legacyPool, err := svc.CreatePool(ctx, "legacy-pool", "", "img-base", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create legacy pool: %v", err)
	}
	legacyPool.Status = core.PoolStatusPaused
	if _, err := svc.UpdatePool(ctx, legacyPool); err != nil {
		t.Fatalf("pause legacy pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, legacyPool.ID, 1, []string{"10.0.0.31"}, []string{"cloud-legacy"}, verifyOK); err != nil {
		t.Fatalf("refill legacy pool: %v", err)
	}
	boundPool, err := svc.CreatePool(ctx, "bound-pool", "", "img-base", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create bound pool: %v", err)
	}
	boundPool.SKUID = "sku-default"
	boundPool.CapacityState = core.PoolCapacityStateQuarantined
	if _, err := svc.UpdatePool(ctx, boundPool); err != nil {
		t.Fatalf("update bound pool: %v", err)
	}
	if _, err := svc.UpsertTemplateSkuBinding(ctx, core.TemplateSkuBinding{
		TemplateClassID:    "openclaw-default",
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}); err != nil {
		t.Fatalf("upsert template sku binding: %v", err)
	}

	_, err = svc.AllocateForRequest(ctx, "openclaw-default", legacyPool.ID, "")
	if !errors.Is(err, core.ErrNoCleanInstance) {
		t.Fatalf("expected no clean instance when sku bindings exist but no eligible pools, got %v", err)
	}
}

func TestAllocateForRequestUsesLegacyPoolInShadowModeAndRecordsDivergence(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	poolLegacy, err := svc.CreatePool(ctx, "pool-legacy", "", "img-legacy", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create legacy pool: %v", err)
	}
	poolBound, err := svc.CreatePool(ctx, "pool-bound", "", "img-bound", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create bound pool: %v", err)
	}
	for _, pool := range []core.Pool{poolLegacy, poolBound} {
		if _, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"10.0.0.10"}, []string{"cloud-" + pool.ID}, verifyOK); err != nil {
			t.Fatalf("refill %s: %v", pool.ID, err)
		}
	}

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeShadow,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: "openclaw-default",
		PoolID:          poolBound.ID,
		AdmissionState:  core.BindingAdmissionStateActive,
	}); err != nil {
		t.Fatalf("upsert template pool binding: %v", err)
	}

	resolution, err := svc.AllocateForRequest(ctx, "openclaw-default", poolLegacy.ID, "")
	if err != nil {
		t.Fatalf("allocate for request: %v", err)
	}
	if resolution.Pool.ID != poolLegacy.ID {
		t.Fatalf("expected legacy pool %s, got %s", poolLegacy.ID, resolution.Pool.ID)
	}
	if resolution.ResolutionSource != "shadow_legacy" {
		t.Fatalf("expected shadow_legacy source, got %q", resolution.ResolutionSource)
	}
	if resolution.Divergence == "" {
		t.Fatal("expected divergence message when legacy pool is outside active bindings")
	}
}

func TestAllocateForRequestSandboxPrimaryDoesNotFallbackToPausedLegacyPoolWhenBindingsExist(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	legacyPool, err := svc.CreatePool(ctx, "legacy", "", "img-legacy", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create legacy pool: %v", err)
	}
	bindingPool, err := svc.CreatePool(ctx, "binding", "", "img-binding", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create binding pool: %v", err)
	}
	legacyPool.Status = core.PoolStatusPaused
	if _, err := svc.UpdatePool(ctx, legacyPool); err != nil {
		t.Fatalf("pause legacy pool: %v", err)
	}
	bindingPool.CapacityState = core.PoolCapacityStateQuarantined
	if _, err := svc.UpdatePool(ctx, bindingPool); err != nil {
		t.Fatalf("quarantine binding pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, legacyPool.ID, 1, []string{"10.0.0.21"}, []string{"cloud-legacy"}, verifyOK); err != nil {
		t.Fatalf("refill legacy pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, bindingPool.ID, 1, []string{"10.0.0.22"}, []string{"cloud-binding"}, verifyOK); err != nil {
		t.Fatalf("refill binding pool: %v", err)
	}
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: "openclaw-default",
		PoolID:          bindingPool.ID,
		AdmissionState:  core.BindingAdmissionStateActive,
	}); err != nil {
		t.Fatalf("upsert template binding: %v", err)
	}

	_, err = svc.AllocateForRequest(ctx, "openclaw-default", legacyPool.ID, "")
	if !errors.Is(err, core.ErrNoCleanInstance) {
		t.Fatalf("expected no clean instance due to authoritative sandbox governance, got %v", err)
	}
}

func TestReconcileTemplateBindingAdmissionsProjectsPoolState(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	activePool, err := svc.CreatePool(ctx, "active", "", "img-active", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create active pool: %v", err)
	}
	drainingPool, err := svc.CreatePool(ctx, "draining", "", "img-draining", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create draining pool: %v", err)
	}
	pausedPool, err := svc.CreatePool(ctx, "paused", "", "img-paused", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create paused pool: %v", err)
	}
	quarantinedPool, err := svc.CreatePool(ctx, "quarantined", "", "img-quarantined", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create quarantined pool: %v", err)
	}

	drainingPool.CapacityState = core.PoolCapacityStateDraining
	if _, err := svc.UpdatePool(ctx, drainingPool); err != nil {
		t.Fatalf("update draining pool: %v", err)
	}
	pausedPool.Status = core.PoolStatusPaused
	pausedPool.PauseReason = "manual"
	if _, err := svc.UpdatePool(ctx, pausedPool); err != nil {
		t.Fatalf("update paused pool: %v", err)
	}
	quarantinedPool.CapacityState = core.PoolCapacityStateQuarantined
	if _, err := svc.UpdatePool(ctx, quarantinedPool); err != nil {
		t.Fatalf("update quarantined pool: %v", err)
	}

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{ID: "openclaw-default"}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	for _, poolID := range []string{activePool.ID, drainingPool.ID, pausedPool.ID, quarantinedPool.ID} {
		if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
			TemplateClassID: "openclaw-default",
			PoolID:          poolID,
			AdmissionState:  core.BindingAdmissionStateActive,
		}); err != nil {
			t.Fatalf("upsert binding for %s: %v", poolID, err)
		}
	}

	updated, err := svc.ReconcileTemplateBindingAdmissions(ctx)
	if err != nil {
		t.Fatalf("reconcile bindings: %v", err)
	}
	if updated != 1 {
		t.Fatalf("expected one template class updated, got %d", updated)
	}

	bindings, err := svc.ListTemplatePoolBindings(ctx, "openclaw-default")
	if err != nil {
		t.Fatalf("list bindings: %v", err)
	}
	byPool := map[string]core.TemplatePoolBinding{}
	for _, binding := range bindings {
		byPool[binding.PoolID] = binding
	}
	if byPool[activePool.ID].AdmissionState != core.BindingAdmissionStateActive {
		t.Fatalf("expected active pool admission active, got %s", byPool[activePool.ID].AdmissionState)
	}
	if byPool[drainingPool.ID].AdmissionState != core.BindingAdmissionStateDraining {
		t.Fatalf("expected draining pool admission draining, got %s", byPool[drainingPool.ID].AdmissionState)
	}
	if byPool[pausedPool.ID].AdmissionState != core.BindingAdmissionStatePaused {
		t.Fatalf("expected paused pool admission paused, got %s", byPool[pausedPool.ID].AdmissionState)
	}
	if byPool[quarantinedPool.ID].AdmissionState != core.BindingAdmissionStateQuarantined {
		t.Fatalf("expected quarantined pool admission quarantined, got %s", byPool[quarantinedPool.ID].AdmissionState)
	}
}

func TestReconcileTemplateBindingAdmissionsPreservesManualPause(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	pool, err := svc.CreatePool(ctx, "active", "", "img-active", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{ID: "openclaw-default"}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: "openclaw-default",
		PoolID:          pool.ID,
		AdmissionState:  core.BindingAdmissionStatePaused,
		Reason:          "manual:operator pause",
	}); err != nil {
		t.Fatalf("upsert binding: %v", err)
	}

	updated, err := svc.ReconcileTemplateBindingAdmissions(ctx)
	if err != nil {
		t.Fatalf("reconcile bindings: %v", err)
	}
	if updated != 0 {
		t.Fatalf("expected no automatic override of manual pause, got %d updates", updated)
	}
	bindings, err := svc.ListTemplatePoolBindings(ctx, "openclaw-default")
	if err != nil {
		t.Fatalf("list bindings: %v", err)
	}
	if len(bindings) != 1 || bindings[0].AdmissionState != core.BindingAdmissionStatePaused {
		t.Fatalf("expected manual pause preserved, got %+v", bindings)
	}
}

func TestReconcileTemplateBindingAdmissionsReactivatesAutoPausedBinding(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	pool, err := svc.CreatePool(ctx, "active", "", "img-active", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{ID: "openclaw-default"}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: "openclaw-default",
		PoolID:          pool.ID,
		AdmissionState:  core.BindingAdmissionStatePaused,
		Reason:          "auto:pool paused",
	}); err != nil {
		t.Fatalf("upsert binding: %v", err)
	}

	updated, err := svc.ReconcileTemplateBindingAdmissions(ctx)
	if err != nil {
		t.Fatalf("reconcile bindings: %v", err)
	}
	if updated != 1 {
		t.Fatalf("expected one auto binding recovery, got %d", updated)
	}
	bindings, err := svc.ListTemplatePoolBindings(ctx, "openclaw-default")
	if err != nil {
		t.Fatalf("list bindings: %v", err)
	}
	if len(bindings) != 1 || bindings[0].AdmissionState != core.BindingAdmissionStateActive {
		t.Fatalf("expected auto paused binding to recover to active, got %+v", bindings)
	}
}

func TestCreatePoolDefaultsActiveStatusAndInstanceType(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	pool, err := svc.CreatePool(ctx, "defaults", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if pool.Status != core.PoolStatusActive {
		t.Fatalf("expected default pool status active, got %q", pool.Status)
	}
	if pool.InstanceType == "" {
		t.Fatalf("expected default instance_type to be set")
	}
}

func TestUpdatePoolRejectsInvalidStatus(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	pool, err := svc.CreatePool(ctx, "invalid-status", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	pool.Status = core.PoolStatus("broken")

	if _, err := svc.UpdatePool(ctx, pool); err == nil {
		t.Fatalf("expected update pool to reject invalid status")
	}
}

func TestUpdatePoolRequiresBaseImage(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	pool, err := svc.CreatePool(ctx, "missing-image-update", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	pool.BaseImage = ""

	if _, err := svc.UpdatePool(ctx, pool); err == nil {
		t.Fatalf("expected update pool to fail without base_image")
	}
}

func TestResolveTemplateClassPoolsFiltersToActiveBindingsAndPools(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	templateClass, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Name:           "OpenClaw Default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	})
	if err != nil {
		t.Fatalf("upsert template class: %v", err)
	}

	activePool, err := svc.CreatePool(ctx, "active", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create active pool: %v", err)
	}
	pausedPool, err := svc.CreatePool(ctx, "paused", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create paused pool: %v", err)
	}
	pausedPool.Status = core.PoolStatusPaused
	if _, err := svc.UpdatePool(ctx, pausedPool); err != nil {
		t.Fatalf("update paused pool: %v", err)
	}

	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: templateClass.ID,
		PoolID:          activePool.ID,
		Priority:        10,
		AdmissionState:  core.BindingAdmissionStateActive,
	}); err != nil {
		t.Fatalf("upsert active binding: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: templateClass.ID,
		PoolID:          pausedPool.ID,
		Priority:        20,
		AdmissionState:  core.BindingAdmissionStateActive,
	}); err != nil {
		t.Fatalf("upsert paused binding: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: templateClass.ID,
		PoolID:          "missing-pool",
		Priority:        30,
		AdmissionState:  core.BindingAdmissionStateActive,
	}); err == nil {
		t.Fatalf("expected missing pool binding to fail")
	}

	_, bindings, pools, err := svc.ResolveTemplateClassPools(ctx, templateClass.ID)
	if err != nil {
		t.Fatalf("resolve template class pools: %v", err)
	}
	if len(bindings) != 2 {
		t.Fatalf("expected 2 bindings, got %d", len(bindings))
	}
	if len(pools) != 1 {
		t.Fatalf("expected 1 active resolved pool, got %d", len(pools))
	}
	if pools[0].ID != activePool.ID {
		t.Fatalf("expected active pool %s, got %s", activePool.ID, pools[0].ID)
	}
}

func TestAllocateForRequestSupportsDualTrackResolution(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	legacyPool, err := svc.CreatePool(ctx, "legacy", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create legacy pool: %v", err)
	}
	bindingPool, err := svc.CreatePool(ctx, "binding", "", "img-test", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create binding pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, legacyPool.ID, 1, []string{"10.0.0.10"}, []string{"cloud-legacy"}, verifyOK); err != nil {
		t.Fatalf("refill legacy pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, bindingPool.ID, 1, []string{"10.0.0.11"}, []string{"cloud-binding"}, verifyOK); err != nil {
		t.Fatalf("refill binding pool: %v", err)
	}

	templateClass, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Name:           "OpenClaw Default",
		ResolutionMode: core.ResolutionModeShadow,
	})
	if err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: templateClass.ID,
		PoolID:          bindingPool.ID,
		Priority:        1,
		AdmissionState:  core.BindingAdmissionStateActive,
		CreatedAt:       time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert template binding: %v", err)
	}

	resolution, err := svc.AllocateForRequest(ctx, templateClass.ID, legacyPool.ID, "")
	if err != nil {
		t.Fatalf("allocate for request (shadow): %v", err)
	}
	if resolution.Pool.ID != legacyPool.ID {
		t.Fatalf("expected shadow mode to use legacy pool %s, got %s", legacyPool.ID, resolution.Pool.ID)
	}
	if resolution.ResolutionSource != "shadow_legacy" {
		t.Fatalf("expected shadow_legacy resolution source, got %s", resolution.ResolutionSource)
	}
	if resolution.Divergence == "" {
		t.Fatalf("expected divergence message when legacy pool differs from active bindings")
	}

	templateClass.ResolutionMode = core.ResolutionModeSandboxPrimary
	if _, err := svc.UpsertTemplateClass(ctx, templateClass); err != nil {
		t.Fatalf("update template class: %v", err)
	}

	resolution, err = svc.AllocateForRequest(ctx, templateClass.ID, legacyPool.ID, "")
	if err != nil {
		t.Fatalf("allocate for request (sandbox primary): %v", err)
	}
	if resolution.Pool.ID != bindingPool.ID {
		t.Fatalf("expected sandbox primary to use binding pool %s, got %s", bindingPool.ID, resolution.Pool.ID)
	}
	if resolution.ResolutionSource != "sandbox_binding" {
		t.Fatalf("expected sandbox_binding resolution source, got %s", resolution.ResolutionSource)
	}
}

func TestAllocateForRequestLegacyModeRequiresLegacyTemplateID(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Name:           "OpenClaw Default",
		ResolutionMode: core.ResolutionModeLegacy,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}

	if _, err := svc.AllocateForRequest(ctx, "openclaw-default", "", ""); err == nil {
		t.Fatalf("expected legacy resolution without templateID to fail")
	}
}

func TestEnsurePoolForCapacityBundleCreatesDerivedPoolAndBinding(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	sku, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                     "sku-default",
		Name:                   "Default SKU",
		TemplateClassID:        "openclaw-default",
		BaseImage:              "img-old",
		DesiredImageID:         "img-new",
		InstanceType:           "SA9.MEDIUM2",
		DefaultDesiredCapacity: 2,
	})
	if err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if sku.SystemDiskSize != 50 {
		t.Fatalf("expected omitted system disk size to default to 50, got %d", sku.SystemDiskSize)
	}
	binding := core.TemplateSkuBinding{
		TemplateClassID:    "openclaw-default",
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             2,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}
	if _, err := svc.UpsertCapacityBundle(ctx, core.CapacityBundle{
		ID:               "bundle-a",
		Region:           "ap-beijing",
		Zone:             testZone,
		VpcID:            testVpcID,
		SubnetID:         testSubnetID,
		SecurityGroupIDs: testSecurityGroups,
		Status:           core.CapacityBundleStatusWarm,
		LineageTags: map[string]string{
			"template_class_id": "openclaw-default",
			"sku_id":            "sku-default",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert bundle: %v", err)
	}

	pool, created, err := svc.EnsurePoolForCapacityBundle(ctx, binding, sku, "bundle-a")
	if err != nil {
		t.Fatalf("ensure pool for bundle: %v", err)
	}
	if !created {
		t.Fatalf("expected derived pool creation")
	}
	if pool.SKUID != "sku-default" {
		t.Fatalf("expected sku-default, got %q", pool.SKUID)
	}
	if pool.TemplateClassID != "openclaw-default" {
		t.Fatalf("expected template class binding on pool, got %q", pool.TemplateClassID)
	}
	if pool.BaseImage != "img-new" {
		t.Fatalf("expected desired image img-new, got %q", pool.BaseImage)
	}
	if pool.DesiredCap != 2 {
		t.Fatalf("expected desired capacity 2, got %d", pool.DesiredCap)
	}
	bindings, err := svc.ListTemplatePoolBindings(ctx, "openclaw-default")
	if err != nil {
		t.Fatalf("list template pool bindings: %v", err)
	}
	if len(bindings) != 1 || bindings[0].PoolID != pool.ID {
		t.Fatalf("expected derived pool binding, got %+v", bindings)
	}
	bundle, err := svc.GetCapacityBundle(ctx, "bundle-a")
	if err != nil {
		t.Fatalf("get bundle: %v", err)
	}
	if bundle.LineageTags["pool_id"] != pool.ID {
		t.Fatalf("expected bundle reserved to pool %s, got %+v", pool.ID, bundle.LineageTags)
	}
}

func TestUpsertSKUPreservesExistingSystemDiskSizeWhenOmitted(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-4c8g80g",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	sku, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-hermes-4c8g",
		TemplateClassID: "openclaw-4c8g80g",
		BaseImage:       "img-old",
		DesiredImageID:  "img-old",
		InstanceType:    "SA5.LARGE8",
		SystemDiskSize:  80,
	})
	if err != nil {
		t.Fatalf("create sku: %v", err)
	}

	sku.DesiredImageID = "img-new"
	sku.SystemDiskSize = 0
	updated, err := svc.UpsertSKU(ctx, sku)
	if err != nil {
		t.Fatalf("update sku: %v", err)
	}
	if updated.SystemDiskSize != 80 {
		t.Fatalf("expected omitted system disk size to preserve 80, got %d", updated.SystemDiskSize)
	}
}

func TestEnsurePoolForCapacityBundleRestoresBindingWithoutDuplicatePool(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	sku, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-default",
		Name:            "Default SKU",
		TemplateClassID: "openclaw-default",
		BaseImage:       "img-old",
		DesiredImageID:  "img-new",
		InstanceType:    "SA9.MEDIUM2",
	})
	if err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	binding := core.TemplateSkuBinding{
		TemplateClassID:    "openclaw-default",
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}
	if _, err := svc.UpsertCapacityBundle(ctx, core.CapacityBundle{
		ID:               "bundle-a",
		Region:           "ap-beijing",
		Zone:             testZone,
		VpcID:            testVpcID,
		SubnetID:         testSubnetID,
		SecurityGroupIDs: testSecurityGroups,
		Status:           core.CapacityBundleStatusWarm,
		LineageTags: map[string]string{
			"template_class_id": "openclaw-default",
			"sku_id":            "sku-default",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert bundle: %v", err)
	}

	pool, created, err := svc.EnsurePoolForCapacityBundle(ctx, binding, sku, "bundle-a")
	if err != nil || !created {
		t.Fatalf("initial ensure failed created=%v err=%v", created, err)
	}
	if err := svc.DeleteTemplatePoolBinding(ctx, "openclaw-default", pool.ID); err != nil {
		t.Fatalf("delete template pool binding: %v", err)
	}

	restored, created, err := svc.EnsurePoolForCapacityBundle(ctx, binding, sku, "bundle-a")
	if err != nil {
		t.Fatalf("ensure existing pool for bundle: %v", err)
	}
	if created {
		t.Fatalf("expected idempotent restore without creating a new pool")
	}
	if restored.ID != pool.ID {
		t.Fatalf("expected restored pool %s, got %s", pool.ID, restored.ID)
	}
	pools, err := svc.ListPoolsForSKU(ctx, "sku-default")
	if err != nil {
		t.Fatalf("list pools for sku: %v", err)
	}
	if len(pools) != 1 {
		t.Fatalf("expected exactly one pool after restore, got %d", len(pools))
	}
	bindings, err := svc.ListTemplatePoolBindings(ctx, "openclaw-default")
	if err != nil {
		t.Fatalf("list template pool bindings: %v", err)
	}
	if len(bindings) != 1 || bindings[0].PoolID != pool.ID {
		t.Fatalf("expected binding restored to original pool, got %+v", bindings)
	}
}

func TestEnsurePoolForCapacityBundleRejectsReservationConflict(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	sku, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-default",
		Name:            "Default SKU",
		TemplateClassID: "openclaw-default",
		BaseImage:       "img-old",
		DesiredImageID:  "img-new",
		InstanceType:    "SA9.MEDIUM2",
	})
	if err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	binding := core.TemplateSkuBinding{
		TemplateClassID:    "openclaw-default",
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}
	if _, err := svc.UpsertCapacityBundle(ctx, core.CapacityBundle{
		ID:               "bundle-a",
		Region:           "ap-beijing",
		Zone:             testZone,
		VpcID:            testVpcID,
		SubnetID:         testSubnetID,
		SecurityGroupIDs: testSecurityGroups,
		Status:           core.CapacityBundleStatusActive,
		LineageTags: map[string]string{
			"template_class_id": "openclaw-default",
			"sku_id":            "sku-other",
			"pool_id":           "pool-other",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert bundle: %v", err)
	}

	if _, _, err := svc.EnsurePoolForCapacityBundle(ctx, binding, sku, "bundle-a"); err == nil {
		t.Fatalf("expected reservation conflict to fail")
	}
}

// resumePathSetup pushes a freshly allocated instance through the pause path so
// resume-side tests start from PAUSED. Returns (svc, instanceID).
func resumePathSetup(t *testing.T) (*Service, string) {
	t.Helper()
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "renew-test", "", "img-test", 0, "vpc-r", "subnet-r", "ap-beijing-1", []string{"sg-r"})
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"10.0.0.50"}, []string{"ins-renew-1"}, verifyOK); err != nil {
		t.Fatalf("refill: %v", err)
	}
	inst, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if _, err := svc.Pause(ctx, inst.ID); err != nil {
		t.Fatalf("pause: %v", err)
	}
	if _, err := svc.MarkPaused(ctx, inst.ID); err != nil {
		t.Fatalf("mark paused: %v", err)
	}
	got, err := svc.GetInstance(ctx, inst.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StatePaused {
		t.Fatalf("expected PAUSED, got %s", got.State)
	}
	return svc, inst.ID
}

// TestResumeFromPaused asserts the PAUSED → RESUMING transition (R-F).
func TestResumeFromPaused(t *testing.T) {
	svc, instID := resumePathSetup(t)
	ctx := context.Background()

	got, err := svc.Resume(ctx, instID)
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if got.State != core.StateResuming {
		t.Fatalf("expected RESUMING after Resume, got %s", got.State)
	}
}

// TestResumeIdempotentFromResuming asserts that calling Resume on a RESUMING
// instance returns the current instance unchanged (no double transition).
func TestResumeIdempotentFromResuming(t *testing.T) {
	svc, instID := resumePathSetup(t)
	ctx := context.Background()
	if _, err := svc.Resume(ctx, instID); err != nil {
		t.Fatalf("first Resume: %v", err)
	}
	// Second call must be a no-op.
	got, err := svc.Resume(ctx, instID)
	if err != nil {
		t.Fatalf("idempotent Resume: %v", err)
	}
	if got.State != core.StateResuming {
		t.Fatalf("expected RESUMING preserved, got %s", got.State)
	}
}

// TestResumeIdempotentFromAllocated asserts that calling Resume on an
// already-allocated instance returns it unchanged (mirrors ctl's
// expectedResumeConflictMessages tolerance).
func TestResumeIdempotentFromAllocated(t *testing.T) {
	svc, instID := resumePathSetup(t)
	ctx := context.Background()
	if _, err := svc.Resume(ctx, instID); err != nil {
		t.Fatalf("first Resume: %v", err)
	}
	if _, err := svc.MarkResumed(ctx, instID); err != nil {
		t.Fatalf("MarkResumed: %v", err)
	}
	got, err := svc.Resume(ctx, instID)
	if err != nil {
		t.Fatalf("Resume on ALLOCATED: %v", err)
	}
	if got.State != core.StateAllocated {
		t.Fatalf("expected ALLOCATED preserved, got %s", got.State)
	}
}

// TestResumeRejectsNonPausedNonAllocated asserts that calling Resume on a DRY
// (or any other non-{PAUSED, RESUMING, ALLOCATED}) instance returns
// ErrInvalidTransition without state mutation.
func TestResumeRejectsNonPausedNonAllocated(t *testing.T) {
	ctx := context.Background()
	svc := NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "p", "", "img-test", 0, "vpc", "subnet", "zone", []string{"sg"})
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"10.0.0.60"}, []string{"ins-dry-1"}, verifyOK); err != nil {
		t.Fatalf("refill: %v", err)
	}
	inst, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if _, err := svc.Release(ctx, inst.ID); err != nil {
		t.Fatalf("release to DRY: %v", err)
	}
	if _, err := svc.Resume(ctx, inst.ID); err != core.ErrInvalidTransition {
		t.Fatalf("expected ErrInvalidTransition, got %v", err)
	}
}

// TestMarkResumedFromResuming asserts the RESUMING → ALLOCATED transition (R-F).
func TestMarkResumedFromResuming(t *testing.T) {
	svc, instID := resumePathSetup(t)
	ctx := context.Background()
	if _, err := svc.Resume(ctx, instID); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	got, err := svc.MarkResumed(ctx, instID)
	if err != nil {
		t.Fatalf("MarkResumed: %v", err)
	}
	if got.State != core.StateAllocated {
		t.Fatalf("expected ALLOCATED after MarkResumed, got %s", got.State)
	}
}

// TestMarkResumedIdempotentFromAllocated asserts that calling MarkResumed on
// an already-allocated instance is a no-op (matches Pause-side MarkPaused range).
func TestMarkResumedIdempotentFromAllocated(t *testing.T) {
	svc, instID := resumePathSetup(t)
	ctx := context.Background()
	if _, err := svc.Resume(ctx, instID); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if _, err := svc.MarkResumed(ctx, instID); err != nil {
		t.Fatalf("first MarkResumed: %v", err)
	}
	got, err := svc.MarkResumed(ctx, instID)
	if err != nil {
		t.Fatalf("idempotent MarkResumed: %v", err)
	}
	if got.State != core.StateAllocated {
		t.Fatalf("expected ALLOCATED preserved, got %s", got.State)
	}
}

// TestMarkResumedRejectsFromPaused asserts that calling MarkResumed on a still
// PAUSED instance (without going through Resume first) returns
// ErrInvalidTransition. This guards against handler-layer bugs that would
// short-circuit the PAUSED → RESUMING CAS.
func TestMarkResumedRejectsFromPaused(t *testing.T) {
	svc, instID := resumePathSetup(t)
	ctx := context.Background()
	if _, err := svc.MarkResumed(ctx, instID); err != core.ErrInvalidTransition {
		t.Fatalf("expected ErrInvalidTransition, got %v", err)
	}
}

// TestRollbackResumingFromResuming asserts the RESUMING → PAUSED rollback
// transition used when cp.StartInstance fails (R-F + Q4).
func TestRollbackResumingFromResuming(t *testing.T) {
	svc, instID := resumePathSetup(t)
	ctx := context.Background()
	if _, err := svc.Resume(ctx, instID); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	got, err := svc.RollbackResuming(ctx, instID)
	if err != nil {
		t.Fatalf("RollbackResuming: %v", err)
	}
	if got.State != core.StatePaused {
		t.Fatalf("expected PAUSED after rollback, got %s", got.State)
	}
}

// TestRollbackResumingRejectsFromAllocated asserts that calling
// RollbackResuming on an already-allocated instance is rejected with
// ErrInvalidTransition (would otherwise silently revert a successful resume).
func TestRollbackResumingRejectsFromAllocated(t *testing.T) {
	svc, instID := resumePathSetup(t)
	ctx := context.Background()
	if _, err := svc.Resume(ctx, instID); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if _, err := svc.MarkResumed(ctx, instID); err != nil {
		t.Fatalf("MarkResumed: %v", err)
	}
	if _, err := svc.RollbackResuming(ctx, instID); err != core.ErrInvalidTransition {
		t.Fatalf("expected ErrInvalidTransition, got %v", err)
	}
}
