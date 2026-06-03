package main

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestBootstrapIfNeededBackfillsEmptySchemaMigrationsFromLegacyTable(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create sql mock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(regexp.QuoteMeta("SHOW TABLES LIKE ?")).
		WithArgs("schema_migrations").
		WillReturnRows(sqlmock.NewRows([]string{"Tables_in_test (schema_migrations)"}).AddRow("schema_migrations"))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT COUNT(*) FROM schema_migrations")).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery(regexp.QuoteMeta("SHOW TABLES LIKE ?")).
		WithArgs("schema_migration_files").
		WillReturnRows(sqlmock.NewRows([]string{"Tables_in_test (schema_migration_files)"}).AddRow("schema_migration_files"))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT file_name FROM schema_migration_files")).
		WillReturnRows(sqlmock.NewRows([]string{"file_name"}).
			AddRow("000001_init_schema.up.sql").
			AddRow("000004_add_model_discovery_protocol_to_providers.up.sql"))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO schema_migrations (version, dirty) VALUES (?, 0)")).
		WithArgs(int64(4)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	if err := bootstrapIfNeeded(db); err != nil {
		t.Fatalf("bootstrapIfNeeded failed: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestBootstrapIfNeededSkipsNonEmptySchemaMigrations(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create sql mock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(regexp.QuoteMeta("SHOW TABLES LIKE ?")).
		WithArgs("schema_migrations").
		WillReturnRows(sqlmock.NewRows([]string{"Tables_in_test (schema_migrations)"}).AddRow("schema_migrations"))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT COUNT(*) FROM schema_migrations")).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	if err := bootstrapIfNeeded(db); err != nil {
		t.Fatalf("bootstrapIfNeeded failed: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}
