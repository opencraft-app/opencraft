package openapirelease

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPromoteIsImmutableAndIdempotent(t *testing.T) {
	root := t.TempDir()
	write := func(relative, content string) {
		path := filepath.Join(root, relative)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("platform/v1/openapi.yaml", "openapi: 3.0.3\ninfo:\n  version: 1.0.0\n")
	write("platform/v1/computer-bootstrap.openapi.yaml", "openapi: 3.0.3\ninfo:\n  version: 1.0.0\n")
	write("platform/v1/computer-update.openapi.yaml", "openapi: 3.0.3\ninfo:\n  version: 1.0.0\n")
	if err := Promote(root, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := PromoteComputerUpdate(root, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	updateRelease := filepath.Join(
		root,
		"platform/v1/releases/1.0.0.computer-update.openapi.yaml",
	)
	if _, err := os.Stat(updateRelease); err != nil {
		t.Fatalf("Computer Update release missing: %v", err)
	}
	if err := Promote(root, "1.0.0"); err != nil {
		t.Fatalf("重复 promote 不幂等: %v", err)
	}
	released := filepath.Join(root, "platform/v1/releases/1.0.0.openapi.yaml")
	if err := os.WriteFile(released, []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyRoot(root); err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("改写 release 未被拒绝: %v", err)
	}
}

func TestTrustedBaseRejectsRewrittenSnapshotAndLock(t *testing.T) {
	root := t.TempDir()
	write := func(relative, content string) {
		path := filepath.Join(root, relative)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("platform/v1/openapi.yaml", "openapi: 3.0.3\ninfo:\n  version: 1.0.0\n")
	write("platform/v1/computer-bootstrap.openapi.yaml", "openapi: 3.0.3\ninfo:\n  version: 1.0.0\n")
	write("platform/v1/computer-update.openapi.yaml", "openapi: 3.0.3\ninfo:\n  version: 1.0.0\n")
	if err := Promote(root, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	basePath := filepath.Join(t.TempDir(), "trusted.lock.json")
	lockData, err := os.ReadFile(filepath.Join(root, lockRelativePath))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(basePath, lockData, 0o600); err != nil {
		t.Fatal(err)
	}
	write("platform/v1/openapi.yaml", "openapi: 3.0.3\ninfo:\n  version: 1.0.0\ndescription: rewritten\n")
	if err := os.Remove(filepath.Join(root, "platform/v1/releases/1.0.0.openapi.yaml")); err != nil {
		t.Fatal(err)
	}
	var lock lockFile
	if err := json.Unmarshal(lockData, &lock); err != nil {
		t.Fatal(err)
	}
	delete(lock.Files, "platform/v1/releases/1.0.0.openapi.yaml")
	rewrittenLock, err := json.Marshal(lock)
	if err != nil {
		t.Fatal(err)
	}
	write(lockRelativePath, string(rewrittenLock))
	if err := Promote(root, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := VerifyTrustedBase(root, basePath); err == nil || !strings.Contains(err.Error(), "只能追加") {
		t.Fatalf("同时改写 snapshot 与 lock 未被可信 base 拒绝: %v", err)
	}
}
