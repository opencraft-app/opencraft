package database

import (
	"context"
	"database/sql"

	"chatserver/internal/apperror"
	"chatserver/internal/config"
	"chatserver/internal/database/migration"
	"chatserver/internal/database/platform"
	"chatserver/internal/database/schemaaudit"
)

type staticAdapter struct {
	driver       config.DatabaseDriver
	capabilities platform.Capabilities
}

func (a staticAdapter) Driver() config.DatabaseDriver { return a.driver }

func (a staticAdapter) Capabilities() platform.Capabilities { return a.capabilities }

func (a staticAdapter) Open(
	ctx context.Context,
	cfg config.Database,
	mode platform.OpenMode,
) (platform.Handle, error) {
	if cfg.Driver != a.driver {
		return nil, apperror.New("CONFIG_INVALID", "数据库适配器与配置方言不一致", nil)
	}
	switch a.driver {
	case config.DatabaseDriverSQLite:
		switch mode {
		case platform.OpenModeWriter:
			return openSQLiteWriter(ctx, cfg)
		case platform.OpenModeReadOnly:
			return openSQLiteReadOnly(ctx, cfg)
		}
	case config.DatabaseDriverTDSQL:
		switch mode {
		case platform.OpenModeWriter:
			return openTDSQL(ctx, cfg, true)
		case platform.OpenModeReadOnly:
			return openTDSQL(ctx, cfg, false)
		}
	}
	return nil, apperror.New("CONFIG_INVALID", "数据库连接模式不受支持", nil)
}

func (a staticAdapter) Migrate(ctx context.Context, db *sql.DB) error {
	return migration.ApplyFor(ctx, db, a.driver)
}

func (a staticAdapter) MigrationStatus(
	ctx context.Context,
	db *sql.DB,
) (platform.MigrationState, error) {
	info, err := migration.StatusFor(ctx, db, a.driver)
	if err != nil {
		return platform.MigrationState{}, err
	}
	var kind platform.MigrationStateKind
	switch info.Kind {
	case migration.StateEmpty:
		kind = platform.MigrationStateEmpty
	case migration.StateClean:
		kind = platform.MigrationStateClean
	case migration.StatePending:
		kind = platform.MigrationStatePending
	case migration.StateDirty:
		kind = platform.MigrationStateDirty
	case migration.StateUnsafe:
		kind = platform.MigrationStateUnsafe
	default:
		return platform.MigrationState{}, apperror.New(
			"DATABASE_MIGRATION_UNSAFE",
			"数据库迁移状态无法识别",
			nil,
		)
	}
	return platform.MigrationState{
		Kind:              kind,
		Reason:            info.Reason,
		CurrentVersion:    info.CurrentVersion,
		LatestVersion:     info.LatestVersion,
		Applied:           info.Applied,
		Pending:           info.Pending,
		AppliedStatements: info.AppliedStatements,
		TotalStatements:   info.TotalStatements,
	}, nil
}

func (a staticAdapter) VerifySchema(ctx context.Context, db *sql.DB) error {
	return schemaaudit.Verify(ctx, db, a.driver)
}

// AdapterFor 返回正式数据库方言对应的高层适配器。
func AdapterFor(driver config.DatabaseDriver) (platform.Adapter, error) {
	switch driver {
	case config.DatabaseDriverSQLite:
		return staticAdapter{
			driver: driver,
			capabilities: platform.Capabilities{
				TransactionalDDL: true,
			},
		}, nil
	case config.DatabaseDriverTDSQL:
		return staticAdapter{
			driver: driver,
			capabilities: platform.Capabilities{
				PhysicalSharding:   true,
				RequiresProxyAudit: true,
			},
		}, nil
	default:
		return nil, apperror.New("CONFIG_INVALID", "数据库方言不受支持", nil)
	}
}
