package database

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/apperror"
	"chatserver/internal/config"
)

func TestOpenWriter创建安全文件并设置SQLite参数(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "data")
	path := filepath.Join(parent, "chatserver.db")
	cfg, err := config.NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}

	handle, err := OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatalf("OpenWriter() error = %v", err)
	}
	defer handle.Close()

	assertMode(t, parent, 0o700)
	assertMode(t, path, 0o600)
	assertMode(t, path+".writer.lock", 0o600)

	var journalMode string
	if err := handle.SQLDB().QueryRow("PRAGMA journal_mode").Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if journalMode != "wal" {
		t.Fatalf("journal_mode = %q，期望 wal", journalMode)
	}
	var synchronous, busyTimeout, foreignKeys int
	if err := handle.SQLDB().QueryRow("PRAGMA synchronous").Scan(&synchronous); err != nil {
		t.Fatal(err)
	}
	if err := handle.SQLDB().QueryRow("PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if err := handle.SQLDB().QueryRow("PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if synchronous != 2 || busyTimeout != 5000 || foreignKeys != 0 {
		t.Fatalf("PRAGMA = synchronous:%d busy_timeout:%d foreign_keys:%d", synchronous, busyTimeout, foreignKeys)
	}
	if got, want := handle.SQLDB().Stats().MaxOpenConnections, 1; got != want {
		t.Fatalf("MaxOpenConnections = %d，期望 %d", got, want)
	}
}

func TestOpenWriter阻止第二个写进程并在关闭后释放(t *testing.T) {
	cfg, err := config.NewDatabase(filepath.Join(t.TempDir(), "data", "chatserver.db"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.LockTimeout = 50 * time.Millisecond
	first, err := OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}

	_, err = OpenWriter(context.Background(), cfg)
	if code := apperror.CodeOf(err); code != "DATABASE_IN_USE" {
		t.Fatalf("第二个 OpenWriter 错误码 = %q，期望 DATABASE_IN_USE；err=%v", code, err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("关闭第一个 writer：%v", err)
	}

	second, err := OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatalf("锁释放后 OpenWriter() error = %v", err)
	}
	if err := second.Close(); err != nil {
		t.Fatalf("关闭第二个 writer：%v", err)
	}
}

func TestOpenWriter拒绝不安全目录权限且不泄漏路径(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "unsafe")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "secret-chatserver.db")
	cfg, err := config.NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}

	_, err = OpenWriter(context.Background(), cfg)
	if code := apperror.CodeOf(err); code != "DATABASE_PERMISSION_UNSAFE" {
		t.Fatalf("错误码 = %q，期望 DATABASE_PERMISSION_UNSAFE；err=%v", code, err)
	}
	if err != nil && filepath.IsAbs(err.Error()) {
		t.Fatalf("错误消息疑似泄漏绝对路径：%v", err)
	}
}

func TestOpenReadOnly可与Writer并存且不取得WriterLock(t *testing.T) {
	cfg, err := config.NewDatabase(filepath.Join(t.TempDir(), "data", "chatserver.db"))
	if err != nil {
		t.Fatal(err)
	}
	writer, err := OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()

	reader, err := OpenReadOnly(context.Background(), cfg)
	if err != nil {
		t.Fatalf("OpenReadOnly() error = %v", err)
	}
	defer reader.Close()
	var value int
	if err := reader.SQLDB().QueryRow("SELECT 1").Scan(&value); err != nil || value != 1 {
		t.Fatalf("只读查询失败：value=%d err=%v", value, err)
	}
	if _, err := reader.SQLDB().Exec("CREATE TABLE forbidden_write (id TEXT PRIMARY KEY)"); err == nil {
		t.Fatal("OpenReadOnly 连接允许了写入")
	}
}

func TestOpenReadOnly不创建缺失数据库(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "missing.db")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}

	_, err = OpenReadOnly(context.Background(), cfg)
	if code := apperror.CodeOf(err); code != "DATABASE_OPEN_FAILED" {
		t.Fatalf("错误码 = %q，期望 DATABASE_OPEN_FAILED；err=%v", code, err)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatalf("OpenReadOnly 创建了缺失数据库：%v", statErr)
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s：%v", filepath.Base(path), err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s 权限 = %04o，期望 %04o", filepath.Base(path), got, want)
	}
}
