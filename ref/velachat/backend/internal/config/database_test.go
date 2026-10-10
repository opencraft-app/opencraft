package config

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"chatserver/internal/apperror"
)

func TestNewDatabase接受绝对文件路径并设置默认值(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chatserver.db")
	got, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase() error = %v", err)
	}
	if got.Path != path {
		t.Fatalf("Path = %q，期望 %q", got.Path, path)
	}
	if got.BusyTimeout != 5*time.Second || got.LockTimeout != 5*time.Second {
		t.Fatalf("默认超时 = busy:%s lock:%s", got.BusyTimeout, got.LockTimeout)
	}
}

func TestNewDatabase拒绝危险路径(t *testing.T) {
	tests := []struct {
		name string
		path string
	}{
		{name: "空路径"},
		{name: "相对路径", path: "chatserver.db"},
		{name: "NUL", path: "/tmp/chatserver\x00.db"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewDatabase(tt.path)
			if code := apperror.CodeOf(err); code != "CONFIG_INVALID" {
				t.Fatalf("错误码 = %q，期望 CONFIG_INVALID；err=%v", code, err)
			}
			if strings.Contains(err.Error(), tt.path) && tt.path != "" {
				t.Fatalf("错误消息泄漏完整路径：%v", err)
			}
		})
	}
}

func TestDatabaseValidate拒绝非正超时(t *testing.T) {
	cfg, err := NewDatabase(filepath.Join(t.TempDir(), "chatserver.db"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.BusyTimeout = 0
	if err := cfg.Validate(); apperror.CodeOf(err) != "CONFIG_INVALID" {
		t.Fatalf("Validate() error = %v，期望 CONFIG_INVALID", err)
	}
}

func TestNewTDSQLDatabase接受安全DSN文件并设置连接池默认值(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mysql.dsn")
	got, err := NewTDSQLDatabase(path)
	if err != nil {
		t.Fatalf("NewTDSQLDatabase() error = %v", err)
	}
	if got.Driver != DatabaseDriverTDSQL || got.DSNFile != path || got.Path != "" {
		t.Fatalf("TDSQL config = %#v", got)
	}
	if got.MaxOpenConnections != 20 || got.MaxIdleConnections != 20 ||
		got.ConnectionMaxLifetime != 3*time.Minute {
		t.Fatalf("MySQL 连接池默认值 = %#v", got)
	}
}

func TestNewTDSQLDatabase拒绝相对DSN文件(t *testing.T) {
	_, err := NewTDSQLDatabase("mysql.dsn")
	if code := apperror.CodeOf(err); code != "CONFIG_INVALID" {
		t.Fatalf("错误码 = %q，期望 CONFIG_INVALID；err=%v", code, err)
	}
}

func TestDatabaseValidate拒绝旧MySQL运行时方言(t *testing.T) {
	cfg := Database{Driver: DatabaseDriver("mysql")}
	if err := cfg.Validate(); apperror.CodeOf(err) != "CONFIG_INVALID" {
		t.Fatalf("Validate() error = %v，期望拒绝旧 mysql 方言", err)
	}
}
