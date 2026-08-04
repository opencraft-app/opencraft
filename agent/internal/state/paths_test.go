package state

import (
	"path/filepath"
	"testing"
)

func TestDefaultRootUsesVelaStateDirectory(t *testing.T) {
	t.Parallel()

	home := filepath.Join(string(filepath.Separator), "Users", "example")
	got := DefaultRoot(home)
	want := filepath.Join(home, ".vela", "state")
	if got != want {
		t.Fatalf("DefaultRoot() = %q, want %q", got, want)
	}
	if got == filepath.Join(home, ".slock") {
		t.Fatal("DefaultRoot() must not use the official .slock directory")
	}
}
