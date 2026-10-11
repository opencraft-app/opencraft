// Package database 提供 SQLite 连接、迁移、校验和事务基础设施。
package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"chatserver/internal/apperror"
	"chatserver/internal/config"
	"chatserver/internal/database/platform"
	"chatserver/internal/ent"
	"chatserver/internal/securefile"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	gomysql "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

// Handle 持有一个 SQLite 写连接、Ent Client 和进程级 writer lock。
type Handle struct {
	db               *sql.DB
	client           *ent.Client
	lock             *writerLock
	writer           bool
	supportsRowLocks bool

	closeOnce sync.Once
	closeErr  error
}

// OpenWriter 打开 SQLite 单写者连接，并在整个 Handle 生命周期内持有 writer lock。
func OpenWriter(ctx context.Context, cfg config.Database) (*Handle, error) {
	adapter, err := AdapterFor(cfg.Driver)
	if err != nil {
		return nil, err
	}
	opened, err := adapter.Open(ctx, cfg, platform.OpenModeWriter)
	if err != nil {
		return nil, err
	}
	handle, ok := opened.(*Handle)
	if !ok {
		_ = opened.Close()
		return nil, apperror.New("DATABASE_OPEN_FAILED", "数据库适配器返回了无效连接", nil)
	}
	return handle, nil
}

func openSQLiteWriter(ctx context.Context, cfg config.Database) (*Handle, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if err := prepareParent(cfg.Path); err != nil {
		return nil, err
	}
	lock, err := acquireWriterLock(ctx, cfg.Path, cfg.LockTimeout)
	if err != nil {
		return nil, err
	}
	release := true
	defer func() {
		if release {
			_ = lock.close()
		}
	}()

	if err := prepareDatabaseFile(cfg.Path); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", writerDSN(cfg))
	if err != nil {
		return nil, apperror.New("DATABASE_OPEN_FAILED", "无法打开 SQLite 数据库", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, apperror.New("DATABASE_OPEN_FAILED", "无法连接 SQLite 数据库", err)
	}
	if err := verifyWriterPragmas(ctx, db, cfg); err != nil {
		_ = db.Close()
		return nil, err
	}

	driver := entsql.OpenDB(dialect.SQLite, db)
	handle := &Handle{
		db:     db,
		client: ent.NewClient(ent.Driver(driver)),
		lock:   lock,
		writer: true,
	}
	release = false
	return handle, nil
}

// OpenReadOnly 打开不持有 writer lock 的只读连接。
//
// 它只接受已经存在且权限安全的数据库文件，不创建目录、数据库或锁文件。
// 因此 status/verify 可以和唯一写进程并存，也不会把一次诊断操作变成写操作。
func OpenReadOnly(ctx context.Context, cfg config.Database) (*Handle, error) {
	adapter, err := AdapterFor(cfg.Driver)
	if err != nil {
		return nil, err
	}
	opened, err := adapter.Open(ctx, cfg, platform.OpenModeReadOnly)
	if err != nil {
		return nil, err
	}
	handle, ok := opened.(*Handle)
	if !ok {
		_ = opened.Close()
		return nil, apperror.New("DATABASE_OPEN_FAILED", "数据库适配器返回了无效连接", nil)
	}
	return handle, nil
}

func openSQLiteReadOnly(ctx context.Context, cfg config.Database) (*Handle, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if err := inspectParent(cfg.Path); err != nil {
		return nil, err
	}
	if err := inspectDatabaseFile(cfg.Path); err != nil {
		return nil, err
	}

	db, err := sql.Open("sqlite", readOnlyDSN(cfg))
	if err != nil {
		return nil, apperror.New("DATABASE_OPEN_FAILED", "无法打开 SQLite 只读数据库", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, apperror.New("DATABASE_OPEN_FAILED", "无法连接 SQLite 只读数据库", err)
	}

	driver := entsql.OpenDB(dialect.SQLite, db)
	return &Handle{
		db:     db,
		client: ent.NewClient(ent.Driver(driver)),
	}, nil
}

func openTDSQL(ctx context.Context, cfg config.Database, writer bool) (*Handle, error) {
	dsn, err := loadTDSQLDSN(cfg)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, apperror.New("DATABASE_OPEN_FAILED", "无法打开 MySQL/TDSQL 数据库", err)
	}
	db.SetMaxOpenConns(cfg.MaxOpenConnections)
	db.SetMaxIdleConns(cfg.MaxIdleConnections)
	db.SetConnMaxLifetime(cfg.ConnectionMaxLifetime)
	db.SetConnMaxIdleTime(time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, apperror.New("DATABASE_OPEN_FAILED", "无法连接 MySQL/TDSQL 数据库", err)
	}
	driver := entsql.OpenDB(dialect.MySQL, db)
	return &Handle{
		db:               db,
		client:           ent.NewClient(ent.Driver(driver)),
		writer:           writer,
		supportsRowLocks: true,
	}, nil
}

func loadTDSQLDSN(cfg config.Database) (string, error) {
	if err := cfg.Validate(); err != nil {
		return "", err
	}
	data, err := securefile.Read(cfg.DSNFile, "MySQL DSN", 4096)
	if err != nil {
		return "", err
	}
	dsn := strings.TrimSpace(string(data))
	if dsn == "" || strings.ContainsAny(dsn, "\r\n\x00") {
		return "", apperror.New("CONFIG_INVALID", "MySQL DSN 内容无效", nil)
	}
	parsed, err := gomysql.ParseDSN(dsn)
	if err != nil {
		return "", apperror.New("CONFIG_INVALID", "MySQL DSN 内容无效", err)
	}
	if parsed.Net != "tcp" || strings.TrimSpace(parsed.Addr) == "" ||
		strings.TrimSpace(parsed.DBName) == "" || !parsed.ParseTime ||
		parsed.MultiStatements || parsed.AllowAllFiles ||
		parsed.AllowCleartextPasswords || parsed.AllowFallbackToPlaintext ||
		parsed.AllowOldPasswords {
		return "", apperror.New("CONFIG_INVALID", "MySQL DSN 缺少安全必需参数", nil)
	}
	return dsn, nil
}

// SQLDB 返回底层 database/sql 连接，仅供数据库基础设施和诊断使用。
func (h *Handle) SQLDB() *sql.DB {
	if h == nil {
		return nil
	}
	return h.db
}

// Client 返回生成的 Ent Client。
func (h *Handle) Client() *ent.Client {
	if h == nil {
		return nil
	}
	return h.client
}

// SupportsRowLocks reports whether SELECT ... FOR UPDATE is available.
// SQLite writers are already serialized by the Handle's single connection.
func (h *Handle) SupportsRowLocks() bool {
	return h != nil && h.supportsRowLocks
}

// Close 关闭 Ent/SQL 连接并释放 writer lock；重复调用是幂等的。
func (h *Handle) Close() error {
	if h == nil {
		return nil
	}
	h.closeOnce.Do(func() {
		var connectionErr error
		if h.client != nil {
			connectionErr = h.client.Close()
		} else if h.db != nil {
			connectionErr = h.db.Close()
		}
		lockErr := h.lock.close()
		h.closeErr = errors.Join(connectionErr, lockErr)
	})
	return h.closeErr
}

func prepareParent(path string) error {
	parent := filepath.Dir(path)
	info, err := os.Lstat(parent)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return apperror.New("DATABASE_OPEN_FAILED", "无法创建数据库目录", err)
		}
		info, err = os.Lstat(parent)
	}
	if err != nil {
		return apperror.New("DATABASE_OPEN_FAILED", "无法检查数据库目录", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return apperror.New("DATABASE_PERMISSION_UNSAFE", "数据库父路径不是安全目录", nil)
	}
	if info.Mode().Perm() != 0o700 {
		return apperror.New("DATABASE_PERMISSION_UNSAFE", "数据库目录权限必须为 0700", nil)
	}
	return nil
}

func inspectParent(path string) error {
	info, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return apperror.New("DATABASE_OPEN_FAILED", "无法检查数据库目录", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return apperror.New("DATABASE_PERMISSION_UNSAFE", "数据库父路径不是安全目录", nil)
	}
	if info.Mode().Perm() != 0o700 {
		return apperror.New("DATABASE_PERMISSION_UNSAFE", "数据库目录权限必须为 0700", nil)
	}
	return nil
}

func prepareDatabaseFile(path string) error {
	info, err := os.Lstat(path)
	if err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return apperror.New("DATABASE_PERMISSION_UNSAFE", "数据库路径不是安全普通文件", nil)
		}
		if info.Mode().Perm() != 0o600 {
			return apperror.New("DATABASE_PERMISSION_UNSAFE", "数据库文件权限必须为 0600", nil)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return apperror.New("DATABASE_OPEN_FAILED", "无法检查数据库文件", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return apperror.New("DATABASE_OPEN_FAILED", "无法创建数据库文件", err)
	}
	if err := file.Close(); err != nil {
		return apperror.New("DATABASE_OPEN_FAILED", "无法关闭新建数据库文件", err)
	}
	return nil
}

func inspectDatabaseFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return apperror.New("DATABASE_OPEN_FAILED", "无法检查数据库文件", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return apperror.New("DATABASE_PERMISSION_UNSAFE", "数据库路径不是安全普通文件", nil)
	}
	if info.Mode().Perm() != 0o600 {
		return apperror.New("DATABASE_PERMISSION_UNSAFE", "数据库文件权限必须为 0600", nil)
	}
	return nil
}

func writerDSN(cfg config.Database) string {
	query := url.Values{}
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "synchronous(FULL)")
	query.Add("_pragma", "busy_timeout("+strconv.FormatInt(cfg.BusyTimeout.Milliseconds(), 10)+")")
	query.Add("_pragma", "foreign_keys(OFF)")
	query.Set("_time_format", "sqlite")
	return (&url.URL{Scheme: "file", Path: cfg.Path, RawQuery: query.Encode()}).String()
}

func readOnlyDSN(cfg config.Database) string {
	query := url.Values{}
	query.Set("mode", "ro")
	query.Add("_pragma", "busy_timeout("+strconv.FormatInt(cfg.BusyTimeout.Milliseconds(), 10)+")")
	query.Add("_pragma", "query_only(ON)")
	query.Set("_time_format", "sqlite")
	return (&url.URL{Scheme: "file", Path: cfg.Path, RawQuery: query.Encode()}).String()
}

func verifyWriterPragmas(ctx context.Context, db *sql.DB, cfg config.Database) error {
	var journalMode string
	var synchronous, busyTimeout, foreignKeys int
	checks := []struct {
		query string
		dest  any
	}{
		{query: "PRAGMA journal_mode", dest: &journalMode},
		{query: "PRAGMA synchronous", dest: &synchronous},
		{query: "PRAGMA busy_timeout", dest: &busyTimeout},
		{query: "PRAGMA foreign_keys", dest: &foreignKeys},
	}
	for _, check := range checks {
		if err := db.QueryRowContext(ctx, check.query).Scan(check.dest); err != nil {
			return apperror.New("DATABASE_OPEN_FAILED", "无法核验 SQLite 连接参数", err)
		}
	}
	if journalMode != "wal" || synchronous != 2 ||
		busyTimeout != int(cfg.BusyTimeout.Milliseconds()) || foreignKeys != 0 {
		cause := fmt.Errorf("unexpected pragma values")
		return apperror.New("DATABASE_OPEN_FAILED", "SQLite 连接参数未生效", cause)
	}
	return nil
}
