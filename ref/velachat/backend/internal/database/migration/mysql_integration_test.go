package migration_test

import (
	"context"
	"os"
	"testing"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
)

func TestTDSQLMigration真实数据库闭环(t *testing.T) {
	dsnFile := os.Getenv("CHATSERVER_TEST_TDSQL_DSN_FILE")
	if dsnFile == "" {
		t.Skip("未设置 CHATSERVER_TEST_TDSQL_DSN_FILE")
	}
	cfg, err := config.NewTDSQLDatabase(dsnFile)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	if err := migration.ApplyFor(context.Background(), handle.SQLDB(), config.DatabaseDriverTDSQL); err != nil {
		t.Fatalf("首次 ApplyFor(tdsql) error = %v", err)
	}
	if err := migration.ApplyFor(context.Background(), handle.SQLDB(), config.DatabaseDriverTDSQL); err != nil {
		t.Fatalf("幂等 ApplyFor(tdsql) error = %v", err)
	}
	status, err := migration.StatusFor(context.Background(), handle.SQLDB(), config.DatabaseDriverTDSQL)
	if err != nil {
		t.Fatal(err)
	}
	if status.Pending != 0 || status.Applied != 1 || status.CurrentVersion == "" {
		t.Fatalf("TDSQL migration status = %#v", status)
	}
	var businessTables int
	if err := handle.SQLDB().QueryRowContext(context.Background(), `
		SELECT COUNT(*) FROM information_schema.tables
		WHERE table_schema = DATABASE()
		  AND table_name <> 'atlas_schema_revisions'
	`).Scan(&businessTables); err != nil {
		t.Fatal(err)
	}
	if businessTables != 25 {
		t.Fatalf("业务表数量 = %d，期望 25", businessTables)
	}
}
