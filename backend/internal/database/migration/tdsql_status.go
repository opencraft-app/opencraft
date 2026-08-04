package migration

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

func statusTDSQL(ctx context.Context, db *sql.DB) (StatusInfo, error) {
	state, expected, err := inspectTDSQLState(ctx, db)
	if err != nil {
		return StatusInfo{}, err
	}
	info := StatusInfo{
		Kind:              state.Kind,
		Reason:            state.Reason,
		CurrentVersion:    state.Version,
		LatestVersion:     expected.Migrations[len(expected.Migrations)-1].Version,
		AppliedStatements: state.Applied,
		TotalStatements:   state.Total,
		ChecksumValid:     true,
	}
	info.Applied = lenExpectedRevisionsAtOrBefore(expected, state.Version)
	info.Pending = len(expected.Migrations) - info.Applied
	if state.Kind == StateEmpty {
		info.Applied = 0
		info.Pending = len(expected.Migrations)
	}
	return info, nil
}

func lenExpectedRevisionsAtOrBefore(expected tdsqlRuntimeExpectation, version string) int {
	if version == "" {
		return 0
	}
	for index, migration := range expected.Migrations {
		if migration.Version == version {
			return index + 1
		}
	}
	return 0
}

func inspectTDSQLState(
	ctx context.Context,
	db *sql.DB,
) (State, tdsqlRuntimeExpectation, error) {
	dir, err := embeddedDirFor("tdsql")
	if err != nil {
		return State{}, tdsqlRuntimeExpectation{}, err
	}
	defer dir.Close()
	expected, err := tdsqlRuntimeExpectationFromDir(dir)
	if err != nil {
		return State{}, tdsqlRuntimeExpectation{}, err
	}
	snapshot, err := readTDSQLSnapshot(ctx, db)
	if err != nil {
		return State{}, tdsqlRuntimeExpectation{}, err
	}
	return classifyTDSQLRuntime(snapshot, expected), expected, nil
}

func readTDSQLSnapshot(ctx context.Context, db *sql.DB) (TDSQLSnapshot, error) {
	if db == nil {
		return TDSQLSnapshot{}, fmt.Errorf("database is nil")
	}
	var snapshot TDSQLSnapshot
	var revisionTables int
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM information_schema.tables
		WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
		  AND table_name = ?
	`, revisionTable).Scan(&revisionTables); err != nil {
		return TDSQLSnapshot{}, err
	}
	snapshot.RevisionTableExists = revisionTables == 1

	rows, err := db.QueryContext(ctx, `
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
		  AND table_name <> ?
		ORDER BY table_name
	`, revisionTable)
	if err != nil {
		return TDSQLSnapshot{}, err
	}
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			rows.Close()
			return TDSQLSnapshot{}, err
		}
		snapshot.UserTables = append(snapshot.UserTables, table)
	}
	if err := rows.Close(); err != nil {
		return TDSQLSnapshot{}, err
	}
	if !snapshot.RevisionTableExists {
		return snapshot, nil
	}

	var (
		claimColumns int
		columnType   sql.NullString
		nullable     sql.NullString
		characterSet sql.NullString
		collation    sql.NullString
	)
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*), MAX(column_type), MAX(is_nullable),
		       MAX(character_set_name), MAX(collation_name)
		FROM information_schema.columns
		WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'claim_id'
	`, revisionTable).Scan(
		&claimColumns, &columnType, &nullable, &characterSet, &collation,
	); err != nil {
		return TDSQLSnapshot{}, err
	}
	snapshot.RevisionColumnsValid = claimColumns == 1 &&
		strings.EqualFold(columnType.String, "char(32)") &&
		strings.EqualFold(nullable.String, "NO") &&
		strings.EqualFold(characterSet.String, "ascii") &&
		strings.EqualFold(collation.String, "ascii_bin")
	if !snapshot.RevisionColumnsValid {
		return snapshot, nil
	}

	revisionRows, err := db.QueryContext(ctx, `
		SELECT version, applied, total, error, hash, partial_hashes, claim_id
		FROM atlas_schema_revisions
		ORDER BY version
	`)
	if err != nil {
		return TDSQLSnapshot{}, err
	}
	defer revisionRows.Close()
	for revisionRows.Next() {
		var revision TDSQLRevision
		var partialHashes string
		if err := revisionRows.Scan(
			&revision.Version,
			&revision.Applied,
			&revision.Total,
			&revision.Error,
			&revision.Hash,
			&partialHashes,
			&revision.ClaimID,
		); err != nil {
			return TDSQLSnapshot{}, err
		}
		if partialHashes != "" {
			revision.PartialHashes = strings.Split(partialHashes, "\n")
		}
		snapshot.Revisions = append(snapshot.Revisions, revision)
	}
	if err := revisionRows.Err(); err != nil {
		return TDSQLSnapshot{}, err
	}
	return snapshot, nil
}
