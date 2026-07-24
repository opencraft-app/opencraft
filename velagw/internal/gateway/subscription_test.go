package gateway

import (
	"errors"
	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestApplySubscriptionCreatesNewAPISubscriptionAndAggregatesActiveBalance(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID:     "user-1",
		SetID:              "set-a",
		UpstreamUserID:     42,
		Username:           "sgw-user-1",
		Password:           "user-pass-123",
		ProvisionStatus:    BindingProvisionStatusUserReady,
		LastProvisionError: "",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	sub, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: "trade:deal-create-aggregate",
		UserID:         "user-1",
		PlanID:         "plan-pro",
		Nickname:       "User One",
	})
	if err != nil {
		t.Fatal(err)
	}
	if fixture.createdPlanIDs[0] != 7 {
		t.Fatalf("created plan id = %d, want 7", fixture.createdPlanIDs[0])
	}
	if fixture.invalidated[3] {
		t.Fatalf("existing active subscription must remain active: %+v", fixture.invalidated)
	}
	if sub.UserID != "user-1" || sub.PlanID != "plan-pro" || sub.Status != "active" {
		t.Fatalf("unexpected subscription identity: %+v", sub)
	}
	if sub.TokenBalance != 1400 {
		t.Fatalf("token balance = %d, want 1400", sub.TokenBalance)
	}

	binding, ok, err := store.GetUserBinding(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("binding not saved: ok=%v err=%v", ok, err)
	}
	if binding.UpstreamUserID != 42 || binding.LastPlanID != "plan-pro" {
		t.Fatalf("unexpected binding: %+v", binding)
	}
	if binding.ProvisionStatus != BindingProvisionStatusUserReady || binding.LastProvisionError != "" {
		t.Fatalf("unexpected binding provisioning state after subscription apply: %+v", binding)
	}
	assignment, err := svc.GetUserAssignment(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if assignment.Backend != UserBackendNew || assignment.SetID != "set-a" {
		t.Fatalf("successful new subscription should route user to new backend: %+v", assignment)
	}
}

func TestApplySubscriptionUsesReturnedIDWithoutPostCreateLookup(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	fixture.omitCreatedSubscriptionsFromList = true
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
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000,
		PeriodValue: 1, PeriodUnit: "months", IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	_, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey:   "trade:deal-returned-id",
		UserID:           "user-1",
		PlanID:           "plan-pro",
		SubscriptionName: "package:user-1:pass-1",
		IsUnique:         true,
	})
	if err != nil {
		t.Fatal(err)
	}

	projections, err := store.ListSubscriptionProjections(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(projections) != 1 {
		t.Fatalf("projections = %+v, want one", projections)
	}
	if projections[0].UpstreamSubscriptionID != 10 || projections[0].SubscriptionName != "package:user-1:pass-1" {
		t.Fatalf("unexpected projection: %+v", projections[0])
	}
}

func TestUpstreamSubscriptionRequestIDIsStableAndNamespaced(t *testing.T) {
	first := upstreamSubscriptionRequestID("trade:deal-returned-id")
	second := upstreamSubscriptionRequestID("trade:deal-returned-id")
	other := upstreamSubscriptionRequestID("trade:another-deal")

	if first != second {
		t.Fatalf("same idempotency key produced different upstream request IDs: %q != %q", first, second)
	}
	if first == other {
		t.Fatalf("different idempotency keys produced the same upstream request ID: %q", first)
	}
	if !strings.HasPrefix(first, "llmgw:subscription:") {
		t.Fatalf("upstream request ID %q is missing the VelaGW namespace", first)
	}
	if len(first) > 128 {
		t.Fatalf("upstream request ID length = %d, want <= 128", len(first))
	}
}

func TestApplySubscriptionAllowsMissingIdempotencyKeyWithoutDeduplication(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
			UserID: "user-1",
			PlanID: "plan-pro",
		}); err != nil {
			t.Fatal(err)
		}
	}
	if len(fixture.createdPlanIDs) != 2 {
		t.Fatalf("new-api create count = %d, want 2 without deduplication", len(fixture.createdPlanIDs))
	}
}

func TestApplySubscriptionReplaysSucceededIdempotencyKeyWithoutCreatingAgain(t *testing.T) {
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
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	req := ApplySubscriptionRequest{
		IdempotencyKey: "trade:deal-001",
		UserID:         "user-1",
		PlanID:         "plan-pro",
	}
	first, err := svc.ApplySubscription(t.Context(), req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.ApplySubscription(t.Context(), req)
	if err != nil {
		t.Fatal(err)
	}
	if len(fixture.createdPlanIDs) != 1 {
		t.Fatalf("new-api create count = %d, want 1", len(fixture.createdPlanIDs))
	}
	if first.TokenBalance != second.TokenBalance {
		t.Fatalf("replayed balance = %d, want %d", second.TokenBalance, first.TokenBalance)
	}
}

func TestApplySubscriptionRejectsPeriodEndWithRelativePeriod(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000,
		PeriodValue: 1, PeriodUnit: "months", IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	periodEnd := time.Now().UTC().Add(24 * time.Hour)
	_, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey:   "trade:deal-period-conflict",
		UserID:           "user-1",
		PlanID:           "plan-pro",
		SubscriptionName: "package:user-1:pass-1",
		PeriodValue:      1,
		PeriodUnit:       "months",
		PeriodEnd:        &periodEnd,
	})
	if err == nil || !strings.Contains(err.Error(), "period_end is mutually exclusive") {
		t.Fatalf("err = %v, want period_end mutual exclusion", err)
	}
	if len(fixture.createdPlanIDs) != 0 {
		t.Fatalf("subscription was created despite invalid period args: %+v", fixture.createdPlanIDs)
	}
}

func TestApplySubscriptionRejectsDuplicateActiveNameWhenUnique(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	fixture.existingSubscriptionNames = map[int]string{3: "package:user-1:pass-1"}
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
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000,
		PeriodValue: 1, PeriodUnit: "months", IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	_, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey:   "trade:deal-duplicate-name",
		UserID:           "user-1",
		PlanID:           "plan-pro",
		SubscriptionName: "package:user-1:pass-1",
		IsUnique:         true,
	})
	if !errors.Is(err, ErrSubscriptionNameConflict) {
		t.Fatalf("err = %v, want ErrSubscriptionNameConflict", err)
	}
	if len(fixture.createdPlanIDs) != 0 {
		t.Fatalf("new-api create count = %d, want 0", len(fixture.createdPlanIDs))
	}
}

func TestApplySubscriptionAllowsMultipleNamedSubscriptionsWhenNotUnique(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	fixture.existingSubscriptionNames = map[int]string{3: "free-credit:campaign:same"}
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
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000,
		PeriodValue: 1, PeriodUnit: "months", IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey:   "credit:grant-same",
		UserID:           "user-1",
		PlanID:           "plan-pro",
		SubscriptionName: "free-credit:campaign:same",
		IsUnique:         false,
	}); err != nil {
		t.Fatal(err)
	}
	if len(fixture.createdPlanIDs) != 1 || fixture.createdSubscriptionNames[0] != "free-credit:campaign:same" {
		t.Fatalf("created subscriptions = plans %+v names %+v", fixture.createdPlanIDs, fixture.createdSubscriptionNames)
	}
}

func TestListActiveSubscriptionsReturnsNamesAndExplicitPeriodEnd(t *testing.T) {
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
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000,
		PeriodValue: 1, PeriodUnit: "months", IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	periodEnd := time.Unix(fixture.now+7200, 0).UTC()
	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey:   "credit:grant-explicit-end",
		UserID:           "user-1",
		PlanID:           "plan-pro",
		SubscriptionName: "free-credit:campaign:grant-1",
		PeriodEnd:        &periodEnd,
	}); err != nil {
		t.Fatal(err)
	}

	list, err := svc.ListActiveSubscriptions(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	var found *Subscription
	for i := range list.Subscriptions {
		if list.Subscriptions[i].Name == "free-credit:campaign:grant-1" {
			found = &list.Subscriptions[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("free-credit subscription not found in %+v", list.Subscriptions)
	}
	if found.PeriodEnd != periodEnd.Format(time.RFC3339Nano) {
		t.Fatalf("period_end = %s, want %s", found.PeriodEnd, periodEnd.Format(time.RFC3339Nano))
	}
	if found.TokenTotal != 1000 {
		t.Fatalf("token_total = %d, want 1000", found.TokenTotal)
	}
}

func TestApplySubscriptionKeepsDifferentDealsAsIndependentActiveSubscriptions(t *testing.T) {
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
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	for _, key := range []string{"trade:deal-001", "trade:deal-002"} {
		if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
			IdempotencyKey: key,
			UserID:         "user-1",
			PlanID:         "plan-pro",
		}); err != nil {
			t.Fatal(err)
		}
	}
	if len(fixture.createdPlanIDs) != 2 {
		t.Fatalf("new-api create count = %d, want 2", len(fixture.createdPlanIDs))
	}
	if fixture.invalidated[3] || fixture.invalidated[10] || fixture.invalidated[11] {
		t.Fatalf("independent deals must remain active: %+v", fixture.invalidated)
	}
	sub, err := svc.GetActiveSubscription(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if sub.TokenBalance != 2400 {
		t.Fatalf("token balance = %d, want 2400", sub.TokenBalance)
	}
}

func TestApplySubscriptionRejectsReusedKeyWithDifferentRequest(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	key := "trade:deal-conflict"
	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: key,
		UserID:         "user-1",
		PlanID:         "plan-pro",
		Nickname:       "first",
	}); err != nil {
		t.Fatal(err)
	}
	_, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: key,
		UserID:         "user-1",
		PlanID:         "plan-pro",
		Nickname:       "changed",
	})
	if !errors.Is(err, ErrSubscriptionIdempotencyConflict) {
		t.Fatalf("err = %v, want idempotency conflict", err)
	}
	if len(fixture.createdPlanIDs) != 1 {
		t.Fatalf("new-api create count = %d, want 1", len(fixture.createdPlanIDs))
	}
}

func TestApplySubscriptionRetriesUnknownOutcomeThroughNewAPIIdempotency(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	fixture.failCreateResponseAfterCommit = true
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	req := ApplySubscriptionRequest{
		IdempotencyKey:   "trade:deal-unknown",
		UserID:           "user-1",
		PlanID:           "plan-pro",
		SubscriptionName: "package:user-1:pass-1",
		IsUnique:         true,
	}
	if _, err := svc.ApplySubscription(t.Context(), req); err == nil {
		t.Fatal("expected upstream create error")
	}
	subscription, err := svc.ApplySubscription(t.Context(), req)
	if err != nil {
		t.Fatalf("retry failed: %v", err)
	}
	if fixture.createAttempts != 2 {
		t.Fatalf("new-api create attempts = %d, want 2", fixture.createAttempts)
	}
	if len(fixture.createdPlanIDs) != 1 {
		t.Fatalf("new-api subscriptions = %d, want 1", len(fixture.createdPlanIDs))
	}
	if subscription.TokenBalance != 1400 {
		t.Fatalf("token balance = %d, want 1400 without double-counting the retried subscription", subscription.TokenBalance)
	}
}

func TestApplySubscriptionForNewUserAvoidsSubscriptionListRoundTrips(t *testing.T) {
	var calls []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"id":       42,
				"username": "sgw-user-1",
				"role":     1,
				"status":   1,
				"group":    "default",
			}})
		case "POST /api/subscription/admin/users/42/subscriptions":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"id": 10, "user_id": 42, "plan_id": 7,
				"amount_total": 1000, "amount_used": 0,
				"start_time": time.Now().UTC().Unix(),
				"end_time":   time.Now().UTC().Add(31 * 24 * time.Hour).Unix(),
				"status":     "active", "source": "admin",
			}})
		case "GET /api/subscription/admin/users/42/subscriptions":
			t.Fatalf("new users should not list subscriptions during apply")
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("set not saved: ok=%v err=%v", ok, err)
	}
	set.Setup = true
	set.AdminUserID = 1
	set.AdminAccessToken = "set-admin-token"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	sub, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{IdempotencyKey: "trade:deal-new-user", UserID: "user-1", PlanID: "plan-pro"})
	if err != nil {
		t.Fatal(err)
	}
	if sub.UserID != "user-1" || sub.PlanID != "plan-pro" || sub.TokenBalance != 1000 {
		t.Fatalf("unexpected projected subscription: %+v", sub)
	}
	wantCalls := []string{
		"POST /api/user/",
		"POST /api/user/login",
		"POST /api/subscription/admin/users/42/subscriptions",
	}
	if strings.Join(calls, ",") != strings.Join(wantCalls, ",") {
		t.Fatalf("calls = %v, want %v", calls, wantCalls)
	}
}

func TestApplySubscriptionEmitsProvisionSpans(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	defer otel.SetTracerProvider(previous)
	defer func() { _ = provider.Shutdown(t.Context()) }()

	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{IdempotencyKey: "trade:deal-spans", UserID: "user-1", PlanID: "plan-pro"}); err != nil {
		t.Fatal(err)
	}
	spanNames := endedSpanNames(recorder)
	for _, want := range []string{
		"llmgateway.subscription.apply",
		"llmgateway.ensure_binding_for_plan",
		"llmgateway.ensure_upstream_user",
		"newapi.admin_create_user_subscription",
	} {
		if !spanNameExists(spanNames, want) {
			t.Fatalf("missing span %q in %v", want, spanNames)
		}
	}
}

func TestEnsureUpstreamUserCreatesThenResolvesIDByLoginWithoutSearch(t *testing.T) {
	var calls []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			var req newapi.LoginRequest
			decodeTestJSON(t, r, &req)
			if req.Username != "sgw-user-1" || req.Password != "user-pass-123" {
				t.Fatalf("unexpected login request: %+v", req)
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"id":       42,
				"username": req.Username,
				"role":     1,
				"status":   1,
				"group":    "default",
			}})
		case "GET /api/user/search":
			t.Fatalf("ensureUpstreamUser should resolve the created user by login instead of search")
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	binding, err := svc.ensureUpstreamUser(t.Context(), newapi.NewClient(upstream.URL, upstream.Client()), newapi.AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
	})
	if err != nil {
		t.Fatal(err)
	}
	if binding.UpstreamUserID != 42 || binding.ProvisionStatus != BindingProvisionStatusUserReady {
		t.Fatalf("unexpected binding: %+v", binding)
	}
	wantCalls := []string{"POST /api/user/", "POST /api/user/login"}
	if strings.Join(calls, ",") != strings.Join(wantCalls, ",") {
		t.Fatalf("calls = %v, want %v", calls, wantCalls)
	}
}

func TestEnsureUpstreamUserResolvesUsernameDuplicateByLoginWithoutSearch(t *testing.T) {
	var calls []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/":
			writeTestJSON(t, w, map[string]any{
				"success": false,
				"message": "Error 1062 (23000): Duplicate entry 'sgw-user-1' for key 'users.username'",
			})
		case "POST /api/user/login":
			var req newapi.LoginRequest
			decodeTestJSON(t, r, &req)
			if req.Username != "sgw-user-1" || req.Password != "user-pass-123" {
				t.Fatalf("unexpected login request: %+v", req)
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"id":       42,
				"username": req.Username,
				"role":     1,
				"status":   1,
				"group":    "default",
			}})
		case "GET /api/user/search":
			t.Fatalf("username duplicate with matching password should resolve by login instead of search")
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	binding, err := svc.ensureUpstreamUser(t.Context(), newapi.NewClient(upstream.URL, upstream.Client()), newapi.AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
	})
	if err != nil {
		t.Fatal(err)
	}
	if binding.UpstreamUserID != 42 || binding.ProvisionStatus != BindingProvisionStatusUserReady {
		t.Fatalf("unexpected binding: %+v", binding)
	}
	wantCalls := []string{"POST /api/user/", "POST /api/user/login"}
	if strings.Join(calls, ",") != strings.Join(wantCalls, ",") {
		t.Fatalf("calls = %v, want %v", calls, wantCalls)
	}
}

func TestApplySubscriptionDoesNotInvalidateExistingSubscriptionWhenCreateFails(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	fixture.failCreateSubscription = true
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
		LastPlanID:     "plan-old",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{IdempotencyKey: "trade:deal-create-fails", UserID: "user-1", PlanID: "plan-pro"}); err == nil {
		t.Fatal("expected apply subscription to fail")
	}
	if fixture.invalidated[3] {
		t.Fatalf("existing active subscription was invalidated before replacement succeeded: %+v", fixture.invalidated)
	}
}

func TestApplySubscriptionMovesPendingBindingToSetWithPlanMapping(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	fixture.registerBootstrappedSetWithID(t, svc, store, "set-b")
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-b": 7},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{IdempotencyKey: "trade:deal-move-binding", UserID: "user-1", PlanID: "plan-pro"}); err != nil {
		t.Fatal(err)
	}
	binding, ok, err := store.GetUserBinding(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("binding not saved: ok=%v err=%v", ok, err)
	}
	if binding.SetID != "set-b" || binding.UpstreamUserID != 42 {
		t.Fatalf("binding was not moved to set with plan mapping: %+v", binding)
	}
}

func TestApplySubscriptionRejectsUnsupportedPeriodOverride(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	_, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: "trade:deal-invalid-period",
		UserID:         "user-1",
		PlanID:         "plan-pro",
		PeriodValue:    3,
		PeriodUnit:     "months",
	})
	if err == nil {
		t.Fatal("expected unsupported period override to fail")
	}
	if len(fixture.createdPlanIDs) != 0 {
		t.Fatalf("subscription was created despite unsupported period override: %+v", fixture.createdPlanIDs)
	}
}

func TestApplySubscriptionSelectsPeriodSpecificUpstreamPlan(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-launch", Name: "Launch", MonthlyTokens: 1000,
		PeriodValue: 1, PeriodUnit: "months", IsActive: true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanPeriod(t.Context(), PlanPeriod{
		PlanID: "plan-launch", PeriodValue: 14, PeriodUnit: "days",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetPlanPeriod(t.Context(), SetPlanPeriod{
		PlanID: "plan-launch", PeriodValue: 14, PeriodUnit: "days",
		SetID: "set-a", UpstreamPlanID: 37, Status: SetPlanStatusReady,
	}); err != nil {
		t.Fatal(err)
	}

	sub, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: "trade:deal-launch-14d", UserID: "user-1", PlanID: "plan-launch",
		PeriodValue: 14, PeriodUnit: "d",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := fixture.createdPlanIDs[0]; got != 37 {
		t.Fatalf("created upstream plan id=%d, want 37", got)
	}
	if sub.PlanID != "plan-launch" {
		t.Fatalf("external plan id=%q, want plan-launch", sub.PlanID)
	}
}

func TestApplySubscriptionAcceptsEquivalentPeriodUnitAlias(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: "trade:deal-period-alias",
		UserID:         "user-1",
		PlanID:         "plan-pro",
		PeriodValue:    1,
		PeriodUnit:     "m",
	}); err != nil {
		t.Fatal(err)
	}
	if len(fixture.createdPlanIDs) != 1 {
		t.Fatalf("created count = %d, want 1", len(fixture.createdPlanIDs))
	}
}

func TestAddSubscriptionPeriodUsesCtlNaturalMonthSemantics(t *testing.T) {
	loc := time.FixedZone("CST", 8*3600)
	cases := []struct {
		name  string
		start time.Time
		value int
		unit  string
		want  time.Time
	}{
		{
			name:  "mid_month_keeps_day",
			start: time.Date(2026, 1, 15, 12, 34, 56, 789, loc),
			value: 1,
			unit:  "months",
			want:  time.Date(2026, 2, 15, 12, 34, 56, 789, loc),
		},
		{
			name:  "jan_31_to_feb_28_non_leap",
			start: time.Date(2025, 1, 31, 10, 0, 0, 0, loc),
			value: 1,
			unit:  "months",
			want:  time.Date(2025, 2, 28, 10, 0, 0, 0, loc),
		},
		{
			name:  "jan_31_to_feb_29_leap",
			start: time.Date(2024, 1, 31, 10, 0, 0, 0, loc),
			value: 1,
			unit:  "m",
			want:  time.Date(2024, 2, 29, 10, 0, 0, 0, loc),
		},
		{
			name:  "mar_31_to_apr_30",
			start: time.Date(2025, 3, 31, 10, 0, 0, 0, loc),
			value: 1,
			unit:  "month",
			want:  time.Date(2025, 4, 30, 10, 0, 0, 0, loc),
		},
		{
			name:  "nov_30_plus_three_months_to_feb_28",
			start: time.Date(2025, 11, 30, 8, 0, 0, 0, loc),
			value: 3,
			unit:  "months",
			want:  time.Date(2026, 2, 28, 8, 0, 0, 0, loc),
		},
		{
			name:  "day_unit_uses_calendar_days",
			start: time.Date(2025, 2, 27, 8, 0, 0, 0, loc),
			value: 2,
			unit:  "days",
			want:  time.Date(2025, 3, 1, 8, 0, 0, 0, loc),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := addSubscriptionPeriod(tc.start, tc.value, tc.unit)
			if err != nil {
				t.Fatalf("addSubscriptionPeriod returned error: %v", err)
			}
			if !got.Equal(tc.want) {
				t.Fatalf("addSubscriptionPeriod(%s, %d, %q) = %s, want %s",
					tc.start.Format(time.RFC3339Nano),
					tc.value,
					tc.unit,
					got.Format(time.RFC3339Nano),
					tc.want.Format(time.RFC3339Nano),
				)
			}
		})
	}
}

func TestApplySubscriptionProjectsCtlNaturalMonthPeriodFromFixedClock(t *testing.T) {
	loc := time.FixedZone("CST", 8*3600)
	cases := []struct {
		name  string
		start time.Time
		value int
		unit  string
		want  time.Time
	}{
		{
			name:  "middle_of_month",
			start: time.Date(2026, 6, 15, 9, 30, 0, 0, loc),
			value: 1,
			unit:  "months",
			want:  time.Date(2026, 7, 15, 9, 30, 0, 0, loc),
		},
		{
			name:  "jan_31_to_feb_28",
			start: time.Date(2025, 1, 31, 9, 30, 0, 0, loc),
			value: 1,
			unit:  "months",
			want:  time.Date(2025, 2, 28, 9, 30, 0, 0, loc),
		},
		{
			name:  "jan_31_to_feb_29_on_leap_year",
			start: time.Date(2024, 1, 31, 9, 30, 0, 0, loc),
			value: 1,
			unit:  "months",
			want:  time.Date(2024, 2, 29, 9, 30, 0, 0, loc),
		},
		{
			name:  "three_renewal_months_from_nov_30",
			start: time.Date(2025, 11, 30, 9, 30, 0, 0, loc),
			value: 3,
			unit:  "months",
			want:  time.Date(2026, 2, 28, 9, 30, 0, 0, loc),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newSubscriptionFixture(t)
			defer fixture.server.Close()

			store := NewMemoryStore()
			svc := NewService(store, nil, Options{})
			svc.now = func() time.Time { return tc.start }
			fixture.registerBootstrappedSet(t, svc, store)
			if err := store.SavePlanMapping(t.Context(), PlanMapping{
				ID:              "plan-pro",
				Name:            "Pro",
				MonthlyTokens:   1000,
				PeriodValue:     tc.value,
				PeriodUnit:      tc.unit,
				IsActive:        true,
				UpstreamPlanIDs: map[string]int{"set-a": 7},
			}); err != nil {
				t.Fatal(err)
			}

			sub, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
				IdempotencyKey: "trade:deal-period-case",
				UserID:         "user-1",
				PlanID:         "plan-pro",
			})
			if err != nil {
				t.Fatal(err)
			}
			wantStart := tc.start.UTC().Format(time.RFC3339Nano)
			wantEnd := tc.want.UTC().Format(time.RFC3339Nano)
			if sub.PeriodStart != wantStart {
				t.Fatalf("period_start = %s, want %s", sub.PeriodStart, wantStart)
			}
			if sub.PeriodEnd != wantEnd {
				t.Fatalf("period_end = %s, want %s", sub.PeriodEnd, wantEnd)
			}
		})
	}
}

func TestApplySubscriptionRejectsPeriodStartOverride(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	start := time.Now().Add(-24 * time.Hour)
	_, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: "trade:deal-period-start",
		UserID:         "user-1",
		PlanID:         "plan-pro",
		PeriodStart:    &start,
	})
	if err == nil {
		t.Fatal("expected period_start override to fail")
	}
	if len(fixture.createdPlanIDs) != 0 {
		t.Fatalf("subscription was created despite unsupported period_start: %+v", fixture.createdPlanIDs)
	}
}

func TestExtendSubscriptionMirrorsMultipleCtlRenewalTargetsExactly(t *testing.T) {
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
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}

	targets := []time.Time{
		time.Date(2027, 2, 28, 10, 0, 0, 0, time.UTC),
		time.Date(2027, 3, 28, 10, 0, 0, 0, time.UTC),
		time.Date(2027, 4, 28, 10, 0, 0, 0, time.UTC),
	}
	for i, target := range targets {
		got, err := svc.ExtendSubscription(t.Context(), ExtendSubscriptionRequest{
			UserID:       "user-1",
			NewPeriodEnd: target,
		})
		if err != nil {
			t.Fatalf("renewal %d returned error: %v", i+1, err)
		}
		if !got.Updated || got.Subscription == nil {
			t.Fatalf("renewal %d expected updated subscription, got %+v", i+1, got)
		}
		if got.Subscription.PeriodEnd != target.Format(time.RFC3339Nano) {
			t.Fatalf("renewal %d period_end = %s, want %s", i+1, got.Subscription.PeriodEnd, target.Format(time.RFC3339Nano))
		}
		if got.Subscription.TokenBalance != 400 {
			t.Fatalf("renewal %d token balance changed: got %d want live balance 400", i+1, got.Subscription.TokenBalance)
		}
	}

	retry, err := svc.ExtendSubscription(t.Context(), ExtendSubscriptionRequest{
		UserID:       "user-1",
		NewPeriodEnd: targets[len(targets)-1],
	})
	if err != nil {
		t.Fatal(err)
	}
	if retry.Updated {
		t.Fatalf("retrying final renewal target should be a no-op: %+v", retry)
	}
}

func TestRegisterPlanMappingPreservesExplicitInactiveStatus(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})

	if err := svc.RegisterPlanMapping(t.Context(), PlanMapping{
		ID:              "plan-disabled",
		Name:            "Disabled",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        false,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	plan, err := svc.GetPlanMapping(t.Context(), "plan-disabled")
	if err != nil {
		t.Fatal(err)
	}
	if plan.IsActive {
		t.Fatalf("inactive plan was forced active: %+v", plan)
	}
	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{IdempotencyKey: "trade:deal-disabled-plan", UserID: "user-1", PlanID: "plan-disabled"}); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("apply disabled plan err = %v, want ErrPlanNotFound", err)
	}
}

func TestRegisterPlanMappingRejectsMissingUpstreamPlanID(t *testing.T) {
	svc := NewService(NewMemoryStore(), nil, Options{})

	err := svc.RegisterPlanMapping(t.Context(), PlanMapping{
		ID:            "plan-bad",
		Name:          "Bad",
		MonthlyTokens: 1000,
		PeriodValue:   1,
		PeriodUnit:    "months",
		IsActive:      true,
	})
	if err == nil {
		t.Fatal("expected missing upstream plan id to fail")
	}
}

func TestExtendSubscriptionAlignsPeriodEndExactlyAndNoopsOnRetry(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}

	targetEnd := time.Unix(fixture.now+86400*40, 0).UTC()
	first, err := svc.ExtendSubscription(t.Context(), ExtendSubscriptionRequest{
		UserID:       "user-1",
		NewPeriodEnd: targetEnd,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Updated || first.Subscription == nil {
		t.Fatalf("expected first extend to update: %+v", first)
	}
	if first.Subscription.PeriodEnd != targetEnd.Format(time.RFC3339Nano) {
		t.Fatalf("period end = %s, want %s", first.Subscription.PeriodEnd, targetEnd.Format(time.RFC3339Nano))
	}
	if first.Subscription.TokenBalance != 400 {
		t.Fatalf("token balance changed on extend: got %d want 400", first.Subscription.TokenBalance)
	}
	if len(fixture.createdPlanIDs) != 0 {
		t.Fatalf("extend should not mint extra upstream subscription, created=%v", fixture.createdPlanIDs)
	}

	second, err := svc.ExtendSubscription(t.Context(), ExtendSubscriptionRequest{
		UserID:       "user-1",
		NewPeriodEnd: targetEnd,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.Updated {
		t.Fatalf("expected retry to be idempotent no-op: %+v", second)
	}
	if second.Subscription == nil || second.Subscription.PeriodEnd != targetEnd.Format(time.RFC3339Nano) {
		t.Fatalf("retry returned wrong subscription: %+v", second)
	}
	if len(fixture.createdPlanIDs) != 0 {
		t.Fatalf("created count after retry = %d, want 0", len(fixture.createdPlanIDs))
	}
}

func TestExtendSubscriptionCanMovePeriodEndBackwardForCtlRollbackAlignment(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}

	targetEnd := time.Unix(fixture.now+3600, 0).UTC()
	result, err := svc.ExtendSubscription(t.Context(), ExtendSubscriptionRequest{
		UserID:       "user-1",
		NewPeriodEnd: targetEnd,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Updated || result.Subscription == nil {
		t.Fatalf("expected backward alignment to update: %+v", result)
	}
	if result.Subscription.PeriodEnd != targetEnd.Format(time.RFC3339Nano) {
		t.Fatalf("period end = %s, want %s", result.Subscription.PeriodEnd, targetEnd.Format(time.RFC3339Nano))
	}
	if result.Subscription.TokenBalance != 400 {
		t.Fatalf("token balance changed on backward alignment: got %d want 400", result.Subscription.TokenBalance)
	}
	if len(fixture.createdPlanIDs) != 0 {
		t.Fatalf("created count = %d, want 0", len(fixture.createdPlanIDs))
	}
}

func TestGetActiveSubscriptionUsesNewAPIBalanceWithPeriodEndOverlay(t *testing.T) {
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
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}

	targetEnd := time.Unix(fixture.now+86400*40, 0).UTC()
	if _, err := svc.ExtendSubscription(t.Context(), ExtendSubscriptionRequest{
		UserID:       "user-1",
		NewPeriodEnd: targetEnd,
	}); err != nil {
		t.Fatal(err)
	}
	fixture.existingAmountUsed = 250

	sub, err := svc.GetActiveSubscription(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if sub.TokenBalance != 250 {
		t.Fatalf("token balance = %d, want live new-api balance 250", sub.TokenBalance)
	}
	if sub.PeriodEnd != targetEnd.Format(time.RFC3339Nano) {
		t.Fatalf("period end = %s, want overlay %s", sub.PeriodEnd, targetEnd.Format(time.RFC3339Nano))
	}
}

func TestGetActiveSubscriptionAggregatesMultipleActiveSubscriptions(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	fixture.createdPlanIDs = []int{7, 7}
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
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}

	sub, err := svc.GetActiveSubscription(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if sub.TokenBalance != 2400 {
		t.Fatalf("token balance = %d, want 2400", sub.TokenBalance)
	}
	wantEnd := time.Unix(fixture.now+86400*31, 0).UTC().Format(time.RFC3339Nano)
	if sub.PeriodEnd != wantEnd {
		t.Fatalf("period end = %s, want %s", sub.PeriodEnd, wantEnd)
	}
}

func TestGetActiveSubscriptionReturnsNotFoundWhenOnlyCancelledSubscriptionsExist(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	fixture.invalidated[3] = true
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

	if _, err := svc.GetActiveSubscription(t.Context(), "user-1"); !errors.Is(err, ErrSubscriptionNotFound) {
		t.Fatalf("err = %v, want ErrSubscriptionNotFound", err)
	}
}

func TestCancelSubscriptionInvalidatesAllActiveNewAPISubscriptions(t *testing.T) {
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
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}

	if err := svc.CancelSubscription(t.Context(), "user-1"); err != nil {
		t.Fatal(err)
	}
	if !fixture.invalidated[3] {
		t.Fatalf("active subscription was not invalidated: %+v", fixture.invalidated)
	}
}

func TestCancelSubscriptionMissingUserIsNoop(t *testing.T) {
	svc := NewService(NewMemoryStore(), nil, Options{})

	if err := svc.CancelSubscription(t.Context(), "missing-user"); err != nil {
		t.Fatal(err)
	}
}

func TestCancelSubscriptionEnsureOnlyUserIsNoop(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
	}); err != nil {
		t.Fatal(err)
	}

	if err := svc.CancelSubscription(t.Context(), "user-1"); err != nil {
		t.Fatal(err)
	}
}

type subscriptionFixture struct {
	server                           *httptest.Server
	now                              int64
	userCreated                      bool
	createdUsername                  string
	createdPassword                  string
	failCreateSubscription           bool
	failCreateResponseAfterCommit    bool
	createAttempts                   int
	existingAmountUsed               int64
	createdPlanIDs                   []int
	createdSubscriptionNames         []string
	createdRequestIDs                []string
	subscriptionByRequestID          map[string]int
	existingSubscriptionNames        map[int]string
	omitCreatedSubscriptionsFromList bool
	invalidated                      map[int]bool
}

func newSubscriptionFixture(t *testing.T) *subscriptionFixture {
	t.Helper()
	f := &subscriptionFixture{
		now:                       time.Now().UTC().Unix(),
		existingAmountUsed:        100,
		subscriptionByRequestID:   map[string]int{},
		existingSubscriptionNames: map[int]string{},
		invalidated:               map[int]bool{},
	}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/search":
			items := []map[string]any{}
			if f.userCreated {
				items = append(items, map[string]any{
					"id":           42,
					"username":     "sgw-user-1",
					"display_name": "sgw-user-1",
					"role":         1,
					"status":       1,
					"group":        "default",
				})
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/":
			var req newapi.CreateUserRequest
			decodeTestJSON(t, r, &req)
			f.userCreated = true
			f.createdUsername = req.Username
			f.createdPassword = req.Password
			writeTestJSON(t, w, map[string]any{"success": true})
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			var req newapi.LoginRequest
			decodeTestJSON(t, r, &req)
			if !f.userCreated || req.Username != f.createdUsername || req.Password != f.createdPassword {
				writeTestJSON(t, w, map[string]any{"success": false, "message": "用户名或密码错误"})
				return
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"id":       42,
				"username": req.Username,
				"role":     1,
				"status":   1,
				"group":    "default",
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/api/subscription/admin/users/42/subscriptions":
			subs := []map[string]any{{
				"subscription": map[string]any{
					"id":           3,
					"name":         f.existingSubscriptionNames[3],
					"user_id":      42,
					"plan_id":      7,
					"amount_total": 500,
					"amount_used":  f.existingAmountUsed,
					"start_time":   f.now - 60,
					"end_time":     f.now + 86400,
					"status":       statusForInvalidated(f.invalidated[3]),
				},
			}}
			for i, planID := range f.createdPlanIDs {
				if f.omitCreatedSubscriptionsFromList {
					continue
				}
				id := 10 + i
				name := ""
				if i < len(f.createdSubscriptionNames) {
					name = f.createdSubscriptionNames[i]
				}
				requestID := ""
				if i < len(f.createdRequestIDs) {
					requestID = f.createdRequestIDs[i]
				}
				subs = append(subs, map[string]any{
					"subscription": map[string]any{
						"id":           id,
						"name":         name,
						"request_id":   requestID,
						"user_id":      42,
						"plan_id":      planID,
						"amount_total": 1000,
						"amount_used":  0,
						"start_time":   f.now,
						"end_time":     f.now + 86400*31,
						"status":       statusForInvalidated(f.invalidated[id]),
					},
				})
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": subs})
		case r.Method == http.MethodPost && r.URL.Path == "/api/subscription/admin/users/42/subscriptions":
			f.createAttempts++
			if f.failCreateSubscription {
				http.Error(w, "create failed", http.StatusBadGateway)
				return
			}
			var req newapi.AdminCreateUserSubscriptionRequest
			decodeTestJSON(t, r, &req)
			subscriptionID, ok := f.subscriptionByRequestID[req.RequestID]
			if !ok {
				f.createdPlanIDs = append(f.createdPlanIDs, req.PlanID)
				f.createdSubscriptionNames = append(f.createdSubscriptionNames, req.Name)
				f.createdRequestIDs = append(f.createdRequestIDs, req.RequestID)
				subscriptionID = 9 + len(f.createdPlanIDs)
				f.subscriptionByRequestID[req.RequestID] = subscriptionID
			}
			if f.failCreateResponseAfterCommit && f.createAttempts == 1 {
				http.Error(w, "response lost after commit", http.StatusBadGateway)
				return
			}
			writeTestJSON(t, w, map[string]any{
				"success": true,
				"data": map[string]any{
					"id":           subscriptionID,
					"name":         req.Name,
					"request_id":   req.RequestID,
					"user_id":      42,
					"plan_id":      req.PlanID,
					"amount_total": 1000,
					"amount_used":  0,
					"start_time":   f.now,
					"end_time":     f.now + 86400*31,
					"status":       "active",
					"source":       "admin",
				},
			})
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/subscription/admin/user_subscriptions/") && strings.HasSuffix(r.URL.Path, "/invalidate"):
			parts := strings.Split(r.URL.Path, "/")
			id, err := strconv.Atoi(parts[len(parts)-2])
			if err != nil {
				t.Fatal(err)
			}
			f.invalidated[id] = true
			writeTestJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	return f
}

func (f *subscriptionFixture) registerBootstrappedSet(t *testing.T, svc *Service, store *MemoryStore) {
	t.Helper()
	f.registerBootstrappedSetWithID(t, svc, store, "set-a")
}

func (f *subscriptionFixture) registerBootstrappedSetWithID(t *testing.T, svc *Service, store *MemoryStore, setID string) {
	t.Helper()
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: setID, BaseURL: f.server.URL, Status: SetStatusActive}); err != nil {
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

func statusForInvalidated(invalidated bool) string {
	if invalidated {
		return "cancelled"
	}
	return "active"
}
