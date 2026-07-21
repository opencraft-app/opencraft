package dbbootstrap

import (
	"context"
	"database/sql"
	"fmt"
)

func CreateDatabaseStatement(database string) (string, error) {
	quoted, err := quoteIdentifier(database)
	if err != nil {
		return "", err
	}
	return createDatabaseSQL(quoted), nil
}

func CreateDatabase(ctx context.Context, dsn, database string) error {
	statement, err := CreateDatabaseStatement(database)
	if err != nil {
		return err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, statement); err != nil {
		return fmt.Errorf("create database: %w", err)
	}
	return nil
}
