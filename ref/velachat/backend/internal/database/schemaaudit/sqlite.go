package schemaaudit

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"chatserver/internal/apperror"
	entmigrate "chatserver/internal/ent/migrate"
	"entgo.io/ent/dialect"
	entschema "entgo.io/ent/dialect/sql/schema"
	"entgo.io/ent/schema/field"
)

const revisionTable = "atlas_schema_revisions"

// VerifySQLite 对业务表、列、主键、索引、外键和完整性做只读校验。
func VerifySQLite(ctx context.Context, db *sql.DB) error {
	var integrity string
	if err := db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil {
		return apperror.New("DATABASE_INTEGRITY_FAILED", "SQLite 完整性检查失败", err)
	}
	if integrity != "ok" {
		return apperror.New("DATABASE_INTEGRITY_FAILED", "SQLite 完整性检查未通过", nil)
	}
	if err := verifyPragmas(ctx, db); err != nil {
		return apperror.New("SCHEMA_DRIFT", "SQLite 关键连接参数与程序规格不一致", err)
	}
	if err := verifyTables(ctx, db); err != nil {
		return apperror.New("SCHEMA_DRIFT", "SQLite Schema 与程序规格不一致", err)
	}
	return nil
}

func verifyPragmas(ctx context.Context, db *sql.DB) error {
	var journalMode string
	var synchronous, foreignKeys int
	checks := []struct {
		query string
		dest  any
	}{
		{query: "PRAGMA journal_mode", dest: &journalMode},
		{query: "PRAGMA synchronous", dest: &synchronous},
		{query: "PRAGMA foreign_keys", dest: &foreignKeys},
	}
	for _, check := range checks {
		if err := db.QueryRowContext(ctx, check.query).Scan(check.dest); err != nil {
			return err
		}
	}
	if journalMode != "wal" || synchronous != 2 || foreignKeys != 0 {
		return fmt.Errorf(
			"unexpected pragmas: journal_mode=%s synchronous=%d foreign_keys=%d",
			journalMode,
			synchronous,
			foreignKeys,
		)
	}
	return nil
}

func verifyTables(ctx context.Context, db *sql.DB) error {
	actual, err := actualBusinessTables(ctx, db)
	if err != nil {
		return err
	}
	expectedNames := make([]string, 0, len(entmigrate.Tables))
	for _, table := range entmigrate.Tables {
		expectedNames = append(expectedNames, table.Name)
	}
	slices.Sort(actual)
	slices.Sort(expectedNames)
	if !slices.Equal(actual, expectedNames) {
		return fmt.Errorf("business tables mismatch: got=%v want=%v", actual, expectedNames)
	}
	for _, table := range entmigrate.Tables {
		if err := verifyTable(ctx, db, table); err != nil {
			return fmt.Errorf("table %s: %w", table.Name, err)
		}
	}
	return nil
}

func actualBusinessTables(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT name
		FROM sqlite_schema
		WHERE type = 'table'
		  AND name NOT LIKE 'sqlite_%'
		  AND name <> ?
		ORDER BY name
	`, revisionTable)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

func verifyTable(ctx context.Context, db *sql.DB, expected *entschema.Table) error {
	columns, err := sqliteColumns(ctx, db, expected.Name)
	if err != nil {
		return err
	}
	if len(columns) != len(expected.Columns) {
		return fmt.Errorf("column count %d != %d", len(columns), len(expected.Columns))
	}
	expectedPK := make(map[string]struct{}, len(expected.PrimaryKey))
	for _, column := range expected.PrimaryKey {
		expectedPK[column.Name] = struct{}{}
	}
	for _, column := range expected.Columns {
		actual, ok := columns[column.Name]
		if !ok {
			return fmt.Errorf("missing column %s", column.Name)
		}
		if actual.columnType != sqliteType(column) {
			return fmt.Errorf("column %s type %s != %s", column.Name, actual.columnType, sqliteType(column))
		}
		if actual.nullable != column.Nullable {
			return fmt.Errorf("column %s nullable %v != %v", column.Name, actual.nullable, column.Nullable)
		}
		_, primary := expectedPK[column.Name]
		if actual.primary != primary {
			return fmt.Errorf("column %s primary %v != %v", column.Name, actual.primary, primary)
		}
		if !sqliteDefaultMatches(actual.defaultValue, column.Default) {
			return fmt.Errorf(
				"column %s default %q does not match desired value",
				column.Name,
				actual.defaultValue.String,
			)
		}
	}
	if err := verifyIndexes(ctx, db, expected); err != nil {
		return err
	}
	rows, err := db.QueryContext(ctx, "PRAGMA foreign_key_list("+quoteIdentifier(expected.Name)+")")
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return fmt.Errorf("unexpected foreign key")
	}
	return nil
}

func sqliteDefaultMatches(actual sql.NullString, expected any) bool {
	if expected == nil {
		return !actual.Valid
	}
	if !actual.Valid {
		return false
	}
	value := strings.TrimSpace(actual.String)
	for len(value) >= 2 && value[0] == '(' && value[len(value)-1] == ')' {
		value = strings.TrimSpace(value[1 : len(value)-1])
	}
	switch expected := expected.(type) {
	case bool:
		if expected {
			return strings.EqualFold(value, "true") || value == "1"
		}
		return strings.EqualFold(value, "false") || value == "0"
	case int:
		parsed, err := strconv.ParseInt(value, 10, 64)
		return err == nil && parsed == int64(expected)
	case int64:
		parsed, err := strconv.ParseInt(value, 10, 64)
		return err == nil && parsed == expected
	case string:
		if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
			value = strings.ReplaceAll(value[1:len(value)-1], "''", "'")
		}
		return value == expected
	default:
		return false
	}
}

type sqliteColumn struct {
	columnType   string
	nullable     bool
	primary      bool
	defaultValue sql.NullString
}

func sqliteColumns(ctx context.Context, db *sql.DB, table string) (map[string]sqliteColumn, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+quoteIdentifier(table)+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make(map[string]sqliteColumn)
	for rows.Next() {
		var (
			cid          int
			name         string
			columnType   string
			notNull      int
			defaultValue sql.NullString
			primary      int
		)
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primary); err != nil {
			return nil, err
		}
		columns[name] = sqliteColumn{
			columnType:   strings.ToLower(columnType),
			nullable:     notNull == 0,
			primary:      primary > 0,
			defaultValue: defaultValue,
		}
	}
	return columns, rows.Err()
}

func verifyIndexes(ctx context.Context, db *sql.DB, table *entschema.Table) error {
	type indexMetadata struct {
		name   string
		unique bool
	}
	var metadata []indexMetadata
	rows, err := db.QueryContext(ctx, "PRAGMA index_list("+quoteIdentifier(table.Name)+")")
	if err != nil {
		return err
	}
	for rows.Next() {
		var seq, unique, partial int
		var name, origin string
		if err := rows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
			rows.Close()
			return err
		}
		if origin != "c" {
			continue
		}
		metadata = append(metadata, indexMetadata{name: name, unique: unique == 1})
	}
	if err := rows.Close(); err != nil {
		return err
	}

	actual := make([]string, 0, len(metadata))
	for _, index := range metadata {
		columns, err := sqliteIndexColumns(ctx, db, index.name)
		if err != nil {
			return err
		}
		actual = append(actual, indexSignature(index.unique, columns))
	}

	expected := make([]string, 0, len(table.Indexes))
	for _, index := range table.Indexes {
		columns := make([]string, 0, len(index.Columns))
		for _, column := range index.Columns {
			columns = append(columns, column.Name)
		}
		expected = append(expected, indexSignature(index.Unique, columns))
	}
	slices.Sort(actual)
	slices.Sort(expected)
	if !slices.Equal(actual, expected) {
		return fmt.Errorf("indexes mismatch: got=%v want=%v", actual, expected)
	}
	return nil
}

func sqliteIndexColumns(ctx context.Context, db *sql.DB, index string) ([]string, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA index_info("+quoteIdentifier(index)+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var columns []string
	for rows.Next() {
		var seq, cid int
		var name string
		if err := rows.Scan(&seq, &cid, &name); err != nil {
			return nil, err
		}
		columns = append(columns, name)
	}
	return columns, rows.Err()
}

func indexSignature(unique bool, columns []string) string {
	return fmt.Sprintf("%t|%s", unique, strings.Join(columns, ","))
}

func sqliteType(column *entschema.Column) string {
	if value := column.SchemaType[dialect.SQLite]; value != "" {
		return strings.ToLower(value)
	}
	switch column.Type {
	case field.TypeString, field.TypeEnum, field.TypeJSON:
		return "text"
	case field.TypeBytes:
		return "blob"
	case field.TypeTime:
		return "datetime"
	case field.TypeBool:
		return "bool"
	default:
		if column.Type.Integer() {
			return "integer"
		}
		if column.Type.Float() {
			return "real"
		}
		return strings.ToLower(column.Type.String())
	}
}

func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}
