package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

type policySQLQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// ExecPolicySQL is the synchronous SQL entry point exposed to the trusted QuickJS
// policy. It eagerly materializes rows so no database cursor crosses the JS
// invocation boundary.
func (s *Store) ExecPolicySQL(query string, bindings []any) ([]string, [][]any, int64, error) {
	if err := validatePolicySQL(query, bindings); err != nil {
		return nil, nil, 0, err
	}
	conn, err := s.db.Conn(context.Background())
	if err != nil {
		return nil, nil, 0, err
	}
	defer conn.Close()
	return execPolicySQL(conn, query, bindings)
}

// TransactionPolicySQL runs a synchronous QuickJS callback against one SQLite
// transaction. Returning an error rolls the entire callback back.
func (s *Store) TransactionPolicySQL(callback func(func(string, []any) ([]string, [][]any, int64, error)) error) error {
	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	exec := func(query string, bindings []any) ([]string, [][]any, int64, error) {
		if err := validatePolicySQL(query, bindings); err != nil {
			return nil, nil, 0, err
		}
		return execPolicySQL(tx, query, bindings)
	}
	if err := callback(exec); err != nil {
		return err
	}
	return tx.Commit()
}

func execPolicySQL(db policySQLQueryer, query string, bindings []any) ([]string, [][]any, int64, error) {
	ctx := context.Background()
	var before int64
	if err := db.QueryRowContext(ctx, `SELECT total_changes()`).Scan(&before); err != nil {
		return nil, nil, 0, err
	}
	rows, err := db.QueryContext(ctx, query, bindings...)
	if err != nil {
		return nil, nil, 0, err
	}
	columns, err := rows.Columns()
	if err != nil {
		rows.Close()
		return nil, nil, 0, err
	}
	result := make([][]any, 0)
	for rows.Next() {
		values := make([]any, len(columns))
		destinations := make([]any, len(columns))
		for index := range values {
			destinations[index] = &values[index]
		}
		if err := rows.Scan(destinations...); err != nil {
			rows.Close()
			return nil, nil, 0, err
		}
		result = append(result, values)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, 0, err
	}
	if err := rows.Close(); err != nil {
		return nil, nil, 0, err
	}
	var after int64
	if err := db.QueryRowContext(ctx, `SELECT total_changes()`).Scan(&after); err != nil {
		return nil, nil, 0, err
	}
	return columns, result, after - before, nil
}

func validatePolicySQL(query string, bindings []any) error {
	if strings.TrimSpace(query) == "" || len(query) > 1024*1024 {
		return fmt.Errorf("durable SQL query must contain 1-1048576 bytes")
	}
	if len(bindings) > 256 {
		return fmt.Errorf("durable SQL accepts at most 256 bindings")
	}
	upper := strings.ToUpper(strings.TrimSpace(query))
	for _, keyword := range []string{"BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"} {
		if upper == keyword || strings.HasPrefix(upper, keyword+" ") || strings.HasPrefix(upper, keyword+";") {
			return fmt.Errorf("transaction control SQL is not allowed; use durableStorage.transactionSync")
		}
	}
	return nil
}
