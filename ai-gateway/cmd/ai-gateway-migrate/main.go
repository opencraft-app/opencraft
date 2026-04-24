package main

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/golang-migrate/migrate/v4"
	mysqlmigrate "github.com/golang-migrate/migrate/v4/database/mysql"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	aimigrations "git.woa.com/wisp/mono/ai-gateway/migrations"
)

func main() {
	dsn := strings.TrimSpace(os.Getenv("AI_GATEWAY_MIGRATE_DSN"))
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if dsn == "" {
		log.Fatal("AI_GATEWAY_MIGRATE_DSN or DATABASE_URL is required")
	}

	db, err := openMySQL(ensureMultiStatements(mustNormalizeDSN(dsn)))
	if err != nil {
		log.Fatalf("connect to database: %v", err)
	}
	defer db.Close()

	// 自动兼容旧迁移系统：如果 schema_migrations 不存在但旧表存在，
	// 从旧表推算已执行的最大版本号并写入 schema_migrations，避免重复执行。
	if err := bootstrapIfNeeded(db); err != nil {
		log.Fatalf("bootstrap schema_migrations: %v", err)
	}

	m, err := buildMigrator(db)
	if err != nil {
		log.Fatalf("init migrator: %v", err)
	}
	defer func() { _, _ = m.Close() }()

	version, dirty, err := m.Version()
	if err != nil && !errors.Is(err, migrate.ErrNilVersion) {
		log.Fatalf("get current version: %v", err)
	}
	if dirty {
		log.Fatalf("database schema is dirty at version %d — repair manually before running migrations", version)
	}

	if err := m.Up(); err != nil {
		if errors.Is(err, migrate.ErrNoChange) {
			log.Printf("schema already up to date (version %d)", version)
			return
		}
		log.Fatalf("apply migrations: %v", err)
	}

	newVersion, _, _ := m.Version()
	log.Printf("ai-gateway migrations applied (version %d → %d)", version, newVersion)
}

// bootstrapIfNeeded 检测迁移系统状态并自动处理新旧衔接：
//   - schema_migrations 已存在 → 无需处理，golang-migrate 正常接管
//   - schema_migrations 不存在 + schema_migration_files 存在（旧系统） → 推算版本并写入
//   - 两张表都不存在（全新环境） → 不做任何操作，golang-migrate 从 1 开始执行
func bootstrapIfNeeded(db *sql.DB) error {
	if tableExists(db, "schema_migrations") {
		log.Printf("schema_migrations table exists, skipping bootstrap")
		return nil
	}

	if !tableExists(db, "schema_migration_files") {
		log.Printf("fresh environment detected, golang-migrate will run all migrations from scratch")
		return nil
	}

	// 旧系统存在：从 schema_migration_files 推算已执行的最大版本号
	version, err := maxVersionFromLegacyTable(db)
	if err != nil {
		return fmt.Errorf("read legacy migration table: %w", err)
	}
	if version == 0 {
		log.Printf("legacy table exists but no migrations recorded, running from scratch")
		return nil
	}

	log.Printf("legacy migration system detected (schema_migration_files), bootstrapping schema_migrations at version %d", version)

	_, err = db.Exec(`
		CREATE TABLE schema_migrations (
			version bigint NOT NULL,
			dirty   tinyint(1) NOT NULL,
			PRIMARY KEY (version)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	if err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	_, err = db.Exec("INSERT INTO schema_migrations (version, dirty) VALUES (?, 0)", version)
	if err != nil {
		return fmt.Errorf("insert bootstrap version: %w", err)
	}

	log.Printf("bootstrap complete: schema_migrations initialized at version %d", version)
	return nil
}

var migrationVersionRe = regexp.MustCompile(`^(\d+)_.*\.up\.sql$`)

// maxVersionFromLegacyTable 从旧的 schema_migration_files 表里找最大版本号。
// 文件名格式为 000003_xxx.up.sql，从中提取序号。
func maxVersionFromLegacyTable(db *sql.DB) (int64, error) {
	rows, err := db.Query("SELECT file_name FROM schema_migration_files")
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	var maxVersion int64
	for rows.Next() {
		var fileName string
		if err := rows.Scan(&fileName); err != nil {
			return 0, err
		}
		matches := migrationVersionRe.FindStringSubmatch(fileName)
		if len(matches) != 2 {
			continue
		}
		v, err := strconv.ParseInt(matches[1], 10, 64)
		if err != nil {
			continue
		}
		if v > maxVersion {
			maxVersion = v
		}
	}
	return maxVersion, rows.Err()
}

func tableExists(db *sql.DB, name string) bool {
	var n string
	err := db.QueryRow("SHOW TABLES LIKE ?", name).Scan(&n)
	return err == nil
}

func buildMigrator(db *sql.DB) (*migrate.Migrate, error) {
	sourceDriver, err := iofs.New(aimigrations.Files, ".")
	if err != nil {
		return nil, fmt.Errorf("init migration source: %w", err)
	}

	dbDriver, err := mysqlmigrate.WithInstance(db, &mysqlmigrate.Config{})
	if err != nil {
		return nil, fmt.Errorf("init migration db driver: %w", err)
	}

	return migrate.NewWithInstance("iofs", sourceDriver, "mysql", dbDriver)
}

func openMySQL(dsn string) (*sql.DB, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping mysql: %w", err)
	}
	return db, nil
}

func ensureMultiStatements(dsn string) string {
	if strings.Contains(dsn, "multiStatements=") {
		return dsn
	}
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	return dsn + sep + "multiStatements=true"
}

func mustNormalizeDSN(dsn string) string {
	cfg, err := mysql.ParseDSN(strings.TrimSpace(dsn))
	if err != nil {
		log.Fatalf("parse mysql dsn: %v", err)
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	return cfg.FormatDSN()
}
