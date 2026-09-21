package selfupdate

import (
	"path/filepath"
	"testing"
)

func TestParseApplyCommandRequiresFixedHiddenSurface(t *testing.T) {
	t.Parallel()
	stateRoot := filepath.Join(t.TempDir(), "computer", "state")
	config, err := parseApplyCommand([]string{
		"apply", "--state-dir", stateRoot,
		"--transaction-id", "0198d444-0000-7000-8000-000000000005",
		"--parent-pid", "4321",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.StateRoot != stateRoot || config.InstallationRoot != filepath.Dir(stateRoot) ||
		config.TransactionID != "0198d444-0000-7000-8000-000000000005" || config.ParentPID != 4321 {
		t.Fatalf("config = %#v", config)
	}
	if _, err := parseApplyCommand([]string{
		"apply", "--state-dir", "relative", "--transaction-id", config.TransactionID,
		"--parent-pid", "4321",
	}); err == nil {
		t.Fatal("relative state root was accepted")
	}
}
