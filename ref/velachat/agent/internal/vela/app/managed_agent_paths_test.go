package app

import (
	"path/filepath"
	"testing"
)

func TestManagedAgentWorkspaceIsSiblingOfStateRoot(t *testing.T) {
	t.Parallel()

	velaRoot := filepath.Join(string(filepath.Separator), "Users", "example", ".vela")
	factory := &managedAgentFactory{root: filepath.Join(velaRoot, "computer", "state")}

	got, err := factory.workspaceDirectory("019fcafe-15a6-7494-9da6-0f69a8e60c24")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(
		velaRoot,
		"workspaces",
		"019fcafe-15a6-7494-9da6-0f69a8e60c24",
	)
	if got != want {
		t.Fatalf("workspaceDirectory() = %q, want %q", got, want)
	}
}

func TestManagedAgentWorkspaceRejectsUnsafeAgentID(t *testing.T) {
	t.Parallel()

	factory := &managedAgentFactory{root: filepath.Join(t.TempDir(), "state")}
	if _, err := factory.workspaceDirectory("../outside"); err == nil {
		t.Fatal("workspaceDirectory() accepted an unsafe Agent ID")
	}
}

func TestManagedAgentWorkspaceStaysScopedForArbitraryStateRoot(t *testing.T) {
	t.Parallel()

	stateRoot := t.TempDir()
	factory := &managedAgentFactory{root: stateRoot}
	got, err := factory.workspaceDirectory("agent-safe")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(stateRoot, "workspaces", "agent-safe"); got != want {
		t.Fatalf("workspaceDirectory() = %q, want %q", got, want)
	}
}
