package gateway

import (
	"testing"
	"time"
)

func TestClaimSetProvisionRequestFencesConcurrentOwners(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	request := SetProvisionRequest{
		ID: "prod:llmgateway:prod:set-a", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 4, LifecycleRevision: 1, Version: 1,
		Status: SetProvisionStatusPending,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}

	first, acquired, err := svc.ClaimSetProvisionRequest(t.Context(), SetProvisionClaimInput{
		ID: request.ID, RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 4,
		LifecycleRevision: 1, Owner: "provisioner-a", LeaseTTL: time.Minute,
	})
	if err != nil || !acquired {
		t.Fatalf("first claim acquired=%v err=%v", acquired, err)
	}
	if first.Status != SetProvisionStatusProvisioning || first.ClaimToken == "" || first.Version != 2 || first.Attempt != 1 {
		t.Fatalf("unexpected first claim: %+v", first)
	}
	if _, acquired, err := svc.ClaimSetProvisionRequest(t.Context(), SetProvisionClaimInput{
		ID: request.ID, RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 4,
		LifecycleRevision: 1, Owner: "provisioner-b", LeaseTTL: time.Minute,
	}); err != nil || acquired {
		t.Fatalf("concurrent claim acquired=%v err=%v, want fenced", acquired, err)
	}

	now = now.Add(61 * time.Second)
	second, acquired, err := svc.ClaimSetProvisionRequest(t.Context(), SetProvisionClaimInput{
		ID: request.ID, RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 4,
		LifecycleRevision: 1, Owner: "provisioner-b", LeaseTTL: time.Minute,
	})
	if err != nil || !acquired {
		t.Fatalf("expired claim acquired=%v err=%v", acquired, err)
	}
	if second.ClaimToken == first.ClaimToken || second.Version != 3 {
		t.Fatalf("claim was not fenced: first=%+v second=%+v", first, second)
	}
}

func TestRenewAndReleaseSetProvisionClaimPreserveFencing(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	request := SetProvisionRequest{
		ID: "native", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 2, LifecycleRevision: 1, Version: 1,
		Status: SetProvisionStatusPending,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	claimed, acquired, err := svc.ClaimSetProvisionRequest(t.Context(), SetProvisionClaimInput{
		ID: request.ID, RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 2,
		LifecycleRevision: 1, Owner: "provisioner-a", LeaseTTL: time.Minute,
	})
	if err != nil || !acquired {
		t.Fatalf("claim acquired=%v err=%v", acquired, err)
	}

	now = now.Add(30 * time.Second)
	renewed, ok, err := svc.RenewSetProvisionClaim(t.Context(), SetProvisionLeaseInput{
		ID: request.ID, RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 2,
		LifecycleRevision: 1, ExpectedVersion: claimed.Version, ClaimToken: claimed.ClaimToken,
		LeaseTTL: 2 * time.Minute,
	})
	if err != nil || !ok {
		t.Fatalf("renew ok=%v err=%v", ok, err)
	}
	if renewed.Version != claimed.Version || !renewed.ClaimLeaseUntil.Equal(now.Add(2*time.Minute)) {
		t.Fatalf("renewed request = %+v", renewed)
	}

	released, ok, err := svc.ReleaseSetProvisionClaim(t.Context(), SetProvisionLeaseInput{
		ID: request.ID, RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 2,
		LifecycleRevision: 1, ExpectedVersion: renewed.Version, ClaimToken: renewed.ClaimToken,
	})
	if err != nil || !ok {
		t.Fatalf("release ok=%v err=%v", ok, err)
	}
	if released.ClaimToken != "" || released.Version != renewed.Version+1 {
		t.Fatalf("released request = %+v", released)
	}
	if _, ok, err := svc.RenewSetProvisionClaim(t.Context(), SetProvisionLeaseInput{
		ID: request.ID, RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 2,
		LifecycleRevision: 1, ExpectedVersion: claimed.Version, ClaimToken: claimed.ClaimToken,
		LeaseTTL: time.Minute,
	}); err != nil || ok {
		t.Fatalf("stale renew ok=%v err=%v", ok, err)
	}
}

func TestCommitSetProvisionFactRequiresCurrentClaim(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	request := SetProvisionRequest{
		ID: "prod:llmgateway:prod:set-a", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 2, LifecycleRevision: 1, Version: 1,
		Status: SetProvisionStatusPending,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	claimed, acquired, err := svc.ClaimSetProvisionRequest(t.Context(), SetProvisionClaimInput{
		ID: request.ID, RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 2,
		LifecycleRevision: 1, Owner: "provisioner-a", LeaseTTL: time.Minute,
	})
	if err != nil || !acquired {
		t.Fatalf("claim acquired=%v err=%v", acquired, err)
	}
	factInput := SetReconcileFactInput{SetID: "set-a", BaseURL: "http://prod-set-a-newapi-admin:3000", ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "3"}
	if _, committed, err := svc.CommitSetProvisionFact(t.Context(), SetProvisionFactCommitInput{
		ID: request.ID, RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 2,
		LifecycleRevision: 1, ExpectedStatus: SetProvisionStatusProvisioning,
		ExpectedVersion: claimed.Version, ClaimToken: "stale-token", NextStatus: SetProvisionStatusCreated,
		Fact: factInput,
	}); err != nil || committed {
		t.Fatalf("stale commit committed=%v err=%v", committed, err)
	}
	updated, committed, err := svc.CommitSetProvisionFact(t.Context(), SetProvisionFactCommitInput{
		ID: request.ID, RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 2,
		LifecycleRevision: 1, ExpectedStatus: SetProvisionStatusProvisioning,
		ExpectedVersion: claimed.Version, ClaimToken: claimed.ClaimToken, NextStatus: SetProvisionStatusCreated,
		Fact: factInput,
	})
	if err != nil || !committed {
		t.Fatalf("current commit committed=%v err=%v", committed, err)
	}
	if updated.Status != SetProvisionStatusCreated || updated.ClaimToken != "" || updated.Version != claimed.Version+1 || updated.AdminFactHash == "" {
		t.Fatalf("unexpected committed request: %+v", updated)
	}
	fact, ok, err := store.GetSetReconcileFact(t.Context(), "prod", "llmgateway", "prod", "set-a")
	if err != nil || !ok || fact.DesiredHash != updated.AdminFactHash {
		t.Fatalf("fact ok=%v err=%v fact=%+v request=%+v", ok, err, fact, updated)
	}
}

func TestLegacyStatusUpdateRejectsVelaGWSetRequest(t *testing.T) {
	store := NewMemoryStore()
	request := nativeProvisionRequest(SetProvisionStatusPending)
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Options{})
	if _, err := svc.UpdateSetProvisionRequestStatus(t.Context(), request.ID, SetProvisionStatusConfigured, ""); err == nil {
		t.Fatal("legacy status API must not mutate a VelaGWSet request")
	}
	stored, _, err := store.GetSetProvisionRequest(t.Context(), request.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != SetProvisionStatusPending || stored.Version != request.Version {
		t.Fatalf("stored request changed through legacy API: %+v", stored)
	}
}

func TestCleanupPendingJobSkipsVelaGWSetRequests(t *testing.T) {
	store := NewMemoryStore()
	native := nativeProvisionRequest(SetProvisionStatusPending)
	legacy := native
	legacy.ID = "legacy-request"
	legacy.SetID = "legacy-set"
	legacy.RuntimeBackend = SetRuntimeBackendLLMFleet
	for _, request := range []SetProvisionRequest{native, legacy} {
		if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
			t.Fatal(err)
		}
	}
	storedLegacy, _, _ := store.GetSetProvisionRequest(t.Context(), legacy.ID)
	svc := NewService(store, nil, Options{})
	svc.now = func() time.Time { return storedLegacy.UpdatedAt.Add(2 * time.Hour) }
	cleaned, err := svc.cleanupPendingJob(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if cleaned != 1 {
		t.Fatalf("cleaned=%d want 1 legacy request", cleaned)
	}
	storedNative, _, _ := store.GetSetProvisionRequest(t.Context(), native.ID)
	if storedNative.Status != SetProvisionStatusPending {
		t.Fatalf("native request status=%s want pending", storedNative.Status)
	}
}

func nativeProvisionRequest(status string) SetProvisionRequest {
	return SetProvisionRequest{
		ID: "native-request", Source: "kro", Namespace: "llmgateway", Fleet: "prod", SetID: "native-set",
		RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 2, LifecycleRevision: 1, Version: 1, Status: status,
	}
}

func TestManagedFactAdvancesNativeProvisionRequestMonotonically(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	request := SetProvisionRequest{
		ID: "native", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		RuntimeBackend: SetRuntimeBackendVelaGWSet, WriterEpoch: 1, LifecycleRevision: 1, Version: 5,
		Status: SetProvisionStatusCreated, AdminFactHash: "admin-hash",
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	adminFact := SetReconcileFact{Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a", DesiredHash: "admin-hash", Status: SetReconcileStatusManaged}
	if err := svc.advanceNativeProvisionRequestForManagedFact(t.Context(), adminFact); err != nil {
		t.Fatal(err)
	}
	configured, _, _ := store.GetSetProvisionRequest(t.Context(), request.ID)
	if configured.Status != SetProvisionStatusConfigured || configured.Version != 6 {
		t.Fatalf("configured request = %+v", configured)
	}

	configured.ServingFactHash = "serving-hash"
	if err := store.SaveSetProvisionRequest(t.Context(), configured); err != nil {
		t.Fatal(err)
	}
	servingFact := SetReconcileFact{Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a", RuntimeGeneration: 1, DesiredHash: "serving-hash", Status: SetReconcileStatusManaged}
	if err := svc.advanceNativeProvisionRequestForManagedFact(t.Context(), servingFact); err != nil {
		t.Fatal(err)
	}
	managed, _, _ := store.GetSetProvisionRequest(t.Context(), request.ID)
	if managed.Status != SetProvisionStatusManaged || managed.Version != 7 {
		t.Fatalf("managed request = %+v", managed)
	}
}
