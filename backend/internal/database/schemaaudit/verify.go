package schemaaudit

import (
	"context"
	"database/sql"

	"chatserver/internal/apperror"
	"chatserver/internal/config"
)

// Verify 按显式方言执行只读 schema audit。
func Verify(ctx context.Context, db *sql.DB, dialect config.DatabaseDriver) error {
	switch dialect {
	case config.DatabaseDriverSQLite:
		return VerifySQLite(ctx, db)
	case config.DatabaseDriverTDSQL:
		return VerifyTDSQL(ctx, db)
	default:
		return apperror.New("CONFIG_INVALID", "数据库方言不受支持", nil)
	}
}
