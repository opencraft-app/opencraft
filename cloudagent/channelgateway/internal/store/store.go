package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

const (
	dialectSQLite = "sqlite"
	dialectMySQL  = "mysql"
)

//go:embed migrations/*.sql migrations_mysql/*.sql
var migrationFiles embed.FS

type Store struct {
	db      *sql.DB
	dialect string
	mu      sync.Mutex
}

func Open(ctx context.Context, path string) (*Store, error) {
	return OpenWithDriver(ctx, "", path)
}

func OpenWithDriver(ctx context.Context, driver, path string) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		path = "channelgateway.db"
	}
	driver, dsn, err := normalizeDriverAndDSN(driver, path)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	if driver == dialectSQLite {
		db.SetMaxOpenConns(1)
		if _, err := db.ExecContext(ctx, `PRAGMA busy_timeout = 5000`); err != nil {
			_ = db.Close()
			return nil, err
		}
	} else {
		db.SetMaxOpenConns(10)
		db.SetMaxIdleConns(5)
		db.SetConnMaxLifetime(5 * time.Minute)
		if err := db.PingContext(ctx); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	store := &Store{db: db, dialect: driver}
	if err := store.Migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Migrate(ctx context.Context) error {
	if s == nil || s.db == nil {
		return errors.New("store is nil")
	}
	dir := "migrations"
	if s.dialect == dialectMySQL {
		dir = "migrations_mysql"
	}
	entries, err := migrationFiles.ReadDir(dir)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		if err := s.applyMigration(ctx, dir, name); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) applyMigration(ctx context.Context, dir, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback()
		}
	}()
	migrationTableSQL := `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`
	if s.dialect == dialectMySQL {
		migrationTableSQL = `CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at VARCHAR(64) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
	}
	_, _ = tx.ExecContext(ctx, migrationTableSQL)
	var existing string
	err = tx.QueryRowContext(ctx, `SELECT version FROM schema_migrations WHERE version = ?`, name).Scan(&existing)
	if err == nil {
		_ = tx.Rollback()
		tx = nil
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	body, err := migrationFiles.ReadFile(dir + "/" + name)
	if err != nil {
		return err
	}
	if err := execMigrationBody(ctx, tx, string(body)); err != nil {
		return fmt.Errorf("apply migration %s: %w", name, err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)`, name, nowText()); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	tx = nil
	return nil
}

func execMigrationBody(ctx context.Context, tx *sql.Tx, body string) error {
	for _, statement := range splitSQLStatements(body) {
		if statement == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func splitSQLStatements(body string) []string {
	parts := strings.Split(body, ";")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		statement := strings.TrimSpace(part)
		if statement == "" {
			continue
		}
		out = append(out, statement)
	}
	return out
}

func normalizeDriverAndDSN(driver, raw string) (string, string, error) {
	driver = strings.TrimSpace(strings.ToLower(driver))
	raw = strings.TrimSpace(raw)
	if driver == "" {
		switch {
		case strings.HasPrefix(raw, "mysql://"):
			driver = dialectMySQL
		case strings.Contains(raw, "@tcp("), strings.Contains(raw, "@unix("):
			driver = dialectMySQL
		default:
			driver = dialectSQLite
		}
	}
	switch driver {
	case dialectSQLite, "sqlite3":
		return dialectSQLite, raw, nil
	case dialectMySQL:
		dsn := raw
		if strings.HasPrefix(raw, "mysql://") {
			converted, err := mysqlURLToDSN(raw)
			if err != nil {
				return "", "", err
			}
			dsn = converted
		}
		if !strings.Contains(dsn, "parseTime=") {
			if strings.Contains(dsn, "?") {
				dsn += "&parseTime=true"
			} else {
				dsn += "?parseTime=true"
			}
		}
		return dialectMySQL, dsn, nil
	default:
		return "", "", fmt.Errorf("unsupported channelgateway db driver %q", driver)
	}
}

func mysqlURLToDSN(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	user := parsed.User.Username()
	password, hasPassword := parsed.User.Password()
	auth := user
	if hasPassword {
		auth += ":" + password
	}
	dbName := strings.TrimPrefix(parsed.Path, "/")
	query := parsed.RawQuery
	dsn := fmt.Sprintf("%s@tcp(%s)/%s", auth, parsed.Host, dbName)
	if query != "" {
		dsn += "?" + query
	}
	return dsn, nil
}

func nowText() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func parseTime(value string) (time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return time.Time{}, nil
	}
	return time.Parse(time.RFC3339Nano, value)
}
