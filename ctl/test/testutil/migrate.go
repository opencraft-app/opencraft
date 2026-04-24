package testutil

import (
	"database/sql"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func ApplyMigrations(t *testing.T, db *sql.DB, migrationsDir string) {
	t.Helper()

	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		t.Fatalf("read migrations dir: %v", err)
	}

	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".up.sql") {
			continue
		}
		files = append(files, filepath.Join(migrationsDir, entry.Name()))
	}
	sort.Strings(files)

	for _, path := range files {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read migration %s: %v", path, err)
		}
		if _, err := db.Exec(string(content)); err != nil {
			t.Fatalf("apply migration %s: %v", path, err)
		}
	}
}
