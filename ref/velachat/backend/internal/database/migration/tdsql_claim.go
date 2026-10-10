package migration

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	gomysql "github.com/go-sql-driver/mysql"
)

// ClaimOutcome 区分正常赢得 claim、正常并发竞争与真实写失败。
type ClaimOutcome string

const (
	ClaimWon       ClaimOutcome = "won"
	ClaimDuplicate ClaimOutcome = "duplicate"
	ClaimFailed    ClaimOutcome = "failed"
)

type tdsqlRevisionExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func newClaimID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func ensureTDSQLRevisionTable(ctx context.Context, db tdsqlRevisionExecer) error {
	_, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS atlas_schema_revisions (
			version varchar(20) NOT NULL PRIMARY KEY,
			description varchar(255) NOT NULL,
			revision_type bigint unsigned NOT NULL,
			applied bigint NOT NULL,
			total bigint NOT NULL,
			executed_at datetime(6) NOT NULL,
			execution_time_ns bigint NOT NULL,
			error longtext NOT NULL,
			error_stmt longtext NOT NULL,
			hash varchar(255) NOT NULL,
			partial_hashes longtext NOT NULL,
			operator_version varchar(255) NOT NULL,
			claim_id char(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
	`)
	return err
}

func claimRevision(
	ctx context.Context,
	db tdsqlRevisionExecer,
	revision *atlasmigrate.Revision,
	claimID string,
) (ClaimOutcome, error) {
	if revision == nil || !claimIDPattern.MatchString(claimID) {
		return ClaimFailed, fmt.Errorf("invalid revision claim")
	}
	_, err := db.ExecContext(ctx, `
		INSERT INTO atlas_schema_revisions (
			version, description, revision_type, applied, total, executed_at,
			execution_time_ns, error, error_stmt, hash, partial_hashes,
			operator_version, claim_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
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
		claimID,
	)
	if err == nil {
		return ClaimWon, nil
	}
	var mysqlError *gomysql.MySQLError
	if errors.As(err, &mysqlError) && mysqlError.Number == 1062 {
		return ClaimDuplicate, nil
	}
	return ClaimFailed, err
}

func writeOwnedRevision(
	ctx context.Context,
	db tdsqlRevisionExecer,
	revision *atlasmigrate.Revision,
	claimID string,
	expectedApplied int,
) error {
	if revision == nil || !claimIDPattern.MatchString(claimID) {
		return fmt.Errorf("invalid owned revision update")
	}
	result, err := db.ExecContext(ctx, `
		UPDATE atlas_schema_revisions
		SET description = ?, revision_type = ?, applied = ?, total = ?,
		    executed_at = ?, execution_time_ns = ?, error = ?, error_stmt = ?,
		    hash = ?, partial_hashes = ?, operator_version = ?
		WHERE version = ? AND claim_id = ? AND applied = ?
	`,
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
		revision.Version,
		claimID,
		expectedApplied,
	)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows != 1 {
		return fmt.Errorf("owned revision CAS affected %d rows", rows)
	}
	return nil
}
