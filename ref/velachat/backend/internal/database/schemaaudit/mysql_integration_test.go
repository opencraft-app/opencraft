package schemaaudit_test

import (
	"context"
	"os"
	"testing"

	"chatserver/internal/apperror"
	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/schemaaudit"
)

func TestVerifyTDSQL接受正式Baseline并发现索引漂移(t *testing.T) {
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
	if err := schemaaudit.VerifyTDSQL(context.Background(), handle.SQLDB()); err != nil {
		t.Fatalf("VerifyTDSQL() error = %v", err)
	}
	var indexName string
	if err := handle.SQLDB().QueryRowContext(context.Background(), `
		SELECT index_name FROM information_schema.statistics
		WHERE table_schema = DATABASE() AND table_name = 'agents'
		  AND column_name = 'desired_state'
		LIMIT 1
	`).Scan(&indexName); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.SQLDB().ExecContext(
		context.Background(),
		"DROP INDEX `"+indexName+"` ON `agents`",
	); err != nil {
		t.Fatal(err)
	}
	if err := schemaaudit.VerifyTDSQL(context.Background(), handle.SQLDB()); apperror.CodeOf(err) != "DATABASE_SCHEMA_MISMATCH" {
		t.Fatalf("索引漂移错误 = %v", err)
	}
}
