package main

import (
	"testing"

	dbmysql "github.com/go-sql-driver/mysql"
)

func TestMigrationDSNEnablesMultiStatements(t *testing.T) {
	dsn, err := migrationDSN("ticket:password@tcp(127.0.0.1:3306)/lightvela_ticket?parseTime=true")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := dbmysql.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.MultiStatements || !cfg.ParseTime || cfg.DBName != "lightvela_ticket" {
		t.Fatalf("migration DSN lost required options: multiStatements=%v parseTime=%v db=%q", cfg.MultiStatements, cfg.ParseTime, cfg.DBName)
	}
}

func TestMigrationDSNFromEnv(t *testing.T) {
	t.Setenv("TICKET_MYSQL_DSN", "")
	t.Setenv("TICKET_DB_USER", "ticket")
	t.Setenv("TICKET_DB_PASSWORD", "test-password")
	t.Setenv("MYSQL_HOST", "mysql.internal")
	t.Setenv("MYSQL_PORT", "3306")
	t.Setenv("TICKET_DB", "lightvela_ticket")
	dsn, err := migrationDSNFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := dbmysql.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.User != "ticket" || cfg.DBName != "lightvela_ticket" || cfg.Addr != "mysql.internal:3306" || !cfg.MultiStatements {
		t.Fatalf("unexpected migration config: user=%q db=%q addr=%q multi=%v", cfg.User, cfg.DBName, cfg.Addr, cfg.MultiStatements)
	}
}

func TestMigrationDSNFromEnvRejectsIncompleteConfig(t *testing.T) {
	t.Setenv("TICKET_MYSQL_DSN", "")
	t.Setenv("TICKET_DB_PASSWORD", "")
	if _, err := migrationDSNFromEnv(); err == nil {
		t.Fatal("expected missing DB password error")
	}
}
