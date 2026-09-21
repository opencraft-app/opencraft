package migrations

import (
	"io/fs"
	"regexp"
	"testing"
)

func TestMigrationVersionsAreUnique(t *testing.T) {
	entries, err := fs.ReadDir(Files, ".")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}

	pattern := regexp.MustCompile(`^(\d+)_.*\.(up|down)\.sql$`)
	seen := make(map[string]string)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		matches := pattern.FindStringSubmatch(entry.Name())
		if matches == nil {
			continue
		}
		key := matches[1] + "." + matches[2]
		if previous, ok := seen[key]; ok {
			t.Errorf("migration version %s has duplicate %s files: %s and %s", matches[1], matches[2], previous, entry.Name())
			continue
		}
		seen[key] = entry.Name()
	}
}
