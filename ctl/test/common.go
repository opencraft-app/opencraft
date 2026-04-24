// Package test ...
package test

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"ctl/main/common"
	"ctl/pkg/config"
	"ctl/pkg/context"
	"ctl/pkg/logic/app"
	"ctl/pkg/model/instance"
	"ctl/pkg/model/userresourcequota"
	"ctl/pkg/resource"
	"ctl/pkg/tracing"
	"ctl/pkg/transport"
	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"go.uber.org/zap"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func defaultConfDir() string {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		return ""
	}
	return filepath.Join(filepath.Dir(filename), "..", "conf", "server")
}

func ensureRewriteConf(confDir string) {
	rewriteDir := filepath.Join(confDir, "rewrite")
	if err := os.MkdirAll(rewriteDir, 0o755); err != nil {
		panic(err)
	}

	rewriteFile := filepath.Join(rewriteDir, "server_conf_rewrite.toml")
	if _, err := os.Stat(rewriteFile); err == nil {
		return
	}

	if err := os.WriteFile(rewriteFile, []byte(""), 0o644); err != nil {
		panic(err)
	}
}

func initFallbackDB() error {
	db, err := gorm.Open(sqlite.Open("file::memory:?cache=shared"), &gorm.Config{})
	if err != nil {
		return fmt.Errorf("open sqlite db: %w", err)
	}

	resource.GormDB = db
	return createFallbackSchema(db)
}

func createFallbackSchema(db *gorm.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			created_time DATETIME,
			updated_time DATETIME,
			user_id TEXT,
			task_id TEXT UNIQUE,
			parent_task_id TEXT,
			task_name TEXT,
			task_params TEXT,
			task_state TEXT,
			task_message TEXT,
			trace_id TEXT,
			execute_interval INTEGER,
			execute_count INTEGER,
			max_execute_count INTEGER,
			last_execute_time DATETIME
		);`,
		`CREATE TABLE IF NOT EXISTS id_gen (
			name TEXT PRIMARY KEY,
			max_id INTEGER NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS request_idempotent (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT,
			request_id TEXT,
			created_time DATETIME,
			updated_time DATETIME
		);`,
	}

	for _, stmt := range statements {
		if err := db.Exec(stmt).Error; err != nil {
			return fmt.Errorf("execute fallback schema: %w", err)
		}
	}

	if err := db.AutoMigrate(&instance.Entity{}, &userresourcequota.Entity{}); err != nil {
		return fmt.Errorf("auto migrate fallback schema: %w", err)
	}

	return nil
}

func initFallbackRedis() error {
	mr, err := miniredis.Run()
	if err != nil {
		return fmt.Errorf("start miniredis: %w", err)
	}

	port, err := strconv.Atoi(mr.Port())
	if err != nil {
		return fmt.Errorf("parse miniredis port: %w", err)
	}

	config.ServerConf.RedisConfig.Host = mr.Host()
	config.ServerConf.RedisConfig.Port = port
	resource.InitRedis(config.ServerConf.RedisConfig)
	return nil
}

func ensureAppsDataDir() error {
	if config.ServerConf.MiscConfig.AppsDataDir != "" {
		if _, err := os.Stat(config.ServerConf.MiscConfig.AppsDataDir); err == nil {
			return nil
		}
	}

	dir, err := os.MkdirTemp("", "ctl-test-apps-*")
	if err != nil {
		return fmt.Errorf("create temp apps dir: %w", err)
	}

	config.ServerConf.MiscConfig.AppsDataDir = dir
	content := `name = "test-app"
secret_id = "test-secret-id"
secret_key = "test-secret-key"
check_action = false
action_list = ["CreateInstance"]
`
	if err := os.WriteFile(filepath.Join(dir, "test-app.toml"), []byte(content), 0o644); err != nil {
		return fmt.Errorf("write temp app config: %w", err)
	}

	return nil
}

func tryInitCommon() (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("InitCommon panic: %v", r)
		}
	}()

	err = common.InitCommon()
	return err
}

// InitTestResource ...
func InitTestResource() {
	confDir := os.Getenv("CONF_DIR")
	if confDir == "" {
		confDir = defaultConfDir()
		_ = os.Setenv("CONF_DIR", confDir)
	}
	ensureRewriteConf(confDir)

	err := config.Init(confDir)
	if err != nil {
		panic(err)
	}

	_ = resource.InitLog(config.ServerConf.LogConfig.API)
	if resource.ZapLogger == nil {
		resource.ZapLogger = zap.NewNop()
	}
	err = tryInitCommon()
	if err != nil {
		if fallbackErr := initFallbackDB(); fallbackErr != nil {
			panic(fallbackErr)
		}
		if fallbackErr := initFallbackRedis(); fallbackErr != nil {
			panic(fallbackErr)
		}
		if fallbackErr := ensureAppsDataDir(); fallbackErr != nil {
			panic(fallbackErr)
		}
		if fallbackErr := app.InitAppsCacheData(config.ServerConf.MiscConfig.AppsDataDir, resource.ZapLogger); fallbackErr != nil {
			panic(fallbackErr)
		}
	}
	_ = tracing.Init(config.ServerConf.TracingConfig, "ctl-test")

}

// Context ...
func Context() context.Context {
	tid := uuid.New().String()
	fmt.Println("tid", strings.ReplaceAll(tid, "-", ""))

	ctx := context.NewContext(nil).WithRegion("ap-guangzhou").WithUserID("3237154827")
	ctx.SetRequestId(tid)
	ctx.SetLanguage(transport.LanguageZhCn)
	return ctx
}
