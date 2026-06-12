package migrations

import (
	"io/fs"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	authmigrations "github.com/openclaw/openclaw/mono/backend/auth/migrations"
)

func TestNormalizeDSNEnablesMultiStatements(t *testing.T) {
	t.Parallel()

	dsn, err := normalizeDSN("user:pass@tcp(127.0.0.1:3306)/lightclaw_auth?parseTime=true")
	if err != nil {
		t.Fatalf("normalize dsn failed: %v", err)
	}
	if dsn == "" {
		t.Fatal("expected normalized dsn")
	}
	if want := "multiStatements=true"; !strings.Contains(dsn, want) {
		t.Fatalf("expected %q in dsn, got %q", want, dsn)
	}
	if want := "parseTime=true"; !strings.Contains(dsn, want) {
		t.Fatalf("expected %q in dsn, got %q", want, dsn)
	}
	if want := "time_zone="; !strings.Contains(dsn, want) {
		t.Fatalf("expected %q in dsn, got %q", want, dsn)
	}
	if strings.Contains(dsn, "loc=Local") {
		t.Fatalf("expected normalized UTC semantics, got %q", dsn)
	}
}

func TestEmbeddedMigrationsAreContiguousAndPaired(t *testing.T) {
	t.Parallel()

	entries, err := fs.ReadDir(authmigrations.Files, ".")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}

	re := regexp.MustCompile(`^(\d+)_(.+)\.(up|down)\.sql$`)
	seen := make(map[int]map[string]bool)
	stemByVersion := make(map[int]string)
	var versions []int

	for _, entry := range entries {
		matches := re.FindStringSubmatch(entry.Name())
		if matches == nil {
			continue
		}
		version, err := strconv.Atoi(matches[1])
		if err != nil {
			t.Fatalf("parse migration version for %s: %v", entry.Name(), err)
		}
		stem := matches[2]
		if existingStem, exists := stemByVersion[version]; exists && existingStem != stem {
			t.Fatalf(
				"duplicate migration version %06d: %q and %q; renumber one branch before merge",
				version,
				existingStem,
				stem,
			)
		}
		stemByVersion[version] = stem

		if seen[version] == nil {
			seen[version] = make(map[string]bool)
			versions = append(versions, version)
		}
		seen[version][matches[3]] = true
	}

	slices.Sort(versions)
	for i, version := range versions {
		if i != version {
			t.Fatalf("expected contiguous migration version %06d, got %06d", i, version)
		}
		if !seen[version]["up"] || !seen[version]["down"] {
			t.Fatalf("migration version %06d must include both up and down files", version)
		}
	}
}
