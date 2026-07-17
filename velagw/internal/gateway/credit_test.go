package gateway

import (
	"errors"
	"testing"
	"time"
)

func TestGetUserCreditRejectsPendingTenant(t *testing.T) {
	svc := NewService(NewMemoryStore(), nil, Options{})

	if _, err := svc.GetUserCredit(t.Context(), "user-1"); !errors.Is(err, ErrTenantPending) {
		t.Fatalf("error = %v, want ErrTenantPending", err)
	}
}

func TestGetUserCreditRoutesNewAssignmentToNewAPI(t *testing.T) {
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
		MigratedAt:     time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	credit, err := svc.GetUserCredit(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if credit.UserID != "user-1" || credit.Backend != UserBackendNew || credit.SetID != "set-a" || credit.PlanID != "plan-pro" {
		t.Fatalf("unexpected new credit identity: %+v", credit)
	}
	if credit.TokenBalance != 400 {
		t.Fatalf("token balance = %d, want 400", credit.TokenBalance)
	}
	if credit.Source != "new-api" {
		t.Fatalf("source = %q, want new-api", credit.Source)
	}
}
