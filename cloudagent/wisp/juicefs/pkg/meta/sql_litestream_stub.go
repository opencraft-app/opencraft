//go:build !litestreamvfs || !vfs

package meta

import (
	"context"
	"fmt"
	"net/url"
	"strings"
)

const litestreamDriverName = "sqlite3-litestream"

func configureLitestreamSQLiteDriver(baseURL string, query *url.Values, cfg sqliteLitestreamConfig) (string, string, sqliteLitestreamConfig, error) {
	if !cfg.Enabled {
		return "sqlite3", "", cfg, nil
	}
	return "", "", cfg, fmt.Errorf("litestream writable VFS requested for %s but this binary was not built with -tags litestreamvfs,vfs", strings.TrimSpace(baseURL))
}

func litestreamBuildEnabled() bool {
	return false
}

func (m *dbMeta) flushLitestreamWrites(ctx context.Context) error {
	return nil
}

func (m *dbMeta) RunLitestreamMaintenance(ctx context.Context, opts LitestreamMaintenanceOptions) (LitestreamMaintenanceStats, error) {
	return LitestreamMaintenanceStats{}, fmt.Errorf("litestream maintenance requested but this binary was not built with -tags litestreamvfs,vfs")
}
