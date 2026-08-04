package schemaaudit

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"chatserver/internal/database/physicalschema"
	"chatserver/internal/database/tdsqlddl"
)

// ColumnObservation 是 information_schema.columns 的只读规范化投影。
type ColumnObservation struct {
	Name         string
	Type         string
	Nullable     bool
	CharacterSet string
	Collation    string
	DefaultValue string
	DefaultValid bool
}

type tdsqlInspector interface {
	Topology(context.Context) ([]Set, error)
	BusinessTables(context.Context) ([]string, error)
	ShowCreate(context.Context, string) (string, error)
	Columns(context.Context, string) ([]ColumnObservation, error)
	Allsets(context.Context, string) ([]AllsetsObservation, error)
}

func verifyTDSQLInspector(
	ctx context.Context,
	inspector tdsqlInspector,
	catalog *physicalschema.Catalog,
) error {
	sets, err := inspector.Topology(ctx)
	if err != nil {
		return err
	}
	actualTables, err := inspector.BusinessTables(ctx)
	if err != nil {
		return err
	}
	specs := catalog.Tables()
	expectedTables := make([]string, 0, len(specs))
	for _, spec := range specs {
		expectedTables = append(expectedTables, spec.Name)
	}
	slices.Sort(actualTables)
	slices.Sort(expectedTables)
	var problems []error
	if !slices.Equal(actualTables, expectedTables) {
		problems = append(problems, fmt.Errorf("business table set mismatch"))
	}
	for _, spec := range specs {
		createSQL, err := inspector.ShowCreate(ctx, spec.Name)
		if err != nil {
			problems = append(problems, fmt.Errorf("table %s SHOW CREATE failed: %w", spec.Name, err))
			continue
		}
		parsed, err := tdsqlddl.ParseDocument(createSQL)
		if err != nil || len(parsed) != 1 {
			problems = append(problems, fmt.Errorf("table %s SHOW CREATE is invalid", spec.Name))
			continue
		}
		if violations := tdsqlddl.ComparePhysical(parsed[0], spec); len(violations) != 0 {
			problems = append(problems, fmt.Errorf("table %s: %s", spec.Name, violations[0].Message))
		}
		columns, err := inspector.Columns(ctx, spec.Name)
		if err != nil {
			problems = append(problems, fmt.Errorf("table %s columns failed: %w", spec.Name, err))
		} else if err := comparePhysicalColumns(columns, spec); err != nil {
			problems = append(problems, fmt.Errorf("table %s: %w", spec.Name, err))
		}
		observations, err := inspector.Allsets(ctx, spec.Name)
		if err != nil {
			problems = append(problems, fmt.Errorf("table %s allsets failed: %w", spec.Name, err))
		} else if err := verifyAllsetsVector(sets, observations); err != nil {
			problems = append(problems, fmt.Errorf("table %s: %w", spec.Name, err))
		}
	}
	return errors.Join(problems...)
}

func comparePhysicalColumns(
	actual []ColumnObservation,
	spec physicalschema.TableSpec,
) error {
	if len(actual) != len(spec.Desired.Columns) {
		return fmt.Errorf("column count mismatch")
	}
	for index, expected := range spec.Desired.Columns {
		column := actual[index]
		if column.Name != expected.Name ||
			normalizeMySQLType(column.Type) != normalizeMySQLType(mysqlType(expected)) ||
			column.Nullable != expected.Nullable ||
			!mysqlDefaultMatches(column.DefaultValue, column.DefaultValid, expected.Default) {
			return fmt.Errorf("column %s definition mismatch", expected.Name)
		}
		if expected.Name == spec.ShardKey &&
			(!strings.EqualFold(column.CharacterSet, spec.Route.CharacterSet) ||
				!strings.EqualFold(column.Collation, spec.Route.Collation)) {
			return fmt.Errorf("route column %s character semantics mismatch", expected.Name)
		}
	}
	return nil
}

func mysqlDefaultMatches(actual string, valid bool, expected any) bool {
	if expected == nil {
		return !valid
	}
	if !valid {
		return false
	}
	value := strings.TrimSpace(actual)
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
