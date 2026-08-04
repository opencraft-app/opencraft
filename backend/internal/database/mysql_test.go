package database

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"chatserver/internal/apperror"
	"chatserver/internal/config"
)

func TestLoadTDSQLDSN接受受限文件和生产必需参数(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mysql.dsn")
	const dsn = "chatserver:password@tcp(127.0.0.1:3306)/chatserver?parseTime=true&charset=utf8mb4&collation=utf8mb4_unicode_ci"
	if err := os.WriteFile(path, []byte(dsn+"\n"), 0o440); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.NewTDSQLDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := loadTDSQLDSN(cfg)
	if err != nil {
		t.Fatalf("loadTDSQLDSN() error = %v", err)
	}
	if got != dsn {
		t.Fatalf("DSN 被意外改写")
	}
}

func TestLoadTDSQLDSN拒绝缺少数据库或ParseTime且不泄漏凭据(t *testing.T) {
	for _, dsn := range []string{
		"chatserver:never-log-password@tcp(127.0.0.1:3306)/?parseTime=true&charset=utf8mb4",
		"chatserver:never-log-password@tcp(127.0.0.1:3306)/chatserver?charset=utf8mb4",
	} {
		path := filepath.Join(t.TempDir(), "mysql.dsn")
		if err := os.WriteFile(path, []byte(dsn), 0o600); err != nil {
			t.Fatal(err)
		}
		cfg, err := config.NewTDSQLDatabase(path)
		if err != nil {
			t.Fatal(err)
		}
		_, err = loadTDSQLDSN(cfg)
		if code := apperror.CodeOf(err); code != "CONFIG_INVALID" {
			t.Fatalf("错误码 = %q，期望 CONFIG_INVALID；err=%v", code, err)
		}
		if strings.Contains(err.Error(), "never-log-password") || strings.Contains(err.Error(), path) {
			t.Fatalf("错误泄漏 DSN 或路径：%v", err)
		}
	}
}
