package policy

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func waitForWorkspaceChange(t *testing.T, watch *workspaceWatch, expected string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if paths := watch.drain(); slices.Contains(paths, expected) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("workspace watch did not report %s", expected)
}

func TestWorkspaceWatchReportsRecursiveExternalChanges(t *testing.T) {
	mount := t.TempDir()
	repository := filepath.Join(mount, "@main", "projects", "repo")
	if err := os.MkdirAll(repository, 0o755); err != nil {
		t.Fatal(err)
	}
	watch, err := newWorkspaceWatch("/workspace/@main/projects/repo", mount, func() {})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(watch.Close)

	readme := filepath.Join(repository, "README.md")
	if err := os.WriteFile(readme, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForWorkspaceChange(t, watch, "/workspace/@main/projects/repo/README.md")

	nested := filepath.Join(repository, "src")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "index.js"), []byte("export {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForWorkspaceChange(t, watch, "/workspace/@main/projects/repo/src/index.js")
}

func TestWorkspaceWatchFollowsInitiallyMissingPath(t *testing.T) {
	mount := t.TempDir()
	projects := filepath.Join(mount, "@main", "projects")
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatal(err)
	}
	watch, err := newWorkspaceWatch("/workspace/@main/projects/future", mount, func() {})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(watch.Close)

	future := filepath.Join(projects, "future")
	if err := os.Mkdir(future, 0o755); err != nil {
		t.Fatal(err)
	}
	waitForWorkspaceChange(t, watch, "/workspace/@main/projects/future")
	if err := os.WriteFile(filepath.Join(future, "created.txt"), []byte("created"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForWorkspaceChange(t, watch, "/workspace/@main/projects/future/created.txt")
}
