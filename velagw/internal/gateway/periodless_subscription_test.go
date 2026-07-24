package gateway

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestApplySubscriptionReusesExistingActivePlan(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000, IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	sub, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: "trade:deal-existing",
		UserID:         "user-1",
		PlanID:         "plan-pro",
		IsUnique:       true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(fixture.createdPlanIDs) != 0 {
		t.Fatalf("created duplicate subscriptions: %v", fixture.createdPlanIDs)
	}
	if sub.TokenBalance != 400 {
		t.Fatalf("remaining quota=%d, want 400", sub.TokenBalance)
	}
}

func TestApplySubscriptionReusesExistingSubscriptionAfterPlanRetired(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000, IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RetirePlan(t.Context(), "plan-pro"); err != nil {
		t.Fatal(err)
	}

	sub, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		UserID:   "user-1",
		PlanID:   "plan-pro",
		IsUnique: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if sub.TokenBalance != 400 {
		t.Fatalf("remaining quota=%d, want 400", sub.TokenBalance)
	}
	if len(fixture.createdPlanIDs) != 0 || fixture.invalidated[3] {
		t.Fatalf("retired existing subscription was mutated: created=%v invalidated=%v",
			fixture.createdPlanIDs, fixture.invalidated)
	}
}

func TestApplySubscriptionRejectsRetiredPlanWithoutMutatingOtherSubscription(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-retired", Name: "Retired", MonthlyTokens: 1000, IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 9},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RetirePlan(t.Context(), "plan-retired"); err != nil {
		t.Fatal(err)
	}

	_, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		UserID: "user-1",
		PlanID: "plan-retired",
	})
	if !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("apply retired plan error=%v, want ErrPlanNotFound", err)
	}
	if len(fixture.createdPlanIDs) != 0 || fixture.invalidated[3] {
		t.Fatalf("retired plan changed upstream subscriptions: created=%v invalidated=%v",
			fixture.createdPlanIDs, fixture.invalidated)
	}
}

func TestApplySubscriptionDifferentIdempotencyKeysStillEnsureOneSubscription(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	fixture.invalidated[3] = true
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000, IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	for _, key := range []string{"trade:deal-a", "trade:deal-b"} {
		if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
			IdempotencyKey: key,
			UserID:         "user-1",
			PlanID:         "plan-pro",
			IsUnique:       true,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if len(fixture.createdPlanIDs) != 1 {
		t.Fatalf("created subscriptions=%v, want one", fixture.createdPlanIDs)
	}
}

func TestApplySubscriptionDefaultModeAddsCreditWithoutReplacingExistingSubscription(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-user-1", Password: "user-pass-123",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-credit", Name: "Migration Credit", MonthlyTokens: 1000, IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: "credit:migration:user-1",
		UserID:         "user-1",
		PlanID:         "plan-credit",
	}); err != nil {
		t.Fatal(err)
	}
	if len(fixture.createdPlanIDs) != 1 || fixture.createdPlanIDs[0] != 7 {
		t.Fatalf("created plan IDs=%v, want one additive plan 7", fixture.createdPlanIDs)
	}
	if fixture.invalidated[3] {
		t.Fatal("additive credit invalidated the existing subscription")
	}
}

func TestApplySubscriptionIgnoresLegacyBusinessPeriodFields(t *testing.T) {
	withoutPeriod := ApplySubscriptionRequest{
		IdempotencyKey: "trade:deal-periodless",
		UserID:         "user-1",
		PlanID:         "plan-pro",
	}
	withPeriod := withoutPeriod
	start := time.Date(2030, 2, 3, 4, 5, 6, 0, time.UTC)
	withPeriod.PeriodStart = &start
	withPeriod.PeriodValue = 14
	withPeriod.PeriodUnit = "days"

	if got, want := subscriptionRequestHash(withPeriod), subscriptionRequestHash(withoutPeriod); got != want {
		t.Fatalf("legacy period changed idempotency hash: got=%s want=%s", got, want)
	}
}

func TestApplySubscriptionIdempotencyHashDistinguishesDeliveryModeAndName(t *testing.T) {
	base := ApplySubscriptionRequest{
		IdempotencyKey: "trade:deal-mode",
		UserID:         "user-1",
		PlanID:         "plan-pro",
	}
	unique := base
	unique.IsUnique = true
	named := base
	named.SubscriptionName = "migration-credit"

	if subscriptionRequestHash(base) == subscriptionRequestHash(unique) {
		t.Fatal("unique and additive delivery modes share an idempotency hash")
	}
	if subscriptionRequestHash(base) == subscriptionRequestHash(named) {
		t.Fatal("different subscription names share an idempotency hash")
	}
}

func TestApplySubscriptionReplacesDifferentActivePlanAndConverges(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-user-1", Password: "user-pass-123",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-enterprise", Name: "Enterprise", MonthlyTokens: 5000, IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 9},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: "trade:switch-plan",
		UserID:         "user-1", PlanID: "plan-enterprise", IsUnique: true,
	}); err != nil {
		t.Fatal(err)
	}
	if len(fixture.createdPlanIDs) != 1 || fixture.createdPlanIDs[0] != 9 {
		t.Fatalf("created plan IDs=%v, want [9]", fixture.createdPlanIDs)
	}
	if !fixture.invalidated[3] {
		t.Fatal("previous active plan was not invalidated")
	}
}

func TestApplySubscriptionSwitchPreservesAdditiveCredits(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	fixture.existingSubscriptionNames[3] = "package:user-1:old-pass"
	fixture.createdPlanIDs = []int{7}
	fixture.createdSubscriptionNames = []string{"free-credit:migration:user-1"}
	fixture.createdRequestIDs = []string{"credit:migration:user-1"}
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-user-1", Password: "user-pass-123",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-enterprise", Name: "Enterprise", MonthlyTokens: 5000, IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 9},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey:   "trade:switch-plan-preserve-credit",
		UserID:           "user-1",
		PlanID:           "plan-enterprise",
		SubscriptionName: "package:user-1:new-pass",
		IsUnique:         true,
	}); err != nil {
		t.Fatal(err)
	}
	if !fixture.invalidated[3] {
		t.Fatal("old package subscription was not invalidated")
	}
	if fixture.invalidated[10] {
		t.Fatal("additive free-credit subscription was invalidated")
	}
}

func TestApplySubscriptionSerializesConcurrentDifferentCommandsPerUser(t *testing.T) {
	var creates atomic.Int32
	var active atomic.Bool
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/users/42/subscriptions":
			mu.Lock()
			hasActive := active.Load()
			mu.Unlock()
			if hasActive {
				writeTestJSON(t, w, map[string]any{"success": true, "data": []any{
					map[string]any{"subscription": map[string]any{
						"id": 10, "user_id": 42, "plan_id": 7, "amount_total": 1000,
						"amount_used": 0, "start_time": time.Now().Add(-time.Minute).Unix(),
						"end_time": time.Now().AddDate(100, 0, 0).Unix(), "status": "active",
					}},
				}})
				return
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": []any{}})
		case "POST /api/subscription/admin/users/42/subscriptions":
			creates.Add(1)
			time.Sleep(30 * time.Millisecond)
			mu.Lock()
			active.Store(true)
			mu.Unlock()
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"id": 10, "user_id": 42, "plan_id": 7, "amount_total": 1000,
				"amount_used": 0, "start_time": time.Now().Add(-time.Minute).Unix(),
				"end_time": time.Now().AddDate(100, 0, 0).Unix(), "status": "active",
			}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	set := Set{
		ID: "set-a", BaseURL: server.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin", AdmissionStatus: SetAdmissionStatusPassed,
	}
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "user-1", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-user-1", Password: "user-pass-123",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000, IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	errs := make(chan error, 2)
	for _, key := range []string{"trade:concurrent-a", "trade:concurrent-b"} {
		key := key
		go func() {
			<-start
			_, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
				IdempotencyKey: key, UserID: "user-1", PlanID: "plan-pro", IsUnique: true,
			})
			errs <- err
		}()
	}
	close(start)
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if got := creates.Load(); got != 1 {
		t.Fatalf("concurrent create count=%d, want 1", got)
	}
}
