package gateway

import (
	"testing"
	"time"
)

func TestGetUserStateReadsCurrentPlanFromNewAPIActiveSubscription(t *testing.T) {
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
	if _, err := svc.SetUserAssignment(t.Context(), UserAssignment{
		ExternalUserID: "user-1",
		Backend:        UserBackendNew,
		SetID:          "set-a",
	}); err != nil {
		t.Fatal(err)
	}

	state, err := svc.GetUserState(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if state.UserID != "user-1" || state.Backend != UserBackendNew || state.SetID != "set-a" || state.UpstreamUserID != 42 {
		t.Fatalf("unexpected state identity: %+v", state)
	}
	if !state.HasActiveSubscription || state.CurrentPlanID != "plan-pro" || state.LastAppliedPlanID != "plan-pro" {
		t.Fatalf("unexpected plan state: %+v", state)
	}
	if state.CreditAvailable != 400 || state.TokenBalance != 400 || state.SubscriptionStatus != "active" || state.Source != "new-api" {
		t.Fatalf("unexpected subscription state: %+v", state)
	}
}

func TestGetUserStateReturnsPendingWithoutExternalCreditBackend(t *testing.T) {
	svc := NewService(NewMemoryStore(), nil, Options{})

	state, err := svc.GetUserState(t.Context(), "user-old")
	if err != nil {
		t.Fatal(err)
	}
	if state.UserID != "user-old" || state.Backend != UserBackendPending || state.Source != "pending" {
		t.Fatalf("unexpected pending state: %+v", state)
	}
	if state.HasActiveSubscription || state.CurrentPlanID != "" || state.CreditStatus != "unavailable" {
		t.Fatalf("pending state must not expose subscription credit: %+v", state)
	}
}

func TestObserveTenantPersistsProjectionFromCurrentUserState(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	svc.now = func() time.Time {
		return time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)
	}
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
	if _, err := svc.SetUserAssignment(t.Context(), UserAssignment{
		ExternalUserID: "user-1",
		Backend:        UserBackendNew,
		SetID:          "set-a",
	}); err != nil {
		t.Fatal(err)
	}

	observation, err := svc.ObserveTenant(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if observation.ExternalUserID != "user-1" ||
		observation.CurrentPlanID != "plan-pro" ||
		observation.CreditAvailable != 400 ||
		observation.CreditStatus != "ok" ||
		!observation.ObservedAt.Equal(time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("unexpected observation: %+v", observation)
	}
	if observation.CreatedAt.IsZero() || observation.UpdatedAt.IsZero() {
		t.Fatalf("returned observation should include persisted timestamps: %+v", observation)
	}
	saved, ok, err := store.GetTenantObservation(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("observation was not saved: ok=%v err=%v", ok, err)
	}
	if saved.CurrentPlanID != "plan-pro" || saved.CreditAvailable != 400 {
		t.Fatalf("saved observation mismatch: %+v", saved)
	}
}

func TestObserveTenantPreservesDisabledTenantStatus(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-disabled",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-user-disabled",
		Password:       "user-pass-123",
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-disabled",
		Backend:        UserBackendNew,
		SetID:          "set-a",
		Status:         TenantStatusDisabled,
		Source:         "operator",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ObserveTenant(t.Context(), "user-disabled"); err != nil {
		t.Fatal(err)
	}
	tenant, ok, err := store.GetTenant(t.Context(), "user-disabled")
	if err != nil || !ok {
		t.Fatalf("get tenant: ok=%v err=%v", ok, err)
	}
	if tenant.Status != TenantStatusDisabled {
		t.Fatalf("observer changed disabled tenant status: %+v", tenant)
	}
}
