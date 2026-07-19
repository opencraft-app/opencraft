package gateway

import "testing"

func TestEnsureUserBindingRejectsExplicitAssignmentToFullSet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyServiceSet(t, store, "set-a")
	set, _, err := store.GetSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	set.MaxUsers = 1
	set.ObservedUserCount = 1
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetUserAssignment(t.Context(), UserAssignment{
		ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EnsureUserBinding(t.Context(), "user-1"); err == nil {
		t.Fatal("explicit assignment unexpectedly bypassed Set capacity")
	}
}
