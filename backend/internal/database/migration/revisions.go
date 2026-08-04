package migration

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	"chatserver/internal/config"
)

const revisionTable = "atlas_schema_revisions"

type revisionStore struct {
	db      revisionDatabase
	dialect config.DatabaseDriver
}

type revisionDatabase interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *revisionStore) Ident() *atlasmigrate.TableIdent {
	return &atlasmigrate.TableIdent{Name: revisionTable}
}

func (s *revisionStore) ReadRevisions(ctx context.Context) ([]*atlasmigrate.Revision, error) {
	if s.dialect != config.DatabaseDriverSQLite {
		return nil, errors.New("Atlas revisionStore 只允许 SQLite 使用")
	}
	if err := s.ensure(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT version, description, revision_type, applied, total, executed_at,
		       execution_time_ns, error, error_stmt, hash, partial_hashes, operator_version
		FROM atlas_schema_revisions
		ORDER BY version
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var revisions []*atlasmigrate.Revision
	for rows.Next() {
		revision, err := scanRevision(rows)
		if err != nil {
			return nil, err
		}
		revisions = append(revisions, revision)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return revisions, nil
}

func (s *revisionStore) ReadRevision(ctx context.Context, version string) (*atlasmigrate.Revision, error) {
	if s.dialect != config.DatabaseDriverSQLite {
		return nil, errors.New("Atlas revisionStore 只允许 SQLite 使用")
	}
	if err := s.ensure(ctx); err != nil {
		return nil, err
	}
	revision, err := scanRevision(s.db.QueryRowContext(ctx, `
		SELECT version, description, revision_type, applied, total, executed_at,
		       execution_time_ns, error, error_stmt, hash, partial_hashes, operator_version
		FROM atlas_schema_revisions
		WHERE version = ?
	`, version))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, atlasmigrate.ErrRevisionNotExist
	}
	return revision, err
}

func (s *revisionStore) WriteRevision(ctx context.Context, revision *atlasmigrate.Revision) error {
	if s.dialect != config.DatabaseDriverSQLite {
		return errors.New("TDSQL 禁止使用可 upsert 的 Atlas revisionStore")
	}
	if err := s.ensure(ctx); err != nil {
		return err
	}
	query := `
		INSERT INTO atlas_schema_revisions (
			version, description, revision_type, applied, total, executed_at,
			execution_time_ns, error, error_stmt, hash, partial_hashes, operator_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(version) DO UPDATE SET
			description = excluded.description,
			revision_type = excluded.revision_type,
			applied = excluded.applied,
			total = excluded.total,
			executed_at = excluded.executed_at,
			execution_time_ns = excluded.execution_time_ns,
			error = excluded.error,
			error_stmt = excluded.error_stmt,
			hash = excluded.hash,
			partial_hashes = excluded.partial_hashes,
			operator_version = excluded.operator_version
	`
	_, err := s.db.ExecContext(ctx, query,
		revision.Version,
		revision.Description,
		uint(revision.Type),
		revision.Applied,
		revision.Total,
		revision.ExecutedAt.UTC(),
		int64(revision.ExecutionTime),
		revision.Error,
		revision.ErrorStmt,
		revision.Hash,
		strings.Join(revision.PartialHashes, "\n"),
		revision.OperatorVersion,
	)
	return err
}

func (s *revisionStore) DeleteRevision(ctx context.Context, version string) error {
	if s.dialect != config.DatabaseDriverSQLite {
		return errors.New("Atlas revisionStore 只允许 SQLite 使用")
	}
	if err := s.ensure(ctx); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM atlas_schema_revisions WHERE version = ?", version)
	return err
}

func (s *revisionStore) ensure(ctx context.Context) error {
	if s.dialect != config.DatabaseDriverSQLite {
		return errors.New("Atlas revisionStore 只允许 SQLite 使用")
	}
	query := `
		CREATE TABLE IF NOT EXISTS atlas_schema_revisions (
			version text NOT NULL PRIMARY KEY,
			description text NOT NULL,
			revision_type integer NOT NULL,
			applied integer NOT NULL,
			total integer NOT NULL,
			executed_at datetime NOT NULL,
			execution_time_ns integer NOT NULL,
			error text NOT NULL,
			error_stmt text NOT NULL,
			hash text NOT NULL,
			partial_hashes text NOT NULL,
			operator_version text NOT NULL
		)
	`
	_, err := s.db.ExecContext(ctx, query)
	return err
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanRevision(row rowScanner) (*atlasmigrate.Revision, error) {
	var (
		revision         atlasmigrate.Revision
		revisionType     uint
		executionTimeNS  int64
		partialHashesRaw string
	)
	err := row.Scan(
		&revision.Version,
		&revision.Description,
		&revisionType,
		&revision.Applied,
		&revision.Total,
		&revision.ExecutedAt,
		&executionTimeNS,
		&revision.Error,
		&revision.ErrorStmt,
		&revision.Hash,
		&partialHashesRaw,
		&revision.OperatorVersion,
	)
	if err != nil {
		return nil, err
	}
	revision.Type = atlasmigrate.RevisionType(revisionType)
	revision.ExecutionTime = time.Duration(executionTimeNS)
	if partialHashesRaw != "" {
		revision.PartialHashes = strings.Split(partialHashesRaw, "\n")
	}
	return &revision, nil
}
