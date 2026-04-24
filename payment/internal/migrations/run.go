package migrations

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/golang-migrate/migrate/v4"
	mysqlmigrate "github.com/golang-migrate/migrate/v4/database/mysql"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	paymigrations "git.woa.com/wisp/mono/payment/migrations"
)

func Run(dsn string) error {
	trimmed := strings.TrimSpace(dsn)
	if trimmed == "" {
		return fmt.Errorf("mysql dsn is required")
	}
	normalizedDSN, err := normalizeDSN(trimmed)
	if err != nil {
		return err
	}
	db, err := sql.Open("mysql", normalizedDSN)
	if err != nil {
		return fmt.Errorf("open mysql: %w", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		return fmt.Errorf("ping mysql: %w", err)
	}
	sourceDriver, err := iofs.New(paymigrations.Files, ".")
	if err != nil {
		return fmt.Errorf("init migration source: %w", err)
	}
	databaseDriver, err := mysqlmigrate.WithInstance(db, &mysqlmigrate.Config{})
	if err != nil {
		return fmt.Errorf("init migration database: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", sourceDriver, "mysql", databaseDriver)
	if err != nil {
		return fmt.Errorf("build migrator: %w", err)
	}
	defer func() {
		_, _ = m.Close()
	}()
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

func normalizeDSN(dsn string) (string, error) {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		return "", fmt.Errorf("parse mysql dsn: %w", err)
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.MultiStatements = true
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	return cfg.FormatDSN(), nil
}
