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

const latestKnownSchemaVersion int64 = 5

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

	// 自动兼容旧迁移系统和早期 playground 初始化出来的半迁移状态。
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
//   - schema_migrations 已存在且干净 → 无需处理，golang-migrate 正常接管
//   - schema_migrations 已存在但 dirty → 仅在业务表指纹明确领先时修复
//   - schema_migrations 不存在 + schema_migration_files 存在（旧系统） → 推算版本并写入
//   - 两张迁移表都不存在但业务 schema 已存在 → 通过保守指纹补写版本
//   - 全新环境 → 不做任何操作，golang-migrate 从 1 开始执行
func bootstrapIfNeeded(db *sql.DB) error {
	if tableExists(db, "schema_migrations") {
		return reconcileSchemaMigrations(db)
	}

	if !tableExists(db, "schema_migration_files") {
		return bootstrapFromSchemaFingerprint(db)
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

	if err := createSchemaMigrations(db); err != nil {
		return err
	}
	if err := replaceMigrationState(db, version, false); err != nil {
		return err
	}

	log.Printf("bootstrap complete: schema_migrations initialized at version %d", version)
	return nil
}

func reconcileSchemaMigrations(db *sql.DB) error {
	version, dirty, ok, err := currentMigrationState(db)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	if ok && !dirty {
		log.Printf("schema_migrations table exists at clean version %d, skipping bootstrap", version)
		return nil
	}

	inferredVersion, err := inferExistingSchemaVersion(db)
	if err != nil {
		return err
	}
	if inferredVersion == 0 {
		if ok {
			return fmt.Errorf("schema_migrations is dirty at version %d but no ai-gateway schema fingerprint was detected", version)
		}
		log.Printf("schema_migrations table exists but has no rows and no schema fingerprint, golang-migrate will run from scratch")
		return nil
	}
	if ok && inferredVersion <= version {
		return fmt.Errorf(
			"schema_migrations is dirty at version %d but schema fingerprint only proves version %d; repair manually",
			version,
			inferredVersion,
		)
	}

	if ok {
		log.Printf("schema_migrations dirty at version %d; schema fingerprint proves version %d, clearing dirty state", version, inferredVersion)
	} else {
		log.Printf("schema_migrations table exists without a row; schema fingerprint proves version %d, inserting clean state", inferredVersion)
	}
	if err := replaceMigrationState(db, inferredVersion, false); err != nil {
		return err
	}
	return nil
}

func currentMigrationState(db *sql.DB) (int64, bool, bool, error) {
	var version int64
	var dirty bool
	err := db.QueryRow("SELECT version, dirty FROM schema_migrations ORDER BY version DESC LIMIT 1").Scan(&version, &dirty)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, false, nil
	}
	if err != nil {
		return 0, false, false, err
	}
	return version, dirty, true, nil
}

func bootstrapFromSchemaFingerprint(db *sql.DB) error {
	version, err := inferExistingSchemaVersion(db)
	if err != nil {
		return err
	}
	if version == 0 {
		log.Printf("fresh environment detected, golang-migrate will run all migrations from scratch")
		return nil
	}
	log.Printf("existing ai-gateway schema detected without migration metadata, bootstrapping schema_migrations at version %d", version)
	if err := createSchemaMigrations(db); err != nil {
		return err
	}
	if err := replaceMigrationState(db, version, false); err != nil {
		return err
	}
	return nil
}

func createSchemaMigrations(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version bigint NOT NULL,
			dirty   tinyint(1) NOT NULL,
			PRIMARY KEY (version)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	if err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	return nil
}

func replaceMigrationState(db *sql.DB, version int64, dirty bool) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin migration state update: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec("DELETE FROM schema_migrations"); err != nil {
		return fmt.Errorf("clear schema_migrations: %w", err)
	}
	if _, err := tx.Exec("INSERT INTO schema_migrations (version, dirty) VALUES (?, ?)", version, dirty); err != nil {
		return fmt.Errorf("insert bootstrap version: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration state update: %w", err)
	}
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
	var count int
	err := db.QueryRow(
		"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
		name,
	).Scan(&count)
	return err == nil && count > 0
}

type schemaFacts struct {
	tables  map[string]bool
	columns map[string]map[string]bool
}

var aiGatewayCoreTables = []string{
	"admin_audit_logs",
	"api_keys",
	"model_mappings",
	"plans",
	"providers",
	"runtime_configs",
	"subscriptions",
	"usage_logs",
	"users",
}

func inferExistingSchemaVersion(db *sql.DB) (int64, error) {
	facts := schemaFacts{
		tables:  make(map[string]bool),
		columns: make(map[string]map[string]bool),
	}
	for _, table := range append(append([]string{}, aiGatewayCoreTables...), "response_cache") {
		facts.tables[table] = tableExists(db, table)
	}
	facts.columns["providers"] = map[string]bool{
		"model_discovery_protocol": columnExists(db, "providers", "model_discovery_protocol"),
	}
	facts.columns["subscriptions"] = map[string]bool{
		"last_refreshed_at": columnExists(db, "subscriptions", "last_refreshed_at"),
	}
	return inferSchemaVersionFromFacts(facts)
}

func inferSchemaVersionFromFacts(facts schemaFacts) (int64, error) {
	var presentCoreTables int
	var missingCoreTables []string
	for _, table := range aiGatewayCoreTables {
		if facts.tables[table] {
			presentCoreTables++
			continue
		}
		missingCoreTables = append(missingCoreTables, table)
	}
	if presentCoreTables == 0 {
		return 0, nil
	}
	if len(missingCoreTables) > 0 {
		return 0, fmt.Errorf("partial ai-gateway schema detected, missing core tables: %s", strings.Join(missingCoreTables, ", "))
	}

	version := int64(1)
	if !facts.tables["response_cache"] {
		version = 3
	}
	if facts.columns["providers"]["model_discovery_protocol"] {
		if facts.tables["response_cache"] {
			return 0, fmt.Errorf("inconsistent ai-gateway schema fingerprint: providers.model_discovery_protocol exists but response_cache still exists")
		}
		version = 4
	}
	if facts.columns["subscriptions"]["last_refreshed_at"] {
		if facts.tables["response_cache"] || !facts.columns["providers"]["model_discovery_protocol"] {
			return 0, fmt.Errorf("inconsistent ai-gateway schema fingerprint: subscriptions.last_refreshed_at exists but earlier migrations are missing")
		}
		version = latestKnownSchemaVersion
	}
	return version, nil
}

func columnExists(db *sql.DB, tableName string, columnName string) bool {
	var count int
	err := db.QueryRow(
		"SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
		tableName,
		columnName,
	).Scan(&count)
	return err == nil && count > 0
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
