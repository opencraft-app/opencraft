package migration

import (
	"context"
	"testing"

	"chatserver/internal/apperror"
)

func TestStatus不修改空数据库并报告全部Pending(t *testing.T) {
	handle := openTestDatabase(t)
	defer handle.Close()
	if tableExists(t, handle, revisionTable) {
		t.Fatal("测试前不应存在 revision 表")
	}

	status, err := Status(context.Background(), handle)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if status.CurrentVersion != "" || status.LatestVersion == "" ||
		status.Pending != sqliteMigrationCount(t) || !status.ChecksumValid ||
		status.Kind != StateEmpty {
		t.Fatalf("Status() = %#v", status)
	}
	if tableExists(t, handle, revisionTable) {
		t.Fatal("Status() 修改了空数据库")
	}
}

func TestSQLite已发布Baseline身份不可改写(t *testing.T) {
	dir, err := embeddedDirFor("sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	checksums, err := dir.Checksum()
	if err != nil {
		t.Fatal(err)
	}
	hash, err := checksums.SumByName("20260730040159_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	if hash != "va9A487WcrBqc/OmVLdwyxdgZO9bsk8Zc129H6r7cwE=" {
		t.Fatalf("SQLite published baseline hash = %q", hash)
	}
}

func TestStatus在迁移后报告最新版本(t *testing.T) {
	handle := openTestDatabase(t)
	defer handle.Close()
	if err := Apply(context.Background(), handle); err != nil {
		t.Fatal(err)
	}

	status, err := Status(context.Background(), handle)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if status.CurrentVersion != status.LatestVersion || status.Pending != 0 ||
		status.Applied != sqliteMigrationCount(t) || status.Kind != StateClean {
		t.Fatalf("Status() = %#v", status)
	}
}

func TestStatus拒绝数据库Revision哈希漂移(t *testing.T) {
	handle := openTestDatabase(t)
	defer handle.Close()
	if err := Apply(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(
		`UPDATE atlas_schema_revisions SET hash = ?`,
		"tampered-revision-hash",
	); err != nil {
		t.Fatal(err)
	}

	_, err := Status(context.Background(), handle)
	if code := apperror.CodeOf(err); code != "MIGRATION_CHECKSUM_MISMATCH" {
		t.Fatalf("错误码 = %q，期望 MIGRATION_CHECKSUM_MISMATCH；err=%v", code, err)
	}
}
