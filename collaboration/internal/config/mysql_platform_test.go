package config

import (
	"path/filepath"
	"testing"
)

func TestNewMySQLDatabaseExplicitSingleInstanceMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "database.dsn")
	cfg, err := NewMySQLDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Driver != DatabaseDriverMySQL || cfg.DSNFile != path || cfg.Path != "" {
		t.Fatal("MySQL mode must use an explicit DSN file, never a guessed dialect")
	}
	if _, err := NewMySQLDatabase("relative.dsn"); err == nil {
		t.Fatal("relative DSN path accepted")
	}
}
