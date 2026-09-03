package testutil

import (
	"database/sql"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ctl/pkg/resource"

	gomysql "github.com/go-sql-driver/mysql"
	"go.uber.org/zap"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var (
	sharedMySQLMu        sync.Mutex
	sharedMySQLContainer *MySQLContainer
)

func acquireSharedMySQLContainer(t *testing.T) *MySQLContainer {
	t.Helper()

	sharedMySQLMu.Lock()
	defer sharedMySQLMu.Unlock()

	if sharedMySQLContainer == nil {
		sharedMySQLContainer = StartMySQLContainer(t)
	}
	return sharedMySQLContainer
}

func createTestDatabase(t *testing.T, rootDSN string) string {
	t.Helper()

	rootDB, err := sql.Open("mysql", rootDSN)
	if err != nil {
		t.Fatalf("open mysql root db: %v", err)
	}
	t.Cleanup(func() {
		_ = rootDB.Close()
	})

	dbName := "ctl_test_" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if _, err := rootDB.Exec("CREATE DATABASE `" + dbName + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); err != nil {
		t.Fatalf("create test database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = rootDB.Exec("DROP DATABASE IF EXISTS `" + dbName + "`")
	})
	return dbName
}

func databaseDSN(baseDSN, dbName string) string {
	cfg, err := gomysql.ParseDSN(baseDSN)
	if err != nil {
		return strings.Replace(baseDSN, "/ctl_test?", "/"+dbName+"?", 1)
	}
	cfg.DBName = dbName
	return cfg.FormatDSN()
}

func NewMySQLDB(t *testing.T, migrationPathParts ...string) *MySQLContainer {
	t.Helper()

	resource.ZapLogger = zap.NewNop()
	originalDB := resource.GormDB

	container := acquireSharedMySQLContainer(t)
	dbName := createTestDatabase(t, container.DSN)
	dsn := databaseDSN(container.DSN, dbName)
	sqlDB, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open mysql db: %v", err)
	}
	t.Cleanup(func() {
		_ = sqlDB.Close()
	})

	ApplyMigrations(t, sqlDB, filepath.Join(migrationPathParts...))

	gdb, err := gorm.Open(mysql.Open(dsn), &gorm.Config{
		NowFunc: func() time.Time { return time.Now().UTC() },
	})
	if err != nil {
		t.Fatalf("open gorm mysql db: %v", err)
	}
	resource.GormDB = gdb
	t.Cleanup(func() {
		resource.GormDB = originalDB
	})
	return container
}

func NewMySQLAutoMigrateDB(t *testing.T, models ...interface{}) *MySQLContainer {
	t.Helper()

	resource.ZapLogger = zap.NewNop()
	originalDB := resource.GormDB

	container := acquireSharedMySQLContainer(t)
	dbName := createTestDatabase(t, container.DSN)
	dsn := databaseDSN(container.DSN, dbName)

	gdb, err := gorm.Open(mysql.Open(dsn), &gorm.Config{
		NowFunc: func() time.Time { return time.Now().UTC() },
	})
	if err != nil {
		t.Fatalf("open gorm mysql db: %v", err)
	}
	if err := gdb.AutoMigrate(models...); err != nil {
		t.Fatalf("auto migrate mysql db: %v", err)
	}
	resource.GormDB = gdb
	t.Cleanup(func() {
		resource.GormDB = originalDB
	})
	return container
}
