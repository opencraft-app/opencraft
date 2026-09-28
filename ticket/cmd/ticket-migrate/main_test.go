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
