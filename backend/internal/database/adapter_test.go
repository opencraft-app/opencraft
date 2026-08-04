package database

import (
	"context"
	"path/filepath"
	"testing"

	"chatserver/internal/apperror"
	"chatserver/internal/config"
	"chatserver/internal/database/platform"
)

func TestResolveAdapter返回正式数据库能力(t *testing.T) {
	tests := []struct {
		name          string
		driver        config.DatabaseDriver
		sharding      bool
		transactional bool
		proxyAudit    bool
	}{
		{name: "SQLite", driver: config.DatabaseDriverSQLite, transactional: true},
		{
			name:       "TDSQL",
			driver:     config.DatabaseDriverTDSQL,
			sharding:   true,
			proxyAudit: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			adapter, err := AdapterFor(tt.driver)
			if err != nil {
				t.Fatalf("AdapterFor() error = %v", err)
			}
			if adapter.Driver() != tt.driver {
				t.Fatalf("Driver() = %q，期望 %q", adapter.Driver(), tt.driver)
			}
			capabilities := adapter.Capabilities()
			if capabilities.PhysicalSharding != tt.sharding ||
				capabilities.TransactionalDDL != tt.transactional ||
				capabilities.RequiresProxyAudit != tt.proxyAudit {
				t.Fatalf("Capabilities() = %#v", capabilities)
			}
		})
	}
}

func TestSQLiteAdapter统一连接迁移状态和审计(t *testing.T) {
	cfg, err := config.NewDatabase(filepath.Join(t.TempDir(), "data", "chatserver.db"))
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := AdapterFor(cfg.Driver)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := adapter.Open(context.Background(), cfg, platform.OpenModeWriter)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := handle.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	if err := adapter.Migrate(context.Background(), handle.SQLDB()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	state, err := adapter.MigrationStatus(context.Background(), handle.SQLDB())
	if err != nil {
		t.Fatalf("MigrationStatus() error = %v", err)
	}
	if state.Kind != platform.MigrationStateClean || state.Pending != 0 {
		t.Fatalf("MigrationStatus() = %#v", state)
	}
	if err := adapter.VerifySchema(context.Background(), handle.SQLDB()); err != nil {
		t.Fatalf("VerifySchema() error = %v", err)
	}
}

func TestResolveAdapter拒绝旧MySQL方言(t *testing.T) {
	_, err := AdapterFor(config.DatabaseDriver("mysql"))
	if code := apperror.CodeOf(err); code != "CONFIG_INVALID" {
		t.Fatalf("错误码 = %q，期望 CONFIG_INVALID；err=%v", code, err)
	}
}
