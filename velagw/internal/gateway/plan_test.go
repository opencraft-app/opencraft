package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
)

func TestRegisterPlanIsIdempotentAndImmutable(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	plan := Plan{
		ID:            "starter-2026-07",
		Name:          "入门型",
		MonthlyTokens: 10_000,
		PeriodValue:   1,
		PeriodUnit:    "months",
		IsActive:      true,
	}

	if err := svc.RegisterPlan(t.Context(), plan); err != nil {
		t.Fatalf("register plan: %v", err)
	}
	if err := svc.RegisterPlan(t.Context(), plan); err != nil {
		t.Fatalf("idempotent register: %v", err)
	}

	changed := plan
	changed.MonthlyTokens++
	if err := svc.RegisterPlan(t.Context(), changed); !errors.Is(err, ErrPlanImmutableConflict) {
		t.Fatalf("changed plan error = %v, want ErrPlanImmutableConflict", err)
	}

	got, err := svc.GetPlan(t.Context(), plan.ID)
	if err != nil {
		t.Fatalf("get plan: %v", err)
	}
	if got.MonthlyTokens != plan.MonthlyTokens || got.Fingerprint == "" {
		t.Fatalf("stored plan changed or missing fingerprint: %+v", got)
	}
}

func TestCreatePlanGeneratesStableIdentityAndQueuesActiveSets(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSet(t.Context(), Set{ID: "set-disabled", Status: SetStatusDisabled}); err != nil {
		t.Fatal(err)
	}

	created, err := svc.CreatePlan(t.Context(), Plan{
		Name: "入门型 14 天", MonthlyTokens: 1_000_000,
		PeriodValue: 14, PeriodUnit: "days", IsActive: true,
	})
	if err != nil {
		t.Fatalf("create plan: %v", err)
	}
	if !strings.HasPrefix(created.ID, "plan-") || created.Fingerprint == "" {
		t.Fatalf("generated plan identity is incomplete: %+v", created)
	}
	if stored, err := svc.GetPlan(t.Context(), created.ID); err != nil || stored.Fingerprint != created.Fingerprint {
		t.Fatalf("stored plan = %+v err=%v", stored, err)
	}
	if state, ok, err := store.GetSetPlan(t.Context(), created.ID, "set-a"); err != nil || !ok || state.Status != SetPlanStatusPending {
		t.Fatalf("active set delivery state ok=%v state=%+v err=%v", ok, state, err)
	}
	if _, ok, err := store.GetSetPlan(t.Context(), created.ID, "set-disabled"); err != nil || ok {
		t.Fatalf("disabled set must not be queued, ok=%v err=%v", ok, err)
	}
}

func TestSetPlanStorageKeepsPerSetUpstreamIdentity(t *testing.T) {
	store := NewMemoryStore()
	want := SetPlan{
		PlanID:         "starter-2026-07",
		SetID:          "set-a",
		UpstreamPlanID: 42,
		Status:         SetPlanStatusReady,
	}
	if err := store.SaveSetPlan(t.Context(), want); err != nil {
		t.Fatalf("save set plan: %v", err)
	}

	got, ok, err := store.GetSetPlan(t.Context(), want.PlanID, want.SetID)
	if err != nil {
		t.Fatalf("get set plan: %v", err)
	}
	if !ok || got.UpstreamPlanID != 42 || got.Status != SetPlanStatusReady {
		t.Fatalf("unexpected set plan: ok=%v plan=%+v", ok, got)
	}
}

func TestPickSetForPlanRequiresReadySetPlan(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	set := Set{ID: "set-a", Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin"}
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatalf("save set: %v", err)
	}
	plan := Plan{ID: "starter-2026-07", IsActive: true}
	if err := store.SavePlan(t.Context(), plan); err != nil {
		t.Fatalf("save plan: %v", err)
	}
	if err := store.SaveSetPlan(t.Context(), SetPlan{PlanID: plan.ID, SetID: set.ID, Status: SetPlanStatusPending}); err != nil {
		t.Fatalf("save pending set plan: %v", err)
	}

	if _, _, err := svc.pickSetForPlan(t.Context(), plan); !errors.Is(err, ErrPlanNotReady) {
		t.Fatalf("pending mapping error = %v, want ErrPlanNotReady", err)
	}

	if err := store.SaveSetPlan(t.Context(), SetPlan{PlanID: plan.ID, SetID: set.ID, UpstreamPlanID: 42, Status: SetPlanStatusReady}); err != nil {
		t.Fatalf("save ready set plan: %v", err)
	}
	gotSet, upstreamPlanID, err := svc.pickSetForPlan(t.Context(), plan)
	if err != nil {
		t.Fatalf("pick ready set: %v", err)
	}
	if gotSet.ID != set.ID || upstreamPlanID != 42 {
		t.Fatalf("unexpected pick: set=%+v upstream_plan_id=%d", gotSet, upstreamPlanID)
	}
}

func TestPlanWorkerSynchronizesPendingPlanOnce(t *testing.T) {
	var creates atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/plans":
			_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
		case "POST /api/subscription/admin/plans":
			creates.Add(1)
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":99}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "starter-2026-07", Name: "入门型", MonthlyTokens: 10_000,
		PeriodValue: 1, PeriodUnit: "months", IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}

	synced, failed, err := svc.syncPlansJob(t.Context())
	if err != nil || synced != 1 || failed != 0 {
		t.Fatalf("first sync synced=%d failed=%d err=%v", synced, failed, err)
	}
	state, ok, err := store.GetSetPlan(t.Context(), "starter-2026-07", "set-a")
	if err != nil || !ok || state.Status != SetPlanStatusReady || state.UpstreamPlanID != 99 {
		t.Fatalf("unexpected state ok=%v state=%+v err=%v", ok, state, err)
	}
	if synced, failed, err = svc.syncPlansJob(t.Context()); err != nil || synced != 0 || failed != 0 {
		t.Fatalf("second sync synced=%d failed=%d err=%v", synced, failed, err)
	}
	if got := creates.Load(); got != 1 {
		t.Fatalf("upstream creates=%d, want 1", got)
	}
}

func TestPlanWorkerAdoptsExistingManagedPlanAfterLostCreateResponse(t *testing.T) {
	var creates atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/plans":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"plan":{"id":77,"title":"入门型","subtitle":"llmgateway plan:starter-2026-07"}}]}`))
		case "POST /api/subscription/admin/plans":
			creates.Add(1)
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":99}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "starter-2026-07", Name: "入门型", MonthlyTokens: 10_000,
		PeriodValue: 1, PeriodUnit: "months", IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}

	synced, failed, err := svc.syncPlansJob(t.Context())
	if err != nil || synced != 1 || failed != 0 {
		t.Fatalf("sync existing plan synced=%d failed=%d err=%v", synced, failed, err)
	}
	state, ok, err := store.GetSetPlan(t.Context(), "starter-2026-07", "set-a")
	if err != nil || !ok || state.UpstreamPlanID != 77 || state.Status != SetPlanStatusReady {
		t.Fatalf("unexpected adopted state ok=%v state=%+v err=%v", ok, state, err)
	}
	if got := creates.Load(); got != 0 {
		t.Fatalf("upstream creates=%d, want 0", got)
	}
}

func TestSetAdmissionRequiresEveryActivePlanReady(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/setup" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"status":true,"root_init":true}}`))
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	set := Set{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token"}
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlan(t.Context(), Plan{ID: "starter-2026-07", Name: "入门型", PeriodValue: 1, PeriodUnit: "months", IsActive: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetPlan(t.Context(), SetPlan{PlanID: "starter-2026-07", SetID: "set-a", Status: SetPlanStatusPending}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.CheckSetAdmission(t.Context(), set.ID); err == nil {
		t.Fatal("pending plan unexpectedly passed admission")
	}
	if err := store.SaveSetPlan(t.Context(), SetPlan{PlanID: "starter-2026-07", SetID: "set-a", Status: SetPlanStatusReady, UpstreamPlanID: 99}); err != nil {
		t.Fatal(err)
	}
	result, err := svc.CheckSetAdmission(t.Context(), set.ID)
	if err != nil || result.Status != SetAdmissionStatusPassed {
		t.Fatalf("ready plan admission result=%+v err=%v", result, err)
	}
}

func TestSetAdmissionRequiresEveryPlanPeriodReady(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/setup" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"status":true,"root_init":true}}`))
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	set := Set{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token"}
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlan(t.Context(), Plan{ID: "starter-2026-07", Name: "入门型", PeriodValue: 1, PeriodUnit: "months", IsActive: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetPlan(t.Context(), SetPlan{PlanID: "starter-2026-07", SetID: set.ID, Status: SetPlanStatusReady, UpstreamPlanID: 99}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanPeriod(t.Context(), PlanPeriod{PlanID: "starter-2026-07", PeriodValue: 14, PeriodUnit: "days"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetPlanPeriod(t.Context(), SetPlanPeriod{
		PlanID: "starter-2026-07", PeriodValue: 14, PeriodUnit: "days", SetID: set.ID, Status: SetPlanStatusPending,
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.CheckSetAdmission(t.Context(), set.ID); err == nil {
		t.Fatal("pending plan period unexpectedly passed admission")
	}
	if err := store.SaveSetPlanPeriod(t.Context(), SetPlanPeriod{
		PlanID: "starter-2026-07", PeriodValue: 14, PeriodUnit: "days", SetID: set.ID,
		Status: SetPlanStatusReady, UpstreamPlanID: 100,
	}); err != nil {
		t.Fatal(err)
	}
	result, err := svc.CheckSetAdmission(t.Context(), set.ID)
	if err != nil || result.Status != SetAdmissionStatusPassed {
		t.Fatalf("ready plan period admission result=%+v err=%v", result, err)
	}
}

func TestRegisterPlanPeriodQueuesAllActiveSets(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	for _, setID := range []string{"set-a", "set-b"} {
		if err := store.SaveSet(t.Context(), Set{ID: setID, Status: SetStatusActive}); err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "plan-launch", Name: "Launch", MonthlyTokens: 1000,
		PeriodValue: 1, PeriodUnit: "months", IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}

	if err := svc.RegisterPlanPeriod(t.Context(), PlanPeriod{
		PlanID: "plan-launch", PeriodValue: 14, PeriodUnit: "days",
	}); err != nil {
		t.Fatal(err)
	}

	for _, setID := range []string{"set-a", "set-b"} {
		state, ok, err := store.GetSetPlanPeriod(t.Context(), "plan-launch", 14, "days", setID)
		if err != nil || !ok {
			t.Fatalf("period mapping %s missing: ok=%v err=%v", setID, ok, err)
		}
		if state.Status != SetPlanStatusPending {
			t.Fatalf("period mapping %s status=%q, want pending", setID, state.Status)
		}
	}
}

func TestRegisterPlanPeriodRejectsUnsupportedUnit(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SavePlan(t.Context(), Plan{
		ID: "plan-launch", Name: "Launch", PeriodValue: 1, PeriodUnit: "months", IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}

	err := svc.RegisterPlanPeriod(t.Context(), PlanPeriod{
		PlanID: "plan-launch", PeriodValue: 2, PeriodUnit: "weeks",
	})
	if err == nil {
		t.Fatal("unsupported period unit unexpectedly accepted")
	}
}

func TestPlanWorkerSynchronizesPeriodVariant(t *testing.T) {
	var created newapi.AdminCreateSubscriptionPlanRequest
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/plans":
			_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
		case "POST /api/subscription/admin/plans":
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Fatal(err)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":37}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin"}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterPlan(t.Context(), Plan{ID: "plan-launch", Name: "Launch", MonthlyTokens: 1000, PeriodValue: 1, PeriodUnit: "months", IsActive: true}); err != nil {
		t.Fatal(err)
	}
	// Keep this test focused on the variant sync.
	if err := store.SaveSetPlan(t.Context(), SetPlan{PlanID: "plan-launch", SetID: "set-a", UpstreamPlanID: 7, Status: SetPlanStatusReady}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterPlanPeriod(t.Context(), PlanPeriod{PlanID: "plan-launch", PeriodValue: 14, PeriodUnit: "days"}); err != nil {
		t.Fatal(err)
	}

	synced, failed, err := svc.syncPlansJob(t.Context())
	if err != nil || synced != 1 || failed != 0 {
		t.Fatalf("sync synced=%d failed=%d err=%v", synced, failed, err)
	}
	if created.Plan.DurationUnit != "day" || created.Plan.DurationValue != 14 {
		t.Fatalf("created period=%d %q, want 14 day", created.Plan.DurationValue, created.Plan.DurationUnit)
	}
	if created.Plan.Subtitle != "llmgateway plan:plan-launch:14:days" {
		t.Fatalf("marker=%q", created.Plan.Subtitle)
	}
	state, ok, err := store.GetSetPlanPeriod(t.Context(), "plan-launch", 14, "days", "set-a")
	if err != nil || !ok || state.Status != SetPlanStatusReady || state.UpstreamPlanID != 37 {
		t.Fatalf("state=%+v ok=%v err=%v", state, ok, err)
	}
}
