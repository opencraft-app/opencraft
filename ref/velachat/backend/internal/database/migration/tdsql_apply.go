package migration

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	"chatserver/internal/apperror"
)

func tdsqlPreflightError(state State) error {
	switch state.Kind {
	case StateEmpty, StateClean:
		return nil
	case StateUnsafe:
		if state.Reason == ReasonNotEmpty {
			return apperror.New(
				"DATABASE_NOT_EMPTY",
				"数据库不是可安全初始化的空库",
				nil,
			)
		}
		fallthrough
	case StatePending, StateDirty:
		return apperror.New(
			"DATABASE_MIGRATION_UNSAFE",
			"数据库存在不可续跑的 TDSQL baseline 状态",
			nil,
		)
	default:
		return apperror.New(
			"DATABASE_MIGRATION_UNSAFE",
			"数据库迁移状态无法识别",
			nil,
		)
	}
}

func applyTDSQLBaseline(
	ctx context.Context,
	db *sql.DB,
	dir atlasmigrate.Dir,
) error {
	expected, err := tdsqlRuntimeExpectationFromDir(dir)
	if err != nil {
		return apperror.New("DATABASE_MIGRATION_FAILED", "无法读取 TDSQL 迁移规格", err)
	}
	snapshot, err := readTDSQLSnapshot(ctx, db)
	if err != nil {
		return apperror.New("DATABASE_MIGRATION_FAILED", "无法读取 TDSQL 迁移状态", err)
	}
	state := classifyTDSQLRuntime(snapshot, expected)
	if state.Kind == StateClean {
		return nil
	}
	if state.Kind != StateEmpty && !isCompleteTDSQLPrefix(snapshot, expected) {
		if err := tdsqlPreflightError(state); err != nil {
			return err
		}
	}
	files, err := dir.Files()
	if err != nil || len(files) != len(expected.Migrations) {
		return apperror.New("DATABASE_MIGRATION_FAILED", "TDSQL migration 文件集合无效", err)
	}
	for index := len(snapshot.Revisions); index < len(files); index++ {
		statements, err := files[index].Stmts()
		if err != nil || len(statements) != expected.Migrations[index].Total {
			return apperror.New("DATABASE_MIGRATION_FAILED", "TDSQL migration 语句集合无效", err)
		}
		if err := applyOwnedTDSQLMigration(
			ctx,
			db,
			files[index],
			expected.Migrations[index],
			statements,
		); err != nil {
			return err
		}
	}
	return nil
}

func isCompleteTDSQLPrefix(
	snapshot TDSQLSnapshot,
	expected tdsqlRuntimeExpectation,
) bool {
	if len(snapshot.Revisions) == 0 || len(snapshot.Revisions) >= len(expected.Migrations) {
		return false
	}
	for index, revision := range snapshot.Revisions {
		migration := expected.Migrations[index]
		if revision.Version != migration.Version || revision.Hash != migration.Hash ||
			revision.Total != migration.Total || revision.Applied != revision.Total ||
			revision.Error != "" || len(revision.PartialHashes) != 0 ||
			!claimIDPattern.MatchString(revision.ClaimID) {
			return false
		}
	}
	return sameTableSet(
		snapshot.UserTables,
		tablesAfterRevisions(expected, len(snapshot.Revisions)),
	)
}

func applyOwnedTDSQLMigration(
	ctx context.Context,
	db *sql.DB,
	file atlasmigrate.File,
	expected tdsqlMigrationExpectation,
	statements []string,
) error {
	if err := ensureTDSQLRevisionTable(ctx, db); err != nil {
		return apperror.New("DATABASE_MIGRATION_FAILED", "无法初始化 TDSQL revision control", err)
	}
	claimID, err := newClaimID()
	if err != nil {
		return apperror.New("DATABASE_MIGRATION_FAILED", "无法生成 TDSQL migration owner", err)
	}
	revision := &atlasmigrate.Revision{
		Version:         expected.Version,
		Description:     file.Desc(),
		Applied:         0,
		Total:           expected.Total,
		ExecutedAt:      time.Now().UTC(),
		Hash:            expected.Hash,
		OperatorVersion: "chatserver-v1",
	}
	outcome, err := claimRevision(ctx, db, revision, claimID)
	if err != nil || outcome == ClaimFailed {
		return apperror.New("DATABASE_MIGRATION_FAILED", "无法声明 TDSQL baseline owner", err)
	}
	if outcome == ClaimDuplicate {
		snapshot, inspectErr := readTDSQLSnapshot(ctx, db)
		if inspectErr != nil {
			return apperror.New("DATABASE_MIGRATION_FAILED", "无法读取并发 TDSQL migration 状态", inspectErr)
		}
		for _, competing := range snapshot.Revisions {
			if competing.Version == expected.Version && competing.Hash == expected.Hash &&
				competing.Total == expected.Total && competing.Applied == competing.Total &&
				competing.Error == "" && len(competing.PartialHashes) == 0 {
				return nil
			}
		}
		return apperror.New(
			"DATABASE_MIGRATION_UNSAFE",
			"另一个进程已经声明了同一 TDSQL migration",
			nil,
		)
	}
	if outcome != ClaimWon {
		return apperror.New(
			"DATABASE_MIGRATION_FAILED",
			fmt.Sprintf("无法识别 TDSQL claim 结果 %q", outcome),
			nil,
		)
	}
	if err := executeOwnedStatements(ctx, db, revision, claimID, statements); err != nil {
		return apperror.New("DATABASE_MIGRATION_FAILED", "TDSQL migration 执行失败", err)
	}
	return nil
}
