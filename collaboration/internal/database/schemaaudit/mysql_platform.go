package schemaaudit

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	"git.woa.com/wisp/mono2/collaboration/internal/database/physicalschema"
	"git.woa.com/wisp/mono2/collaboration/internal/database/tdsqlddl"
)

type mysqlInspector interface {
	BusinessTables(context.Context) ([]string, error)
	ShowCreate(context.Context, string) (string, error)
	Columns(context.Context, string) ([]ColumnObservation, error)
}

func VerifyMySQL(ctx context.Context, db *sql.DB) error {
	if err := db.PingContext(ctx); err != nil {
		return apperror.New("DATABASE_INTEGRITY_FAILED", "MySQL 连接检查失败", err)
	}
	catalog, err := physicalschema.Current()
	if err != nil {
		return apperror.New("DATABASE_SCHEMA_MISMATCH", "无法构建 MySQL 规格", err)
	}
	if err := verifyMySQLInspector(ctx, sqlTDSQLInspector{db: db}, catalog); err != nil {
		return apperror.New("DATABASE_SCHEMA_MISMATCH", "MySQL Schema 与程序规格不一致", err)
	}
	return nil
}

func verifyMySQLInspector(ctx context.Context, inspector mysqlInspector, catalog *physicalschema.Catalog) error {
	actual, err := inspector.BusinessTables(ctx)
	if err != nil {
		return err
	}
	expected := make([]string, 0, len(catalog.Tables()))
	for _, spec := range catalog.Tables() {
		expected = append(expected, spec.Name)
	}
	slices.Sort(actual)
	slices.Sort(expected)
	var problems []error
	if !slices.Equal(actual, expected) {
		problems = append(problems, fmt.Errorf("business table set mismatch"))
	}
	for _, spec := range catalog.Tables() {
		createSQL, err := inspector.ShowCreate(ctx, spec.Name)
		if err != nil {
			problems = append(problems, err)
			continue
		}
		tables, err := tdsqlddl.ParseDocument(createSQL)
		if err != nil || len(tables) != 1 {
			problems = append(problems, fmt.Errorf("table %s SHOW CREATE is invalid", spec.Name))
			continue
		}
		if violations := tdsqlddl.CompareMySQL(tables[0], spec); len(violations) != 0 {
			problems = append(problems, fmt.Errorf("table %s: %s", spec.Name, violations[0].Message))
		}
		columns, err := inspector.Columns(ctx, spec.Name)
		if err != nil {
			problems = append(problems, err)
		} else if err := comparePhysicalColumns(columns, spec); err != nil {
			problems = append(problems, fmt.Errorf("table %s: %w", spec.Name, err))
		}
	}
	return errors.Join(problems...)
}
