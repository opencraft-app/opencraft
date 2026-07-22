package gateway

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testUpgradeImage = "example.com/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestSetUpgradeProbeQuotaIsOverriddenForDedicatedUser(t *testing.T) {
	var calls []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer admin-token" || r.Header.Get("New-Api-User") != "1" {
			t.Fatalf("headers=%v", r.Header)
		}
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/manage":
			var body struct {
				ID     int    `json:"id"`
				Action string `json:"action"`
				Mode   string `json:"mode"`
				Value  int    `json:"value"`
			}
			decodeTestJSON(t, r, &body)
			if body.ID != 42 || body.Action != "add_quota" || body.Mode != "override" || body.Value != setUpgradeProbeQuota {
				t.Fatalf("body=%+v", body)
			}
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/user/42":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"id": 42, "username": "probe-user", "display_name": "probe-user",
				"role": 1, "status": 1, "group": "default", "quota": setUpgradeProbeQuota,
			}})
		case "PUT /api/user/":
			writeTestJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("request=%s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{ID: "set-a", BaseURL: upstream.URL, AdminUserID: 1, AdminAccessToken: "admin-token"})
	if err := store.SaveUserBinding(t.Context(), UserBinding{ExternalUserID: "probe-user", SetID: "set-a", UpstreamUserID: 42}); err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, upstream.Client().Transport, Options{})
	set, _, _ := store.GetSet(t.Context(), "set-a")
	if err := svc.ensureSetUpgradeProbeQuota(t.Context(), set, "probe-user"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(calls, ","); got != "POST /api/user/manage,GET /api/user/42,PUT /api/user/" {
		t.Fatalf("calls=%q", got)
	}
}

func TestCreateSetUpgradeBatchAllocatesNextGenerationAndRejectsConcurrentRun(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{
		ID: "set-a", Status: SetStatusActive, ActiveRuntimeGeneration: 12, RouteRevision: 20,
	})
	if err := store.SaveSetRuntime(t.Context(), SetRuntime{
		SetID: "set-a", Generation: 12, Image: "old@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		TrafficBaseURL: "http://set-a-g12:3000", Status: SetRuntimeStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Options{})

	batch, err := svc.CreateSetUpgradeBatch(t.Context(), CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-a"}, TargetImage: testUpgradeImage,
		DrainTimeout: 15 * time.Second, RollbackWindow: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Runs) != 1 || batch.Runs[0].FromGeneration != 12 || batch.Runs[0].ToGeneration != 13 {
		t.Fatalf("unexpected batch: %+v", batch)
	}
	if _, err := svc.CreateSetUpgradeBatch(t.Context(), CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-a"}, TargetImage: testUpgradeImage,
	}); !errors.Is(err, ErrSetUpgradeAlreadyActive) {
		t.Fatalf("concurrent upgrade error=%v, want %v", err, ErrSetUpgradeAlreadyActive)
	}
}

func TestCreateSetUpgradeBatchNeverReusesRetiredGenerationAfterRollback(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{
		ID: "set-a", Status: SetStatusActive, ActiveRuntimeGeneration: 12, RouteRevision: 22,
	})
	for _, runtime := range []SetRuntime{
		{SetID: "set-a", Generation: 12, Image: "old@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", TrafficBaseURL: "http://set-a-g12:3000", Status: SetRuntimeStatusActive},
		{SetID: "set-a", Generation: 13, Image: testUpgradeImage, TrafficBaseURL: "http://set-a-g13:3000", Status: SetRuntimeStatusRetired},
	} {
		if err := store.SaveSetRuntime(t.Context(), runtime); err != nil {
			t.Fatal(err)
		}
	}
	svc := NewService(store, nil, Options{})
	batch, err := svc.CreateSetUpgradeBatch(t.Context(), CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-a"}, TargetImage: "next@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := batch.Runs[0].ToGeneration; got != 14 {
		t.Fatalf("to_generation=%d want 14", got)
	}
}

func TestCreateSetUpgradeBatchRequiresDigestPinnedImage(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive})
	svc := NewService(store, nil, Options{})
	if _, err := svc.CreateSetUpgradeBatch(t.Context(), CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-a"}, TargetImage: "calciumion/new-api:latest",
	}); err == nil {
		t.Fatal("tag-based image unexpectedly accepted")
	}
}

func TestSetUpgradeRunLeaseIsExclusive(t *testing.T) {
	store, run := newPendingUpgradeRun(t)
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	first, ok, err := store.TryAcquireSetUpgradeRun(t.Context(), run.ID, "manager-a", time.Minute, now)
	if err != nil || !ok {
		t.Fatalf("first claim ok=%v err=%v", ok, err)
	}
	if _, ok, err := store.TryAcquireSetUpgradeRun(t.Context(), run.ID, "manager-b", time.Minute, now.Add(time.Second)); err != nil || ok {
		t.Fatalf("competing claim ok=%v err=%v", ok, err)
	}
	if _, ok, err := store.TryAcquireSetUpgradeRun(t.Context(), run.ID, "manager-b", time.Minute, first.LeaseUntil.Add(time.Second)); err != nil || !ok {
		t.Fatalf("expired claim takeover ok=%v err=%v", ok, err)
	}
}

func TestSetUpgradeRunStopsWhenSetLifecycleChanges(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{
		ID: "set-a", Status: SetStatusActive, LifecycleGeneration: 4,
		ActiveRuntimeGeneration: 1, LastRuntimeGeneration: 1,
	})
	if err := store.SaveSetRuntime(t.Context(), SetRuntime{
		SetID: "set-a", Generation: 1, Image: "old@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		TrafficBaseURL: "http://set-a-g1:3000", Status: SetRuntimeStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Options{})
	batch, err := svc.CreateSetUpgradeBatch(t.Context(), CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-a"}, TargetImage: testUpgradeImage,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, ok, err := store.TryAcquireSetUpgradeRun(t.Context(), batch.Runs[0].ID, "manager", time.Minute, time.Now().UTC())
	if err != nil || !ok {
		t.Fatalf("claim ok=%v err=%v", ok, err)
	}
	run, err = store.CompleteSetUpgradeMaster(t.Context(), run, true, "", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	run, err = store.CompleteSetUpgradeCompatibility(t.Context(), run, true, "", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	set.Status = SetStatusDraining
	set.LifecycleGeneration++
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	_, err = store.PrepareSetUpgradeRuntime(t.Context(), run, SetRuntime{
		SetID: "set-a", Generation: run.ToGeneration, Image: run.TargetImage,
		TrafficBaseURL: "http://set-a-g2:3000",
	}, time.Now().UTC())
	if err == nil || !strings.Contains(err.Error(), "lifecycle changed") {
		t.Fatalf("prepare error=%v", err)
	}
}

func TestSetUpgradeRunsAdminBeforePreparingTraffic(t *testing.T) {
	store, run := newPendingUpgradeRun(t)
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	claimed, ok, err := store.TryAcquireSetUpgradeRun(t.Context(), run.ID, "manager-a", time.Minute, now)
	if err != nil || !ok || claimed.Status != SetUpgradeRunStatusUpgradingMaster {
		t.Fatalf("claim run=%+v ok=%v err=%v", claimed, ok, err)
	}
	set, _, _ := store.GetSet(t.Context(), run.SetID)
	if !set.AdminWritesPaused || setReadyForServing(set) {
		t.Fatalf("claim did not pause management admission before master upgrade: %+v", set)
	}
	if _, err := store.PrepareSetUpgradeRuntime(t.Context(), claimed, SetRuntime{
		SetID: run.SetID, Generation: run.ToGeneration, Image: run.TargetImage,
		TrafficBaseURL: "http://set-a-g13:3000",
	}, now); err == nil {
		t.Fatal("traffic candidate prepared before admin upgrade")
	}
	claimed, err = store.CompleteSetUpgradeMaster(t.Context(), claimed, true, "", now.Add(2*time.Second))
	if err != nil || claimed.Status != SetUpgradeRunStatusVerifyingCompatibility {
		t.Fatalf("master run=%+v err=%v", claimed, err)
	}
	set, _, _ = store.GetSet(t.Context(), run.SetID)
	if set.AdminHealthStatus != SetAdminHealthHealthy || set.AdminHealthError != "" {
		t.Fatalf("admin health was not restored after successful master readiness: %+v", set)
	}
	claimed, err = store.CompleteSetUpgradeCompatibility(t.Context(), claimed, true, "", now.Add(3*time.Second))
	if err != nil || claimed.Status != SetUpgradeRunStatusPreparing {
		t.Fatalf("compatibility run=%+v err=%v", claimed, err)
	}
	set, _, _ = store.GetSet(t.Context(), run.SetID)
	if !set.AdminWritesPaused {
		t.Fatal("management writes resumed before traffic cutover")
	}
	claimed, err = store.PrepareSetUpgradeRuntime(t.Context(), claimed, SetRuntime{
		SetID: run.SetID, Generation: run.ToGeneration, Image: run.TargetImage,
		TrafficBaseURL: "http://set-a-g13:3000",
	}, now.Add(4*time.Second))
	if err != nil || claimed.Status != SetUpgradeRunStatusProbing {
		t.Fatalf("prepare run=%+v err=%v", claimed, err)
	}
}

func TestSetUpgradeBatchMaxParallelIsEnforcedAtClaim(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 16, 10, 0, 0, 0, time.UTC)
	for _, setID := range []string{"set-a", "set-b"} {
		mustSaveSet(t, store, Set{ID: setID, Status: SetStatusActive})
	}
	svc := NewService(store, nil, Options{})
	svc.now = func() time.Time { return now }
	batch, err := svc.CreateSetUpgradeBatch(t.Context(), CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-a", "set-b"}, TargetImage: testUpgradeImage, MaxParallel: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, acquired, err := store.TryAcquireSetUpgradeRun(t.Context(), batch.Runs[0].ID, "manager-a", time.Minute, now); err != nil || !acquired {
		t.Fatalf("first claim acquired=%v err=%v", acquired, err)
	}
	if _, acquired, err := store.TryAcquireSetUpgradeRun(t.Context(), batch.Runs[1].ID, "manager-b", time.Minute, now); err != nil || acquired {
		t.Fatalf("second claim acquired=%v err=%v, want capacity refusal", acquired, err)
	}
}

func TestSetUpgradeBatchStatusIsDerivedFromRuns(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive})
	svc := NewService(store, nil, Options{})
	batch, err := svc.CreateSetUpgradeBatch(t.Context(), CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-a"}, TargetImage: testUpgradeImage, StopOnFailure: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	got, ok, err := store.GetSetUpgradeBatch(t.Context(), batch.ID)
	if err != nil || !ok || got.Status != SetUpgradeBatchStatusPending {
		t.Fatalf("pending batch=%+v ok=%v err=%v", got, ok, err)
	}
	run := got.Runs[0]
	run.Status = SetUpgradeRunStatusProbing
	store.setUpgradeRuns[run.ID] = run
	got, _, _ = store.GetSetUpgradeBatch(t.Context(), batch.ID)
	if got.Status != SetUpgradeBatchStatusRunning {
		t.Fatalf("running status=%q", got.Status)
	}
	run.Status = SetUpgradeRunStatusFailed
	store.setUpgradeRuns[run.ID] = run
	got, _, _ = store.GetSetUpgradeBatch(t.Context(), batch.ID)
	if got.Status != SetUpgradeBatchStatusFailed {
		t.Fatalf("failed status=%q", got.Status)
	}
}

func TestStoppedSetUpgradeBatchDoesNotClaimAnotherPendingRun(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 16, 10, 0, 0, 0, time.UTC)
	for _, setID := range []string{"set-a", "set-b"} {
		mustSaveSet(t, store, Set{ID: setID, Status: SetStatusActive})
	}
	svc := NewService(store, nil, Options{})
	svc.now = func() time.Time { return now }
	batch, err := svc.CreateSetUpgradeBatch(t.Context(), CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-a", "set-b"}, TargetImage: testUpgradeImage, MaxParallel: 2, StopOnFailure: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	failed := store.setUpgradeRuns[batch.Runs[0].ID]
	failed.Status = SetUpgradeRunStatusFailed
	store.setUpgradeRuns[failed.ID] = failed
	store.mu.Unlock()
	if _, acquired, err := store.TryAcquireSetUpgradeRun(t.Context(), batch.Runs[1].ID, "manager-b", time.Minute, now); err != nil || acquired {
		t.Fatalf("claim acquired=%v err=%v, want stopped batch", acquired, err)
	}
}

func TestSetUpgradeProbeSwitchAndRollbackAdvanceRouteRevision(t *testing.T) {
	store, run := newPendingUpgradeRun(t)
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	claimed, ok, err := store.TryAcquireSetUpgradeRun(t.Context(), run.ID, "manager-a", time.Minute, now)
	if err != nil || !ok {
		t.Fatalf("claim ok=%v err=%v", ok, err)
	}
	claimed = advanceUpgradeToPreparing(t, store, claimed, now)
	candidate := SetRuntime{
		SetID: run.SetID, Generation: run.ToGeneration, Image: run.TargetImage,
		TrafficBaseURL: "http://set-a-g13:3000", Status: SetRuntimeStatusPreparing,
	}
	claimed, err = store.PrepareSetUpgradeRuntime(t.Context(), claimed, candidate, now)
	if err != nil || claimed.Status != SetUpgradeRunStatusProbing {
		t.Fatalf("prepare run=%+v err=%v", claimed, err)
	}
	for i := 1; i <= 3; i++ {
		claimed, err = store.RecordSetUpgradeProbe(t.Context(), claimed, true, "", now.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
	}
	if claimed.Status != SetUpgradeRunStatusSwitching || claimed.ConsecutiveProbeSuccesses != 3 {
		t.Fatalf("run after probes=%+v", claimed)
	}

	claimed, snapshot, err := store.SwitchSetUpgradeRuntime(t.Context(), claimed, now.Add(4*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != SetUpgradeRunStatusSwitching || snapshot.RouteRevision != 21 || snapshot.RuntimeGeneration != 13 {
		t.Fatalf("switch run=%+v snapshot=%+v", claimed, snapshot)
	}
	claimed, ok, err = store.ConfirmSetRuntimeRoutePublished(t.Context(), "set-a", 21, now.Add(4*time.Second))
	if err != nil || !ok || claimed.Status != SetUpgradeRunStatusDraining {
		t.Fatalf("confirm switch run=%+v ok=%v err=%v", claimed, ok, err)
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	if set.ActiveRuntimeGeneration != 13 || set.RouteRevision != 21 {
		t.Fatalf("set after switch=%+v", set)
	}
	if set.AdminWritesPaused {
		t.Fatal("management writes remained paused after Green route publication")
	}

	claimed, rollbackSnapshot, err := store.RollbackSetUpgradeRuntime(t.Context(), claimed, now.Add(5*time.Second), "green unhealthy")
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != SetUpgradeRunStatusRollbackSwitching || rollbackSnapshot.RouteRevision != 22 || rollbackSnapshot.RuntimeGeneration != 12 {
		t.Fatalf("rollback run=%+v snapshot=%+v", claimed, rollbackSnapshot)
	}
	claimed, ok, err = store.ConfirmSetRuntimeRoutePublished(t.Context(), "set-a", 22, now.Add(5*time.Second))
	if err != nil || !ok || claimed.Status != SetUpgradeRunStatusRollbackDraining {
		t.Fatalf("confirm rollback run=%+v ok=%v err=%v", claimed, ok, err)
	}
	set, _, _ = store.GetSet(t.Context(), "set-a")
	if set.ActiveRuntimeGeneration != 12 || set.RouteRevision != 22 {
		t.Fatalf("set after rollback=%+v", set)
	}
}

func TestPostSwitchProbeRequestsRollbackAfterThreeFailures(t *testing.T) {
	store, run := switchedUpgradeRun(t)
	now := run.SwitchedAt.Add(time.Second)
	for i := 1; i <= 3; i++ {
		var shouldRollback bool
		var err error
		run, shouldRollback, err = store.RecordSetUpgradePostSwitchProbe(t.Context(), run, false, "green failed", now.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if shouldRollback != (i == 3) {
			t.Fatalf("probe %d shouldRollback=%v", i, shouldRollback)
		}
	}
}

func TestDrainCompletionRetiresOldRuntimeAndCompletesRun(t *testing.T) {
	store, run := switchedUpgradeRun(t)
	if _, err := store.AdvanceSetUpgradeAfterDrain(t.Context(), run, run.DrainDeadline.Add(-time.Second)); err == nil {
		t.Fatal("drain completed before deadline")
	}
	run, err := store.AdvanceSetUpgradeAfterDrain(t.Context(), run, run.DrainDeadline)
	if err != nil || run.Status != SetUpgradeRunStatusCompleted {
		t.Fatalf("advance run=%+v err=%v", run, err)
	}
	oldRuntime, _, _ := store.GetSetRuntime(t.Context(), run.SetID, run.FromGeneration)
	if oldRuntime.Status != SetRuntimeStatusRetired {
		t.Fatalf("old runtime status=%q, want retired", oldRuntime.Status)
	}
	set, _, _ := store.GetSet(t.Context(), run.SetID)
	if set.AdminImage != run.TargetImage {
		t.Fatalf("admin image=%q, want %q", set.AdminImage, run.TargetImage)
	}
}

func TestRuntimeRouteOutboxPublishesIdempotently(t *testing.T) {
	store, run := switchedUpgradeRun(t)
	cache := NewMemoryAPIKeyRouteCache(time.Minute, 10)
	svc := NewService(store, nil, Options{KeyRouteCache: cache})
	published, failed, err := svc.PublishPendingSetRuntimeRoutes(t.Context(), 10)
	if err != nil || published != 1 || failed != 0 {
		t.Fatalf("publish result published=%d failed=%d err=%v", published, failed, err)
	}
	runtimeRoute, ok, err := cache.GetSetRuntime(t.Context(), run.SetID)
	if err != nil || !ok || runtimeRoute.RouteRevision != 21 {
		t.Fatalf("runtime route=%+v ok=%v err=%v", runtimeRoute, ok, err)
	}
	published, failed, err = svc.PublishPendingSetRuntimeRoutes(t.Context(), 10)
	if err != nil || published != 0 || failed != 0 {
		t.Fatalf("second publish result published=%d failed=%d err=%v", published, failed, err)
	}
}

func TestRuntimeRouteOutboxRejectsEqualRevisionWithDifferentPayload(t *testing.T) {
	store := NewMemoryStore()
	cache := NewMemoryAPIKeyRouteCache(time.Minute, 10)
	current := SetRuntimeRouteSnapshot{
		SetID: "set-a", RuntimeGeneration: 13, RouteRevision: 21,
		TrafficBaseURL: "http://set-a-g13:3000", Enabled: true,
	}
	if applied, err := cache.SetSetRuntime(t.Context(), current); err != nil || !applied {
		t.Fatalf("seed cache applied=%v err=%v", applied, err)
	}
	now := time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)
	conflicting := current
	conflicting.RuntimeGeneration = 12
	conflicting.TrafficBaseURL = "http://set-a-g12:3000"
	store.setRuntimeRouteOutbox["conflict"] = SetRuntimeRouteOutbox{
		ID: "conflict", SetID: "set-a", RouteRevision: 21, Snapshot: conflicting,
		Status: SetRuntimeRouteOutboxStatusPending, CreatedAt: now, UpdatedAt: now,
	}
	svc := NewService(store, nil, Options{KeyRouteCache: cache})
	published, failed, err := svc.PublishPendingSetRuntimeRoutes(t.Context(), 10)
	if err == nil || published != 0 || failed != 1 {
		t.Fatalf("published=%d failed=%d err=%v", published, failed, err)
	}
	item := store.setRuntimeRouteOutbox["conflict"]
	if item.Status != SetRuntimeRouteOutboxStatusPending || !strings.Contains(item.LastError, "conflict") {
		t.Fatalf("outbox item=%+v", item)
	}
}

func TestTransitionSetTrafficStatePublishesDisabledRuntimeRoute(t *testing.T) {
	store := NewMemoryStore()
	cache := NewMemoryAPIKeyRouteCache(time.Minute, 10)
	mustSaveSet(t, store, Set{
		ID: "set-a", Status: SetStatusActive, ActiveRuntimeGeneration: 3,
		LastRuntimeGeneration: 3, RouteRevision: 7,
	})
	if err := store.SaveSetRuntime(t.Context(), SetRuntime{
		SetID: "set-a", Generation: 3, Image: testUpgradeImage,
		TrafficBaseURL: "http://set-a-g3:3000", Status: SetRuntimeStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Options{KeyRouteCache: cache})
	set, err := svc.TransitionSetTrafficState(t.Context(), "set-a", SetStatusDisabled)
	if err != nil {
		t.Fatal(err)
	}
	if set.Status != SetStatusDisabled || set.RouteRevision != 8 {
		t.Fatalf("set=%+v", set)
	}
	if published, failed, err := svc.PublishPendingSetRuntimeRoutes(t.Context(), 10); err != nil || published != 1 || failed != 0 {
		t.Fatalf("publish result published=%d failed=%d err=%v", published, failed, err)
	}
	route, ok, err := cache.GetSetRuntime(t.Context(), "set-a")
	if err != nil || !ok || route.Enabled || route.RouteRevision != 8 {
		t.Fatalf("route=%+v ok=%v err=%v", route, ok, err)
	}
}

func TestSaveSetCannotRewriteLifecycleOwnedFields(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{
		ID: "set-a", Name: "before", Status: SetStatusActive, LifecycleGeneration: 7,
		ActiveRuntimeGeneration: 3, LastRuntimeGeneration: 5, RouteRevision: 11,
	})
	stale, _, err := store.GetSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	stale.Name = "after"
	stale.LifecycleGeneration = 9
	stale.ActiveRuntimeGeneration = 4
	stale.LastRuntimeGeneration = 6
	stale.RouteRevision = 12
	if err := store.SaveSet(t.Context(), stale); err != nil {
		t.Fatal(err)
	}
	got, _, err := store.GetSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "after" || got.LifecycleGeneration != 7 || got.ActiveRuntimeGeneration != 3 || got.LastRuntimeGeneration != 5 || got.RouteRevision != 11 {
		t.Fatalf("set=%+v", got)
	}
}

func TestBackfillLegacySetRuntimePublishesGenerationZero(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{
		ID: "set-a", Status: SetStatusActive, TrafficBaseURL: "http://set-a-traffic:3000",
		AdminImage: "legacy@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	})
	cache := NewMemoryAPIKeyRouteCache(0, 10)
	svc := NewService(store, nil, Options{KeyRouteCache: cache})
	backfilled, err := svc.BackfillLegacySetRuntimeRoutes(t.Context(), 10)
	if err != nil || backfilled != 1 {
		t.Fatalf("backfilled=%d err=%v", backfilled, err)
	}
	runtime, ok, err := store.GetSetRuntime(t.Context(), "set-a", 0)
	if err != nil || !ok || runtime.Status != SetRuntimeStatusActive {
		t.Fatalf("runtime=%+v ok=%v err=%v", runtime, ok, err)
	}
	route, ok, err := cache.GetSetRuntime(t.Context(), "set-a")
	if err != nil || !ok || route.RuntimeGeneration != 0 || route.TrafficBaseURL != "http://set-a-traffic:3000" {
		t.Fatalf("route=%+v ok=%v err=%v", route, ok, err)
	}
}

func TestSetUpgradeMetricsExposeGenerationStageAndOutbox(t *testing.T) {
	store, run := newPendingUpgradeRun(t)
	set, _, _ := store.GetSet(t.Context(), run.SetID)
	set.ActiveRuntimeGeneration = 12
	set.RouteRevision = 20
	mustSaveSet(t, store, set)
	store.mu.Lock()
	store.setRuntimeRouteOutbox["outbox-a"] = SetRuntimeRouteOutbox{ID: "outbox-a", SetID: run.SetID, RouteRevision: 21, Status: SetRuntimeRouteOutboxStatusPending, Attempts: 2}
	store.mu.Unlock()
	metrics := NewService(store, nil, Options{}).PrometheusMetrics()
	for _, want := range []string{
		`llmgateway_set_runtime_generation{set_id="set-a"} 12`,
		`llmgateway_set_route_revision{set_id="set-a"} 20`,
		fmt.Sprintf(`llmgateway_set_upgrade_state{set_id="set-a",run_id="%s",status="pending"} 1`, run.ID),
		`llmgateway_set_runtime_route_outbox_pending 1`,
		`llmgateway_set_runtime_route_publish_failures{set_id="set-a"} 2`,
	} {
		if !strings.Contains(metrics, want) {
			t.Fatalf("metrics missing %q:\n%s", want, metrics)
		}
	}
}

func TestRequestSetUpgradeRollbackPersistsOperatorIntent(t *testing.T) {
	store, run := switchedUpgradeRun(t)
	svc := NewService(store, nil, Options{})
	svc.now = func() time.Time { return run.RollbackDeadline.Add(-time.Second) }
	requested, err := svc.RequestSetUpgradeRollback(t.Context(), run.ID, "operator requested")
	if err != nil {
		t.Fatal(err)
	}
	if !requested.RollbackRequested || requested.RollbackReason != "operator requested" {
		t.Fatalf("rollback request=%+v", requested)
	}
}

func TestRetryFailedSetUpgradeChoosesPhaseFromActiveRuntime(t *testing.T) {
	store, run := newPendingUpgradeRun(t)
	store.mu.Lock()
	failed := store.setUpgradeRuns[run.ID]
	failed.Status = SetUpgradeRunStatusFailed
	failed.LastError = "candidate failed"
	store.setUpgradeRuns[run.ID] = failed
	store.mu.Unlock()
	svc := NewService(store, nil, Options{})
	retried, err := svc.RetrySetUpgradeRun(t.Context(), run.ID)
	if err != nil || retried.Status != SetUpgradeRunStatusPending {
		t.Fatalf("retry run=%+v err=%v", retried, err)
	}
}

func newPendingUpgradeRun(t *testing.T) (*MemoryStore, SetUpgradeRun) {
	t.Helper()
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{
		ID: "set-a", Status: SetStatusActive, ActiveRuntimeGeneration: 12, RouteRevision: 20,
	})
	if err := store.SaveSetRuntime(t.Context(), SetRuntime{
		SetID: "set-a", Generation: 12, Image: "old@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		TrafficBaseURL: "http://set-a-g12:3000", Status: SetRuntimeStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Options{})
	batch, err := svc.CreateSetUpgradeBatch(t.Context(), CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-a"}, TargetImage: testUpgradeImage,
		DrainTimeout: 15 * time.Second, RollbackWindow: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return store, batch.Runs[0]
}

func switchedUpgradeRun(t *testing.T) (*MemoryStore, SetUpgradeRun) {
	t.Helper()
	store, run := newPendingUpgradeRun(t)
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	claimed, ok, err := store.TryAcquireSetUpgradeRun(t.Context(), run.ID, "manager-a", time.Minute, now)
	if err != nil || !ok {
		t.Fatalf("claim ok=%v err=%v", ok, err)
	}
	claimed = advanceUpgradeToPreparing(t, store, claimed, now)
	claimed, err = store.PrepareSetUpgradeRuntime(t.Context(), claimed, SetRuntime{
		SetID: run.SetID, Generation: run.ToGeneration, Image: run.TargetImage,
		TrafficBaseURL: "http://set-a-g13:3000",
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		claimed, err = store.RecordSetUpgradeProbe(t.Context(), claimed, true, "", now.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
	}
	claimed, _, err = store.SwitchSetUpgradeRuntime(t.Context(), claimed, now.Add(4*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	claimed, ok, err = store.ConfirmSetRuntimeRoutePublished(t.Context(), run.SetID, 21, now.Add(4*time.Second))
	if err != nil || !ok {
		t.Fatalf("confirm route ok=%v err=%v", ok, err)
	}
	return store, claimed
}

func advanceUpgradeToPreparing(t *testing.T, store *MemoryStore, run SetUpgradeRun, now time.Time) SetUpgradeRun {
	t.Helper()
	var err error
	run, err = store.CompleteSetUpgradeMaster(t.Context(), run, true, "", now.Add(2*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	run, err = store.CompleteSetUpgradeCompatibility(t.Context(), run, true, "", now.Add(3*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	return run
}
