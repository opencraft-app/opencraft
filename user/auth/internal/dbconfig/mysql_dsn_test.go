package dbconfig

import (
	"strings"
	"testing"

	"github.com/go-sql-driver/mysql"
)

func TestResolveMySQLDSNPrefersStructuredConfig(t *testing.T) {
	t.Setenv("MYSQL_HOST", "mysql.lightvela-playground-sandbox-bj-7.svc.cluster.local")
	t.Setenv("MYSQL_PORT", "3306")
	t.Setenv("LIGHTCLAW_AUTH_DB_USER", "lightclaw_auth")
	t.Setenv("LIGHTCLAW_AUTH_DB_PASSWORD", "secret!pass")
	t.Setenv("LIGHTCLAW_AUTH_DB", "lightclaw_auth_sandbox_bj_7")
	t.Setenv("LIGHTCLAW_MYSQL_DSN", "legacy:pass@tcp(10.31.192.4:3306)/lightclaw_auth_sandbox_bj_5?parseTime=true")
	t.Setenv("MYSQL_DSN", "legacy:pass@tcp(10.31.192.4:3306)/lightclaw_auth_sandbox_bj_5?parseTime=true")

	dsn := ResolveMySQLDSN()

	if !strings.Contains(dsn, "/lightclaw_auth_sandbox_bj_7?") {
		t.Fatalf("ResolveMySQLDSN() = %q, want structured DB name", dsn)
	}
	if strings.Contains(dsn, "lightclaw_auth_sandbox_bj_5") {
		t.Fatalf("ResolveMySQLDSN() = %q, should not use legacy DSN when structured config is complete", dsn)
	}
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatalf("ParseDSN(%q): %v", dsn, err)
	}
	if !cfg.AllowNativePasswords {
		t.Fatalf("ResolveMySQLDSN() = %q, want mysql_native_password support", dsn)
	}
}

func TestResolveMySQLDSNFallsBackToLegacyDSN(t *testing.T) {
	t.Setenv("MYSQL_HOST", "mysql")
	t.Setenv("MYSQL_PORT", "3306")
	t.Setenv("LIGHTCLAW_AUTH_DB_USER", "lightclaw_auth")
	t.Setenv("LIGHTCLAW_AUTH_DB_PASSWORD", "")
	t.Setenv("LIGHTCLAW_AUTH_DB", "lightclaw_auth_sandbox_bj_7")
	t.Setenv("LIGHTCLAW_MYSQL_DSN", "legacy:pass@tcp(mysql:3306)/legacy_db?parseTime=true")

	if got := ResolveMySQLDSN(); got != "legacy:pass@tcp(mysql:3306)/legacy_db?parseTime=true" {
		t.Fatalf("ResolveMySQLDSN() = %q, want legacy DSN", got)
	}
}
