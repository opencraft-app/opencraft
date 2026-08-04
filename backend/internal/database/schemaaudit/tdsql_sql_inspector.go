package schemaaudit

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"

	gomysql "github.com/go-sql-driver/mysql"
)

var (
	errTDSQLPlatformMismatch = errors.New("TDSQL platform mismatch")
	errTDSQLAuditForbidden   = errors.New("TDSQL audit forbidden")
)

type sqlTDSQLInspector struct{ db *sql.DB }

func (inspector sqlTDSQLInspector) Topology(ctx context.Context) ([]Set, error) {
	rows, err := inspector.db.QueryContext(ctx, "/*proxy*/show status")
	if err != nil {
		return nil, classifyTDSQLAuditError(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var rawRows [][][]byte
	for rows.Next() {
		values, err := scanRawValues(rows, len(columns))
		if err != nil {
			return nil, err
		}
		rawRows = append(rawRows, values)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	observations, err := parseTopologyObservations(columns, rawRows)
	if err != nil {
		return nil, err
	}
	sets, err := normalizeTopology(observations)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errTDSQLPlatformMismatch, err)
	}
	return sets, nil
}

func parseTopologyObservations(
	columns []string,
	rows [][][]byte,
) ([]TopologyObservation, error) {
	identityIndex := topologyColumnIndex(
		columns,
		[]string{"set", "set_id", "setid", "set_name", "alias"},
	)
	rangeIndex := topologyColumnIndex(columns, []string{"hash_range", "hashrange"})
	if identityIndex >= 0 && rangeIndex >= 0 {
		observations := make([]TopologyObservation, 0, len(rows))
		for _, values := range rows {
			if len(values) != len(columns) {
				return nil, errTDSQLPlatformMismatch
			}
			observations = append(observations, TopologyObservation{
				OpaqueID:  string(values[identityIndex]),
				HashRange: string(values[rangeIndex]),
			})
		}
		return observations, nil
	}

	statusNameIndex := topologyColumnIndex(columns, []string{"status_name"})
	valueIndex := topologyColumnIndex(columns, []string{"value"})
	if statusNameIndex < 0 || valueIndex < 0 {
		return nil, errTDSQLPlatformMismatch
	}
	const hashRangeSuffix = ":hash_range"
	observations := make([]TopologyObservation, 0, len(rows))
	for _, values := range rows {
		if len(values) != len(columns) {
			return nil, errTDSQLPlatformMismatch
		}
		statusName := strings.TrimSpace(string(values[statusNameIndex]))
		if !strings.HasSuffix(statusName, hashRangeSuffix) {
			continue
		}
		opaqueID := strings.TrimSpace(strings.TrimSuffix(statusName, hashRangeSuffix))
		if opaqueID == "" {
			return nil, errTDSQLPlatformMismatch
		}
		observations = append(observations, TopologyObservation{
			OpaqueID:  opaqueID,
			HashRange: strings.TrimSpace(string(values[valueIndex])),
		})
	}
	if len(observations) == 0 {
		return nil, errTDSQLPlatformMismatch
	}
	return observations, nil
}

func (inspector sqlTDSQLInspector) BusinessTables(ctx context.Context) ([]string, error) {
	rows, err := inspector.db.QueryContext(ctx, `
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
		  AND table_name <> ?
		ORDER BY table_name
	`, revisionTable)
	if err != nil {
		return nil, classifyTDSQLAuditError(err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			return nil, err
		}
		tables = append(tables, table)
	}
	return tables, rows.Err()
}

func (inspector sqlTDSQLInspector) ShowCreate(
	ctx context.Context,
	table string,
) (string, error) {
	var returnedName, createSQL string
	err := inspector.db.QueryRowContext(
		ctx,
		"SHOW CREATE TABLE "+quoteMySQLIdentifier(table),
	).Scan(&returnedName, &createSQL)
	if err != nil {
		return "", classifyTDSQLAuditError(err)
	}
	if returnedName != table {
		return "", fmt.Errorf("SHOW CREATE returned another table")
	}
	return createSQL, nil
}

func quoteMySQLIdentifier(value string) string {
	return "`" + strings.ReplaceAll(value, "`", "``") + "`"
}

func (inspector sqlTDSQLInspector) Columns(
	ctx context.Context,
	table string,
) ([]ColumnObservation, error) {
	rows, err := inspector.db.QueryContext(ctx, `
		SELECT column_name, column_type, is_nullable,
		       character_set_name, collation_name, column_default
		FROM information_schema.columns
		WHERE table_schema = DATABASE() AND table_name = ?
		ORDER BY ordinal_position
	`, table)
	if err != nil {
		return nil, classifyTDSQLAuditError(err)
	}
	defer rows.Close()
	var columns []ColumnObservation
	for rows.Next() {
		var (
			column                ColumnObservation
			nullable              string
			characterSet, collate sql.NullString
			defaultValue          sql.NullString
		)
		if err := rows.Scan(
			&column.Name,
			&column.Type,
			&nullable,
			&characterSet,
			&collate,
			&defaultValue,
		); err != nil {
			return nil, err
		}
		column.Nullable = nullable == "YES"
		column.CharacterSet = characterSet.String
		column.Collation = collate.String
		column.DefaultValue = defaultValue.String
		column.DefaultValid = defaultValue.Valid
		columns = append(columns, column)
	}
	return columns, rows.Err()
}

func (inspector sqlTDSQLInspector) Allsets(
	ctx context.Context,
	table string,
) ([]AllsetsObservation, error) {
	query, err := allsetsQuery(table)
	if err != nil {
		return nil, err
	}
	rows, err := inspector.db.QueryContext(ctx, query)
	if err != nil {
		return nil, classifyTDSQLAuditError(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	if len(columns) != 2 {
		return nil, errTDSQLPlatformMismatch
	}
	var observations []AllsetsObservation
	for rows.Next() {
		values, err := scanRawValues(rows, 2)
		if err != nil {
			return nil, err
		}
		count, err := strconv.Atoi(string(values[0]))
		if err != nil {
			return nil, errTDSQLPlatformMismatch
		}
		observations = append(observations, AllsetsObservation{
			Count: count, OpaqueID: strings.TrimSpace(string(values[1])),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return observations, nil
}

func allsetsQuery(table string) (string, error) {
	if table == "" {
		return "", fmt.Errorf("physical table name is empty")
	}
	for _, character := range table {
		if (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '_' {
			return "", fmt.Errorf("physical table name is invalid")
		}
	}
	return `/*sets:allsets*/ SELECT COUNT(*) AS table_count
		FROM information_schema.tables
		WHERE table_schema = DATABASE() AND table_name = '` + table + `'
	`, nil
}

func topologyColumnIndex(columns []string, candidates []string) int {
	for _, candidate := range candidates {
		for index, column := range columns {
			normalized := strings.ToLower(strings.TrimSpace(column))
			if normalized == candidate {
				return index
			}
		}
	}
	return -1
}

func scanRawValues(rows *sql.Rows, count int) ([][]byte, error) {
	values := make([]sql.RawBytes, count)
	destinations := make([]any, count)
	for index := range values {
		destinations[index] = &values[index]
	}
	if err := rows.Scan(destinations...); err != nil {
		return nil, err
	}
	result := make([][]byte, count)
	for index := range values {
		result[index] = append([]byte(nil), values[index]...)
	}
	return result, nil
}

func classifyTDSQLAuditError(err error) error {
	var mysqlError *gomysql.MySQLError
	if errors.As(err, &mysqlError) {
		switch mysqlError.Number {
		case 1044, 1045, 1142, 1227:
			return fmt.Errorf("%w: %v", errTDSQLAuditForbidden, err)
		}
	}
	return err
}
