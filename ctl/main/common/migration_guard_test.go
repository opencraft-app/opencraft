package common

import (
	"path/filepath"
	"strings"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestVerifySchemaVersionPassesWhenDBMatchesLatestMigration(t *testing.T) {
	db := newMigrationGuardTestDB(t)
	if err := db.Exec(`CREATE TABLE schema_migrations (version BIGINT NOT NULL, dirty BOOLEAN NOT NULL);`).Error; err != nil {
		t.Fatalf("create schema_migrations: %v", err)
	}
	expectedVersion := latestTestMigrationVersion(t)
	if err := db.Exec(`INSERT INTO schema_migrations(version, dirty) VALUES (?, 0);`, expectedVersion).Error; err != nil {
		t.Fatalf("seed schema_migrations: %v", err)
	}

	if err := verifySchemaVersion(db, filepath.Join("..", "..", "conf", "local")); err != nil {
		t.Fatalf("expected schema version check to pass, got %v", err)
	}
}

func TestVerifySchemaVersionFailsWhenDBLagsBehindMigrations(t *testing.T) {
	db := newMigrationGuardTestDB(t)
	if err := db.Exec(`CREATE TABLE schema_migrations (version BIGINT NOT NULL, dirty BOOLEAN NOT NULL);`).Error; err != nil {
		t.Fatalf("create schema_migrations: %v", err)
	}
	expectedVersion := latestTestMigrationVersion(t)
	if expectedVersion == 0 {
		t.Fatal("expected at least one migration")
	}
	if err := db.Exec(`INSERT INTO schema_migrations(version, dirty) VALUES (?, 0);`, expectedVersion-1).Error; err != nil {
		t.Fatalf("seed schema_migrations: %v", err)
	}

	err := verifySchemaVersion(db, filepath.Join("..", "..", "conf", "local"))
	if err == nil {
		t.Fatal("expected schema version check to fail")
	}
	if !strings.Contains(err.Error(), "database schema version mismatch") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func newMigrationGuardTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	return db
}

func latestTestMigrationVersion(t *testing.T) uint {
	t.Helper()

	version, err := latestMigrationVersion(filepath.Join("..", "..", "migrations"))
	if err != nil {
		t.Fatalf("read latest migration version: %v", err)
	}
	return version
}
