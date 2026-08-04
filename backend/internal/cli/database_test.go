package cli

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"chatserver/internal/apperror"
	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/platform"
)

func TestDatabaseCLI参数错误使用稳定退出码和中文提示(t *testing.T) {
	var stdout, stderr bytes.Buffer

	exitCode := Run(context.Background(), []string{"database", "unknown"}, &stdout, &stderr)

	if exitCode != 2 {
		t.Fatalf("退出码 = %d，期望 2", exitCode)
	}
	if !strings.Contains(stderr.String(), "用法") || !strings.Contains(stderr.String(), "migrate") {
		t.Fatalf("错误输出没有中文用法：%q", stderr.String())
	}
	if stdout.Len() != 0 {
		t.Fatalf("参数错误不应写 stdout：%q", stdout.String())
	}
}

func TestDatabaseCLI迁移状态和校验闭环(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "chatserver.db")

	migrateOut, migrateErr, code := runDatabaseCLI(t, "migrate", path)
	if code != 0 {
		t.Fatalf("migrate 退出码 = %d；stdout=%q stderr=%q", code, migrateOut, migrateErr)
	}
	if !strings.Contains(migrateOut, "迁移完成") {
		t.Fatalf("migrate 输出 = %q", migrateOut)
	}

	statusOut, statusErr, code := runDatabaseCLI(t, "status", path)
	if code != 0 {
		t.Fatalf("status 退出码 = %d；stdout=%q stderr=%q", code, statusOut, statusErr)
	}
	for _, want := range []string{"当前版本", "最新版本", "待执行：0", "校验和：正常"} {
		if !strings.Contains(statusOut, want) {
			t.Fatalf("status 输出缺少 %q：%q", want, statusOut)
		}
	}

	verifyOut, verifyErr, code := runDatabaseCLI(t, "verify", path)
	if code != 0 {
		t.Fatalf("verify 退出码 = %d；stdout=%q stderr=%q", code, verifyOut, verifyErr)
	}
	if !strings.Contains(verifyOut, "校验通过") {
		t.Fatalf("verify 输出 = %q", verifyOut)
	}

	for _, output := range []string{migrateOut, migrateErr, statusOut, statusErr, verifyOut, verifyErr} {
		if strings.Contains(output, path) || strings.Contains(output, filepath.Dir(path)) {
			t.Fatalf("CLI 输出泄漏绝对数据库路径：%q", output)
		}
	}
}

func TestDatabaseCLIMigrate在Writer持锁时失败(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "chatserver.db")
	cfg, err := config.NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()

	var stdout, stderr bytes.Buffer
	exitCode := Run(context.Background(), []string{
		"database", "migrate",
		"--database", path,
		"--lock-timeout", "25ms",
	}, &stdout, &stderr)

	if exitCode != 3 {
		t.Fatalf("退出码 = %d，期望 3；stderr=%q", exitCode, stderr.String())
	}
	if !strings.Contains(stderr.String(), "DATABASE_IN_USE") ||
		!strings.Contains(stderr.String(), "数据库正在被另一个服务进程使用") {
		t.Fatalf("锁冲突错误输出 = %q", stderr.String())
	}
	if strings.Contains(stderr.String(), path) {
		t.Fatalf("锁冲突错误泄漏路径：%q", stderr.String())
	}
}

func TestDatabaseCLIStatus和Verify不写入空数据库(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "chatserver.db")
	cfg, err := config.NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	statusOut, statusErr, code := runDatabaseCLI(t, "status", path)
	if code != 0 || !strings.Contains(statusOut, "待执行：") ||
		strings.Contains(statusOut, "待执行：0") {
		t.Fatalf("status 结果：code=%d stdout=%q stderr=%q", code, statusOut, statusErr)
	}
	_, verifyErr, code := runDatabaseCLI(t, "verify", path)
	if code != 1 || !strings.Contains(verifyErr, "DATABASE_MIGRATION_REQUIRED") {
		t.Fatalf("verify 结果：code=%d stderr=%q", code, verifyErr)
	}

	reader, err := database.OpenReadOnly(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var tables int
	if err := reader.SQLDB().QueryRow(`
		SELECT COUNT(*) FROM sqlite_schema
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
	`).Scan(&tables); err != nil {
		t.Fatal(err)
	}
	if tables != 0 {
		t.Fatalf("status/verify 在空数据库写入了 %d 张表", tables)
	}
}

func TestMigrationStateError使用稳定错误矩阵(t *testing.T) {
	tests := []struct {
		state platform.MigrationState
		code  string
	}{
		{state: platform.MigrationState{Kind: platform.MigrationStateClean}},
		{state: platform.MigrationState{Kind: platform.MigrationStateEmpty}, code: "DATABASE_MIGRATION_REQUIRED"},
		{state: platform.MigrationState{Kind: platform.MigrationStatePending}, code: "DATABASE_MIGRATION_UNSAFE"},
		{state: platform.MigrationState{Kind: platform.MigrationStateDirty}, code: "DATABASE_MIGRATION_UNSAFE"},
		{
			state: platform.MigrationState{Kind: platform.MigrationStateUnsafe, Reason: "not_empty"},
			code:  "DATABASE_NOT_EMPTY",
		},
		{state: platform.MigrationState{Kind: platform.MigrationStateUnsafe}, code: "DATABASE_MIGRATION_UNSAFE"},
	}
	for _, tt := range tests {
		err := migrationStateError(tt.state)
		if code := apperror.CodeOf(err); code != tt.code {
			t.Fatalf("state=%#v error code=%q，期望 %q", tt.state, code, tt.code)
		}
	}
}

func TestDatabaseCLI拒绝非法Duration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "chatserver.db")
	var stdout, stderr bytes.Buffer

	exitCode := Run(context.Background(), []string{
		"database", "migrate",
		"--database", path,
		"--busy-timeout", "forever",
	}, &stdout, &stderr)

	if exitCode != 2 || !strings.Contains(stderr.String(), "CONFIG_INVALID") {
		t.Fatalf("非法 duration：code=%d stderr=%q", exitCode, stderr.String())
	}
}

func TestParseDatabaseConfig支持显式TDSQLDSN文件(t *testing.T) {
	dsnFile := filepath.Join(t.TempDir(), "mysql.dsn")
	cfg, err := parseDatabaseConfig("migrate", []string{
		"--database-driver", "tdsql",
		"--database-dsn-file", dsnFile,
	})
	if err != nil {
		t.Fatalf("parseDatabaseConfig() error = %v", err)
	}
	if cfg.Driver != config.DatabaseDriverTDSQL || cfg.DSNFile != dsnFile {
		t.Fatalf("TDSQL config = %#v", cfg)
	}
}

func TestParseDatabaseConfig拒绝旧MySQL方言(t *testing.T) {
	_, err := parseDatabaseConfig("migrate", []string{"--database-driver", "mysql"})
	if code := apperror.CodeOf(err); code != "CONFIG_INVALID" {
		t.Fatalf("错误码 = %q，期望 CONFIG_INVALID；err=%v", code, err)
	}
}

func TestParseDatabaseConfig拒绝未知方言(t *testing.T) {
	_, err := parseDatabaseConfig("migrate", []string{
		"--database-driver", "oracle",
	})
	if code := apperror.CodeOf(err); code != "CONFIG_INVALID" {
		t.Fatalf("错误码 = %q，期望 CONFIG_INVALID；err=%v", code, err)
	}
}

func runDatabaseCLI(t *testing.T, action, path string) (string, string, int) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	exitCode := Run(context.Background(), []string{
		"database", action,
		"--database", path,
		"--busy-timeout", (5 * time.Second).String(),
	}, &stdout, &stderr)
	return stdout.String(), stderr.String(), exitCode
}
