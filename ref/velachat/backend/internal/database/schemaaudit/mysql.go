package schemaaudit

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"chatserver/internal/apperror"
	"chatserver/internal/database/physicalschema"
	"entgo.io/ent/dialect"
	entschema "entgo.io/ent/dialect/sql/schema"
	"entgo.io/ent/schema/field"
)

// VerifyTDSQL 对当前 TDSQL 平台、拓扑和物理 Schema 做纯只读严格校验。
func VerifyTDSQL(ctx context.Context, db *sql.DB) error {
	if err := db.PingContext(ctx); err != nil {
		return apperror.New("DATABASE_INTEGRITY_FAILED", "TDSQL 连接检查失败", err)
	}
	catalog, err := physicalschema.Current()
	if err != nil {
		return apperror.New("DATABASE_SCHEMA_MISMATCH", "无法构建 TDSQL 物理规格", err)
	}
	err = verifyTDSQLInspector(ctx, sqlTDSQLInspector{db: db}, catalog)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errTDSQLPlatformMismatch):
		return apperror.New("DATABASE_PLATFORM_MISMATCH", "数据库不是受支持的 TDSQL Proxy", err)
	case errors.Is(err, errTDSQLAuditForbidden):
		return apperror.New("DATABASE_AUDIT_FORBIDDEN", "TDSQL 只读物理审计权限不足", err)
	default:
		return apperror.New("DATABASE_SCHEMA_MISMATCH", "TDSQL 物理 Schema 与程序规格不一致", err)
	}
}

func mysqlType(column *entschema.Column) string {
	if value := column.SchemaType[dialect.MySQL]; value != "" {
		return strings.ToLower(value)
	}
	switch column.Type {
	case field.TypeString, field.TypeEnum:
		if column.Size > 65535 {
			return "longtext"
		}
		size := column.Size
		if size <= 0 {
			size = 255
		}
		return fmt.Sprintf("varchar(%d)", size)
	case field.TypeBytes:
		if column.Size > 0 {
			return fmt.Sprintf("varbinary(%d)", column.Size)
		}
		return "longblob"
	case field.TypeTime:
		return "datetime(6)"
	case field.TypeBool:
		return "tinyint(1)"
	default:
		if column.Type.Integer() {
			return "bigint"
		}
		if column.Type.Float() {
			return "double"
		}
		return strings.ToLower(column.Type.String())
	}
}

func normalizeMySQLType(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimSuffix(value, " unsigned")
	if strings.HasPrefix(value, "bigint(") {
		return "bigint"
	}
	return value
}
