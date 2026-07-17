package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTryReserveSetUserSlotRejectsDrainingSet(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{
		ID:               "set-a",
		Status:           SetStatusDraining,
		Setup:            true,
		AdmissionStatus:  SetAdmissionStatusPassed,
		AdminUserID:      1,
		AdminAccessToken: "admin-token",
		MaxUsers:         100,
	})

	reserved, err := store.TryReserveSetUserSlot(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if reserved {
		t.Fatal("draining set accepted a new user slot")
	}
}

func TestSetOperationLeaseIsFencedByLifecycleGeneration(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{
		ID:                  "set-a",
		Status:              SetStatusActive,
		Setup:               true,
		AdmissionStatus:     SetAdmissionStatusPassed,
		AdminUserID:         1,
		AdminAccessToken:    "admin-token",
		LifecycleGeneration: 7,
	})
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	lease, acquired, err := store.TryAcquireSetOperationLease(
		t.Context(), "set-a", SetOperationBYOKSync, "worker-a", 1, time.Minute, now,
	)
	if err != nil || !acquired {
		t.Fatalf("acquire lease acquired=%v err=%v", acquired, err)
	}
	if lease.LifecycleGeneration != 7 {
		t.Fatalf("lease generation = %d, want 7", lease.LifecycleGeneration)
	}

	set, _, _ := store.GetSet(t.Context(), "set-a")
	set.Status = SetStatusDraining
	set.LifecycleGeneration++
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	renewed, err := store.RenewSetOperationLease(t.Context(), lease, time.Minute, now.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if renewed {
		t.Fatal("lease from an older lifecycle generation was renewed")
	}
}

func TestPreviewTenantDeletionRejectsMultipleSelectors(t *testing.T) {
	svc := NewService(NewMemoryStore(), nil, Options{})
	_, err := svc.PreviewTenantDeletion(t.Context(), TenantDeletionPreviewInput{
		UserIDs:      []string{"user-1"},
		UserIDPrefix: "user-",
	})
	if err == nil || !strings.Contains(err.Error(), "exactly one selector") {
		t.Fatalf("err = %v, want selector validation", err)
	}
}

func TestTenantDeletionPreviewFreezesTargets(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	for _, id := range []string{"test-001", "test-002", "keep-001"} {
		if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: id, Status: TenantStatusActive}); err != nil {
			t.Fatal(err)
		}
	}

	job, err := svc.PreviewTenantDeletion(t.Context(), TenantDeletionPreviewInput{UserIDPrefix: "test-"})
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != TenantDeletionStatusMaterializing {
		t.Fatalf("initial status = %q, want materializing", job.Status)
	}
	job, err = svc.RunTenantDeletionMaintenanceOnce(t.Context(), job.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != TenantDeletionStatusPreviewed || job.TargetCount != 2 || job.TargetDigest == "" {
		t.Fatalf("unexpected preview job: %+v", job)
	}
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "test-003", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	targets, err := store.ListTenantDeletionTargets(t.Context(), job.ID, TenantDeletionTargetListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 2 || targets[0].ExternalUserID != "test-001" || targets[1].ExternalUserID != "test-002" {
		t.Fatalf("frozen targets = %+v", targets)
	}
}

func TestTenantDeletionClaimFreezesUsersBeforeRemoteCleanup(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	for _, id := range []string{"user-001", "user-002"} {
		if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: id, Status: TenantStatusActive}); err != nil {
			t.Fatal(err)
		}
	}
	job, err := svc.PreviewTenantDeletion(t.Context(), TenantDeletionPreviewInput{UserIDs: []string{"user-001", "user-002"}})
	if err != nil {
		t.Fatal(err)
	}
	job, err = svc.RunTenantDeletionMaintenanceOnce(t.Context(), job.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	job, err = svc.StartTenantDeletion(t.Context(), job.ID, TenantDeletionStartInput{
		ExpectedTargetCount: job.TargetCount, ExpectedTargetDigest: job.TargetDigest, IdempotencyKey: "delete-users",
	})
	if err != nil {
		t.Fatal(err)
	}
	job, err = svc.RunTenantDeletionMaintenanceOnce(t.Context(), job.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != TenantDeletionStatusClaiming {
		t.Fatalf("status after first claim = %q, want claiming", job.Status)
	}
	first, _, _ := store.GetTenant(t.Context(), "user-001")
	second, _, _ := store.GetTenant(t.Context(), "user-002")
	if first.Status != TenantStatusDeleting || second.Status != TenantStatusActive {
		t.Fatalf("tenant statuses after first claim = %q, %q", first.Status, second.Status)
	}
	job, err = svc.RunTenantDeletionMaintenanceOnce(t.Context(), job.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	second, _, _ = store.GetTenant(t.Context(), "user-002")
	if job.Status != TenantDeletionStatusQueued || second.Status != TenantStatusDeleting {
		t.Fatalf("job=%+v second tenant=%+v", job, second)
	}
}

func TestTenantDeletionFailureUsesBoundedBackoff(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "user-001", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	job, err := svc.PreviewTenantDeletion(t.Context(), TenantDeletionPreviewInput{UserIDs: []string{"user-001"}})
	if err != nil {
		t.Fatal(err)
	}
	job, err = svc.RunTenantDeletionMaintenanceOnce(t.Context(), job.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	job, err = svc.StartTenantDeletion(t.Context(), job.ID, TenantDeletionStartInput{
		ExpectedTargetCount: job.TargetCount, ExpectedTargetDigest: job.TargetDigest, IdempotencyKey: "delete-user",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RunTenantDeletionMaintenanceOnce(t.Context(), job.ID, 10); err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(time.Hour)
	for attempt := 1; attempt <= maxTenantDeletionAttempts; attempt++ {
		target, acquired, err := store.AcquireTenantDeletionTarget(t.Context(), "worker-a", time.Minute, base)
		if err != nil || !acquired {
			t.Fatalf("attempt %d acquired=%v err=%v", attempt, acquired, err)
		}
		if err := store.FailTenantDeletionTarget(t.Context(), target, "remote failed", base); err != nil {
			t.Fatal(err)
		}
		if _, acquired, err := store.AcquireTenantDeletionTarget(t.Context(), "worker-a", time.Minute, base.Add(tenantDeletionRetryDelay-time.Second)); err != nil || acquired {
			t.Fatalf("attempt %d retried before backoff acquired=%v err=%v", attempt, acquired, err)
		}
		base = base.Add(tenantDeletionRetryDelay)
	}
	if _, acquired, err := store.AcquireTenantDeletionTarget(t.Context(), "worker-a", time.Minute, base.Add(time.Hour)); err != nil || acquired {
		t.Fatalf("terminal failure acquired=%v err=%v", acquired, err)
	}
}

func TestPreviewSetDecommissionRejectsNonEmptySet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive, Setup: true})
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1",
		Backend:        UserBackendNew,
		SetID:          "set-a",
		Status:         TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}

	preview, err := svc.PreviewSetDecommission(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if preview.Empty || preview.Blockers.Tenants != 1 {
		t.Fatalf("preview = %+v, want one tenant blocker", preview)
	}
	_, err = svc.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID:          "set-a",
		ExpectedDigest: preview.Digest,
		IdempotencyKey: "delete-set-a",
	})
	if err == nil || !strings.Contains(err.Error(), "not empty") {
		t.Fatalf("err = %v, want non-empty rejection", err)
	}
}

func TestStartSetDecommissionDrainsSetAndIncrementsGeneration(t *testing.T) {
	store := NewMemoryStore()
	emitter, telemetryEvents := captureTelemetryEvents()
	svc := NewService(store, nil, Options{TelemetryEmitter: emitter})
	mustSaveSet(t, store, Set{
		ID:                  "set-a",
		Status:              SetStatusActive,
		Setup:               true,
		LifecycleGeneration: 3,
	})
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "kro", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "17",
	}); err != nil {
		t.Fatal(err)
	}

	preview, err := svc.PreviewSetDecommission(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	job, err := svc.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID:          "set-a",
		ExpectedDigest: preview.Digest,
		IdempotencyKey: "delete-set-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != SetDecommissionStatusPending {
		t.Fatalf("job status = %q, want pending", job.Status)
	}
	set, ok, err := store.GetSet(context.Background(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, err)
	}
	if set.Status != SetStatusDraining || set.LifecycleGeneration != 4 {
		t.Fatalf("set after start = %+v", set)
	}
	if len(*telemetryEvents) != 1 || (*telemetryEvents)[0].event.Name != "llmgateway.set.state_changed" {
		t.Fatalf("missing decommission transition telemetry: %+v", *telemetryEvents)
	}
	requireTelemetryString(t, (*telemetryEvents)[0].event, "llmgateway.entity.type", "set_decommission_job")
	requireTelemetryString(t, (*telemetryEvents)[0].event, "llmgateway.set.id", "set-a")
	if _, err := svc.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "delete-set-a",
	}); err != nil {
		t.Fatal(err)
	}
	if len(*telemetryEvents) != 1 {
		t.Fatalf("idempotent replay emitted a false transition: %+v", *telemetryEvents)
	}
}

func TestCascadeSetDecommissionPurgesTenantStateAndQueuesRuntimeCleanup(t *testing.T) {
	store := NewMemoryStore()
	cache := &batchDeleteTrackingCache{MemoryAPIKeyRouteCache: NewMemoryAPIKeyRouteCache(time.Minute, 100)}
	svc := NewService(store, nil, Options{KeyRouteCache: cache})
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	mustSaveSet(t, store, Set{
		ID: "set-a", Status: SetStatusActive, Setup: true,
		ObservedUserCount: 1, AdmissionStatus: SetAdmissionStatusPassed,
	})
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-user-1", Password: "password", ProvisionStatus: BindingProvisionStatusTokenReady,
	}); err != nil {
		t.Fatal(err)
	}
	externalKey := signedExternalKeyForTest("key-1", "route-secret")
	lookup := parseTrafficRouteLookup(externalKey)
	binding := APIKeyBinding{
		ExternalKey: externalKey, ExternalKeyHash: lookup.ExternalKeyHash,
		ExternalKeyID: lookup.ExternalKeyID, SecretHash: lookup.SecretHash,
		KeyVersion: lookup.Version, RouteSlot: lookup.RouteSlot,
		SetID: "set-a", UserID: "user-1", UpstreamKey: "sk-upstream", UpstreamKeyID: 77,
		Status: APIKeyStatusActive,
	}
	if err := store.SaveAPIKeyBinding(t.Context(), binding); err != nil {
		t.Fatal(err)
	}
	if err := cache.SetRoute(t.Context(), TrafficRouteSnapshot{
		ExternalKeyID: binding.ExternalKeyID, SecretHash: binding.SecretHash,
		KeyVersion: binding.KeyVersion, RouteSlot: binding.RouteSlot,
		SetID: "set-a", UserID: "user-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserLLMSettings(t.Context(), UserLLMSettings{
		ExternalUserID: "user-1", BYOKGroup: "byok_user_1",
		Providers: []UserLLMProvider{{ID: "provider-1", Enabled: true, RemoteChannelID: 88}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserAssignment(t.Context(), UserAssignment{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenantObservation(t.Context(), TenantObservation{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSubscriptionPeriodOverlay(t.Context(), SubscriptionPeriodOverlay{ExternalUserID: "user-1", SetID: "set-a", PeriodEnd: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}

	preview, err := svc.PreviewSetDecommission(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	job, err := svc.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "cascade-set-a", CascadeTenants: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != SetDecommissionStatusPurgingTenants || !job.CascadeTenants {
		t.Fatalf("started cascade job = %+v", job)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok || set.Status != SetStatusDraining {
		t.Fatalf("draining set = %+v ok=%v err=%v", set, ok, err)
	}

	processed, err := svc.ProcessSetDecommissionCascadeOnce(t.Context(), "maintenance-a", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("cascade worker did not claim a Set")
	}
	job, err = svc.GetSetDecommission(t.Context(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != SetDecommissionStatusPending {
		t.Fatalf("job after local purge = %+v", job)
	}
	if tenant, ok, _ := store.GetTenant(t.Context(), "user-1"); !ok || tenant.Status != TenantStatusDeleted {
		t.Fatalf("tenant after cascade = %+v ok=%v", tenant, ok)
	}
	if _, ok, _ := store.GetUserBinding(t.Context(), "user-1"); ok {
		t.Fatal("binding remains after cascade")
	}
	if keys, _ := store.ListAPIKeyBindingsBySet(t.Context(), "set-a"); len(keys) != 0 {
		t.Fatalf("keys remain after cascade: %+v", keys)
	}
	if _, ok, _ := store.GetUserLLMSettings(t.Context(), "user-1"); ok {
		t.Fatal("BYOK settings remain after cascade")
	}
	if _, ok, err := cache.GetRoute(t.Context(), lookup); err != nil || ok {
		t.Fatalf("traffic route remains after cascade ok=%v err=%v", ok, err)
	}
	if cache.batchCalls != 1 || cache.singleCalls != 0 {
		t.Fatalf("route invalidation calls: batch=%d single=%d, want one batch", cache.batchCalls, cache.singleCalls)
	}
	if leases, _ := store.ListSetRuntimeLeases(t.Context(), SetRuntimeLeaseListOptions{}); len(leases) != 1 {
		t.Fatalf("runtime lease count = %d, want retained until runtime cleanup", len(leases))
	}
}

type batchDeleteTrackingCache struct {
	*MemoryAPIKeyRouteCache
	batchCalls  int
	singleCalls int
}

func (c *batchDeleteTrackingCache) DeleteRoute(ctx context.Context, lookup TrafficRouteLookup) error {
	c.singleCalls++
	return c.MemoryAPIKeyRouteCache.DeleteRoute(ctx, lookup)
}

func (c *batchDeleteTrackingCache) DeleteRoutes(ctx context.Context, lookups []TrafficRouteLookup) error {
	c.batchCalls++
	for _, lookup := range lookups {
		if err := c.MemoryAPIKeyRouteCache.DeleteRoute(ctx, lookup); err != nil {
			return err
		}
	}
	return nil
}

func TestCascadeOrphanSetRequiresExplicitConfirmationAndFinishesLocally(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{ID: "orphan-set", Status: SetStatusDisabled, ObservedUserCount: 1})
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "orphan-user", Backend: UserBackendNew, SetID: "orphan-set", Status: TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := svc.PreviewSetDecommission(t.Context(), "orphan-set")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "orphan-set", ExpectedDigest: preview.Digest, IdempotencyKey: "missing-orphan-confirmation", CascadeTenants: true,
	}); err == nil {
		t.Fatal("expected an orphan Set without explicit confirmation to be rejected")
	}
	job, err := svc.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "orphan-set", ExpectedDigest: preview.Digest, IdempotencyKey: "cascade-orphan-set",
		CascadeTenants: true, AllowOrphan: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != SetDecommissionStatusPurgingTenants || !job.AllowOrphan {
		t.Fatalf("orphan cascade job = %+v", job)
	}
	processed, err := svc.ProcessSetDecommissionCascadeOnce(t.Context(), "maintenance-a", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("orphan cascade worker did not process the Set")
	}
	job, err = svc.GetSetDecommission(t.Context(), job.ID)
	if err != nil || job.Status != SetDecommissionStatusSucceeded {
		t.Fatalf("completed orphan job = %+v err=%v", job, err)
	}
	if _, ok, _ := store.GetSet(t.Context(), "orphan-set"); ok {
		t.Fatal("orphan Set remains after local cleanup")
	}
	if tenant, ok, _ := store.GetTenant(t.Context(), "orphan-user"); !ok || tenant.Status != TenantStatusDeleted {
		t.Fatalf("orphan tenant after cleanup = %+v ok=%v", tenant, ok)
	}
}

func TestFailedCascadeBacksOffWithoutBlockingOtherSets(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	for index, setID := range []string{"set-a", "set-b"} {
		mustSaveSet(t, store, Set{ID: setID, Status: SetStatusActive, Setup: true})
		if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
			Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: setID,
			ShardRef: "shard-a", DatabaseName: "newapi_" + strings.ReplaceAll(setID, "-", "_"),
			RedisDB: fmt.Sprintf("%d", 12+index),
		}); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveTenant(t.Context(), Tenant{
			ExternalUserID: "user-" + setID, Backend: UserBackendNew, SetID: setID, Status: TenantStatusActive,
		}); err != nil {
			t.Fatal(err)
		}
		preview, err := store.GetSetDecommissionPreview(t.Context(), setID, now.Add(time.Duration(index)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.StartSetDecommission(t.Context(), SetDecommissionStartInput{
			SetID: setID, ExpectedDigest: preview.Digest, IdempotencyKey: "cascade-" + setID, CascadeTenants: true,
		}, "job-"+setID, now.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}

	first, acquired, err := store.AcquireSetDecommissionCascade(t.Context(), "worker-a", time.Minute, now.Add(2*time.Second))
	if err != nil || !acquired || first.SetID != "set-a" {
		t.Fatalf("first cascade=%+v acquired=%v err=%v", first, acquired, err)
	}
	if err := store.FailSetDecommissionCascade(t.Context(), first.ID, first.ClaimToken, "redis unavailable", now.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	second, acquired, err := store.AcquireSetDecommissionCascade(t.Context(), "worker-b", time.Minute, now.Add(4*time.Second))
	if err != nil || !acquired || second.SetID != "set-b" {
		t.Fatalf("second cascade=%+v acquired=%v err=%v, want set-b while set-a backs off", second, acquired, err)
	}
}

func TestCascadeCompletionRejectsChangedSetLifecycle(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive, Setup: true})
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := store.GetSetDecommissionPreview(t.Context(), "set-a", now)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "cascade-set-a", CascadeTenants: true,
	}, "job-set-a", now)
	if err != nil {
		t.Fatal(err)
	}
	claimed, acquired, err := store.AcquireSetDecommissionCascade(t.Context(), "worker-a", time.Minute, now.Add(time.Second))
	if err != nil || !acquired {
		t.Fatalf("claim=%+v acquired=%v err=%v", claimed, acquired, err)
	}
	set, _, err := store.GetSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	set.LifecycleGeneration++
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteSetDecommissionCascade(t.Context(), job.ID, claimed.ClaimToken, now.Add(2*time.Second)); err == nil {
		t.Fatal("expected changed Set lifecycle to fence cascade completion")
	}
	if tenant, ok, err := store.GetTenant(t.Context(), "user-1"); err != nil || !ok || tenant.Status == TenantStatusDeleted {
		t.Fatalf("tenant was purged despite lifecycle fence: %+v ok=%v err=%v", tenant, ok, err)
	}
}

func TestCascadeWithExternalKeysRequiresRouteCache(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive, Setup: true})
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAPIKeyBinding(t.Context(), APIKeyBinding{
		ExternalKey: "sk-route", ExternalKeyID: "key-1", SetID: "set-a", UserID: "user-1", UpstreamKey: "sk-upstream",
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := svc.PreviewSetDecommission(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	job, err := svc.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "cascade-set-a", CascadeTenants: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	processed, err := svc.ProcessSetDecommissionCascadeOnce(t.Context(), "maintenance-a", time.Minute)
	if !processed || err == nil || !strings.Contains(err.Error(), "route cache") {
		t.Fatalf("processed=%v err=%v, want route-cache failure", processed, err)
	}
	job, err = svc.GetSetDecommission(t.Context(), job.ID)
	if err != nil || job.Status != SetDecommissionStatusPurgingTenants || job.LastError == "" {
		t.Fatalf("job after route-cache failure=%+v err=%v", job, err)
	}
	if keys, err := store.ListAPIKeyBindingsBySet(t.Context(), "set-a"); err != nil || len(keys) != 1 {
		t.Fatalf("keys were purged without route invalidation: %+v err=%v", keys, err)
	}
	if tenant, ok, err := store.GetTenant(t.Context(), "user-1"); err != nil || !ok || tenant.Status == TenantStatusDeleted {
		t.Fatalf("tenant was purged without route invalidation: %+v ok=%v err=%v", tenant, ok, err)
	}
}

func TestAcquireSetDecommissionCascadeQuarantinesLifecycleConflict(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	for index, setID := range []string{"set-a", "set-b"} {
		mustSaveSet(t, store, Set{ID: setID, Status: SetStatusActive, Setup: true})
		if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
			Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: setID,
			ShardRef: "shard-a", DatabaseName: "newapi_" + strings.ReplaceAll(setID, "-", "_"), RedisDB: fmt.Sprintf("%d", 12+index),
		}); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveTenant(t.Context(), Tenant{
			ExternalUserID: "user-" + setID, Backend: UserBackendNew, SetID: setID, Status: TenantStatusActive,
		}); err != nil {
			t.Fatal(err)
		}
		preview, err := store.GetSetDecommissionPreview(t.Context(), setID, now.Add(time.Duration(index)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.StartSetDecommission(t.Context(), SetDecommissionStartInput{
			SetID: setID, ExpectedDigest: preview.Digest, IdempotencyKey: "cascade-" + setID, CascadeTenants: true,
		}, "decom-"+setID, now.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	setA, _, err := store.GetSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	setA.Status = SetStatusActive
	if err := store.SaveSet(t.Context(), setA); err != nil {
		t.Fatal(err)
	}

	if _, acquired, err := store.AcquireSetDecommissionCascade(t.Context(), "maintenance-a", time.Minute, now.Add(2*time.Second)); err == nil || acquired {
		t.Fatalf("first acquire acquired=%v err=%v, want quarantined lifecycle conflict", acquired, err)
	}
	failed, ok, err := store.GetSetDecommissionJob(t.Context(), "decom-set-a")
	if err != nil || !ok {
		t.Fatalf("failed job lookup ok=%v err=%v", ok, err)
	}
	if failed.Status != SetDecommissionStatusError || !strings.Contains(failed.LastError, "lifecycle changed") {
		t.Fatalf("conflicting cascade was not quarantined: %+v", failed)
	}
	next, acquired, err := store.AcquireSetDecommissionCascade(t.Context(), "maintenance-a", time.Minute, now.Add(3*time.Second))
	if err != nil || !acquired || next.SetID != "set-b" {
		t.Fatalf("next acquire job=%+v acquired=%v err=%v", next, acquired, err)
	}
}

func TestClaimSetDecommissionFreezesRuntimeAndRejectsLateCancel(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive, Setup: true, AdmissionStatus: SetAdmissionStatusPassed})
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := store.GetSetDecommissionPreview(t.Context(), "set-a", now)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "idem-start",
	}, "decom-a", now)
	if err != nil {
		t.Fatal(err)
	}

	claimed, payload, err := store.ClaimSetDecommission(t.Context(), SetDecommissionClaimInput{
		JobID: job.ID, Owner: "set-manager-a", CapabilityHash: "ticket-hash", LeaseTTL: time.Minute,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != SetDecommissionStatusRemovingRuntime || claimed.Attempt != 1 || claimed.ClaimToken == "" {
		t.Fatalf("claimed job = %+v", claimed)
	}
	if payload.SetID != "set-a" || payload.ShardRef != "shard-a" || payload.DatabaseName != "newapi_set_a" || payload.RedisDB != "12" {
		t.Fatalf("cleanup payload = %+v", payload)
	}
	if payload.LeaseFingerprint == "" || payload.LeaseFingerprint != claimed.LeaseFingerprint {
		t.Fatalf("lease fingerprint = %q job=%q", payload.LeaseFingerprint, claimed.LeaseFingerprint)
	}

	if _, err := store.CancelSetDecommission(t.Context(), SetDecommissionCancelInput{
		JobID: job.ID, ExpectedVersion: claimed.Version, IdempotencyKey: "idem-cancel",
	}, now.Add(time.Second)); err == nil {
		t.Fatal("expected cancel after claim to fail")
	}
}

func TestClaimSetDecommissionQuarantinesLifecycleConflict(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive})
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := store.GetSetDecommissionPreview(t.Context(), "set-a", now)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "start-set-a",
	}, "decom-a", now)
	if err != nil {
		t.Fatal(err)
	}
	set, _, err := store.GetSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	set.Status = SetStatusActive
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	if _, _, err := store.ClaimSetDecommission(t.Context(), SetDecommissionClaimInput{
		JobID: job.ID, Owner: "set-manager-a", ClaimToken: "claim-a", CapabilityHash: "hash-a", LeaseTTL: time.Minute,
	}, now.Add(time.Second)); err == nil {
		t.Fatal("expected lifecycle conflict")
	}
	failed, ok, err := store.GetSetDecommissionJob(t.Context(), job.ID)
	if err != nil || !ok {
		t.Fatalf("job lookup ok=%v err=%v", ok, err)
	}
	if failed.Status != SetDecommissionStatusError || !strings.Contains(failed.LastError, "lifecycle changed") {
		t.Fatalf("conflicting job was not quarantined: %+v", failed)
	}
	runtimeJobs, err := store.ListSetDecommissionJobs(t.Context(), SetDecommissionJobListOptions{RuntimeOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(runtimeJobs) != 0 {
		t.Fatalf("conflicting job remains in runtime queue: %+v", runtimeJobs)
	}
}

func TestFailedSetCleanupKeepsLeaseAndCanBeRetried(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive, Setup: true, AdmissionStatus: SetAdmissionStatusPassed})
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := store.GetSetDecommissionPreview(t.Context(), "set-a", now)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "start-set-a",
	}, "decom-a", now)
	if err != nil {
		t.Fatal(err)
	}
	job, payload, err := store.ClaimSetDecommission(t.Context(), SetDecommissionClaimInput{
		JobID: job.ID, Owner: "set-manager-a", ClaimToken: "claim-a", CapabilityHash: "hash-a", LeaseTTL: time.Minute,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	job, err = store.FailSetDecommission(t.Context(), SetDecommissionFailInput{
		JobID: job.ID, Attempt: job.Attempt, ClaimToken: job.ClaimToken,
		LeaseFingerprint: job.LeaseFingerprint, JobUID: "job-uid-a", LastError: "mysql still has connections",
	}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != SetDecommissionStatusError || !strings.Contains(job.LastError, "connections") {
		t.Fatalf("failed job = %+v", job)
	}
	leases, err := store.ListSetRuntimeLeases(t.Context(), SetRuntimeLeaseListOptions{Source: payload.Source, Namespace: payload.Namespace, Fleet: payload.Fleet})
	if err != nil || len(leases) != 1 {
		t.Fatalf("runtime leases = %+v err=%v", leases, err)
	}
	job, err = store.RetrySetDecommission(t.Context(), SetDecommissionRetryInput{
		JobID: job.ID, ExpectedVersion: job.Version, IdempotencyKey: "retry-set-a",
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != SetDecommissionStatusPending || job.ClaimToken != "" || !job.ClaimLeaseUntil.IsZero() {
		t.Fatalf("retried job = %+v", job)
	}
	job, _, err = store.ClaimSetDecommission(t.Context(), SetDecommissionClaimInput{
		JobID: job.ID, Owner: "set-manager-b", ClaimToken: "claim-b", CapabilityHash: "hash-b", LeaseTTL: time.Minute,
	}, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if job.Attempt != 2 || job.Status != SetDecommissionStatusRemovingRuntime {
		t.Fatalf("second attempt = %+v", job)
	}
}

func TestRetryCascadeSetCleanupReturnsToTenantPurgeWhenSetIsNotEmpty(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive, Setup: true})
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-a", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := store.GetSetDecommissionPreview(t.Context(), "set-a", now)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "cascade-set-a", CascadeTenants: true,
	}, "decom-a", now)
	if err != nil {
		t.Fatal(err)
	}
	set, _, err := store.GetSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	set.Status = SetStatusActive
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if _, acquired, err := store.AcquireSetDecommissionCascade(t.Context(), "maintenance-a", time.Minute, now.Add(time.Second)); err == nil || acquired {
		t.Fatalf("acquired=%v err=%v, want lifecycle conflict", acquired, err)
	}
	failed, ok, err := store.GetSetDecommissionJob(t.Context(), job.ID)
	if err != nil || !ok {
		t.Fatalf("job lookup ok=%v err=%v", ok, err)
	}
	set.Status = SetStatusDraining
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	retried, err := store.RetrySetDecommission(t.Context(), SetDecommissionRetryInput{
		JobID: failed.ID, ExpectedVersion: failed.Version, IdempotencyKey: "retry-cascade-set-a",
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if retried.Status != SetDecommissionStatusPurgingTenants {
		t.Fatalf("retried status = %q, want %q", retried.Status, SetDecommissionStatusPurgingTenants)
	}
}

func TestCancelSetDecommissionBeforeClaimRestoresSetWithoutReusingGeneration(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusDisabled, LifecycleGeneration: 7})
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	preview, _ := store.GetSetDecommissionPreview(t.Context(), "set-a", now)
	job, err := store.StartSetDecommission(t.Context(), SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "idem-start",
	}, "decom-a", now)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := store.CancelSetDecommission(t.Context(), SetDecommissionCancelInput{
		JobID: job.ID, ExpectedVersion: job.Version, IdempotencyKey: "idem-cancel",
	}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Status != SetDecommissionStatusCancelled {
		t.Fatalf("status = %q", cancelled.Status)
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	if set.Status != SetStatusDisabled || set.LifecycleGeneration != 8 {
		t.Fatalf("restored set = %+v", set)
	}
}

func TestFinalizeSetDecommissionRetainsLeaseUntilCleanupEvidence(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive})
	if err := store.SaveSetPlan(t.Context(), SetPlan{
		PlanID: "plan-pro", SetID: "set-a", UpstreamPlanID: 42, Status: SetPlanStatusReady,
	}); err != nil {
		t.Fatal(err)
	}
	lease := SetRuntimeLease{Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a", ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12"}
	if err := store.SaveSetRuntimeLease(t.Context(), lease); err != nil {
		t.Fatal(err)
	}
	preview, _ := store.GetSetDecommissionPreview(t.Context(), "set-a", now)
	job, _ := store.StartSetDecommission(t.Context(), SetDecommissionStartInput{SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "start"}, "decom-a", now)
	claimed, payload, err := store.ClaimSetDecommission(t.Context(), SetDecommissionClaimInput{JobID: job.ID, Owner: "manager", CapabilityHash: "hash", LeaseTTL: time.Minute}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.FinalizeSetDecommission(t.Context(), SetDecommissionFinalizeInput{
		JobID: job.ID, Attempt: claimed.Attempt + 1, ClaimToken: claimed.ClaimToken,
		LeaseFingerprint: payload.LeaseFingerprint, JobUID: "job-uid",
	}, now.Add(time.Second)); err == nil {
		t.Fatal("expected stale attempt to fail")
	}
	leases, _ := store.ListSetRuntimeLeases(t.Context(), SetRuntimeLeaseListOptions{})
	if len(leases) != 1 {
		t.Fatalf("runtime leases after rejected evidence = %d", len(leases))
	}
	finalized, err := store.FinalizeSetDecommission(t.Context(), SetDecommissionFinalizeInput{
		JobID: job.ID, Attempt: claimed.Attempt, ClaimToken: claimed.ClaimToken,
		LeaseFingerprint: payload.LeaseFingerprint, JobUID: "job-uid",
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if finalized.Status != SetDecommissionStatusCleanupAckPending {
		t.Fatalf("finalized status = %q", finalized.Status)
	}
	if _, ok, _ := store.GetSet(t.Context(), "set-a"); ok {
		t.Fatal("set registry row still exists after finalization")
	}
	if _, ok, _ := store.GetSetPlan(t.Context(), "plan-pro", "set-a"); ok {
		t.Fatal("set plan row still exists after finalization")
	}
	leases, _ = store.ListSetRuntimeLeases(t.Context(), SetRuntimeLeaseListOptions{})
	if len(leases) != 0 {
		t.Fatalf("runtime leases after finalization = %d", len(leases))
	}
	acked, err := store.AcknowledgeSetDecommission(t.Context(), job.ID, claimed.Attempt, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if acked.Status != SetDecommissionStatusSucceeded {
		t.Fatalf("acked status = %q", acked.Status)
	}
}

func TestTenantDeletionClaimsPreventOverlappingJobs(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "user-1", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}

	first := previewAndMaterializeTenantDeletion(t, svc, TenantDeletionPreviewInput{UserIDs: []string{"user-1"}})
	first, err := svc.StartTenantDeletion(t.Context(), first.ID, TenantDeletionStartInput{
		ExpectedTargetCount:  first.TargetCount,
		ExpectedTargetDigest: first.TargetDigest,
		IdempotencyKey:       "delete-user-1-first",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != TenantDeletionStatusClaiming {
		t.Fatalf("first status = %q, want claiming", first.Status)
	}
	first, err = svc.RunTenantDeletionMaintenanceOnce(t.Context(), first.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != TenantDeletionStatusQueued || first.ClaimedCount != 1 {
		t.Fatalf("first claimed job = %+v", first)
	}

	second := previewAndMaterializeTenantDeletion(t, svc, TenantDeletionPreviewInput{UserIDs: []string{"user-1"}})
	second, err = svc.StartTenantDeletion(t.Context(), second.ID, TenantDeletionStartInput{
		ExpectedTargetCount:  second.TargetCount,
		ExpectedTargetDigest: second.TargetDigest,
		IdempotencyKey:       "delete-user-1-second",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err = svc.RunTenantDeletionMaintenanceOnce(t.Context(), second.ID, 100)
	if err == nil || !strings.Contains(err.Error(), "already claimed") {
		t.Fatalf("err = %v, want overlapping claim rejection", err)
	}
	stored, ok, getErr := store.GetTenantDeletionJob(t.Context(), second.ID)
	if getErr != nil || !ok {
		t.Fatalf("get second job ok=%v err=%v", ok, getErr)
	}
	if stored.Status != TenantDeletionStatusError {
		t.Fatalf("second status = %q, want error", stored.Status)
	}
}

func TestProcessTenantDeletionRevokesRemoteResourcesAndTombstonesLocally(t *testing.T) {
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/users/42/subscriptions":
			writeGatewayTestJSON(t, w, map[string]any{"success": true, "data": []any{}})
		case "POST /api/user/login":
			writeGatewayTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"id": 42, "username": "sgw-user-1", "role": 1, "status": 1, "group": "default",
			}})
		case "GET /api/user/token":
			writeGatewayTestJSON(t, w, map[string]any{"success": true, "data": "user-access-token"})
		case "GET /api/token/":
			writeGatewayTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"page": 1, "page_size": 100, "total": 1,
				"items": []map[string]any{{"id": 77, "name": "managed-key"}},
			}})
		case "DELETE /api/token/77", "DELETE /api/channel/88":
			writeGatewayTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/manage":
			writeGatewayTestJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected new-api request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	store := NewMemoryStore()
	svc := NewService(store, server.Client().Transport, Options{})
	mustSaveSet(t, store, Set{
		ID: "set-a", BaseURL: server.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin-token", AdmissionStatus: SetAdmissionStatusPassed,
		ObservedUserCount: 1,
	})
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-user-1", Password: "password", ProvisionStatus: BindingProvisionStatusTokenReady,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAPIKeyBinding(t.Context(), APIKeyBinding{
		ExternalKey: "secret", ExternalKeyID: "key-1", SetID: "set-a", UserID: "user-1", UpstreamKey: "sk-upstream", UpstreamKeyID: 77,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserLLMSettings(t.Context(), UserLLMSettings{
		ExternalUserID: "user-1", BYOKGroup: "byok_user_1", Providers: []UserLLMProvider{{
			ID: "provider-1", Enabled: true, RemoteChannelID: 88,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserAssignment(t.Context(), UserAssignment{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenantObservation(t.Context(), TenantObservation{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSubscriptionPeriodOverlay(t.Context(), SubscriptionPeriodOverlay{ExternalUserID: "user-1", SetID: "set-a", PeriodEnd: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}

	job := previewAndMaterializeTenantDeletion(t, svc, TenantDeletionPreviewInput{UserIDs: []string{"user-1"}})
	job, err := svc.StartTenantDeletion(t.Context(), job.ID, TenantDeletionStartInput{
		ExpectedTargetCount:  job.TargetCount,
		ExpectedTargetDigest: job.TargetDigest,
		IdempotencyKey:       "delete-user-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	job, err = svc.RunTenantDeletionMaintenanceOnce(t.Context(), job.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != TenantDeletionStatusQueued {
		t.Fatalf("status after claim = %q", job.Status)
	}
	processed, err := svc.ProcessTenantDeletionTargetOnce(t.Context(), "maintenance-worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("worker did not process deletion target")
	}

	wantCalls := []string{
		"GET /api/subscription/admin/users/42/subscriptions",
		"POST /api/user/login",
		"GET /api/user/token",
		"GET /api/token/",
		"DELETE /api/token/77",
		"DELETE /api/channel/88",
		"POST /api/user/manage",
	}
	if strings.Join(calls, "|") != strings.Join(wantCalls, "|") {
		t.Fatalf("new-api calls = %v, want %v", calls, wantCalls)
	}
	tenant, ok, err := store.GetTenant(t.Context(), "user-1")
	if err != nil || !ok || tenant.Status != TenantStatusDeleted {
		t.Fatalf("tenant after deletion = %+v ok=%v err=%v", tenant, ok, err)
	}
	if _, ok, _ := store.GetUserBinding(t.Context(), "user-1"); ok {
		t.Fatal("user binding remains after deletion")
	}
	if keys, _ := store.ListAPIKeyBindingsByUser(t.Context(), "user-1"); len(keys) != 0 {
		t.Fatalf("api keys remain after deletion: %+v", keys)
	}
	if _, ok, _ := store.GetUserLLMSettings(t.Context(), "user-1"); ok {
		t.Fatal("BYOK settings remain after deletion")
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	if set.ObservedUserCount != 0 {
		t.Fatalf("observed user count = %d, want 0", set.ObservedUserCount)
	}
	job, _, _ = store.GetTenantDeletionJob(t.Context(), job.ID)
	if job.Status != TenantDeletionStatusSucceeded || job.SuccessCount != 1 {
		t.Fatalf("completed job = %+v", job)
	}
}

func TestDeletingTenantRejectsDependentWrites(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusDeleting,
	}); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name  string
		write func() error
	}{
		{"binding", func() error {
			return store.SaveUserBinding(t.Context(), UserBinding{ExternalUserID: "user-1", SetID: "set-a"})
		}},
		{"api key", func() error {
			return store.SaveAPIKeyBinding(t.Context(), APIKeyBinding{ExternalKey: "secret", ExternalKeyID: "key-1", UserID: "user-1", SetID: "set-a"})
		}},
		{"BYOK settings", func() error { return store.SaveUserLLMSettings(t.Context(), UserLLMSettings{ExternalUserID: "user-1"}) }},
		{"assignment", func() error {
			return store.SaveUserAssignment(t.Context(), UserAssignment{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a"})
		}},
		{"observation", func() error {
			return store.SaveTenantObservation(t.Context(), TenantObservation{ExternalUserID: "user-1", SetID: "set-a"})
		}},
		{"overlay", func() error {
			return store.SaveSubscriptionPeriodOverlay(t.Context(), SubscriptionPeriodOverlay{ExternalUserID: "user-1", SetID: "set-a"})
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.write(); !errors.Is(err, ErrTenantInactive) {
				t.Fatalf("err = %v, want ErrTenantInactive", err)
			}
		})
	}
}

func TestDeletedTenantIsHiddenFromDefaultList(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "active", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "deleted", Status: TenantStatusDeleted}); err != nil {
		t.Fatal(err)
	}
	result, err := store.ListTenants(t.Context(), TenantListOptions{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].UserID != "active" {
		t.Fatalf("default tenant list = %+v", result.Items)
	}
	deleted, err := store.ListTenants(t.Context(), TenantListOptions{Status: TenantStatusDeleted, Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(deleted.Items) != 1 || deleted.Items[0].UserID != "deleted" {
		t.Fatalf("deleted tenant list = %+v", deleted.Items)
	}
}

func TestMaintenanceWorkerClaimsAndDeletesQueuedTenant(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "old-user", Backend: UserBackendPending, Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	job := previewAndMaterializeTenantDeletion(t, svc, TenantDeletionPreviewInput{UserIDs: []string{"old-user"}})
	var err error
	job, err = svc.StartTenantDeletion(t.Context(), job.ID, TenantDeletionStartInput{
		ExpectedTargetCount:  job.TargetCount,
		ExpectedTargetDigest: job.TargetDigest,
		IdempotencyKey:       "delete-old-user",
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		done <- svc.RunMaintenanceWorker(ctx, "maintenance-a", time.Millisecond, time.Minute, 100)
	}()
	deadline := time.After(time.Second)
	for {
		job, _, _ = store.GetTenantDeletionJob(t.Context(), job.ID)
		if job.Status == TenantDeletionStatusSucceeded {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("maintenance worker did not finish job: %+v", job)
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestMaintenanceCyclePublishesPendingSetRuntimeRoutes(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 16, 10, 0, 0, 0, time.UTC)
	cache := NewMemoryAPIKeyRouteCache(0, 10)
	svc := NewService(store, nil, Options{KeyRouteCache: cache})
	svc.now = func() time.Time { return now }
	store.mu.Lock()
	store.setRuntimeRouteOutbox["route-a"] = SetRuntimeRouteOutbox{
		ID: "route-a", SetID: "set-a", RouteRevision: 7, Status: SetRuntimeRouteOutboxStatusPending,
		Snapshot: SetRuntimeRouteSnapshot{SetID: "set-a", RuntimeGeneration: 3, RouteRevision: 7, TrafficBaseURL: "http://set-a-g3:3000", Enabled: true},
	}
	store.mu.Unlock()
	if err := svc.runMaintenanceCycle(t.Context(), "maintenance-a", time.Minute, 100); err != nil {
		t.Fatal(err)
	}
	route, ok, err := cache.GetSetRuntime(t.Context(), "set-a")
	if err != nil || !ok || route.RouteRevision != 7 {
		t.Fatalf("route=%+v ok=%v err=%v", route, ok, err)
	}
}

func previewAndMaterializeTenantDeletion(t *testing.T, svc *Service, input TenantDeletionPreviewInput) TenantDeletionJob {
	t.Helper()
	job, err := svc.PreviewTenantDeletion(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	for job.Status == TenantDeletionStatusMaterializing {
		job, err = svc.RunTenantDeletionMaintenanceOnce(t.Context(), job.ID, 100)
		if err != nil {
			t.Fatal(err)
		}
	}
	return job
}

func writeGatewayTestJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatal(err)
	}
}
