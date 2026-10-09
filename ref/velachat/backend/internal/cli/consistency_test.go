package cli

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"

	"chatserver/internal/config"
	"chatserver/internal/database"
)

func TestDatabaseConsistencyCLIRequiresExplicitPartitionScope(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"database", "check-consistency"}, &stdout, &stderr)
	if code != 2 || !strings.Contains(stderr.String(), "CONFIG_INVALID") {
		t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func TestDatabaseConsistencyCLIScansOneCleanServerPartition(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "chatserver.db")
	if _, stderr, code := runDatabaseCLI(t, "migrate", path); code != 0 {
		t.Fatalf("migrate code=%d stderr=%q", code, stderr)
	}
	const serverID = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	cfg, err := config.NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, err = handle.SQLDB().ExecContext(context.Background(), `
		INSERT INTO servers(
			id,slug,name,im_group_id,im_state,next_task_number,revision,created_at,updated_at
		) VALUES(?,?,?,?,'ready',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
	`, serverID, "clean-server", "Clean Server", "group-clean")
	if err == nil {
		_, err = handle.SQLDB().ExecContext(context.Background(), `
		INSERT INTO server_slug_registry(
			id,slug,server_id,state,created_at,updated_at
		) VALUES(?,?,?,'active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
		`, "registry-clean", "clean-server", serverID)
	}
	if err != nil {
		_ = handle.Close()
		t.Fatal(err)
	}
	if err := handle.Close(); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"database", "check-consistency",
		"--database", path,
		"--scope", "server",
		"--partition-key", serverID,
	}, &stdout, &stderr)
	if code != 0 || !strings.Contains(stdout.String(), `"issues":[]`) {
		t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if strings.Contains(stdout.String(), path) || strings.Contains(stderr.String(), path) {
		t.Fatal("一致性扫描泄漏数据库绝对路径")
	}
}
