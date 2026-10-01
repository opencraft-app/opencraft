package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReconcileStoreRemovesOnlyAbandonedTemporaryDirectories(t *testing.T) {
	root := t.TempDir()
	transient := []string{".startup-probe-123", "ws-owner/.preparing-456"}
	preserved := []string{"ws-owner/wr-active", "ws-owner/wr-rollback", ".startup-probe-not-owned", "ws-owner/.preparing-not-owned"}
	for _, rel := range append(transient, preserved...) {
		dir := filepath.Join(root, rel)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "app.mjs"), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := reconcileStore(root); err != nil {
		t.Fatal(err)
	}
	for _, rel := range transient {
		if _, err := os.Stat(filepath.Join(root, rel)); !os.IsNotExist(err) {
			t.Fatalf("temporary directory remains: %s", rel)
		}
	}
	for _, rel := range preserved {
		if _, err := os.Stat(filepath.Join(root, rel, "app.mjs")); err != nil {
			t.Fatalf("unrelated release changed: %s", rel)
		}
	}
}
func TestReconcileStoreDoesNotFollowSymlinks(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	victim := filepath.Join(outside, ".preparing-123")
	if err := os.Mkdir(victim, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "ws-link")); err != nil {
		t.Fatal(err)
	}
	if err := reconcileStore(root); err == nil {
		t.Fatal("unexpected store symlink must fail closed")
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatal("followed external symlink")
	}
}
