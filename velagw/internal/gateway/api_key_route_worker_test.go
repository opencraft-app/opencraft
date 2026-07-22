package gateway

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestPublishAPIKeyRoutesWorkerActivatesRoutePendingBinding(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: "http://admin", TrafficBaseURL: "http://traffic",
		Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	material, err := generateExternalKeyV2(bytes.NewReader(bytes.Repeat([]byte{11}, externalKeyRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	binding := APIKeyBinding{
		ExternalKey: material.ExternalKey, ExternalKeyHash: material.ExternalKeyHash, ExternalKeyID: material.ExternalKeyID,
		SecretHash: material.SecretHash, KeyVersion: material.Version, RouteSlot: material.RouteSlot,
		SetID: "set-a", UserID: "user-1", Status: APIKeyStatusReserved,
	}
	if err := store.ReserveAPIKeyBinding(t.Context(), binding); err != nil {
		t.Fatal(err)
	}
	if _, err := store.TransitionAPIKeyBinding(t.Context(), binding.ExternalKeyID, APIKeyStatusReserved, APIKeyStatusUpstreamReady, "sk-upstream", 7, "", testNow()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.TransitionAPIKeyBinding(t.Context(), binding.ExternalKeyID, APIKeyStatusUpstreamReady, APIKeyStatusRoutePending, "", 0, "redis unavailable", testNow()); err != nil {
		t.Fatal(err)
	}

	cache := NewMemoryAPIKeyRouteCache(0, 100)
	svc := NewService(store, nil, Options{KeyRouteCache: cache})
	run, err := svc.RunWorkerJobNow(t.Context(), WorkerJobPublishAPIKeyRoutes)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != WorkerJobStatusSuccess || !strings.Contains(run.Detail, "published=1 failed=0") {
		t.Fatalf("unexpected worker run: %+v", run)
	}
	saved, ok, err := store.GetAPIKeyBindingByExternalKeyID(t.Context(), binding.ExternalKeyID)
	if err != nil || !ok {
		t.Fatalf("binding lookup ok=%v err=%v", ok, err)
	}
	if saved.Status != APIKeyStatusActive || saved.LastError != "" {
		t.Fatalf("binding after worker = %+v", saved)
	}
	lookup := parseTrafficRouteLookup(material.ExternalKey)
	if _, ok, err := cache.GetRoute(t.Context(), lookup); err != nil || !ok {
		t.Fatalf("route lookup ok=%v err=%v", ok, err)
	}
}

func TestPublishAPIKeyRoutesWorkerAcceptsForegroundWinningActivationRace(t *testing.T) {
	memory := NewMemoryStore()
	prepareRoutePendingBinding(t, memory)
	store := &routeActivationRaceStore{Store: memory}
	svc := NewService(store, nil, Options{KeyRouteCache: NewMemoryAPIKeyRouteCache(0, 100)})

	run, err := svc.RunWorkerJobNow(t.Context(), WorkerJobPublishAPIKeyRoutes)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != WorkerJobStatusSuccess || !strings.Contains(run.Detail, "published=1 failed=0") || !store.raced.Load() {
		t.Fatalf("run = %+v raced=%t", run, store.raced.Load())
	}
}

func prepareRoutePendingBinding(t *testing.T, store Store) {
	t.Helper()
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", Status: SetStatusActive, Setup: true, TrafficBaseURL: "http://set-a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	material, err := generateExternalKeyV2(bytes.NewReader(bytes.Repeat([]byte{13}, externalKeyRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	binding := APIKeyBinding{
		ExternalKey: material.ExternalKey, ExternalKeyHash: material.ExternalKeyHash, ExternalKeyID: material.ExternalKeyID,
		SecretHash: material.SecretHash, KeyVersion: material.Version, RouteSlot: material.RouteSlot,
		SetID: "set-a", UserID: "user-1", Status: APIKeyStatusReserved,
	}
	if err := store.ReserveAPIKeyBinding(t.Context(), binding); err != nil {
		t.Fatal(err)
	}
	if _, err := store.TransitionAPIKeyBinding(t.Context(), binding.ExternalKeyID, APIKeyStatusReserved, APIKeyStatusUpstreamReady, "sk-upstream", 7, "", testNow()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.TransitionAPIKeyBinding(t.Context(), binding.ExternalKeyID, APIKeyStatusUpstreamReady, APIKeyStatusRoutePending, "", 0, "", testNow()); err != nil {
		t.Fatal(err)
	}
}

func testNow() time.Time {
	return time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
}
