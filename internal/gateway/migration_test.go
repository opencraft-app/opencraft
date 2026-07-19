package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMigrateUserDryRunValidatesTargetWithoutCallingNewAPI(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("dry-run should not call new-api, got %s %s", r.Method, r.URL.Path)
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	registerBootstrappedMigrationSet(t, svc, store, "set-a", upstream.URL)
	registerMigrationPlan(t, store, "plan-pro", map[string]int{"set-a": 7})

	result, err := svc.MigrateUser(t.Context(), MigrationRequest{
		UserID: "user-1",
		SetID:  "set-a",
		PlanID: "plan-pro",
		DryRun: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.DryRun || result.Migrated || result.Backend != UserBackendNew || result.UpstreamPlanID != 7 {
		t.Fatalf("unexpected dry-run result: %+v", result)
	}
	assignment, err := svc.GetUserAssignment(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if assignment.Backend != UserBackendPending {
		t.Fatalf("dry-run changed assignment: %+v", assignment)
	}
	if _, ok, err := store.GetUserBinding(t.Context(), "user-1"); err != nil || ok {
		t.Fatalf("dry-run wrote binding: ok=%v err=%v", ok, err)
	}
}

func TestMigrateUserActivatesTargetSetAndWritesAssignment(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSetWithID(t, svc, store, "set-b")
	registerMigrationPlan(t, store, "plan-pro", map[string]int{"set-b": 11})

	result, err := svc.MigrateUser(t.Context(), MigrationRequest{
		UserID: "user-1",
		SetID:  "set-b",
		PlanID: "plan-pro",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Migrated || result.Backend != UserBackendNew || result.SetID != "set-b" || result.UpstreamUserID != 42 || result.UpstreamPlanID != 11 {
		t.Fatalf("unexpected migration result: %+v", result)
	}
	if len(fixture.createdPlanIDs) != 1 || fixture.createdPlanIDs[0] != 11 {
		t.Fatalf("created upstream plans = %+v, want [11]", fixture.createdPlanIDs)
	}
	assignment, err := svc.GetUserAssignment(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if assignment.Backend != UserBackendNew || assignment.SetID != "set-b" {
		t.Fatalf("assignment not cut to new/set-b: %+v", assignment)
	}
	binding, ok, err := store.GetUserBinding(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("binding not saved: ok=%v err=%v", ok, err)
	}
	if binding.SetID != "set-b" || binding.UpstreamUserID != 42 || binding.LastPlanID != "plan-pro" {
		t.Fatalf("unexpected binding: %+v", binding)
	}
	if task, ok, err := store.GetTenantObservationTask(t.Context(), "user-1"); err != nil || !ok || task.SetID != "set-b" || task.Priority != TenantObservationPriorityEvent {
		t.Fatalf("migration did not enqueue observation: task=%+v ok=%v err=%v", task, ok, err)
	}
}

func TestMigrateUserDoesNotCutAssignmentWhenNewAPIFails(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	fixture.failCreateSubscription = true
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSetWithID(t, svc, store, "set-b")
	registerMigrationPlan(t, store, "plan-pro", map[string]int{"set-b": 11})

	_, err := svc.MigrateUser(t.Context(), MigrationRequest{
		UserID: "user-1",
		SetID:  "set-b",
		PlanID: "plan-pro",
	})
	if err == nil {
		t.Fatal("expected migration to fail")
	}
	assignment, err := svc.GetUserAssignment(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if assignment.Backend != UserBackendPending {
		t.Fatalf("failed migration cut assignment: %+v", assignment)
	}
}

func TestMigrateUserAlreadyNewIsIdempotent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("already migrated user should not call new-api, got %s %s", r.Method, r.URL.Path)
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	registerBootstrappedMigrationSet(t, svc, store, "set-a", upstream.URL)
	registerMigrationPlan(t, store, "plan-pro", map[string]int{"set-a": 7})
	if _, err := svc.SetUserAssignment(t.Context(), UserAssignment{
		ExternalUserID: "user-1",
		Backend:        UserBackendNew,
		SetID:          "set-a",
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.MigrateUser(t.Context(), MigrationRequest{
		UserID: "user-1",
		SetID:  "set-a",
		PlanID: "plan-pro",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.AlreadyMigrated || !result.Migrated || result.SetID != "set-a" {
		t.Fatalf("unexpected idempotent result: %+v", result)
	}
}

func registerBootstrappedMigrationSet(t *testing.T, svc *Service, store *MemoryStore, setID string, baseURL string) {
	t.Helper()
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: setID, BaseURL: baseURL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, ok, err := store.GetSet(t.Context(), setID)
	if err != nil || !ok {
		t.Fatalf("set not saved: ok=%v err=%v", ok, err)
	}
	set.Setup = true
	set.AdminUserID = 1
	set.AdminAccessToken = "set-admin-token"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
}

func registerMigrationPlan(t *testing.T, store *MemoryStore, planID string, upstreamPlanIDs map[string]int) {
	t.Helper()
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              planID,
		Name:            planID,
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: upstreamPlanIDs,
	}); err != nil {
		t.Fatal(err)
	}
}
