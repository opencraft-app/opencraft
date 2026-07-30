package gateway

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestRebuildAPIKeyRoutesRestoresRuntimeAndBYOKRoute(t *testing.T) {
	store := NewMemoryStore()
	set := Set{
		ID: "set-a", BaseURL: "http://admin", TrafficBaseURL: "http://traffic",
		Status: SetStatusActive, Setup: true, RouteRevision: 7, ActiveRuntimeGeneration: 3,
	}
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntime(t.Context(), SetRuntime{
		SetID: set.ID, Generation: 3, TrafficBaseURL: set.TrafficBaseURL, Status: SetRuntimeStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1", Backend: UserBackendNew, SetID: set.ID, Status: TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserLLMSettings(t.Context(), UserLLMSettings{
		ExternalUserID:  "user-1",
		Routing:         UserLLMRouting{Mode: LLMRouteBYOKFirst},
		BYOKUpstreamKey: "sk-byok",
	}); err != nil {
		t.Fatal(err)
	}
	binding := saveRecoverableAPIKey(t, store, 1, "user-1", set.ID, APIKeyStatusActive)

	cache := NewMemoryAPIKeyRouteCache(time.Hour, 100)
	svc := NewService(store, nil, Options{KeyRouteCache: cache, WorkerKeyRouteRebuildBatch: 100})
	run, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != WorkerJobStatusSuccess || !strings.Contains(run.Detail, "restored=1") || !strings.Contains(run.Detail, "completed=true") {
		t.Fatalf("unexpected worker run: %+v", run)
	}
	runtime, ok, err := cache.GetSetRuntime(t.Context(), set.ID)
	if err != nil || !ok || runtime.RouteRevision != set.RouteRevision || runtime.TrafficBaseURL != set.TrafficBaseURL {
		t.Fatalf("runtime route = %+v ok=%v err=%v", runtime, ok, err)
	}
	route, ok, err := cache.GetRoute(t.Context(), trafficRouteLookupForBinding(binding))
	if err != nil || !ok {
		t.Fatalf("key route lookup ok=%v err=%v", ok, err)
	}
	if route.UpstreamKey != "sk-byok" || route.PlatformKey != "sk-platform" || route.RouteMode != LLMRouteBYOKFirst {
		t.Fatalf("restored BYOK route = %+v", route)
	}
}

func TestRebuildAPIKeyRoutesUsesPersistentKeysetCursor(t *testing.T) {
	store, cache, svc := newRouteRebuildFixture(t, 2)
	bindings := []APIKeyBinding{
		saveRecoverableAPIKey(t, store, 1, "user-1", "set-a", APIKeyStatusActive),
		saveRecoverableAPIKey(t, store, 2, "user-1", "set-a", APIKeyStatusActive),
		saveRecoverableAPIKey(t, store, 3, "user-1", "set-a", APIKeyStatusActive),
	}

	first, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(first.Detail, "restored=2") || !strings.Contains(first.Detail, "completed=false") {
		t.Fatalf("first run = %+v", first)
	}
	job, ok, err := store.GetWorkerJob(t.Context(), WorkerJobRebuildAPIKeyRoutes)
	if err != nil || !ok || strings.TrimSpace(job.Cursor) == "" || job.IntervalSeconds != 1 {
		t.Fatalf("job after first page = %+v ok=%v err=%v", job, ok, err)
	}

	second, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(second.Detail, "restored=3") || !strings.Contains(second.Detail, "completed=true") {
		t.Fatalf("second run = %+v", second)
	}
	job, ok, err = store.GetWorkerJob(t.Context(), WorkerJobRebuildAPIKeyRoutes)
	if err != nil || !ok || job.Cursor != "" || job.IntervalSeconds != 3600 {
		t.Fatalf("job after completed cycle = %+v ok=%v err=%v", job, ok, err)
	}
	for _, binding := range bindings {
		if _, ok, err := cache.GetRoute(t.Context(), trafficRouteLookupForBinding(binding)); err != nil || !ok {
			t.Fatalf("route %s ok=%v err=%v", binding.ExternalKeyID, ok, err)
		}
	}
}

func TestRebuildAPIKeyRoutesDoesNotAdvancePastFailedBinding(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: "http://admin", TrafficBaseURL: "http://traffic",
		Status: SetStatusActive, Setup: true, RouteRevision: 1, ActiveRuntimeGeneration: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	bindings := []APIKeyBinding{
		saveRecoverableAPIKey(t, store, 1, "user-1", "set-a", APIKeyStatusActive),
		saveRecoverableAPIKey(t, store, 2, "user-1", "set-a", APIKeyStatusActive),
		saveRecoverableAPIKey(t, store, 3, "user-1", "set-a", APIKeyStatusActive),
	}
	sort.Slice(bindings, func(i, j int) bool { return bindings[i].ExternalKeyID < bindings[j].ExternalKeyID })
	cache := &failingRouteRebuildCache{MemoryAPIKeyRouteCache: NewMemoryAPIKeyRouteCache(time.Hour, 100), failKeyID: bindings[1].ExternalKeyID}
	svc := NewService(store, nil, Options{KeyRouteCache: cache, WorkerKeyRouteRebuildBatch: 10})

	run, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes)
	if err == nil || run.Status != WorkerJobStatusError {
		t.Fatalf("run = %+v err=%v, want failed run", run, err)
	}
	job, ok, getErr := store.GetWorkerJob(t.Context(), WorkerJobRebuildAPIKeyRoutes)
	if getErr != nil || !ok {
		t.Fatalf("job lookup ok=%v err=%v", ok, getErr)
	}
	cursor, valid := decodeAPIKeyRouteRebuildCursor(job.Cursor)
	if !valid || cursor.AfterKeyID != bindings[0].ExternalKeyID {
		t.Fatalf("cursor = %+v valid=%v, want after first successful key", cursor, valid)
	}
	if _, ok, _ := cache.GetRoute(t.Context(), trafficRouteLookupForBinding(bindings[2])); ok {
		t.Fatal("route after failed key must not be published")
	}

	cache.failKeyID = ""
	if _, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes); err != nil {
		t.Fatal(err)
	}
	for _, binding := range bindings {
		if _, ok, err := cache.GetRoute(t.Context(), trafficRouteLookupForBinding(binding)); err != nil || !ok {
			t.Fatalf("route %s ok=%v err=%v", binding.ExternalKeyID, ok, err)
		}
	}
}

func TestAPIKeyRouteRebuildMetricsExposeCycleProgress(t *testing.T) {
	store, _, svc := newRouteRebuildFixture(t, 1)
	svc.now = func() time.Time { return testNow() }
	saveRecoverableAPIKey(t, store, 1, "user-1", "set-a", APIKeyStatusActive)
	saveRecoverableAPIKey(t, store, 2, "user-1", "set-a", APIKeyStatusActive)
	if _, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes); err != nil {
		t.Fatal(err)
	}
	metrics := svc.PrometheusMetrics()
	for _, want := range []string{
		"llmgateway_key_route_rebuild_in_progress 1",
		"llmgateway_key_route_rebuild_restored 1",
		"llmgateway_key_route_rebuild_cycle_started_timestamp_seconds 1784289600",
	} {
		if !strings.Contains(metrics, want) {
			t.Fatalf("metrics missing %q:\n%s", want, metrics)
		}
	}
}

func TestQueueAPIKeyRouteRebuildResetsCompletedOrPartialCursor(t *testing.T) {
	store, _, svc := newRouteRebuildFixture(t, 1)
	saveRecoverableAPIKey(t, store, 1, "user-1", "set-a", APIKeyStatusActive)
	saveRecoverableAPIKey(t, store, 2, "user-1", "set-a", APIKeyStatusActive)
	if _, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes); err != nil {
		t.Fatal(err)
	}
	job, _, _ := store.GetWorkerJob(t.Context(), WorkerJobRebuildAPIKeyRoutes)
	if job.Cursor == "" {
		t.Fatal("test setup requires a partial rebuild cursor")
	}
	if _, err := svc.QueueWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes); err != nil {
		t.Fatal(err)
	}
	job, _, _ = store.GetWorkerJob(t.Context(), WorkerJobRebuildAPIKeyRoutes)
	if job.Cursor != "" {
		t.Fatalf("queued disaster rebuild retained cursor %q", job.Cursor)
	}
}

func TestQueueWorkerJobNowDoesNotOverwriteRunningLease(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if _, err := svc.ListWorkerJobs(t.Context()); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, acquired, err := store.TryAcquireWorkerJobLease(t.Context(), WorkerJobCheckChannelDrift, "worker-a", time.Minute, now); err != nil || !acquired {
		t.Fatalf("acquire lease=%v err=%v", acquired, err)
	}
	if _, err := svc.QueueWorkerJobNow(t.Context(), WorkerJobCheckChannelDrift); err == nil {
		t.Fatal("queue while running must fail instead of overwriting the lease")
	}
	job, _, _ := store.GetWorkerJob(t.Context(), WorkerJobCheckChannelDrift)
	if job.Status != WorkerJobStatusRunning || job.LeaseOwner != "worker-a" {
		t.Fatalf("running lease was overwritten: %+v", job)
	}
}

func TestRebuildAPIKeyRoutesFailsClosedForOrphanedTenant(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", TrafficBaseURL: "http://traffic", Status: SetStatusActive, RouteRevision: 1}); err != nil {
		t.Fatal(err)
	}
	binding := saveRecoverableAPIKey(t, store, 9, "missing-user", "set-a", APIKeyStatusActive)
	cache := NewMemoryAPIKeyRouteCache(time.Hour, 10)
	svc := NewService(store, nil, Options{KeyRouteCache: cache})
	if _, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes); err != nil {
		t.Fatal(err)
	}
	route, ok, err := cache.GetRoute(t.Context(), trafficRouteLookupForBinding(binding))
	if err != nil || !ok {
		t.Fatalf("route lookup ok=%v err=%v", ok, err)
	}
	if route.Enabled {
		t.Fatalf("orphaned tenant route must fail closed: %+v", route)
	}
}

func TestRebuildAPIKeyRoutesRecoversAfterRedisFlushDB(t *testing.T) {
	redisServer, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer redisServer.Close()
	client := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	defer client.Close()
	cache := NewRedisAPIKeyRouteCache(client, time.Hour, "recovery-test")
	store, _, _ := newRouteRebuildFixture(t, 100)
	binding := saveRecoverableAPIKey(t, store, 10, "user-1", "set-a", APIKeyStatusActive)
	svc := NewService(store, nil, Options{KeyRouteCache: cache, WorkerKeyRouteRebuildBatch: 100})
	if _, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := cache.GetRoute(t.Context(), trafficRouteLookupForBinding(binding)); !ok {
		t.Fatal("preflight route is missing")
	}
	redisServer.FlushAll()
	if _, ok, _ := cache.GetRoute(t.Context(), trafficRouteLookupForBinding(binding)); ok {
		t.Fatal("route remained after FLUSHDB")
	}
	if _, err := svc.QueueWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRebuildAPIKeyRoutes); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := cache.GetRoute(t.Context(), trafficRouteLookupForBinding(binding)); err != nil || !ok {
		t.Fatalf("route after recovery ok=%v err=%v", ok, err)
	}
	if _, ok, err := cache.GetSetRuntime(t.Context(), "set-a"); err != nil || !ok {
		t.Fatalf("runtime route after recovery ok=%v err=%v", ok, err)
	}
}

func newRouteRebuildFixture(t *testing.T, batch int) (*MemoryStore, *MemoryAPIKeyRouteCache, *Service) {
	t.Helper()
	store := NewMemoryStore()
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: "http://admin", TrafficBaseURL: "http://traffic",
		Status: SetStatusActive, Setup: true, RouteRevision: 1, ActiveRuntimeGeneration: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	cache := NewMemoryAPIKeyRouteCache(time.Hour, 100)
	return store, cache, NewService(store, nil, Options{KeyRouteCache: cache, WorkerKeyRouteRebuildBatch: batch})
}

func saveRecoverableAPIKey(t *testing.T, store Store, seed byte, userID, setID, status string) APIKeyBinding {
	t.Helper()
	material, err := generateExternalKeyV2(bytes.NewReader(bytes.Repeat([]byte{seed}, externalKeyRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	binding := APIKeyBinding{
		ExternalKey: material.ExternalKey, ExternalKeyHash: material.ExternalKeyHash, ExternalKeyID: material.ExternalKeyID,
		SecretHash: material.SecretHash, KeyVersion: material.Version, RouteSlot: material.RouteSlot,
		SetID: setID, UserID: userID, UpstreamKey: "sk-platform", UpstreamKeyID: int(seed), Status: status,
		CreatedAt: testNow().Add(time.Duration(seed) * time.Second), UpdatedAt: testNow().Add(time.Duration(seed) * time.Second),
	}
	if err := store.SaveAPIKeyBinding(t.Context(), binding); err != nil {
		t.Fatal(err)
	}
	return binding
}

func trafficRouteLookupForBinding(binding APIKeyBinding) TrafficRouteLookup {
	return TrafficRouteLookup{
		ExternalKeyHash: binding.ExternalKeyHash, ExternalKeyID: binding.ExternalKeyID,
		SecretHash: binding.SecretHash, Version: binding.KeyVersion, RouteSlot: binding.RouteSlot, Valid: true,
	}
}

type failingRouteRebuildCache struct {
	*MemoryAPIKeyRouteCache
	failKeyID string
}

func (c *failingRouteRebuildCache) SetRoute(ctx context.Context, snapshot TrafficRouteSnapshot) error {
	if snapshot.ExternalKeyID == c.failKeyID {
		return errors.New("redis write failed")
	}
	return c.MemoryAPIKeyRouteCache.SetRoute(ctx, snapshot)
}
