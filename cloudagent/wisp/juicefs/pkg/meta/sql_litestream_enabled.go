//go:build litestreamvfs && vfs

package meta

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/benbjohnson/litestream"
	_ "github.com/benbjohnson/litestream/file"
	sqlite3 "github.com/mattn/go-sqlite3"
	"github.com/psanford/sqlite3vfs"
	"xorm.io/xorm"
	"xorm.io/xorm/core"
	"xorm.io/xorm/dialects"
)

const (
	litestreamDriverName = "sqlite3-litestream"
	litestreamIDParam    = "_juicefs_litestream_id"
)

type litestreamRegistration struct {
	ID      string
	VFSName string
	Config  sqliteLitestreamConfig
	VFS     *litestream.VFS
}

type litestreamSQLiteDriver struct{}

var (
	litestreamDriverOnce sync.Once
	litestreamIDSeq      atomic.Uint64
	litestreamRegistry   sync.Map
)

func configureLitestreamSQLiteDriver(baseURL string, query *url.Values, cfg sqliteLitestreamConfig) (string, string, sqliteLitestreamConfig, error) {
	if !cfg.Enabled {
		return "sqlite3", "", cfg, nil
	}

	var regErr error
	litestreamDriverOnce.Do(func() {
		sql.Register(litestreamDriverName, &litestreamSQLiteDriver{})
		engineCreator[litestreamDriverName] = newLitestreamXormEngine
	})
	if regErr != nil {
		return "", "", cfg, regErr
	}

	id := fmt.Sprintf("%x", litestreamIDSeq.Add(1))
	cfg.RegistrationID = id
	reg := litestreamRegistration{
		ID:      id,
		VFSName: "litestream-" + id,
		Config:  cfg,
	}
	sqliteLitestreamTrace("configure_driver", "registration_id", id, "vfs", reg.VFSName, "base_url", normalizeSQLiteVFSBaseURL(baseURL), "hydration", cfg.HydrationEnable, "runtime_maintenance", cfg.RuntimeMaintenance)
	if err := ensureLitestreamRegistration(reg); err != nil {
		return "", "", cfg, err
	}

	query.Set("vfs", reg.VFSName)
	query.Set(litestreamIDParam, id)
	return litestreamDriverName, normalizeSQLiteVFSBaseURL(baseURL), cfg, nil
}

func ensureLitestreamRegistration(reg litestreamRegistration) error {
	sqliteLitestreamTrace("registration_start", "registration_id", reg.ID, "vfs", reg.VFSName)
	client, err := litestream.NewReplicaClientFromURL(reg.Config.ReplicaURL)
	if err != nil {
		return fmt.Errorf("create litestream replica client: %w", err)
	}
	sqliteLitestreamTrace("registration_client_created", "registration_id", reg.ID, "vfs", reg.VFSName, "client_type", fmt.Sprintf("%T", client))
	if err := client.Init(context.Background()); err != nil {
		return fmt.Errorf("initialize litestream replica client: %w", err)
	}
	if reg.Config.AssumeEmpty {
		client = newAssumeEmptyReplicaClient(client)
	}

	reg.Config.BufferPath = fmt.Sprintf("%s.%d", reg.Config.BufferPath, os.Getpid())

	vfs := litestream.NewVFS(client, slog.Default())
	vfs.WriteEnabled = true
	vfs.WriteSyncInterval = reg.Config.SyncInterval
	vfs.PollInterval = reg.Config.PollInterval
	vfs.CacheSize = reg.Config.CacheSize
	vfs.WriteBufferPath = reg.Config.BufferPath
	vfs.HydrationEnabled = reg.Config.HydrationEnable
	vfs.HydrationPath = reg.Config.HydrationPath
	vfs.CompactionEnabled = reg.Config.CompactionEnabled
	if reg.Config.RuntimeMaintenance == "snapshot_only" {
		vfs.CompactionLevels = litestream.CompactionLevels{}
	}
	vfs.SnapshotInterval = reg.Config.SnapshotInterval
	vfs.SnapshotRetention = reg.Config.SnapshotRetention
	vfs.L0Retention = reg.Config.L0Retention
	reg.VFS = vfs

	if err := sqlite3vfs.RegisterVFS(reg.VFSName, vfs); err != nil && !strings.Contains(err.Error(), "already exists") {
		return fmt.Errorf("register litestream VFS %q: %w", reg.VFSName, err)
	}
	litestreamRegistry.Store(reg.ID, reg)
	sqliteLitestreamTrace("registration_done", "registration_id", reg.ID, "vfs", reg.VFSName)
	return nil
}

func (d *litestreamSQLiteDriver) Open(dsn string) (driver.Conn, error) {
	reg, sanitizedDSN, err := litestreamRegistrationForDSN(dsn)
	if err != nil {
		return nil, err
	}
	sqliteLitestreamTrace("driver_open_start", "registration_id", reg.ID, "vfs", reg.VFSName, "dsn", sanitizedDSN)

	conn, err := (&sqlite3.SQLiteDriver{}).Open(sanitizedDSN)
	if err != nil {
		sqliteLitestreamTrace("driver_open_error", "registration_id", reg.ID, "vfs", reg.VFSName, "error", err)
		return nil, err
	}

	sqliteConn, ok := conn.(*sqlite3.SQLiteConn)
	if !ok {
		return nil, fmt.Errorf("unexpected sqlite connection type %T", conn)
	}
	if err := registerLitestreamFunctions(sqliteConn, reg); err != nil {
		_ = conn.Close()
		sqliteLitestreamTrace("driver_open_error", "registration_id", reg.ID, "vfs", reg.VFSName, "error", err)
		return nil, err
	}
	sqliteLitestreamTrace("driver_open_done", "registration_id", reg.ID, "vfs", reg.VFSName)
	return conn, nil
}

func litestreamRegistrationForDSN(dsn string) (litestreamRegistration, string, error) {
	baseURL, queryStr, hasQuery := strings.Cut(dsn, "?")
	query, err := url.ParseQuery(queryStr)
	if err != nil {
		return litestreamRegistration{}, "", err
	}
	id := query.Get(litestreamIDParam)
	if id == "" {
		return litestreamRegistration{}, "", fmt.Errorf("missing %s in litestream sqlite dsn", litestreamIDParam)
	}
	query.Del(litestreamIDParam)
	v, ok := litestreamRegistry.Load(id)
	if !ok {
		return litestreamRegistration{}, "", fmt.Errorf("unknown litestream registration id %q", id)
	}
	reg, ok := v.(litestreamRegistration)
	if !ok {
		return litestreamRegistration{}, "", fmt.Errorf("invalid litestream registration for %q", id)
	}
	sanitized := baseURL
	if encoded := query.Encode(); encoded != "" {
		sanitized += "?" + encoded
	} else if hasQuery && strings.HasSuffix(dsn, "?") {
		sanitized += "?"
	}
	return reg, sanitized, nil
}

func registerLitestreamFunctions(conn *sqlite3.SQLiteConn, reg litestreamRegistration) error {
	if err := conn.RegisterFunc("litestream_write_buffer_size", func() (int64, error) {
		info, err := os.Stat(reg.Config.BufferPath)
		if err == nil {
			return info.Size(), nil
		}
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}, false); err != nil {
		return fmt.Errorf("register litestream_write_buffer_size: %w", err)
	}
	return nil
}

func newLitestreamXormEngine(dsn string) (*xorm.Engine, error) {
	dialect, err := dialects.OpenDialect("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	db, err := core.Open(litestreamDriverName, dsn)
	if err != nil {
		return nil, err
	}
	return xorm.NewEngineWithDialectAndDB(litestreamDriverName, dsn, dialect, db)
}

func normalizeSQLiteVFSBaseURL(baseURL string) string {
	if strings.HasPrefix(baseURL, "file:") {
		return baseURL
	}
	return "file:" + baseURL
}

func litestreamBuildEnabled() bool {
	return true
}

func (m *dbMeta) flushLitestreamWrites(ctx context.Context) error {
	if !m.litestream.Enabled || strings.TrimSpace(m.litestream.RegistrationID) == "" {
		return nil
	}
	value, ok := litestreamRegistry.Load(m.litestream.RegistrationID)
	if !ok {
		return fmt.Errorf("litestream registration %s not found", m.litestream.RegistrationID)
	}
	reg, ok := value.(litestreamRegistration)
	if !ok {
		return fmt.Errorf("litestream registration %s has unexpected type %T", m.litestream.RegistrationID, value)
	}
	if reg.VFS == nil {
		return nil
	}
	started := time.Now()
	if err := reg.VFS.SyncWrites(ctx); err != nil {
		return err
	}
	logger.Infof("litestream active flush writes took %s", time.Since(started))
	return nil
}

func (m *dbMeta) RunLitestreamMaintenance(ctx context.Context, opts LitestreamMaintenanceOptions) (LitestreamMaintenanceStats, error) {
	if !m.litestream.Enabled {
		return LitestreamMaintenanceStats{}, fmt.Errorf("litestream maintenance is only available for sqlite litestream mode")
	}
	started := time.Now()
	m.checkpointMu.Lock()
	defer m.checkpointMu.Unlock()

	if err := m.waitForLitestreamBarrierAfterActiveFlush(ctx, m.litestream.BarrierTimeout); err != nil {
		return LitestreamMaintenanceStats{}, err
	}

	value, ok := litestreamRegistry.Load(m.litestream.RegistrationID)
	if !ok {
		return LitestreamMaintenanceStats{}, fmt.Errorf("litestream registration %s not found", m.litestream.RegistrationID)
	}
	reg, ok := value.(litestreamRegistration)
	if !ok {
		return LitestreamMaintenanceStats{}, fmt.Errorf("litestream registration %s has unexpected type %T", m.litestream.RegistrationID, value)
	}
	if reg.VFS == nil {
		return LitestreamMaintenanceStats{}, nil
	}

	stats, err := reg.VFS.RunMaintenance(ctx, litestream.MaintenanceOptions{
		Snapshot:                 opts.Snapshot,
		CompactLevel:             opts.CompactLevel,
		EnforceSnapshotRetention: opts.EnforceSnapshotRetention,
		SnapshotRetention:        opts.SnapshotRetention,
		EnforceL0Retention:       opts.EnforceL0Retention,
		L0Retention:              opts.L0Retention,
	})
	result := LitestreamMaintenanceStats{
		OpenFiles:                stats.OpenFiles,
		SnapshotCreated:          stats.SnapshotCreated,
		SnapshotSkipped:          stats.SnapshotSkipped,
		SnapshotSkipReason:       stats.SnapshotSkipReason,
		SnapshotMinTXID:          stats.SnapshotMinTXID,
		SnapshotMaxTXID:          stats.SnapshotMaxTXID,
		SnapshotSize:             stats.SnapshotSize,
		Compacted:                stats.Compacted,
		CompactionSkipped:        stats.CompactionSkipped,
		CompactionSkipReason:     stats.CompactionSkipReason,
		CompactionLevel:          stats.CompactionLevel,
		CompactionMinTXID:        stats.CompactionMinTXID,
		CompactionMaxTXID:        stats.CompactionMaxTXID,
		CompactionSize:           stats.CompactionSize,
		SnapshotRetentionMinTXID: stats.SnapshotRetentionMinTXID,
		L0RetentionEnforced:      stats.L0RetentionEnforced,
	}
	logger.Infof("litestream maintenance done open_files=%d snapshot_created=%t snapshot_skipped=%t snapshot_max_txid=%d snapshot_size=%d compacted=%t compaction_level=%d compaction_max_txid=%d l0_retention=%t duration=%s err=%v",
		result.OpenFiles, result.SnapshotCreated, result.SnapshotSkipped, result.SnapshotMaxTXID, result.SnapshotSize, result.Compacted, result.CompactionLevel, result.CompactionMaxTXID, result.L0RetentionEnforced, time.Since(started), err)
	return result, err
}
