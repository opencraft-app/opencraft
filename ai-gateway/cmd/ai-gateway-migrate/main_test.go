package main

import (
	"io/fs"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	aimigrations "git.woa.com/wisp/mono/ai-gateway/migrations"
)

func TestLatestKnownSchemaVersionMatchesEmbeddedMigrations(t *testing.T) {
	var maxVersion int64
	err := fs.WalkDir(aimigrations.Files, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		matches := migrationVersionRe.FindStringSubmatch(path)
		if len(matches) != 2 {
			return nil
		}
		version, err := strconv.ParseInt(matches[1], 10, 64)
		if err != nil {
			return err
		}
		if version > maxVersion {
			maxVersion = version
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk migrations: %v", err)
	}
	if latestKnownSchemaVersion != maxVersion {
		t.Fatalf("latestKnownSchemaVersion = %d, want embedded max migration version %d", latestKnownSchemaVersion, maxVersion)
	}
}

func TestInferSchemaVersionFromFacts(t *testing.T) {
	coreTables := func() map[string]bool {
		tables := make(map[string]bool)
		for _, table := range aiGatewayCoreTables {
			tables[table] = true
		}
		return tables
	}

	tests := []struct {
		name        string
		facts       schemaFacts
		wantVersion int64
		wantErr     string
	}{
		{
			name: "fresh database has no inferred version",
			facts: schemaFacts{
				tables:  map[string]bool{},
				columns: map[string]map[string]bool{},
			},
			wantVersion: 0,
		},
		{
			name: "partial core schema is not repaired automatically",
			facts: schemaFacts{
				tables: map[string]bool{
					"admin_audit_logs": true,
				},
				columns: map[string]map[string]bool{},
			},
			wantErr: "partial ai-gateway schema detected",
		},
		{
			name: "v1 schema keeps response_cache",
			facts: schemaFacts{
				tables: func() map[string]bool {
					tables := coreTables()
					tables["response_cache"] = true
					return tables
				}(),
				columns: map[string]map[string]bool{},
			},
			wantVersion: 1,
		},
		{
			name: "v3 schema has dropped response_cache",
			facts: schemaFacts{
				tables:  coreTables(),
				columns: map[string]map[string]bool{},
			},
			wantVersion: 3,
		},
		{
			name: "v4 schema has model discovery protocol",
			facts: schemaFacts{
				tables: coreTables(),
				columns: map[string]map[string]bool{
					"providers": {
						"model_discovery_protocol": true,
					},
					"subscriptions": {
						"last_refreshed_at": false,
					},
				},
			},
			wantVersion: 4,
		},
		{
			name: "v5 schema has subscriptions.last_refreshed_at",
			facts: schemaFacts{
				tables: coreTables(),
				columns: map[string]map[string]bool{
					"providers": {
						"model_discovery_protocol": true,
					},
					"subscriptions": {
						"last_refreshed_at": true,
					},
				},
			},
			wantVersion: latestKnownSchemaVersion,
		},
		{
			name: "v5 fingerprint without v4 fingerprint is unsafe",
			facts: schemaFacts{
				tables: coreTables(),
				columns: map[string]map[string]bool{
					"providers": {
						"model_discovery_protocol": false,
					},
					"subscriptions": {
						"last_refreshed_at": true,
					},
				},
			},
			wantErr: "inconsistent ai-gateway schema fingerprint",
		},
		{
			name: "mixed v1 and v4 fingerprints are unsafe",
			facts: schemaFacts{
				tables: func() map[string]bool {
					tables := coreTables()
					tables["response_cache"] = true
					return tables
				}(),
				columns: map[string]map[string]bool{
					"providers": {
						"model_discovery_protocol": true,
					},
				},
			},
			wantErr: "inconsistent ai-gateway schema fingerprint",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := inferSchemaVersionFromFacts(tt.facts)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("inferSchemaVersionFromFacts() error = %v, want containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("inferSchemaVersionFromFacts() error = %v", err)
			}
			if got != tt.wantVersion {
				t.Fatalf("inferSchemaVersionFromFacts() = %d, want %d", got, tt.wantVersion)
			}
		})
	}
}

func TestReconcileSchemaMigrationsRepairsDirtyStateWhenFingerprintIsAhead(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error = %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT version, dirty FROM schema_migrations ORDER BY version DESC LIMIT 1")).
		WillReturnRows(sqlmock.NewRows([]string{"version", "dirty"}).AddRow(int64(1), true))
	for _, table := range aiGatewayCoreTables {
		expectTableExists(mock, table, true)
	}
	expectTableExists(mock, "response_cache", false)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?")).
		WithArgs("providers", "model_discovery_protocol").
		WillReturnRows(sqlmock.NewRows([]string{"COUNT(*)"}).AddRow(1))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?")).
		WithArgs("subscriptions", "last_refreshed_at").
		WillReturnRows(sqlmock.NewRows([]string{"COUNT(*)"}).AddRow(1))
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM schema_migrations")).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO schema_migrations (version, dirty) VALUES (?, ?)")).
		WithArgs(latestKnownSchemaVersion, false).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	if err := reconcileSchemaMigrations(db); err != nil {
		t.Fatalf("reconcileSchemaMigrations() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestReconcileSchemaMigrationsDoesNotRepairDirtyStateWithoutAheadFingerprint(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error = %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT version, dirty FROM schema_migrations ORDER BY version DESC LIMIT 1")).
		WillReturnRows(sqlmock.NewRows([]string{"version", "dirty"}).AddRow(int64(3), true))
	for _, table := range aiGatewayCoreTables {
		expectTableExists(mock, table, true)
	}
	expectTableExists(mock, "response_cache", false)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?")).
		WithArgs("providers", "model_discovery_protocol").
		WillReturnRows(sqlmock.NewRows([]string{"COUNT(*)"}).AddRow(0))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?")).
		WithArgs("subscriptions", "last_refreshed_at").
		WillReturnRows(sqlmock.NewRows([]string{"COUNT(*)"}).AddRow(0))

	err = reconcileSchemaMigrations(db)
	if err == nil || !strings.Contains(err.Error(), "repair manually") {
		t.Fatalf("reconcileSchemaMigrations() error = %v, want manual repair error", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func expectTableExists(mock sqlmock.Sqlmock, table string, exists bool) {
	query := regexp.QuoteMeta("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?")
	count := 0
	if exists {
		count = 1
	}
	mock.ExpectQuery(query).
		WithArgs(table).
		WillReturnRows(sqlmock.NewRows([]string{"COUNT(*)"}).AddRow(count))
}
