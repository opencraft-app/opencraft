package schemaaudit

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"path/filepath"
	"testing"

	"chatserver/internal/apperror"
	"chatserver/internal/database/migration"
	_ "modernc.org/sqlite"
)

func TestVerifySQLite接受正式Baseline(t *testing.T) {
	handle := openMigratedDatabase(t)
	defer handle.Close()

	if err := VerifySQLite(context.Background(), handle); err != nil {
		t.Fatalf("VerifySQLite() error = %v；cause=%v", err, errors.Unwrap(err))
	}
}

func TestVerifySQLite发现缺失索引(t *testing.T) {
	handle := openMigratedDatabase(t)
	defer handle.Close()
	if _, err := handle.Exec("DROP INDEX account_id_im_state"); err != nil {
		t.Fatal(err)
	}

	err := VerifySQLite(context.Background(), handle)
	if code := apperror.CodeOf(err); code != "SCHEMA_DRIFT" {
		t.Fatalf("错误码 = %q，期望 SCHEMA_DRIFT；err=%v", code, err)
	}
}

func TestVerifySQLite发现额外业务表(t *testing.T) {
	handle := openMigratedDatabase(t)
	defer handle.Close()
	if _, err := handle.Exec("CREATE TABLE unexpected_table(id text PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}

	err := VerifySQLite(context.Background(), handle)
	if code := apperror.CodeOf(err); code != "SCHEMA_DRIFT" {
		t.Fatalf("错误码 = %q，期望 SCHEMA_DRIFT；err=%v", code, err)
	}
}

func TestVerifySQLite拒绝关键Pragma漂移(t *testing.T) {
	handle := openMigratedDatabase(t)
	defer handle.Close()
	if _, err := handle.Exec("PRAGMA synchronous = NORMAL"); err != nil {
		t.Fatal(err)
	}

	err := VerifySQLite(context.Background(), handle)
	if code := apperror.CodeOf(err); code != "SCHEMA_DRIFT" {
		t.Fatalf("错误码 = %q，期望 SCHEMA_DRIFT；err=%v", code, err)
	}
}

func openMigratedDatabase(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "chatserver.db")
	query := url.Values{}
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "synchronous(FULL)")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "foreign_keys(OFF)")
	query.Set("_time_format", "sqlite")
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: query.Encode()}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if err := db.PingContext(context.Background()); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := migration.Apply(context.Background(), db); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	return db
}
