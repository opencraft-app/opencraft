package migration

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepositoryMigrationReleaseLock(t *testing.T) {
	repositoryRoot := filepath.Join("..", "..", "..")
	lockPath := filepath.Join(repositoryRoot, "migrations", "released.lock.json")
	if err := VerifyReleaseLock(repositoryRoot, lockPath, ""); err != nil {
		t.Fatalf("验证 migration release lock：%v", err)
	}
}

func TestReleaseLockRejectsChangedMissingAndUnpromotedSQL(t *testing.T) {
	root, lockPath := releaseLockFixture(t)
	if err := VerifyReleaseLock(root, lockPath, ""); err != nil {
		t.Fatalf("fixture 初始校验：%v", err)
	}

	mustWrite(t, filepath.Join(root, "migrations", "001.sql"), "SELECT 2;\n")
	if err := VerifyReleaseLock(root, lockPath, ""); err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("修改 SQL 错误 = %v", err)
	}
	mustWrite(t, filepath.Join(root, "migrations", "001.sql"), "SELECT 1;\n")

	mustWrite(t, filepath.Join(root, "migrations", "002.sql"), "SELECT 2;\n")
	if err := VerifyReleaseLock(root, lockPath, ""); err == nil || !strings.Contains(err.Error(), "未进入 release lock") {
		t.Fatalf("未 promote SQL 错误 = %v", err)
	}
	if err := os.Remove(filepath.Join(root, "migrations", "002.sql")); err != nil {
		t.Fatal(err)
	}

	if err := os.Rename(filepath.Join(root, "migrations", "001.sql"), filepath.Join(root, "migrations", "renamed.sql")); err != nil {
		t.Fatal(err)
	}
	if err := VerifyReleaseLock(root, lockPath, ""); err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("改名 SQL 错误 = %v", err)
	}
}

func TestReleaseLockRejectsOldEntryRewriteAgainstTrustedBase(t *testing.T) {
	root, lockPath := releaseLockFixture(t)
	basePath := filepath.Join(t.TempDir(), "base.lock.json")
	base, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, basePath, string(base))
	mustWrite(t, filepath.Join(root, "migrations", "001.sql"), "SELECT 2;\n")
	if err := PromoteReleaseLock(root, lockPath); err != nil {
		t.Fatalf("模拟同一变更重写 lock：%v", err)
	}
	if err := VerifyReleaseLock(root, lockPath, basePath); err == nil ||
		!strings.Contains(err.Error(), "只能追加") {
		t.Fatalf("可信 base transition 错误 = %v", err)
	}
}

func TestReleaseLockRejectsDanglingIncludedBaseline(t *testing.T) {
	root, lockPath := releaseLockFixture(t)
	lock, err := readReleaseLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	lock.Entries[0].IncludedInBaseline = []string{"migrations/tdsql/missing.sql"}
	data, err := json.Marshal(lock)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, lockPath, string(data))
	if err := VerifyReleaseLock(root, lockPath, ""); err == nil || !strings.Contains(err.Error(), "未冻结 baseline") {
		t.Fatalf("dangling baseline error = %v", err)
	}
}

func releaseLockFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "migrations"), 0o700); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(root, "migrations", "001.sql"), "SELECT 1;\n")
	lockPath := filepath.Join(root, "migrations", "released.lock.json")
	if err := PromoteReleaseLock(root, lockPath); err != nil {
		t.Fatalf("生成 fixture lock：%v", err)
	}
	return root, lockPath
}

func mustWrite(t *testing.T, path, value string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
}
