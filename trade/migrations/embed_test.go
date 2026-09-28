package migrations

import (
	"io/fs"
	"regexp"
	"strings"
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

func TestDianshiActivitySceneMigrationContract(t *testing.T) {
	up, err := Files.ReadFile("000011_dianshi_activity_scene.up.sql")
	if err != nil {
		t.Fatalf("read up migration: %v", err)
	}
	down, err := Files.ReadFile("000011_dianshi_activity_scene.down.sql")
	if err != nil {
		t.Fatalf("read down migration: %v", err)
	}

	for _, want := range []string{
		"ADD COLUMN scene VARCHAR(16) NOT NULL DEFAULT 'purchase'",
		"UNIQUE KEY uk_bundle_scene (bundle_id, scene)",
		"UNIQUE KEY uk_uin_activity_scene (uin, activity_id, scene)",
		"activity_id, order_type, bundle_id",
	} {
		if !strings.Contains(string(up), want) {
			t.Errorf("up migration missing %q", want)
		}
	}
	for _, want := range []string{
		"DELETE FROM trade_bundle_activity WHERE scene = 'renew'",
		"DELETE FROM trade_user_activity_participation WHERE scene = 'renew'",
		"UNIQUE KEY uk_uin_activity (uin, activity_id)",
	} {
		if !strings.Contains(string(down), want) {
			t.Errorf("down migration missing %q", want)
		}
	}
}
