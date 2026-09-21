package migration

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	"git.woa.com/wisp/mono2/collaboration/internal/config"
)

type emptyBaselineRecoveryAction string

const (
	emptyBaselineRecoveryAlreadyEmpty         emptyBaselineRecoveryAction = "already_empty"
	emptyBaselineRecoveryDropTableAndRevision emptyBaselineRecoveryAction = "drop_table_and_revision"
	emptyBaselineRecoveryDeleteRevision       emptyBaselineRecoveryAction = "delete_revision"
)

type emptyBaselineRecoverySignature struct {
	Version           string
	Hash              string
	LegacyTotal       int
	FirstStatementSHA string
	FirstTable        string
}

// EmptyBaselineRecoveryResult is a safe, non-secret audit summary.
type EmptyBaselineRecoveryResult struct {
	Action       string
	Applied      bool
	AlreadyEmpty bool
	TableRows    int64
}

type emptyBaselineRecoveryStore interface {
	Snapshot(context.Context) (TDSQLSnapshot, error)
	CountFirstTable(context.Context, string) (int64, error)
	DropFirstTable(context.Context, string) error
	DeleteRevision(context.Context, TDSQLRevision) (int64, error)
}

type sqlEmptyBaselineRecoveryStore struct{ db *sql.DB }

// RecoverEmptyMySQLBaseline repairs only the exact empty-database residue
// created by the released MySQL double-delimiter bug. Without apply it is a
// read-only preflight. Every other database state is rejected.
func RecoverEmptyMySQLBaseline(
	ctx context.Context,
	db *sql.DB,
	apply bool,
) (EmptyBaselineRecoveryResult, error) {
	if db == nil {
		return EmptyBaselineRecoveryResult{}, apperror.New(
			"DATABASE_MIGRATION_FAILED", "数据库恢复连接无效", nil,
		)
	}
	dir, err := embeddedDirFor(config.DatabaseDriverMySQL)
	if err != nil {
		return EmptyBaselineRecoveryResult{}, recoveryFailed("无法读取 MySQL 恢复规格", err)
	}
	defer dir.Close()
	signature, err := emptyBaselineRecoverySignatureFromDir(dir)
	if err != nil {
		return EmptyBaselineRecoveryResult{}, recoveryFailed("无法读取 MySQL 恢复规格", err)
	}
	return recoverEmptyBaseline(
		ctx,
		&sqlEmptyBaselineRecoveryStore{db: db},
		signature,
		apply,
	)
}

func recoverEmptyBaseline(
	ctx context.Context,
	store emptyBaselineRecoveryStore,
	signature emptyBaselineRecoverySignature,
	apply bool,
) (EmptyBaselineRecoveryResult, error) {
	if store == nil {
		return EmptyBaselineRecoveryResult{}, recoveryFailed("数据库恢复存储无效", nil)
	}
	snapshot, err := store.Snapshot(ctx)
	if err != nil {
		return EmptyBaselineRecoveryResult{}, recoveryFailed("无法读取 MySQL 恢复状态", err)
	}
	action, err := classifyEmptyBaselineRecovery(snapshot, signature)
	if err != nil {
		return EmptyBaselineRecoveryResult{}, apperror.New(
			"DATABASE_MIGRATION_UNSAFE",
			"数据库不匹配可恢复的空基线失败状态",
			err,
		)
	}
	result := EmptyBaselineRecoveryResult{Action: string(action)}
	if action == emptyBaselineRecoveryAlreadyEmpty {
		result.AlreadyEmpty = true
		return result, nil
	}

	if action == emptyBaselineRecoveryDropTableAndRevision {
		result.TableRows, err = store.CountFirstTable(ctx, signature.FirstTable)
		if err != nil {
			return EmptyBaselineRecoveryResult{}, recoveryFailed("无法核对恢复表行数", err)
		}
		if result.TableRows != 0 {
			return EmptyBaselineRecoveryResult{}, apperror.New(
				"DATABASE_NOT_EMPTY",
				"恢复目标表不是空表",
				nil,
			)
		}
	}
	if !apply {
		return result, nil
	}

	revision := snapshot.Revisions[0]
	if action == emptyBaselineRecoveryDropTableAndRevision {
		if err := store.DropFirstTable(ctx, signature.FirstTable); err != nil {
			return EmptyBaselineRecoveryResult{}, recoveryFailed("无法删除空基线残留表", err)
		}
	}
	rows, err := store.DeleteRevision(ctx, revision)
	if err != nil {
		return EmptyBaselineRecoveryResult{}, recoveryFailed("无法删除失败的基线 revision", err)
	}
	if rows != 1 {
		return EmptyBaselineRecoveryResult{}, recoveryFailed(
			"失败的基线 revision 已发生变化",
			fmt.Errorf("revision delete affected %d rows", rows),
		)
	}
	postSnapshot, err := store.Snapshot(ctx)
	if err != nil {
		return EmptyBaselineRecoveryResult{}, recoveryFailed("无法回读 MySQL 恢复状态", err)
	}
	postAction, err := classifyEmptyBaselineRecovery(postSnapshot, signature)
	if err != nil || postAction != emptyBaselineRecoveryAlreadyEmpty {
		return EmptyBaselineRecoveryResult{}, recoveryFailed(
			"MySQL 恢复后未回到空库状态",
			err,
		)
	}
	result.Applied = true
	result.AlreadyEmpty = true
	return result, nil
}

func (store *sqlEmptyBaselineRecoveryStore) Snapshot(
	ctx context.Context,
) (TDSQLSnapshot, error) {
	return readTDSQLSnapshot(ctx, store.db)
}

func (store *sqlEmptyBaselineRecoveryStore) CountFirstTable(
	ctx context.Context,
	table string,
) (int64, error) {
	if table != "account_login_identities" {
		return 0, fmt.Errorf("unexpected recovery table")
	}
	var rows int64
	err := store.db.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM `account_login_identities`",
	).Scan(&rows)
	return rows, err
}

func (store *sqlEmptyBaselineRecoveryStore) DropFirstTable(
	ctx context.Context,
	table string,
) error {
	if table != "account_login_identities" {
		return fmt.Errorf("unexpected recovery table")
	}
	_, err := store.db.ExecContext(ctx, "DROP TABLE `account_login_identities`")
	return err
}

func (store *sqlEmptyBaselineRecoveryStore) DeleteRevision(
	ctx context.Context,
	revision TDSQLRevision,
) (int64, error) {
	result, err := store.db.ExecContext(ctx, `
		DELETE FROM atlas_schema_revisions
		WHERE version = ? AND hash = ? AND claim_id = ?
		  AND applied = ? AND total = ? AND error = ? AND error_stmt = ''
		  AND partial_hashes = ?
	`,
		revision.Version,
		revision.Hash,
		revision.ClaimID,
		revision.Applied,
		revision.Total,
		revision.Error,
		strings.Join(revision.PartialHashes, "\n"),
	)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func recoveryFailed(message string, err error) error {
	return apperror.New("DATABASE_MIGRATION_FAILED", message, err)
}

func emptyBaselineRecoverySignatureFromDir(
	dir atlasmigrate.Dir,
) (emptyBaselineRecoverySignature, error) {
	if dir == nil {
		return emptyBaselineRecoverySignature{}, fmt.Errorf("migration directory is nil")
	}
	if err := atlasmigrate.Validate(dir); err != nil {
		return emptyBaselineRecoverySignature{}, err
	}
	files, err := dir.Files()
	if err != nil || len(files) == 0 {
		return emptyBaselineRecoverySignature{}, fmt.Errorf("published MySQL baseline is missing: %w", err)
	}
	rawStatements, err := files[0].Stmts()
	if err != nil {
		return emptyBaselineRecoverySignature{}, err
	}
	executable, err := tdsqlMigrationStatements(files[0])
	if err != nil || len(executable) == 0 {
		return emptyBaselineRecoverySignature{}, fmt.Errorf("published MySQL baseline has no executable statements: %w", err)
	}
	tables := createdTables(executable[:1])
	if len(tables) != 1 {
		return emptyBaselineRecoverySignature{}, fmt.Errorf("published MySQL baseline first table is invalid")
	}
	checksums, err := dir.Checksum()
	if err != nil {
		return emptyBaselineRecoverySignature{}, err
	}
	hash, err := checksums.SumByName(files[0].Name())
	if err != nil {
		return emptyBaselineRecoverySignature{}, err
	}
	digest := sha256.Sum256([]byte(executable[0]))
	return emptyBaselineRecoverySignature{
		Version:           files[0].Version(),
		Hash:              hash,
		LegacyTotal:       len(rawStatements),
		FirstStatementSHA: hex.EncodeToString(digest[:]),
		FirstTable:        tables[0],
	}, nil
}

func classifyEmptyBaselineRecovery(
	snapshot TDSQLSnapshot,
	signature emptyBaselineRecoverySignature,
) (emptyBaselineRecoveryAction, error) {
	if len(snapshot.Revisions) == 0 && len(snapshot.UserTables) == 0 {
		if snapshot.RevisionTableExists && !snapshot.RevisionColumnsValid {
			return "", fmt.Errorf("revision schema is invalid")
		}
		return emptyBaselineRecoveryAlreadyEmpty, nil
	}
	if !snapshot.RevisionTableExists || !snapshot.RevisionColumnsValid ||
		len(snapshot.Revisions) != 1 {
		return "", fmt.Errorf("revision state does not match recovery signature")
	}
	revision := snapshot.Revisions[0]
	if revision.Version != signature.Version ||
		revision.Hash != signature.Hash ||
		!claimIDPattern.MatchString(revision.ClaimID) ||
		revision.Applied != 1 ||
		revision.Total != signature.LegacyTotal ||
		revision.Error != "statement_failed" ||
		revision.ErrorStmt != "" ||
		len(revision.PartialHashes) != 1 ||
		revision.PartialHashes[0] != signature.FirstStatementSHA {
		return "", fmt.Errorf("revision identity does not match recovery signature")
	}
	if len(snapshot.UserTables) == 0 {
		return emptyBaselineRecoveryDeleteRevision, nil
	}
	if len(snapshot.UserTables) == 1 && snapshot.UserTables[0] == signature.FirstTable {
		return emptyBaselineRecoveryDropTableAndRevision, nil
	}
	return "", fmt.Errorf("business table set does not match recovery signature")
}
