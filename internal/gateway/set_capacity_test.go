package gateway

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"testing"
)

func TestEnsureUserBindingPicksLeastLoadedActiveSet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithObservedUsers(t, store, "set-a", 1)
	saveReadyCapacitySet(t, store, "set-b")

	binding, err := svc.EnsureUserBinding(t.Context(), "new-user")
	if err != nil {
		t.Fatal(err)
	}
	if binding.SetID != "set-b" {
		t.Fatalf("set id = %s, want least loaded set-b", binding.SetID)
	}
}

func TestPickSetForPlanPicksLeastLoadedMappedSet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithObservedUsers(t, store, "set-a", 1)
	saveReadyCapacitySet(t, store, "set-b")

	plan := Plan{ID: "plan-pro", Name: "Pro", IsActive: true}
	saveReadySetPlans(t, store, plan.ID, map[string]int{"set-a": 7, "set-b": 8})
	set, upstreamPlanID, err := svc.pickSetForPlan(t.Context(), plan)
	if err != nil {
		t.Fatal(err)
	}
	if set.ID != "set-b" || upstreamPlanID != 8 {
		t.Fatalf("picked set=%s upstream_plan_id=%d, want set-b/8", set.ID, upstreamPlanID)
	}
}

func TestPickSetForPlanReservesCapacityBeforeProvisioning(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithLimitsAndObservedUsers(t, store, "set-a", 1, 0, 0, 0)
	saveReadyCapacitySetWithLimitsAndObservedUsers(t, store, "set-b", 1, 0, 0, 0)
	plan := Plan{ID: "pro", IsActive: true}
	saveReadySetPlans(t, store, plan.ID, map[string]int{"set-a": 10, "set-b": 11})

	first, _, err := svc.pickSetForPlan(t.Context(), plan)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := svc.pickSetForPlan(t.Context(), plan)
	if err != nil {
		t.Fatal(err)
	}

	if first.ID != "set-a" || second.ID != "set-b" {
		t.Fatalf("reserved sets = %s then %s, want set-a then set-b", first.ID, second.ID)
	}
	setA, _, _ := store.GetSet(t.Context(), "set-a")
	setB, _, _ := store.GetSet(t.Context(), "set-b")
	if setA.ObservedUserCount != 1 || setB.ObservedUserCount != 1 {
		t.Fatalf("observed counts = set-a:%d set-b:%d, want 1/1", setA.ObservedUserCount, setB.ObservedUserCount)
	}
}

func TestEnsureBindingForPlanReassignsUnprovisionedBindingFromFailedSet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{
		ID:               "set-failed",
		BaseURL:          "http://set-failed",
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
		MaxUsers:         10000,
		AdmissionStatus:  SetAdmissionStatusFailed,
		AdmissionError:   "channel bundle is not synced",
	}); err != nil {
		t.Fatal(err)
	}
	saveReadyCapacitySetWithObservedUsers(t, store, "set-ready", 0)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID:     "retry-user",
		SetID:              "set-failed",
		Username:           "sgw-retry-user",
		Password:           "secret",
		ProvisionStatus:    BindingProvisionStatusAllocated,
		LastProvisionError: "previous attempt timed out",
	}); err != nil {
		t.Fatal(err)
	}

	plan := Plan{ID: "pro", IsActive: true}
	saveReadySetPlans(t, store, plan.ID, map[string]int{"set-failed": 10, "set-ready": 11})
	binding, set, upstreamPlanID, err := svc.ensureBindingForPlan(t.Context(), "retry-user", plan)
	if err != nil {
		t.Fatal(err)
	}
	if set.ID != "set-ready" || binding.SetID != "set-ready" || upstreamPlanID != 11 {
		t.Fatalf("reassigned to set=%s binding=%s plan=%d, want set-ready/11", set.ID, binding.SetID, upstreamPlanID)
	}
	saved, ok, err := store.GetUserBinding(t.Context(), "retry-user")
	if err != nil || !ok {
		t.Fatalf("saved binding ok=%v err=%v", ok, err)
	}
	if saved.SetID != "set-ready" || saved.ProvisionStatus != BindingProvisionStatusAllocated || saved.LastProvisionError != "" {
		t.Fatalf("saved binding = set=%s status=%s error=%q, want clean allocated set-ready", saved.SetID, saved.ProvisionStatus, saved.LastProvisionError)
	}
}

func saveReadySetPlans(t *testing.T, store *MemoryStore, planID string, setPlans map[string]int) {
	t.Helper()
	for setID, upstreamPlanID := range setPlans {
		if err := store.SaveSetPlan(t.Context(), SetPlan{
			PlanID: planID, SetID: setID, UpstreamPlanID: upstreamPlanID, Status: SetPlanStatusReady,
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEnsureUserBindingSkipsFullSetEvenWhenItLooksLeastLoaded(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithLimitsAndObservedUsers(t, store, "set-a", 1, 1, 0, 1)
	saveReadyCapacitySetWithLimitsAndObservedUsers(t, store, "set-b", 10, 8, 1, 5)

	binding, err := svc.EnsureUserBinding(t.Context(), "new-user")
	if err != nil {
		t.Fatal(err)
	}
	if binding.SetID != "set-b" {
		t.Fatalf("set id = %s, want set-b because set-a reached max_users", binding.SetID)
	}
}

func TestEnsureUserBindingRejectsWhenEverySetIsFullOrUnready(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithLimitsAndObservedUsers(t, store, "set-full", 1, 1, 0, 1)
	if err := store.SaveSet(t.Context(), Set{ID: "set-unready", BaseURL: "http://set-unready", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}

	_, err := svc.EnsureUserBinding(t.Context(), "new-user")
	if err == nil {
		t.Fatal("expected no accepting set when all ready sets are full and the remaining set is unready")
	}
	if got := err.Error(); got != "no active set has available capacity" {
		t.Fatalf("error = %q", got)
	}
}

func TestEnsureUserBindingSkipsSetBeforeAdmissionPassed(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{
		ID:               "set-pending",
		BaseURL:          "http://set-pending",
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
		AdmissionStatus:  SetAdmissionStatusPending,
	}); err != nil {
		t.Fatal(err)
	}
	saveReadyCapacitySet(t, store, "set-ready")

	binding, err := svc.EnsureUserBinding(t.Context(), "new-user")
	if err != nil {
		t.Fatal(err)
	}
	if binding.SetID != "set-ready" {
		t.Fatalf("set id = %s, want only admission-passed set-ready", binding.SetID)
	}
}

func TestEnsureUserBindingSkipsCapacityManagedSetBeforeAdmissionCheck(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{
		ID:               "set-new",
		BaseURL:          "http://set-new",
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
		MaxUsers:         10000,
	}); err != nil {
		t.Fatal(err)
	}
	saveReadyCapacitySet(t, store, "set-ready")

	binding, err := svc.EnsureUserBinding(t.Context(), "new-user")
	if err != nil {
		t.Fatal(err)
	}
	if binding.SetID != "set-ready" {
		t.Fatalf("set id = %s, want capacity-managed set to wait for admission", binding.SetID)
	}
}

func TestEnsureUserBindingUsesProjectedWatermarkWithoutCountingBindings(t *testing.T) {
	store := &countingCapacityStore{MemoryStore: NewMemoryStore()}
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithObservedUsers(t, store.MemoryStore, "set-a", 9)
	saveReadyCapacitySetWithObservedUsers(t, store.MemoryStore, "set-b", 0)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID:  "existing-user",
		SetID:           "set-b",
		Username:        "sgw-existing",
		ProvisionStatus: BindingProvisionStatusUserReady,
	}); err != nil {
		t.Fatal(err)
	}

	binding, err := svc.EnsureUserBinding(t.Context(), "new-user")
	if err != nil {
		t.Fatal(err)
	}
	if binding.SetID != "set-b" {
		t.Fatalf("set id = %s, want set-b from projected watermark", binding.SetID)
	}
	if store.countCalls != 0 {
		t.Fatalf("CountUserBindingsBySet calls = %d, want 0 on new user assignment", store.countCalls)
	}
}

func TestEnsureUserBindingIncrementsProjectedWatermarkAfterAssignment(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithObservedUsers(t, store, "set-a", 0)

	binding, err := svc.EnsureUserBinding(t.Context(), "new-user")
	if err != nil {
		t.Fatal(err)
	}
	if binding.SetID != "set-a" {
		t.Fatalf("set id = %s, want set-a", binding.SetID)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, err)
	}
	if set.ObservedUserCount != 1 {
		t.Fatalf("observed user count = %d, want lightweight projection increment", set.ObservedUserCount)
	}
	if set.CapacityUpdatedAt.IsZero() {
		t.Fatal("capacity updated timestamp was not refreshed")
	}
}

func TestRefreshSetCapacityProjectionJobUpdatesObservedUserCounts(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithLimits(t, store, "set-a", 10, 8, 1)
	for i := 0; i < 3; i++ {
		if err := store.SaveUserBinding(t.Context(), UserBinding{
			ExternalUserID:  "user-" + string(rune('a'+i)),
			SetID:           "set-a",
			Username:        "sgw-user",
			ProvisionStatus: BindingProvisionStatusUserReady,
		}); err != nil {
			t.Fatal(err)
		}
	}

	run, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRefreshSetCapacity)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(run.Detail, "sets=1") {
		t.Fatalf("run detail = %q, want refreshed set count", run.Detail)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, err)
	}
	if set.ObservedUserCount != 3 {
		t.Fatalf("observed user count = %d, want 3", set.ObservedUserCount)
	}
	if set.CapacityUpdatedAt.IsZero() {
		t.Fatal("capacity updated timestamp was not persisted")
	}
}

func TestRegisterSetCapacityFieldsAreOptionalButExplicitZeroClears(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{
		ID:            "set-a",
		BaseURL:       "http://set-a",
		Status:        SetStatusActive,
		MaxUsers:      intPtr(10),
		WarnUsers:     intPtr(8),
		ReservedUsers: intPtr(1),
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, err)
	}
	if set.MaxUsers != 10 || set.WarnUsers != 8 || set.ReservedUsers != 1 {
		t.Fatalf("omitted capacity fields should preserve old values: %+v", set)
	}
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{
		ID:            "set-a",
		BaseURL:       "http://set-a",
		Status:        SetStatusActive,
		MaxUsers:      intPtr(0),
		WarnUsers:     intPtr(0),
		ReservedUsers: intPtr(0),
	}); err != nil {
		t.Fatal(err)
	}
	set, ok, err = store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, err)
	}
	if set.MaxUsers != 0 || set.WarnUsers != 0 || set.ReservedUsers != 0 {
		t.Fatalf("explicit zero should clear capacity fields: %+v", set)
	}
}

func TestReconcileSetCapacityCreatesProvisionRequestBelowWatermark(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithObservedUsers(t, store, "set-a", 9)

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Namespace:          "llmgateway-kro-demo",
		Fleet:              "fleet-demo",
		ShardRefs:          []string{"shard-a"},
		MaxUsersPerSet:     10,
		MinReadyFreeUsers:  5,
		MaxScaleUpPerCycle: 1,
		SetIDPrefix:        "set-auto",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.CreatedRequests != 1 || result.ReadyFreeUsers != 1 || result.RequiredFreeUsers != 5 {
		t.Fatalf("unexpected capacity result: %+v", result)
	}
	if len(result.Requests) != 1 {
		t.Fatalf("request count = %d, want 1", len(result.Requests))
	}
	request := result.Requests[0]
	if request.Status != SetProvisionStatusPending || request.SetID != "set-auto-000001" || request.ShardRef != "shard-a" {
		t.Fatalf("unexpected provision request: %+v", request)
	}
	if _, ok, err := store.GetSet(t.Context(), request.SetID); err != nil || ok {
		t.Fatalf("capacity reconcile should not create set registry: ok=%v err=%v", ok, err)
	}
}

func TestReconcileSetCapacityPinsNewSetToServingReleaseRing(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveShard(t.Context(), Shard{ID: "shard-a", Status: ShardStatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateNewAPIRelease(t.Context(), CreateNewAPIReleaseInput{
		ID: "release-v2", Version: "v2", Image: testNewReleaseImage, Status: NewAPIReleaseStatusStable,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertReleaseRing(t.Context(), UpsertReleaseRingInput{
		ID: "stable", Name: "Stable", Ordinal: 20, ServingReleaseID: "release-v2", AdmissionEnabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", ShardRefs: []string{"shard-a"},
		MaxUsersPerSet: 10, MinWarmSets: 1, MaxScaleUpPerCycle: 1, RedisDBStart: intPtr(1), RedisDBLimit: intPtr(16),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Requests) != 1 {
		t.Fatalf("requests=%+v", result.Requests)
	}
	request := result.Requests[0]
	if request.ReleaseRingID != "stable" || request.ReleaseID != "release-v2" || request.ReleaseImage != testNewReleaseImage {
		t.Fatalf("request release=%+v", request)
	}
}

func TestReconcileSetCapacityTreatsMinWarmSetsAsMinimumSetCount(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithObservedUsers(t, store, "set-a", 1)

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Namespace:          "llmgateway",
		Fleet:              "prod",
		ShardRefs:          []string{"shard-a"},
		MaxUsersPerSet:     10000,
		MinReadyFreeUsers:  3000,
		MinWarmSets:        2,
		MaxScaleUpPerCycle: 2,
		SetIDPrefix:        "set-auto",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.CreatedRequests != 1 {
		t.Fatalf("created requests = %d, want 1 minimum-set request: %+v", result.CreatedRequests, result)
	}
	if result.RequiredFreeUsers >= 10000 || result.DeficitUsers != 0 {
		t.Fatalf("warm-set minimum must not inflate free-user requirement: %+v", result)
	}
}

func TestReconcileSetCapacityChoosesLowestShardSetUtilization(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	for _, shard := range []Shard{
		{ID: "shard-a", Status: ShardStatusActive, MaxSets: 10},
		{ID: "shard-b", Status: ShardStatusActive, MaxSets: 10},
	} {
		if err := store.SaveShard(t.Context(), shard); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 8; i++ {
		if err := store.SaveSet(t.Context(), Set{ID: fmt.Sprintf("set-a-%d", i), Name: "set", ShardID: "shard-a", Status: SetStatusActive}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := store.SaveSet(t.Context(), Set{ID: fmt.Sprintf("set-b-%d", i), Name: "set", ShardID: "shard-b", Status: SetStatusActive}); err != nil {
			t.Fatal(err)
		}
	}

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Namespace:          "llmgateway",
		Fleet:              "prod",
		ShardRefs:          []string{"shard-a", "shard-b"},
		MaxUsersPerSet:     100,
		MinWarmSets:        11,
		MaxScaleUpPerCycle: 1,
		RedisDBStart:       intPtr(10),
		RedisDBLimit:       intPtr(64),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Requests) != 1 || result.Requests[0].ShardRef != "shard-b" {
		t.Fatalf("requests = %+v, want shard-b", result.Requests)
	}
}

func TestReconcileSetCapacityCountsRequestsAndLeasesOnceAndSkipsFullShard(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveShard(t.Context(), Shard{ID: "shard-a", Status: ShardStatusActive, MaxSets: 1}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveShard(t.Context(), Shard{ID: "shard-b", Status: ShardStatusActive, MaxSets: 2}); err != nil {
		t.Fatal(err)
	}
	request := SetProvisionRequest{
		ID: "req-a", Source: "kro", Namespace: "llmgateway", Fleet: "prod",
		SetID: "set-pending", ShardRef: "shard-a", DatabaseName: "newapi_set_pending", RedisDB: "10", Status: SetProvisionStatusPending,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "kro", Namespace: "llmgateway", Fleet: "prod", SetID: "set-pending",
		ShardRef: "shard-a", DatabaseName: "newapi_set_pending", RedisDB: "10",
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Namespace: "llmgateway", Fleet: "prod", ShardRefs: []string{"shard-a", "shard-b"},
		MaxUsersPerSet: 100, MinWarmSets: 2, MaxScaleUpPerCycle: 1,
		RedisDBStart: intPtr(10), RedisDBLimit: intPtr(64),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Requests) != 1 || result.Requests[0].ShardRef != "shard-b" {
		t.Fatalf("requests = %+v, want full shard-a excluded", result.Requests)
	}
}

func TestWorkerReconcileSetCapacityBootstrapsWarmSetsForEmptyFleet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{
		WorkerSetCapacityEnabled: true,
		WorkerSetCapacityPolicy: SetCapacityPolicy{
			Source:             "prod",
			Namespace:          "llmgateway",
			Fleet:              "prod",
			ShardRefs:          []string{"shard-a", "shard-b"},
			MaxUsersPerSet:     10000,
			MinReadyFreeUsers:  0,
			MinWarmSets:        2,
			MaxScaleUpPerCycle: 2,
			SetIDPrefix:        "set-auto",
			RedisDBStart:       intPtr(10),
			RedisDBLimit:       intPtr(16),
		},
	})

	run, err := svc.RunWorkerJobNow(t.Context(), WorkerJobReconcileSetCapacity)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(run.Detail, "created=2") {
		t.Fatalf("run detail = %q, want created=2", run.Detail)
	}
	requests, err := store.ListSetProvisionRequests(t.Context(), SetProvisionRequestListOptions{
		Source:    "prod",
		Namespace: "llmgateway",
		Fleet:     "prod",
		Status:    SetProvisionStatusPending,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 {
		t.Fatalf("pending requests = %d, want 2: %+v", len(requests), requests)
	}
	sort.Slice(requests, func(i, j int) bool { return requests[i].SetID < requests[j].SetID })
	if requests[0].SetID != "set-auto-000001" || requests[0].ShardRef != "shard-a" || requests[0].RedisDB != "10" {
		t.Fatalf("unexpected first request: %+v", requests[0])
	}
	if requests[1].SetID != "set-auto-000002" || requests[1].ShardRef != "shard-b" || requests[1].RedisDB != "10" {
		t.Fatalf("unexpected second request: %+v", requests[1])
	}
}

func TestReconcileSetCapacityCountsOpenProvisionRequestsAsInflightCapacity(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithObservedUsers(t, store, "set-a", 9)
	if err := store.SaveSetProvisionRequest(t.Context(), SetProvisionRequest{
		ID:           "kro/llmgateway-kro-demo/fleet-demo/set-auto-000001",
		Source:       "kro",
		Namespace:    "llmgateway-kro-demo",
		Fleet:        "fleet-demo",
		SetID:        "set-auto-000001",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_auto_000001",
		RedisDB:      "1",
		Status:       SetProvisionStatusPending,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Namespace:          "llmgateway-kro-demo",
		Fleet:              "fleet-demo",
		ShardRefs:          []string{"shard-a"},
		MaxUsersPerSet:     10,
		MinReadyFreeUsers:  5,
		MaxScaleUpPerCycle: 1,
		SetIDPrefix:        "set-auto",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.CreatedRequests != 0 || result.InflightFreeUsers != 10 {
		t.Fatalf("unexpected capacity result: %+v", result)
	}
}

func TestReconcileSetCapacityCountsManagedRuntimeAsInflightUntilAdmissionFinishes(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{
		ID: "set-a", Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token",
		AdmissionStatus: SetAdmissionStatusPending, MaxUsers: 10, ShardID: "shard-a",
	})
	if err := store.SaveSetProvisionRequest(t.Context(), SetProvisionRequest{
		ID: "req-a", Source: "kro", Namespace: "prod", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", Status: SetProvisionStatusManaged, MaxUsersPerSet: 10,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Source: "kro", Namespace: "prod", Fleet: "prod", ShardRefs: []string{"shard-a"},
		MaxUsersPerSet: 10, MinReadyFreeUsers: 10, MinWarmSets: 1, MaxScaleUpPerCycle: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.InflightRequests != 1 || result.CreatedRequests != 0 {
		t.Fatalf("capacity result = %+v", result)
	}
}

func TestReconcileSetCapacityCountsActivePendingSetWhenProvisionRequestErrored(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveShard(t.Context(), Shard{ID: "shard-a", Status: ShardStatusActive, MaxSets: 10}); err != nil {
		t.Fatal(err)
	}
	mustSaveSet(t, store, Set{
		ID: "set-a", Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token",
		AdmissionStatus: SetAdmissionStatusPending, MaxUsers: 10, ShardID: "shard-a",
	})
	if err := store.SaveSetProvisionRequest(t.Context(), SetProvisionRequest{
		ID: "req-a", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", Status: SetProvisionStatusError, MaxUsersPerSet: 10,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", ShardRefs: []string{"shard-a"},
		MaxUsersPerSet: 10, MinReadyFreeUsers: 10, MinWarmSets: 1, MaxScaleUpPerCycle: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.InflightRequests != 1 || result.CreatedRequests != 0 {
		t.Fatalf("capacity result = %+v", result)
	}
}

func TestConfiguredProvisionRequestKeepsRetryErrorUntilManaged(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	request := SetProvisionRequest{ID: "req-a", SetID: "set-a", Status: SetProvisionStatusConfigured}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}

	updated, err := svc.UpdateSetProvisionRequestStatus(t.Context(), request.ID, SetProvisionStatusConfigured, "waiting for Fleet Ready")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != SetProvisionStatusConfigured || updated.LastError != "waiting for Fleet Ready" {
		t.Fatalf("configured request = %+v", updated)
	}
	updated, err = svc.UpdateSetProvisionRequestStatus(t.Context(), request.ID, SetProvisionStatusManaged, "")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != SetProvisionStatusManaged || updated.LastError != "" {
		t.Fatalf("managed request = %+v", updated)
	}
}

func TestReconcileSetCapacityUsesProjectedWatermarkWithoutCountingBindings(t *testing.T) {
	store := &countingCapacityStore{MemoryStore: NewMemoryStore()}
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySetWithObservedUsers(t, store.MemoryStore, "set-a", 9)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID:  "existing-user",
		SetID:           "set-a",
		Username:        "sgw-existing",
		ProvisionStatus: BindingProvisionStatusUserReady,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Namespace:          "llmgateway-kro-demo",
		Fleet:              "fleet-demo",
		ShardRefs:          []string{"shard-a"},
		MaxUsersPerSet:     10,
		MinReadyFreeUsers:  5,
		MaxScaleUpPerCycle: 1,
		SetIDPrefix:        "set-auto",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ReadyFreeUsers != 1 {
		t.Fatalf("ready free users = %d, want projected watermark capacity", result.ReadyFreeUsers)
	}
	if store.countCalls != 0 {
		t.Fatalf("CountUserBindingsBySet calls = %d, want 0 for capacity reconcile", store.countCalls)
	}
}

func TestReconcileSetCapacityAllocatesFirstFreeRedisDBWithinLimit(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySet(t, store, "set-a")
	for _, existing := range []SetProvisionRequest{
		{
			ID:        "kro/llmgateway-kro-demo/fleet-demo/set-auto-000001",
			Source:    "kro",
			Namespace: "llmgateway-kro-demo",
			Fleet:     "fleet-demo",
			SetID:     "set-auto-000001",
			ShardRef:  "shard-a",
			RedisDB:   "3",
			Status:    SetProvisionStatusManaged,
		},
		{
			ID:        "kro/llmgateway-kro-demo/fleet-demo/set-auto-000002",
			Source:    "kro",
			Namespace: "llmgateway-kro-demo",
			Fleet:     "fleet-demo",
			SetID:     "set-auto-000002",
			ShardRef:  "shard-a",
			RedisDB:   "4",
			Status:    SetProvisionStatusManaged,
		},
	} {
		if err := store.SaveSetProvisionRequest(t.Context(), existing); err != nil {
			t.Fatal(err)
		}
	}

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Namespace:          "llmgateway-kro-demo",
		Fleet:              "fleet-demo",
		ShardRefs:          []string{"shard-a"},
		MaxUsersPerSet:     1,
		MinReadyFreeUsers:  2,
		MaxScaleUpPerCycle: 1,
		SetIDPrefix:        "set-auto",
		RedisDBStart:       intPtr(3),
		RedisDBLimit:       intPtr(6),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Requests) != 1 {
		t.Fatalf("request count = %d, want 1", len(result.Requests))
	}
	if result.Requests[0].RedisDB != "5" {
		t.Fatalf("redis db = %q, want first free db 5; result=%+v", result.Requests[0].RedisDB, result)
	}
}

func TestReconcileSetCapacityAvoidsRuntimeLeaseWithoutProvisionRequest(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySet(t, store, "set-a")
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source:       "kro",
		Namespace:    "llmgateway-kro-demo",
		Fleet:        "fleet-demo",
		SetID:        "old-set",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_old_set",
		RedisDB:      "3",
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Namespace:          "llmgateway-kro-demo",
		Fleet:              "fleet-demo",
		ShardRefs:          []string{"shard-a"},
		MaxUsersPerSet:     1,
		MinReadyFreeUsers:  2,
		MaxScaleUpPerCycle: 1,
		SetIDPrefix:        "set-auto",
		RedisDBStart:       intPtr(3),
		RedisDBLimit:       intPtr(5),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Requests) != 1 {
		t.Fatalf("request count = %d, want 1", len(result.Requests))
	}
	if result.Requests[0].RedisDB != "4" {
		t.Fatalf("redis db = %q, want first free db 4 after runtime lease; result=%+v", result.Requests[0].RedisDB, result)
	}
}

func TestReconcileSetCapacityFailsWhenRedisDBRangeIsExhausted(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySet(t, store, "set-a")
	for _, existing := range []SetProvisionRequest{
		{
			ID:        "kro/llmgateway-kro-demo/fleet-demo/set-auto-000001",
			Source:    "kro",
			Namespace: "llmgateway-kro-demo",
			Fleet:     "fleet-demo",
			SetID:     "set-auto-000001",
			ShardRef:  "shard-a",
			RedisDB:   "3",
			Status:    SetProvisionStatusManaged,
		},
		{
			ID:        "kro/llmgateway-kro-demo/fleet-demo/set-auto-000002",
			Source:    "kro",
			Namespace: "llmgateway-kro-demo",
			Fleet:     "fleet-demo",
			SetID:     "set-auto-000002",
			ShardRef:  "shard-a",
			RedisDB:   "4",
			Status:    SetProvisionStatusManaged,
		},
	} {
		if err := store.SaveSetProvisionRequest(t.Context(), existing); err != nil {
			t.Fatal(err)
		}
	}

	_, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Namespace:          "llmgateway-kro-demo",
		Fleet:              "fleet-demo",
		ShardRefs:          []string{"shard-a"},
		MaxUsersPerSet:     1,
		MinReadyFreeUsers:  2,
		MaxScaleUpPerCycle: 1,
		SetIDPrefix:        "set-auto",
		RedisDBStart:       intPtr(3),
		RedisDBLimit:       intPtr(5),
	})
	if err == nil {
		t.Fatal("expected exhausted redis db range to fail")
	}
	if got := err.Error(); got != "no free redis db on shard shard-a: no free redis db in range [3, 5)" {
		t.Fatalf("error = %q", got)
	}
}

func TestReconcileSetCapacityAllowsExplicitRedisDBZero(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyCapacitySet(t, store, "set-a")

	result, err := svc.ReconcileSetCapacity(t.Context(), SetCapacityPolicy{
		Namespace:          "llmgateway-kro-demo",
		Fleet:              "fleet-demo",
		ShardRefs:          []string{"shard-a"},
		MaxUsersPerSet:     1,
		MinReadyFreeUsers:  2,
		MaxScaleUpPerCycle: 1,
		SetIDPrefix:        "set-auto",
		RedisDBStart:       intPtr(0),
		RedisDBLimit:       intPtr(1),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Requests) != 1 {
		t.Fatalf("request count = %d, want 1", len(result.Requests))
	}
	if result.Requests[0].RedisDB != "0" {
		t.Fatalf("redis db = %q, want db 0 for DB0-only Redis", result.Requests[0].RedisDB)
	}
}

func TestSaveSetProvisionRequestRejectsRedisDBReuseOnSameShard(t *testing.T) {
	store := NewMemoryStore()
	first := SetProvisionRequest{
		ID:           "req-a",
		Source:       "prod",
		Namespace:    "llmgateway",
		Fleet:        "prod",
		SetID:        "set-a",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_a",
		RedisDB:      "12",
		Status:       SetProvisionStatusManaged,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), first); err != nil {
		t.Fatal(err)
	}

	second := first
	second.ID = "req-b"
	second.SetID = "set-b"
	second.DatabaseName = "newapi_set_b"
	err := store.SaveSetProvisionRequest(t.Context(), second)
	if err == nil {
		t.Fatal("expected duplicate redis db on same shard to fail")
	}
	if got := err.Error(); got != `redis db 12 on shard shard-a is already leased by set set-a` {
		t.Fatalf("error = %q", got)
	}
}

func TestSaveSetProvisionRequestAllowsSameRedisDBOnDifferentShards(t *testing.T) {
	store := NewMemoryStore()
	first := SetProvisionRequest{
		ID:           "req-a",
		Source:       "prod",
		Namespace:    "llmgateway",
		Fleet:        "prod",
		SetID:        "set-a",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_a",
		RedisDB:      "12",
		Status:       SetProvisionStatusManaged,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), first); err != nil {
		t.Fatal(err)
	}

	second := first
	second.ID = "req-b"
	second.SetID = "set-b"
	second.ShardRef = "shard-b"
	second.DatabaseName = "newapi_set_b"
	if err := store.SaveSetProvisionRequest(t.Context(), second); err != nil {
		t.Fatal(err)
	}
}

func TestSaveSetProvisionRequestRejectsDatabaseNameReuse(t *testing.T) {
	store := NewMemoryStore()
	first := SetProvisionRequest{
		ID:           "req-a",
		Source:       "prod",
		Namespace:    "llmgateway",
		Fleet:        "prod",
		SetID:        "set-a",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_a",
		RedisDB:      "12",
		Status:       SetProvisionStatusManaged,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), first); err != nil {
		t.Fatal(err)
	}

	second := first
	second.ID = "req-b"
	second.SetID = "set-b"
	second.ShardRef = "shard-b"
	second.RedisDB = "13"
	err := store.SaveSetProvisionRequest(t.Context(), second)
	if err == nil {
		t.Fatal("expected duplicate database name to fail")
	}
	if got := err.Error(); got != `database newapi_set_a is already leased by set set-a` {
		t.Fatalf("error = %q", got)
	}
}

func TestSaveSetProvisionRequestAllowsSameSetStatusUpdate(t *testing.T) {
	store := NewMemoryStore()
	request := SetProvisionRequest{
		ID:           "req-a",
		Source:       "prod",
		Namespace:    "llmgateway",
		Fleet:        "prod",
		SetID:        "set-a",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_a",
		RedisDB:      "12",
		Status:       SetProvisionStatusPending,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	request.Status = SetProvisionStatusManaged
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
}

func TestSaveSetProvisionRequestReleasesRuntimeLeaseOnTerminalStatus(t *testing.T) {
	for _, status := range []string{SetProvisionStatusError, SetProvisionStatusCancelled} {
		t.Run(status, func(t *testing.T) {
			store := NewMemoryStore()
			request := SetProvisionRequest{
				ID: "req-a", Source: "prod", Namespace: "llmgateway", Fleet: "prod",
				SetID: "set-a", ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
				Status: SetProvisionStatusPending,
			}
			if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
				t.Fatal(err)
			}
			request.Status = status
			if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
				t.Fatal(err)
			}
			leases, err := store.ListSetRuntimeLeases(t.Context(), SetRuntimeLeaseListOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if len(leases) != 0 {
				t.Fatalf("runtime leases = %+v, want released for terminal request", leases)
			}
		})
	}
}

func TestCleanupStaleSetRuntimeLeasesPreservesLiveSetAndOpenRequest(t *testing.T) {
	store := NewMemoryStore()
	leases := []SetRuntimeLease{
		{Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-live", ShardRef: "shard-a", DatabaseName: "newapi_live", RedisDB: "1"},
		{Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-pending", ShardRef: "shard-a", DatabaseName: "newapi_pending", RedisDB: "2"},
		{Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-stale", ShardRef: "shard-a", DatabaseName: "newapi_stale", RedisDB: "3"},
	}
	for _, lease := range leases {
		if err := store.SaveSetRuntimeLease(t.Context(), lease); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveSet(t.Context(), Set{ID: "set-live", BaseURL: "http://set-live", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetProvisionRequest(t.Context(), SetProvisionRequest{
		ID: "req-pending", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-pending",
		ShardRef: "shard-a", DatabaseName: "newapi_pending", RedisDB: "2", Status: SetProvisionStatusPending,
	}); err != nil {
		t.Fatal(err)
	}

	cleaned, err := store.CleanupStaleSetRuntimeLeases(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if cleaned != 1 {
		t.Fatalf("cleaned = %d, want 1", cleaned)
	}
	remaining, err := store.ListSetRuntimeLeases(t.Context(), SetRuntimeLeaseListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 2 || remaining[0].SetID != "set-live" || remaining[1].SetID != "set-pending" {
		t.Fatalf("remaining leases = %+v, want live Set and open request", remaining)
	}
}

func TestCleanupStaleSetRuntimeLeasesReleasesTerminalLeaseDespiteSetIDCollision(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	request := SetProvisionRequest{
		ID: "req-old-scope", Source: "old-load", Namespace: "llmgateway", Fleet: "load", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_old_set_a", RedisDB: "10", Status: SetProvisionStatusPending,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	request.Status = SetProvisionStatusCancelled
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	leases, err := store.ListSetRuntimeLeases(t.Context(), SetRuntimeLeaseListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 0 {
		t.Fatalf("runtime leases = %+v, want terminal lease released despite global Set ID collision", leases)
	}
}

func TestSaveSetProvisionRequestCanMarkConflictingBypassRequestError(t *testing.T) {
	store := NewMemoryStore()
	first := SetProvisionRequest{
		ID:           "req-a",
		Source:       "prod",
		Namespace:    "llmgateway",
		Fleet:        "prod",
		SetID:        "set-a",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_a",
		RedisDB:      "12",
		Status:       SetProvisionStatusManaged,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), first); err != nil {
		t.Fatal(err)
	}
	conflict := first
	conflict.ID = "req-b"
	conflict.SetID = "set-b"
	conflict.DatabaseName = "newapi_set_b"
	conflict.Status = SetProvisionStatusError
	if err := store.SaveSetProvisionRequest(t.Context(), conflict); err != nil {
		t.Fatal(err)
	}
}

func intPtr(value int) *int {
	return &value
}

func saveReadyCapacitySet(t *testing.T, store *MemoryStore, setID string) {
	t.Helper()
	saveReadyCapacitySetWithLimits(t, store, setID, 0, 0, 0)
}

func saveReadyCapacitySetWithObservedUsers(t *testing.T, store *MemoryStore, setID string, observedUsers int) {
	t.Helper()
	saveReadyCapacitySetWithLimitsAndObservedUsers(t, store, setID, 0, 0, 0, observedUsers)
}

func saveReadyCapacitySetWithLimits(t *testing.T, store *MemoryStore, setID string, maxUsers int, warnUsers int, reservedUsers int) {
	t.Helper()
	saveReadyCapacitySetWithLimitsAndObservedUsers(t, store, setID, maxUsers, warnUsers, reservedUsers, 0)
}

func saveReadyCapacitySetWithLimitsAndObservedUsers(t *testing.T, store *MemoryStore, setID string, maxUsers int, warnUsers int, reservedUsers int, observedUsers int) {
	t.Helper()
	if err := store.SaveSet(t.Context(), Set{
		ID:                setID,
		Name:              setID,
		BaseURL:           "http://" + setID,
		Status:            SetStatusActive,
		Setup:             true,
		AdminUserID:       1,
		AdminAccessToken:  "set-admin-token",
		AdmissionStatus:   SetAdmissionStatusPassed,
		MaxUsers:          maxUsers,
		WarnUsers:         warnUsers,
		ReservedUsers:     reservedUsers,
		ObservedUserCount: observedUsers,
	}); err != nil {
		t.Fatal(err)
	}
}

type countingCapacityStore struct {
	*MemoryStore
	countCalls int
}

func (s *countingCapacityStore) CountUserBindingsBySet(ctx context.Context) (map[string]int, error) {
	s.countCalls++
	return s.MemoryStore.CountUserBindingsBySet(ctx)
}
