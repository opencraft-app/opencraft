// Package migration 执行编译进二进制的版本化 migration。
package migration

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"sync/atomic"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	atlasmysql "ariga.io/atlas/sql/mysql"
	atlasschema "ariga.io/atlas/sql/schema"
	atlassqlite "ariga.io/atlas/sql/sqlite"
	"chatserver/internal/apperror"
	"chatserver/internal/config"
	embedded "chatserver/migrations"
)

var memDirSequence atomic.Uint64

// Apply 校验并应用所有内嵌的 pending SQLite migration。
func Apply(ctx context.Context, db *sql.DB) error {
	return ApplyFor(ctx, db, config.DatabaseDriverSQLite)
}

// ApplyFor 校验并应用指定方言的全部 pending migration。
func ApplyFor(ctx context.Context, db *sql.DB, dialect config.DatabaseDriver) error {
	dir, err := embeddedDirFor(dialect)
	if err != nil {
		return apperror.New("MIGRATION_FAILED", "无法加载内嵌数据库迁移", err)
	}
	defer dir.Close()
	return applyDirFor(ctx, db, dir, dialect)
}

func applyDir(ctx context.Context, db *sql.DB, dir atlasmigrate.Dir) error {
	return applyDirFor(ctx, db, dir, config.DatabaseDriverSQLite)
}

func applyDirFor(
	ctx context.Context,
	db *sql.DB,
	dir atlasmigrate.Dir,
	dialect config.DatabaseDriver,
) error {
	if err := atlasmigrate.Validate(dir); err != nil {
		return apperror.New("MIGRATION_CHECKSUM_MISMATCH", "数据库迁移校验和不一致", err)
	}
	if dialect == config.DatabaseDriverTDSQL {
		return applyTDSQLBaseline(ctx, db, dir)
	}
	driver, err := openDriver(db, dialect)
	if err != nil {
		return apperror.New("MIGRATION_FAILED", "无法初始化数据库迁移驱动", err)
	}
	executor, err := atlasmigrate.NewExecutor(
		driver,
		dir,
		&revisionStore{db: db, dialect: dialect},
		atlasmigrate.WithOperatorVersion("chatserver-v1"),
	)
	if err != nil {
		return apperror.New("MIGRATION_FAILED", "无法初始化数据库迁移执行器", err)
	}
	pending, err := executor.Pending(ctx)
	if errors.Is(err, atlasmigrate.ErrNoPendingFiles) {
		return nil
	}
	if err != nil {
		return apperror.New("MIGRATION_FAILED", "无法读取待执行数据库迁移", err)
	}
	for _, file := range pending {
		if err := executeFileFor(ctx, db, dir, file, dialect); err != nil {
			return apperror.New("MIGRATION_FAILED", "数据库迁移执行失败", err)
		}
	}
	return nil
}

func executeFile(ctx context.Context, db *sql.DB, dir atlasmigrate.Dir, file atlasmigrate.File) error {
	return executeFileFor(ctx, db, dir, file, config.DatabaseDriverSQLite)
}

func executeFileFor(
	ctx context.Context,
	db *sql.DB,
	dir atlasmigrate.Dir,
	file atlasmigrate.File,
	dialect config.DatabaseDriver,
) error {
	if dialect == config.DatabaseDriverTDSQL {
		driver, err := openDriver(db, dialect)
		if err != nil {
			return err
		}
		executor, err := atlasmigrate.NewExecutor(
			driver,
			dir,
			&revisionStore{db: db, dialect: dialect},
			atlasmigrate.WithOperatorVersion("chatserver-v1"),
		)
		if err != nil {
			return err
		}
		// MySQL DDL 会隐式提交；Atlas revision 的逐语句记录负责失败续跑。
		return executor.Execute(ctx, file)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	driver, err := openDriver(tx, dialect)
	if err != nil {
		return err
	}
	executor, err := atlasmigrate.NewExecutor(
		driver,
		dir,
		&revisionStore{db: tx, dialect: dialect},
		atlasmigrate.WithOperatorVersion("chatserver-v1"),
	)
	if err != nil {
		return err
	}
	if err := executor.Execute(ctx, file); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

func embeddedDir() (*atlasmigrate.MemDir, error) {
	return embeddedDirFor(config.DatabaseDriverSQLite)
}

func embeddedDirFor(dialect config.DatabaseDriver) (*atlasmigrate.MemDir, error) {
	if dialect != config.DatabaseDriverSQLite && dialect != config.DatabaseDriverTDSQL {
		return nil, fmt.Errorf("unsupported database dialect")
	}
	sub, err := fs.Sub(embedded.FS, string(dialect))
	if err != nil {
		return nil, err
	}
	entries, err := fs.ReadDir(sub, ".")
	if err != nil {
		return nil, err
	}
	name := fmt.Sprintf("chatserver-embedded-%d", memDirSequence.Add(1))
	dir := atlasmigrate.OpenMemDir(name)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		data, err := fs.ReadFile(sub, entry.Name())
		if err != nil {
			_ = dir.Close()
			return nil, err
		}
		if err := dir.WriteFile(entry.Name(), data); err != nil {
			_ = dir.Close()
			return nil, err
		}
	}
	return dir, nil
}

func openDriver(db atlasschema.ExecQuerier, dialect config.DatabaseDriver) (atlasmigrate.Driver, error) {
	switch dialect {
	case config.DatabaseDriverSQLite:
		return atlassqlite.Open(db)
	case config.DatabaseDriverTDSQL:
		return atlasmysql.Open(db)
	default:
		return nil, fmt.Errorf("unsupported database dialect")
	}
}
