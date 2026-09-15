package mysqlmigrations

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPublishedSourcesGenerateBoundImmutableMySQLArtifacts(t *testing.T) {
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	if err := Publish(root, target); err != nil {
		t.Fatal(err)
	}
	if err := Verify(root, target); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(target, "20260801000000_baseline.sql")
	if err := os.WriteFile(path, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Publish(root, target); err == nil {
		t.Fatal("overwriting published SQL accepted")
	}
}
