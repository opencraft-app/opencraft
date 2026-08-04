package state

import (
	"path/filepath"
	"testing"
	"time"
)

func TestUserSessionRoundTrip(t *testing.T) {
	t.Parallel()

	store := New(filepath.Join(t.TempDir(), "state"))
	want := UserSession{
		SchemaVersion: 1,
		ServerURL:     "https://api.example.invalid",
		AccessToken:   "access_test",
		RefreshToken:  "refresh_test",
		UserID:        "user_test",
		UpdatedAt:     time.Unix(1_700_000_000, 0).UTC(),
	}
	if err := store.SaveUserSession(want); err != nil {
		t.Fatalf("SaveUserSession() error = %v", err)
	}
	got, err := store.LoadUserSession()
	if err != nil {
		t.Fatalf("LoadUserSession() error = %v", err)
	}
	if got != want {
		t.Fatalf("LoadUserSession() = %#v, want %#v", got, want)
	}
}

func TestRunnerStateListsAttachedServers(t *testing.T) {
	t.Parallel()

	store := New(filepath.Join(t.TempDir(), "state"))
	want := RunnerState{
		SchemaVersion:   1,
		ServerID:        "server_test",
		ServerSlug:      "/mono2",
		ServerURL:       "https://api.example.invalid",
		ServerMachineID: "computer_test",
		MachineID:       "machine_test",
		APIKey:          "sk_computer_test",
	}
	if err := store.SaveRunnerState(want); err != nil {
		t.Fatalf("SaveRunnerState() error = %v", err)
	}
	got, err := store.ListRunnerStates()
	if err != nil {
		t.Fatalf("ListRunnerStates() error = %v", err)
	}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("ListRunnerStates() = %#v, want %#v", got, []RunnerState{want})
	}
}

func TestRunnerStateRejectsDotSegmentServerIdentity(t *testing.T) {
	t.Parallel()

	store := New(t.TempDir())
	for _, serverID := range []string{".", "..", "../outside"} {
		if err := store.SaveRunnerState(RunnerState{ServerID: serverID}); err == nil {
			t.Fatalf("SaveRunnerState(%q) error = nil", serverID)
		}
	}
}
