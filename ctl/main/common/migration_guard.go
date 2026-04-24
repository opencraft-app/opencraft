package common

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"gorm.io/gorm"
)

var migrationFilePattern = regexp.MustCompile(`^(\d+)_.*\.up\.sql$`)

type schemaMigrationRow struct {
	Version uint
	Dirty   bool
}

func verifySchemaVersion(db *gorm.DB, confDir string) error {
	if db == nil || strings.TrimSpace(confDir) == "" {
		return nil
	}

	migrationsDir := resolveMigrationsDir(confDir)
	info, err := os.Stat(migrationsDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("stat migrations dir: %w", err)
	}
	if !info.IsDir() {
		return nil
	}

	expectedVersion, err := latestMigrationVersion(migrationsDir)
	if err != nil {
		return fmt.Errorf("read latest migration version: %w", err)
	}

	currentVersion, dirty, err := currentSchemaVersion(db)
	if err != nil {
		return fmt.Errorf("database schema version check failed: %w\nfix: cd ctl && ./conf/local/dev.sh reset-db  # or ./conf/local/dev.sh migrate", err)
	}
	if dirty {
		return fmt.Errorf("database schema is dirty at version %d\nfix: cd ctl && ./conf/local/dev.sh reset-db  # or repair schema_migrations first", currentVersion)
	}
	if currentVersion != expectedVersion {
		return fmt.Errorf("database schema version mismatch: db=%d code=%d\nfix: cd ctl && ./conf/local/dev.sh migrate  # or ./conf/local/dev.sh reset-db", currentVersion, expectedVersion)
	}
	return nil
}

func resolveMigrationsDir(confDir string) string {
	current := filepath.Clean(confDir)
	for depth := 0; depth < 6; depth++ {
		candidate := filepath.Join(current, "migrations")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		goMod := filepath.Join(current, "go.mod")
		if info, err := os.Stat(goMod); err == nil && !info.IsDir() {
			break
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return filepath.Clean(filepath.Join(confDir, "..", "..", "migrations"))
}

func latestMigrationVersion(migrationsDir string) (uint, error) {
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return 0, err
	}

	var maxVersion uint
	found := false
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		matches := migrationFilePattern.FindStringSubmatch(entry.Name())
		if len(matches) != 2 {
			continue
		}
		version, err := strconv.ParseUint(matches[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parse migration version from %s: %w", entry.Name(), err)
		}
		if !found || uint(version) > maxVersion {
			maxVersion = uint(version)
			found = true
		}
	}
	if !found {
		return 0, fmt.Errorf("no up migrations found in %s", migrationsDir)
	}
	return maxVersion, nil
}

func currentSchemaVersion(db *gorm.DB) (uint, bool, error) {
	var row schemaMigrationRow
	if err := db.Table("schema_migrations").Order("version DESC").Limit(1).Take(&row).Error; err != nil {
		return 0, false, err
	}
	return row.Version, row.Dirty, nil
}
