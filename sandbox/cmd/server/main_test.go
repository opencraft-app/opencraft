package main

import (
	"strings"
	"testing"
)

func TestMySQLDSNFromEnvPrefersExplicitDSN(t *testing.T) {
	t.Setenv("MYSQL_DSN", "root:pass@tcp(db:3306)/cvm?parseTime=true")
	t.Setenv("MYSQL_HOST", "ignored-host")
	t.Setenv("MYSQL_USER", "ignored-user")
	t.Setenv("MYSQL_PASSWORD", "ignored-pass")
	t.Setenv("MYSQL_DB", "ignored-db")

	got := mysqlDSNFromEnv()
	if !strings.Contains(got, "root:pass@tcp(db:3306)/cvm") || !strings.Contains(got, "parseTime=true") || !strings.Contains(got, "time_zone=") {
		t.Fatalf("expected normalized explicit dsn, got %q", got)
	}
}

func TestMySQLDSNFromEnvBuildsFromPieces(t *testing.T) {
	t.Setenv("MYSQL_DSN", "")
	t.Setenv("MYSQL_HOST", "10.0.0.4")
	t.Setenv("MYSQL_PORT", "3307")
	t.Setenv("MYSQL_USER", "root")
	t.Setenv("MYSQL_PASSWORD", "secret")
	t.Setenv("MYSQL_DB", "cvm")

	if got := mysqlDSNFromEnv(); !strings.Contains(got, "root:secret@tcp(10.0.0.4:3307)/cvm") || !strings.Contains(got, "parseTime=true") || !strings.Contains(got, "time_zone=") {
		t.Fatalf("unexpected dsn %q", got)
	}
}

func TestMySQLDSNFromEnvReturnsEmptyWhenConfigIncomplete(t *testing.T) {
	t.Setenv("MYSQL_DSN", "")
	t.Setenv("MYSQL_HOST", "10.0.0.4")
	t.Setenv("MYSQL_USER", "")
	t.Setenv("MYSQL_PASSWORD", "secret")
	t.Setenv("MYSQL_DB", "cvm")

	if got := mysqlDSNFromEnv(); got != "" {
		t.Fatalf("expected empty dsn, got %q", got)
	}
}
