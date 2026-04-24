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

	authmigrations "github.com/openclaw/openclaw/mono/backend/auth/migrations"
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

	sourceDriver, err := iofs.New(authmigrations.Files, ".")
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

	if _, err := repairDirtyVersionZero(m); err != nil {
		return err
	}

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		repaired, repairErr := repairDirtyVersionZero(m)
		if repairErr != nil {
			return repairErr
		}
		if !repaired {
			return fmt.Errorf("apply migrations: %w", err)
		}
		if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
			return fmt.Errorf("apply migrations after repair: %w", err)
		}
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

func repairDirtyVersionZero(m *migrate.Migrate) (bool, error) {
	version, dirty, err := m.Version()
	if err != nil {
		if errors.Is(err, migrate.ErrNilVersion) {
			return false, nil
		}
		return false, fmt.Errorf("inspect migration version: %w", err)
	}
	if !dirty {
		return false, nil
	}
	if version != 0 {
		return false, fmt.Errorf("database is dirty at version %d; manual repair required", version)
	}
	if err := m.Force(int(version)); err != nil {
		return false, fmt.Errorf("force dirty version 0 clean: %w", err)
	}
	return true, nil
}
