package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
)

func TestRegisterPlanDefaultsToMonthlyResetWithoutBusinessDuration(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	plan := Plan{
		ID:            "starter",
		Name:          "入门型",
		MonthlyTokens: 10_000,
		IsActive:      true,
	}

	if err := svc.RegisterPlan(t.Context(), plan); err != nil {
		t.Fatalf("register plan: %v", err)
	}
	if err := svc.RegisterPlan(t.Context(), plan); err != nil {
		t.Fatalf("idempotent register: %v", err)
	}

	got, err := svc.GetPlan(t.Context(), plan.ID)
	if err != nil {
		t.Fatalf("get plan: %v", err)
	}
	if got.QuotaResetPeriod != "monthly" || got.QuotaResetCustomSeconds != 0 {
		t.Fatalf("reset policy = %q/%d, want monthly/0", got.QuotaResetPeriod, got.QuotaResetCustomSeconds)
	}
	if got.Fingerprint == "" {
		t.Fatal("missing plan fingerprint")
	}
}

func TestRegisterPlanStillRejectsImplicitMutation(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	plan := Plan{ID: "starter", Name: "入门型", MonthlyTokens: 10_000, IsActive: true}
	if err := svc.RegisterPlan(t.Context(), plan); err != nil {
		t.Fatal(err)
	}
	plan.MonthlyTokens++
	if err := svc.RegisterPlan(t.Context(), plan); !errors.Is(err, ErrPlanImmutableConflict) {
		t.Fatalf("changed plan error = %v, want ErrPlanImmutableConflict", err)
	}
}

func TestRetirePlanPreservesImmutableAndLegacyFields(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	legacy, err := normalizePlan(Plan{
		ID: "starter", Name: "旧套餐", MonthlyTokens: 1_000, IsActive: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	legacy.PeriodValue = 14
	legacy.PeriodUnit = "days"
	store.entitlementPlans[legacy.ID] = legacy

	retired, err := svc.RetirePlan(t.Context(), legacy.ID)
	if err != nil {
		t.Fatal(err)
	}
	if retired.PeriodValue != 14 || retired.PeriodUnit != "days" {
		t.Fatalf("legacy columns were cleaned by retire: %+v", retired)
	}
	if retired.Name != legacy.Name || retired.MonthlyTokens != legacy.MonthlyTokens ||
		retired.QuotaResetPeriod != legacy.QuotaResetPeriod ||
		retired.Fingerprint != legacy.Fingerprint {
		t.Fatalf("retire changed immutable fields: got=%+v want=%+v", retired, legacy)
	}
	if retired.IsActive {
		t.Fatalf("retired plan is still active: %+v", retired)
	}
	again, err := svc.RetirePlan(t.Context(), legacy.ID)
	if err != nil || again.IsActive || again.Fingerprint != legacy.Fingerprint {
		t.Fatalf("idempotent retire got=%+v err=%v", again, err)
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
		Name: "入门型", MonthlyTokens: 1_000_000, IsActive: true,
	})
	if err != nil {
		t.Fatalf("create plan: %v", err)
	}
	if !strings.HasPrefix(created.ID, "plan-") || created.Fingerprint == "" {
		t.Fatalf("generated plan identity is incomplete: %+v", created)
	}
	if state, ok, err := store.GetSetPlan(t.Context(), created.ID, "set-a"); err != nil || !ok || state.Status != SetPlanStatusPending {
		t.Fatalf("active set delivery state ok=%v state=%+v err=%v", ok, state, err)
	} else if state.AppliedFingerprint != "" {
		t.Fatalf("pending mapping must not claim an applied revision: %+v", state)
	}
	if _, ok, err := store.GetSetPlan(t.Context(), created.ID, "set-disabled"); err != nil || ok {
		t.Fatalf("disabled set must not be queued, ok=%v err=%v", ok, err)
	}
}

func TestGetPlanReadinessRequiresEveryActiveSet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	for _, setID := range []string{"set-a", "set-b"} {
		if err := store.SaveSet(t.Context(), Set{ID: setID, Status: SetStatusActive}); err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "starter", Name: "Starter", MonthlyTokens: 1000, IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}
	plan, _ := svc.GetPlan(t.Context(), "starter")
	if err := store.SaveSetPlan(t.Context(), SetPlan{
		PlanID: plan.ID, SetID: "set-a", UpstreamPlanID: 41,
		AppliedFingerprint: plan.Fingerprint, Status: SetPlanStatusReady,
	}); err != nil {
		t.Fatal(err)
	}

	readiness, err := svc.GetPlanReadiness(t.Context(), plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	if readiness.ReadyForAllSets || readiness.ActiveSetCount != 2 || readiness.ReadySetCount != 1 {
		t.Fatalf("partial readiness = %+v", readiness)
	}

	if err := store.SaveSetPlan(t.Context(), SetPlan{
		PlanID: plan.ID, SetID: "set-b", UpstreamPlanID: 42,
		AppliedFingerprint: plan.Fingerprint, Status: SetPlanStatusReady,
	}); err != nil {
		t.Fatal(err)
	}
	readiness, err = svc.GetPlanReadiness(t.Context(), plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !readiness.ReadyForAllSets || readiness.ActiveSetCount != 2 || readiness.ReadySetCount != 2 {
		t.Fatalf("complete readiness = %+v", readiness)
	}

	if _, err := svc.RetirePlan(t.Context(), plan.ID); err != nil {
		t.Fatal(err)
	}
	readiness, err = svc.GetPlanReadiness(t.Context(), plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	if readiness.ReadyForAllSets {
		t.Fatalf("retired plan reported ready for new grants: %+v", readiness)
	}
}

func TestReadySetPlanRejectsStaleAppliedFingerprint(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "starter", Name: "Starter", MonthlyTokens: 1000, IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}
	plan, _ := svc.GetPlan(t.Context(), "starter")
	if err := store.SaveSetPlan(t.Context(), SetPlan{
		PlanID: plan.ID, SetID: "set-a", UpstreamPlanID: 41,
		AppliedFingerprint: "stale-fingerprint", Status: SetPlanStatusReady,
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.readySetPlanID(t.Context(), plan.ID, "set-a"); !errors.Is(err, ErrPlanNotReady) {
		t.Fatalf("stale mapping err = %v, want ErrPlanNotReady", err)
	}
}

func TestPlanWorkerCreatesLongLivedResettingPlan(t *testing.T) {
	var creates atomic.Int32
	var created newapi.AdminCreateSubscriptionPlanRequest
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/plans":
			if creates.Load() == 0 {
				writeTestJSON(t, w, map[string]any{"success": true, "data": []any{}})
				return
			}
			created.Plan.ID = 99
			writeTestJSON(t, w, map[string]any{"success": true, "data": []any{
				map[string]any{"plan": created.Plan},
			}})
		case "POST /api/subscription/admin/plans":
			creates.Add(1)
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Fatal(err)
			}
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
		ID: "starter", Name: "入门型", MonthlyTokens: 10_000,
		QuotaResetPeriod: "weekly", IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}

	synced, failed, err := svc.syncPlansJob(t.Context())
	if err != nil || synced != 1 || failed != 0 {
		t.Fatalf("sync synced=%d failed=%d err=%v", synced, failed, err)
	}
	if created.Plan.DurationUnit != "year" || created.Plan.DurationValue != 100 {
		t.Fatalf("duration = %d %s, want 100 year", created.Plan.DurationValue, created.Plan.DurationUnit)
	}
	if created.Plan.QuotaResetPeriod != "weekly" || created.Plan.TotalAmount != 10_000 {
		t.Fatalf("created plan = %+v", created.Plan)
	}
	plan, _ := svc.GetPlan(t.Context(), "starter")
	if created.Plan.Subtitle != managedPlanMarker(plan) ||
		!strings.HasPrefix(created.Plan.Subtitle, "llmgateway plan:v3:") {
		t.Fatalf("marker = %q, want %q", created.Plan.Subtitle, managedPlanMarker(plan))
	}
	state, ok, err := store.GetSetPlan(t.Context(), "starter", "set-a")
	if err != nil || !ok || state.Status != SetPlanStatusReady || state.UpstreamPlanID != 99 {
		t.Fatalf("unexpected state ok=%v state=%+v err=%v", ok, state, err)
	}
	if state.AppliedFingerprint != plan.Fingerprint {
		t.Fatalf("applied fingerprint = %q, want %q", state.AppliedFingerprint, plan.Fingerprint)
	}
	if got := creates.Load(); got != 1 {
		t.Fatalf("upstream creates=%d, want 1", got)
	}
}

func TestPlanWorkerPropagatesCustomResetSeconds(t *testing.T) {
	var created newapi.AdminCreateSubscriptionPlanRequest
	var createdPlanID atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/plans":
			if createdPlanID.Load() == 0 {
				writeTestJSON(t, w, map[string]any{"success": true, "data": []any{}})
				return
			}
			created.Plan.ID = int(createdPlanID.Load())
			writeTestJSON(t, w, map[string]any{"success": true, "data": []any{
				map[string]any{"plan": created.Plan},
			}})
		case "POST /api/subscription/admin/plans":
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Fatal(err)
			}
			createdPlanID.Store(101)
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":101}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	_ = store.SaveSet(t.Context(), Set{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin"})
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "custom", MonthlyTokens: 1234, QuotaResetPeriod: "custom",
		QuotaResetCustomSeconds: 7 * 86400, IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.syncPlansJob(t.Context()); err != nil {
		t.Fatal(err)
	}
	if created.Plan.QuotaResetCustomSeconds != 7*86400 {
		t.Fatalf("custom reset seconds = %d", created.Plan.QuotaResetCustomSeconds)
	}
}

func TestPlanWorkerReplacesLegacyReadyMappingWithoutClearingItFirst(t *testing.T) {
	var creates atomic.Int32
	var created newapi.AdminCreateSubscriptionPlanRequest
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/plans":
			data := []any{
				map[string]any{"plan": map[string]any{"id": 7, "subtitle": "llmgateway plan:starter"}},
			}
			if creates.Load() > 0 {
				created.Plan.ID = 88
				data = append(data, map[string]any{"plan": created.Plan})
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": data})
		case "POST /api/subscription/admin/plans":
			creates.Add(1)
			decodeTestJSON(t, r, &created)
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":88}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	_ = store.SaveSet(t.Context(), Set{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin"})
	if err := svc.RegisterPlan(t.Context(), Plan{ID: "starter", MonthlyTokens: 1000, IsActive: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetPlan(t.Context(), SetPlan{
		PlanID: "starter", SetID: "set-a", UpstreamPlanID: 7,
		Status: SetPlanStatusReady,
	}); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	legacy := store.setPlans[setPlanKey("starter", "set-a")]
	legacy.AppliedFingerprint = ""
	store.setPlans[setPlanKey("starter", "set-a")] = legacy
	store.mu.Unlock()

	synced, failed, err := svc.syncPlansJob(t.Context())
	if err != nil || synced != 1 || failed != 0 {
		t.Fatalf("sync synced=%d failed=%d err=%v", synced, failed, err)
	}
	state, _, _ := store.GetSetPlan(t.Context(), "starter", "set-a")
	if state.UpstreamPlanID != 88 || state.AppliedFingerprint == "" {
		t.Fatalf("legacy mapping was not atomically replaced: %+v", state)
	}
	if creates.Load() != 1 {
		t.Fatalf("create count=%d, want 1", creates.Load())
	}
}

func TestPlanWorkerKeepsStableMappingAdmittedWhileReplacementIsInFlight(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var lists atomic.Int32
	var created newapi.AdminCreateSubscriptionPlanRequest
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/plans":
			data := []any{
				map[string]any{"plan": map[string]any{"id": 7, "subtitle": "llmgateway plan:v2:starter:legacy"}},
			}
			if lists.Add(1) == 1 {
				close(started)
				<-release
			}
			if created.Plan.ID > 0 {
				data = append(data, map[string]any{"plan": created.Plan})
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": data})
		case "POST /api/subscription/admin/plans":
			decodeTestJSON(t, r, &created)
			created.Plan.ID = 88
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":88}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	_ = store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin",
	})
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "starter", MonthlyTokens: 2_000, IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetPlan(t.Context(), SetPlan{
		PlanID: "starter", SetID: "set-a", UpstreamPlanID: 7,
		Status: SetPlanStatusReady, AppliedFingerprint: "stable-old-fingerprint",
	}); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		_, _, err := svc.syncPlansJob(t.Context())
		done <- err
	}()
	<-started

	state, ok, err := store.GetSetPlan(t.Context(), "starter", "set-a")
	stableVisible := err == nil && ok &&
		state.Status == SetPlanStatusReady &&
		state.UpstreamPlanID == 7 &&
		state.AppliedFingerprint == "stable-old-fingerprint"

	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !stableVisible {
		t.Fatalf("stable mapping was hidden during replacement: %+v (ok=%v err=%v)", state, ok, err)
	}
}

func TestPlanWorkerAdoptsExactRemotePlanAfterCreateResponseLost(t *testing.T) {
	var remote *newapi.AdminSubscriptionPlan
	var creates atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/plans":
			if remote == nil {
				writeTestJSON(t, w, map[string]any{"success": true, "data": []any{}})
				return
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": []any{
				map[string]any{"plan": remote},
			}})
		case "POST /api/subscription/admin/plans":
			creates.Add(1)
			var req newapi.AdminCreateSubscriptionPlanRequest
			decodeTestJSON(t, r, &req)
			req.Plan.ID = 55
			remote = &req.Plan
			http.Error(w, "response lost", http.StatusBadGateway)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "starter", Name: "Starter", MonthlyTokens: 1000, IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}

	synced, failed, err := svc.syncPlansJob(t.Context())
	if err != nil || synced != 1 || failed != 0 {
		t.Fatalf("response-lost sync synced=%d failed=%d err=%v", synced, failed, err)
	}
	state, ok, err := store.GetSetPlan(t.Context(), "starter", "set-a")
	if err != nil || !ok || state.Status != SetPlanStatusReady || state.UpstreamPlanID != 55 {
		t.Fatalf("remote plan was not adopted: ok=%v state=%+v err=%v", ok, state, err)
	}
	if creates.Load() != 1 {
		t.Fatalf("create attempts=%d, want 1", creates.Load())
	}
}

func TestPlanWorkerRejectsRemoteDriftWithoutRecreating(t *testing.T) {
	var creates atomic.Int32
	var remote newapi.AdminSubscriptionPlan
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/plans":
			writeTestJSON(t, w, map[string]any{"success": true, "data": []any{
				map[string]any{"plan": remote},
			}})
		case "POST /api/subscription/admin/plans":
			creates.Add(1)
			t.Fatal("drift verification must not create a replacement plan")
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	_ = store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin",
	})
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "starter", Name: "Starter", MonthlyTokens: 1000, IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}
	plan, _ := svc.GetPlan(t.Context(), "starter")
	remote = newapi.AdminSubscriptionPlan{
		ID: 55, Title: plan.Name, Subtitle: managedPlanMarker(plan),
		DurationUnit: "year", DurationValue: 100, Enabled: true,
		TotalAmount: 999, QuotaResetPeriod: plan.QuotaResetPeriod,
	}
	if err := store.SaveSetPlan(t.Context(), SetPlan{
		PlanID: plan.ID, SetID: "set-a", UpstreamPlanID: 55,
		AppliedFingerprint: plan.Fingerprint, Status: SetPlanStatusReady,
		SyncedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.QueuePlanSync(t.Context(), plan.ID, []string{"set-a"}); err != nil {
		t.Fatal(err)
	}

	_, failed, err := svc.syncPlansJob(t.Context())
	if err == nil || failed != 1 {
		t.Fatalf("drift check failed=%d err=%v, want one failure", failed, err)
	}
	state, _, _ := store.GetSetPlan(t.Context(), plan.ID, "set-a")
	if state.Status != SetPlanStatusError || state.UpstreamPlanID != 55 ||
		state.AppliedFingerprint != plan.Fingerprint || state.LastError == "" {
		t.Fatalf("drift did not isolate the immutable mapping: %+v", state)
	}
	if _, err := svc.readySetPlanID(t.Context(), plan.ID, "set-a"); !errors.Is(err, ErrPlanNotReady) {
		t.Fatalf("drifted mapping remains issuable: %v", err)
	}
	if creates.Load() != 0 {
		t.Fatalf("replacement creates=%d, want 0", creates.Load())
	}

	if _, err := svc.QueuePlanSync(t.Context(), plan.ID, []string{"set-a"}); err != nil {
		t.Fatal(err)
	}
	state, _, _ = store.GetSetPlan(t.Context(), plan.ID, "set-a")
	if state.Status != SetPlanStatusError {
		t.Fatalf("retry queue temporarily re-admitted a drifted mapping: %+v", state)
	}
}

func TestPlanWorkerRejectsDuplicateManagedMarkers(t *testing.T) {
	var remote newapi.AdminSubscriptionPlan
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/plans":
			first := remote
			first.ID = 55
			second := remote
			second.ID = 56
			writeTestJSON(t, w, map[string]any{"success": true, "data": []any{
				map[string]any{"plan": first},
				map[string]any{"plan": second},
			}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	_ = store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin",
	})
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "starter", Name: "Starter", MonthlyTokens: 1000, IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}
	plan, _ := svc.GetPlan(t.Context(), "starter")
	remote = newapi.AdminSubscriptionPlan{
		Title: plan.Name, Subtitle: managedPlanMarker(plan),
		DurationUnit: "year", DurationValue: 100, Enabled: true,
		TotalAmount: plan.MonthlyTokens, QuotaResetPeriod: plan.QuotaResetPeriod,
	}

	_, failed, err := svc.syncPlansJob(t.Context())
	if err == nil || failed != 1 {
		t.Fatalf("duplicate check failed=%d err=%v, want one failure", failed, err)
	}
	state, _, _ := store.GetSetPlan(t.Context(), plan.ID, "set-a")
	if state.Status != SetPlanStatusError || !strings.Contains(state.LastError, "duplicate") {
		t.Fatalf("duplicate markers were not isolated: %+v", state)
	}
}

func TestValidateManagedUpstreamPlanRejectsDisabledPlan(t *testing.T) {
	plan, err := normalizePlan(Plan{
		ID: "starter", Name: "Starter", MonthlyTokens: 1000, IsActive: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	upstream := desiredManagedUpstreamPlan(plan)
	upstream.ID = 55
	upstream.Enabled = false
	if err := validateManagedUpstreamPlan(plan, upstream); err == nil {
		t.Fatal("disabled upstream plan passed readiness verification")
	}
}

func TestPlanWorkerSerializesSamePlanAndSetAcrossWorkers(t *testing.T) {
	var inFlight atomic.Int32
	var maxInFlight atomic.Int32
	var remote newapi.AdminSubscriptionPlan
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet || r.URL.Path != "/api/subscription/admin/plans" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		current := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			maximum := maxInFlight.Load()
			if current <= maximum || maxInFlight.CompareAndSwap(maximum, current) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		writeTestJSON(t, w, map[string]any{"success": true, "data": []any{
			map[string]any{"plan": remote},
		}})
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	set := Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin",
	}
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID: "starter", Name: "Starter", MonthlyTokens: 1000, IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}
	plan, _ := svc.GetPlan(t.Context(), "starter")
	remote = desiredManagedUpstreamPlan(plan)
	remote.ID = 55
	state, _, _ := store.GetSetPlan(t.Context(), plan.ID, set.ID)

	start := make(chan struct{})
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			errs <- svc.syncSetPlan(t.Context(), set, plan, state)
		}()
	}
	close(start)
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if maxInFlight.Load() != 1 {
		t.Fatalf("same plan/set remote concurrency=%d, want 1", maxInFlight.Load())
	}
}

func TestSetAdmissionIgnoresLegacyPlanPeriodRows(t *testing.T) {
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
	set := Set{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin"}
	_ = store.SaveSet(t.Context(), set)
	plan, err := normalizePlan(Plan{ID: "starter", MonthlyTokens: 1000, IsActive: true})
	if err != nil {
		t.Fatal(err)
	}
	_ = store.SavePlan(t.Context(), plan)
	_ = store.SaveSetPlan(t.Context(), SetPlan{
		PlanID: plan.ID, SetID: set.ID, UpstreamPlanID: 99,
		Status: SetPlanStatusReady, AppliedFingerprint: plan.Fingerprint,
	})
	_ = store.SavePlanPeriod(t.Context(), PlanPeriod{PlanID: plan.ID, PeriodValue: 14, PeriodUnit: "days"})
	_ = store.SaveSetPlanPeriod(t.Context(), SetPlanPeriod{
		PlanID: plan.ID, PeriodValue: 14, PeriodUnit: "days",
		SetID: set.ID, Status: SetPlanStatusError, LastError: "legacy dirty row",
	})

	result, err := svc.CheckSetAdmission(t.Context(), set.ID)
	if err != nil || result.Status != SetAdmissionStatusPassed {
		t.Fatalf("legacy rows affected admission: result=%+v err=%v", result, err)
	}
}
