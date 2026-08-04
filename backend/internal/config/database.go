// Package config 定义 Chatserver 的静态配置。
package config

import (
	"path/filepath"
	"strings"
	"time"

	"chatserver/internal/apperror"
)

const (
	defaultBusyTimeout           = 5 * time.Second
	defaultLockTimeout           = 5 * time.Second
	defaultMaxOpenConnections    = 20
	defaultMaxIdleConnections    = 20
	defaultConnectionMaxLifetime = 3 * time.Minute
)

// DatabaseDriver 是显式数据库方言；禁止通过 DSN 猜测方言。
type DatabaseDriver string

const (
	DatabaseDriverSQLite DatabaseDriver = "sqlite"
	DatabaseDriverTDSQL  DatabaseDriver = "tdsql"
)

// Database 是 SQLite 或 MySQL/TDSQL 的连接配置。
type Database struct {
	Driver      DatabaseDriver
	Path        string
	DSNFile     string
	BusyTimeout time.Duration
	LockTimeout time.Duration

	MaxOpenConnections    int
	MaxIdleConnections    int
	ConnectionMaxLifetime time.Duration
}

// NewDatabase 校验绝对数据库路径并填充安全默认值。
func NewDatabase(path string) (Database, error) {
	cfg := Database{
		Driver:      DatabaseDriverSQLite,
		Path:        filepath.Clean(path),
		BusyTimeout: defaultBusyTimeout,
		LockTimeout: defaultLockTimeout,
	}
	if path == "" {
		cfg.Path = ""
	}
	if err := cfg.Validate(); err != nil {
		return Database{}, err
	}
	return cfg, nil
}

// NewTDSQLDatabase 校验 DSN Secret 文件路径并填充保守的连接池默认值。
// 文件内容只会在打开连接时读取，不进入配置错误和日志。
func NewTDSQLDatabase(dsnFile string) (Database, error) {
	cfg := Database{
		Driver:                DatabaseDriverTDSQL,
		DSNFile:               filepath.Clean(dsnFile),
		MaxOpenConnections:    defaultMaxOpenConnections,
		MaxIdleConnections:    defaultMaxIdleConnections,
		ConnectionMaxLifetime: defaultConnectionMaxLifetime,
	}
	if dsnFile == "" {
		cfg.DSNFile = ""
	}
	if err := cfg.Validate(); err != nil {
		return Database{}, err
	}
	return cfg, nil
}

// Validate 只验证静态配置，不创建目录或文件。
func (c Database) Validate() error {
	if c.Driver == "" {
		return apperror.New("CONFIG_INVALID", "数据库方言不能为空", nil)
	}
	if c.Driver == DatabaseDriverTDSQL {
		return c.validateMySQL()
	}
	if c.Driver != DatabaseDriverSQLite {
		return apperror.New("CONFIG_INVALID", "数据库方言不受支持", nil)
	}
	return c.validateSQLite()
}

func (c Database) validateSQLite() error {
	switch {
	case strings.TrimSpace(c.Path) == "":
		return apperror.New("CONFIG_INVALID", "数据库路径不能为空", nil)
	case strings.ContainsRune(c.Path, '\x00'):
		return apperror.New("CONFIG_INVALID", "数据库路径包含非法字符", nil)
	case !filepath.IsAbs(c.Path):
		return apperror.New("CONFIG_INVALID", "数据库路径必须是绝对文件路径", nil)
	case c.BusyTimeout <= 0:
		return apperror.New("CONFIG_INVALID", "数据库忙等待时间必须大于零", nil)
	case c.LockTimeout <= 0:
		return apperror.New("CONFIG_INVALID", "数据库锁等待时间必须大于零", nil)
	default:
		return nil
	}
}

func (c Database) validateMySQL() error {
	switch {
	case strings.TrimSpace(c.DSNFile) == "":
		return apperror.New("CONFIG_INVALID", "MySQL DSN 文件不能为空", nil)
	case strings.ContainsRune(c.DSNFile, '\x00'):
		return apperror.New("CONFIG_INVALID", "MySQL DSN 文件路径包含非法字符", nil)
	case !filepath.IsAbs(c.DSNFile):
		return apperror.New("CONFIG_INVALID", "MySQL DSN 文件必须是绝对路径", nil)
	case c.MaxOpenConnections <= 0:
		return apperror.New("CONFIG_INVALID", "MySQL 最大连接数必须大于零", nil)
	case c.MaxIdleConnections < 0 || c.MaxIdleConnections > c.MaxOpenConnections:
		return apperror.New("CONFIG_INVALID", "MySQL 空闲连接数无效", nil)
	case c.ConnectionMaxLifetime <= 0:
		return apperror.New("CONFIG_INVALID", "MySQL 连接最长生命周期必须大于零", nil)
	default:
		return nil
	}
}
