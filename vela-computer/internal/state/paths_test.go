package state

import (
	"path/filepath"
	"testing"
)

func TestDefaultRootUsesVelaStateDirectory(t *testing.T) {
	t.Parallel()

	home := filepath.Join(string(filepath.Separator), "Users", "example")
	got := DefaultRoot(home)
	want := filepath.Join(home, ".vela", "computer", "state")
	if got != want {
		t.Fatalf("DefaultRoot() = %q, want %q", got, want)
	}
}
