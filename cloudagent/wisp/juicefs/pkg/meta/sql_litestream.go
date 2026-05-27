//go:build !nosqlite

package meta

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"xorm.io/xorm"
)

type sqliteLitestreamConfig struct {
	Enabled            bool
	RegistrationID     string
	ReplicaURL         string
	SyncInterval       time.Duration
	PollInterval       time.Duration
	CacheSize          int
	BufferPath         string
	HydrationPath      string
	BarrierTimeout     time.Duration
	HydrationEnable    bool
	AssumeEmpty        bool
	RuntimeMaintenance string
	CompactionEnabled  bool
	SnapshotInterval   time.Duration
	SnapshotRetention  time.Duration
	L0Retention        time.Duration
}

const (
	defaultLitestreamSyncInterval       = 3 * time.Second
	defaultLitestreamPollInterval       = time.Second
	defaultLitestreamBarrierTimeout     = 30 * time.Second
	defaultLitestreamCacheSize          = 10 * 1024 * 1024
	defaultLitestreamRuntimeMaintenance = "full"
	defaultLitestreamSnapshotInterval   = time.Minute
	defaultLitestreamSnapshotRetention  = 5 * time.Minute
	defaultLitestreamL0Retention        = 10 * time.Minute
)

func extractBoolConfig(value *url.Values, key string, defaultV bool) (bool, error) {
	if value == nil {
		return defaultV, nil
	}
	if v := value.Get(key); v != "" {
		value.Del(key)
		parsed, err := strconv.ParseBool(v)
		if err != nil {
			return defaultV, fmt.Errorf("failed to parse %s as bool: %w", key, err)
		}
		return parsed, nil
	}
	return defaultV, nil
}

func extractDurationConfig(value *url.Values, key string, defaultV time.Duration) (time.Duration, error) {
	if value == nil {
		return defaultV, nil
	}
	if v := value.Get(key); v != "" {
		value.Del(key)
		parsed, err := time.ParseDuration(v)
		if err != nil {
			return defaultV, fmt.Errorf("failed to parse %s as duration: %w", key, err)
		}
		return parsed, nil
	}
	return defaultV, nil
}

func extractIntConfig(value *url.Values, key string, defaultV int) (int, error) {
	if value == nil {
		return defaultV, nil
	}
	if v := value.Get(key); v != "" {
		value.Del(key)
		parsed, err := strconv.Atoi(v)
		if err != nil {
			return defaultV, fmt.Errorf("failed to parse %s as int: %w", key, err)
		}
		return parsed, nil
	}
	return defaultV, nil
}

func extractStringConfig(value *url.Values, key string, defaultV string) string {
	if value == nil {
		return defaultV
	}
	if v := value.Get(key); v != "" {
		value.Del(key)
		return v
	}
	return defaultV
}

func parseSQLiteLitestreamConfig(basePath string, query *url.Values) (sqliteLitestreamConfig, error) {
	var cfg sqliteLitestreamConfig
	var err error
	if cfg.Enabled, err = extractBoolConfig(query, "litestream_write", false); err != nil {
		return cfg, err
	}
	if !cfg.Enabled {
		return cfg, nil
	}
	if cfg.ReplicaURL, err = extractCustomConfig(query, "litestream_replica_url", ""); err != nil {
		return cfg, err
	}
	replicaPath, err := extractCustomConfig(query, "litestream_path", "")
	if err != nil {
		return cfg, err
	}
	if cfg.SyncInterval, err = extractDurationConfig(query, "litestream_sync_interval", defaultLitestreamSyncInterval); err != nil {
		return cfg, err
	}
	if cfg.PollInterval, err = extractDurationConfig(query, "litestream_poll_interval", defaultLitestreamPollInterval); err != nil {
		return cfg, err
	}
	if cfg.CacheSize, err = extractIntConfig(query, "litestream_cache_size", defaultLitestreamCacheSize); err != nil {
		return cfg, err
	}
	if cfg.BufferPath, err = extractCustomConfig(query, "litestream_buffer_path", ""); err != nil {
		return cfg, err
	}
	if cfg.HydrationPath, err = extractCustomConfig(query, "litestream_hydration_path", ""); err != nil {
		return cfg, err
	}
	if cfg.BarrierTimeout, err = extractDurationConfig(query, "litestream_barrier_timeout", defaultLitestreamBarrierTimeout); err != nil {
		return cfg, err
	}
	if cfg.HydrationEnable, err = extractBoolConfig(query, "litestream_hydration", false); err != nil {
		return cfg, err
	}
	if cfg.AssumeEmpty, err = extractBoolConfig(query, "litestream_assume_empty", false); err != nil {
		return cfg, err
	}
	cfg.RuntimeMaintenance = extractStringConfig(query, "litestream_runtime_maintenance", defaultLitestreamRuntimeMaintenance)
	if cfg.CompactionEnabled, err = extractBoolConfig(query, "litestream_compaction", true); err != nil {
		return cfg, err
	}
	if cfg.SnapshotInterval, err = extractDurationConfig(query, "litestream_snapshot_interval", defaultLitestreamSnapshotInterval); err != nil {
		return cfg, err
	}
	if cfg.SnapshotRetention, err = extractDurationConfig(query, "litestream_snapshot_retention", defaultLitestreamSnapshotRetention); err != nil {
		return cfg, err
	}
	if cfg.L0Retention, err = extractDurationConfig(query, "litestream_l0_retention", defaultLitestreamL0Retention); err != nil {
		return cfg, err
	}

	dir := filepath.Dir(basePath)
	base := filepath.Base(basePath)
	if cfg.BufferPath == "" {
		cfg.BufferPath = filepath.Join(dir, ".litestream", base+".buffer.db")
	}
	if cfg.HydrationEnable && cfg.HydrationPath == "" {
		cfg.HydrationPath = filepath.Join(dir, ".litestream", base+".hydrated.db")
	}

	if cfg.ReplicaURL == "" {
		cfg.ReplicaURL = os.Getenv("LITESTREAM_REPLICA_URL")
	}
	if cfg.ReplicaURL == "" {
		cfg.ReplicaURL = buildLitestreamReplicaURLFromEnv(replicaPath)
	}
	if cfg.ReplicaURL == "" {
		return cfg, fmt.Errorf("litestream_write requires litestream_replica_url or COS/LITESTREAM environment")
	}
	switch cfg.RuntimeMaintenance {
	case "full":
	case "off":
		cfg.CompactionEnabled = false
		cfg.SnapshotInterval = 0
		cfg.SnapshotRetention = 0
		cfg.L0Retention = 0
	case "snapshot_only":
		cfg.CompactionEnabled = true
		cfg.L0Retention = 0
	case "compaction_only":
		cfg.CompactionEnabled = true
		cfg.SnapshotInterval = 0
		cfg.SnapshotRetention = 0
	default:
		return cfg, fmt.Errorf("invalid litestream_runtime_maintenance %q", cfg.RuntimeMaintenance)
	}
	return cfg, nil
}

func buildLitestreamReplicaURLFromEnv(replicaPath string) string {
	if raw := os.Getenv("LITESTREAM_REPLICA_URL"); raw != "" {
		return raw
	}
	bucket := firstNonEmpty(os.Getenv("LITESTREAM_S3_BUCKET"), os.Getenv("COS_BUCKET"))
	if bucket == "" {
		return ""
	}
	pathPart := firstNonEmpty(os.Getenv("LITESTREAM_S3_PATH"), replicaPath)
	pathPart = strings.TrimPrefix(pathPart, "/")
	if pathPart == "" {
		pathPart = "juicefs/metadata"
	}
	u := &url.URL{Scheme: "s3", Host: bucket, Path: "/" + pathPart}
	q := u.Query()
	if endpoint := firstNonEmpty(os.Getenv("LITESTREAM_S3_ENDPOINT"), os.Getenv("COS_ENDPOINT")); endpoint != "" {
		q.Set("endpoint", endpoint)
	}
	if region := firstNonEmpty(os.Getenv("LITESTREAM_S3_REGION"), os.Getenv("COS_REGION")); region != "" {
		q.Set("region", region)
	}
	if forcePathStyle := os.Getenv("LITESTREAM_S3_FORCE_PATH_STYLE"); forcePathStyle != "" {
		q.Set("force-path-style", forcePathStyle)
	} else if os.Getenv("COS_ENDPOINT") != "" {
		// Tencent COS should use virtual-hosted style for the public endpoint we
		// pass above; relying on Litestream's env fallback would default custom
		// endpoints to path-style, which breaks open/ping on COS.
		q.Set("force-path-style", "false")
	}
	if signPayload := os.Getenv("LITESTREAM_S3_SIGN_PAYLOAD"); signPayload != "" {
		q.Set("sign-payload", signPayload)
	} else if os.Getenv("COS_ENDPOINT") != "" {
		q.Set("sign-payload", "true")
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func applyLitestreamEnvironment(cfg sqliteLitestreamConfig) error {
	if !cfg.Enabled {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(cfg.BufferPath), 0o755); err != nil {
		return err
	}
	if cfg.HydrationEnable && cfg.HydrationPath != "" {
		if err := os.MkdirAll(filepath.Dir(cfg.HydrationPath), 0o755); err != nil {
			return err
		}
	}
	_ = os.Setenv("LITESTREAM_WRITE_ENABLED", "true")
	_ = os.Setenv("LITESTREAM_SYNC_INTERVAL", cfg.SyncInterval.String())
	_ = os.Setenv("LITESTREAM_BUFFER_PATH", cfg.BufferPath)
	_ = os.Setenv("LITESTREAM_REPLICA_URL", cfg.ReplicaURL)

	if bucket := os.Getenv("COS_BUCKET"); os.Getenv("LITESTREAM_S3_BUCKET") == "" && bucket != "" {
		_ = os.Setenv("LITESTREAM_S3_BUCKET", bucket)
	}
	if region := os.Getenv("COS_REGION"); os.Getenv("LITESTREAM_S3_REGION") == "" && region != "" {
		_ = os.Setenv("LITESTREAM_S3_REGION", region)
	}
	if endpoint := os.Getenv("COS_ENDPOINT"); os.Getenv("LITESTREAM_S3_ENDPOINT") == "" && endpoint != "" {
		_ = os.Setenv("LITESTREAM_S3_ENDPOINT", endpoint)
	}
	if key := os.Getenv("TENCENTCLOUD_SECRET_ID"); os.Getenv("AWS_ACCESS_KEY_ID") == "" && key != "" {
		_ = os.Setenv("AWS_ACCESS_KEY_ID", key)
	}
	if secret := os.Getenv("TENCENTCLOUD_SECRET_KEY"); os.Getenv("AWS_SECRET_ACCESS_KEY") == "" && secret != "" {
		_ = os.Setenv("AWS_SECRET_ACCESS_KEY", secret)
	}

	if cfg.HydrationEnable && cfg.HydrationPath != "" {
		_ = os.Setenv("LITESTREAM_HYDRATION_ENABLED", "true")
		_ = os.Setenv("LITESTREAM_HYDRATION_PATH", cfg.HydrationPath)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

type dbCheckpointLease struct {
	meta     *dbMeta
	released bool
}

func (l *dbCheckpointLease) Release() error {
	if l == nil || l.meta == nil || l.released {
		return nil
	}
	l.released = true
	l.meta.checkpointMu.Unlock()
	return nil
}

func (m *dbMeta) BeginCheckpoint(ctx context.Context) (CheckpointLease, error) {
	if !m.litestream.Enabled {
		return nil, fmt.Errorf("checkpoint barrier is only available for sqlite litestream mode")
	}
	started := time.Now()
	m.checkpointMu.Lock()
	if err := m.waitForLitestreamBarrierAfterActiveFlush(ctx, m.litestream.BarrierTimeout); err != nil {
		m.checkpointMu.Unlock()
		return nil, err
	}
	targetTXID, err := m.litestreamTXID(ctx)
	if err != nil {
		m.checkpointMu.Unlock()
		return nil, err
	}
	if state, err := m.CheckpointBarrierState(ctx); err != nil {
		logger.Warnf("litestream checkpoint barrier pre-state probe failed: %v", err)
	} else {
		state.RequestedCutID = targetTXID
		state.RequestedCutTXID = targetTXID
		logger.Infof("litestream checkpoint barrier pre-state: requested_cut=%d requested_cut_txid=%d durable_cut=%d local_txid=%d local_replicated_txid=%d global_txid=%d global_replicated_txid=%d write_buffer_size=%d observed_at=%s",
			state.RequestedCutID, state.RequestedCutTXID, state.DurableCutID, state.LocalTXID, state.LocalReplicatedTXID, state.GlobalTXID, state.GlobalReplicatedTXID, state.WriteBufferSize, state.ObservedAt.Format(time.RFC3339Nano))
	}
	if err := m.waitForLitestreamCheckpointCut(ctx, targetTXID, m.litestream.BarrierTimeout); err != nil {
		m.checkpointMu.Unlock()
		return nil, err
	}
	if state, err := m.CheckpointBarrierState(ctx); err != nil {
		logger.Warnf("litestream checkpoint barrier post-state probe failed: %v", err)
	} else {
		state.RequestedCutID = targetTXID
		state.RequestedCutTXID = targetTXID
		logger.Infof("litestream checkpoint barrier post-state: requested_cut=%d requested_cut_txid=%d durable_cut=%d local_txid=%d local_replicated_txid=%d global_txid=%d global_replicated_txid=%d write_buffer_size=%d observed_at=%s",
			state.RequestedCutID, state.RequestedCutTXID, state.DurableCutID, state.LocalTXID, state.LocalReplicatedTXID, state.GlobalTXID, state.GlobalReplicatedTXID, state.WriteBufferSize, state.ObservedAt.Format(time.RFC3339Nano))
	}
	logger.Infof("litestream BeginCheckpoint total wait took %s", time.Since(started))
	return &dbCheckpointLease{meta: m}, nil
}

func (m *dbMeta) waitForLitestreamCheckpointCut(ctx context.Context, targetTXID uint64, timeout time.Duration) error {
	if !m.litestream.Enabled {
		return nil
	}
	started := time.Now()
	var (
		firstRemote uint64
		lastRemote  uint64
		polls       int
	)
	deadline := time.Now().Add(timeout)
	for {
		remoteTXID, err := m.litestreamReplicatedTXID(ctx)
		if err != nil {
			return err
		}
		if polls == 0 {
			firstRemote = remoteTXID
		}
		lastRemote = remoteTXID
		polls++
		if remoteTXID >= targetTXID {
			logger.Infof("litestream checkpoint cut durable: target=%d first_remote=%d last_remote=%d polls=%d duration=%s", targetTXID, firstRemote, lastRemote, polls, time.Since(started))
			return nil
		}
		if timeout > 0 && time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for litestream cut durability: target=%d last_remote=%d", targetTXID, remoteTXID)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (m *dbMeta) waitForLitestreamBarrierAfterActiveFlush(ctx context.Context, timeout time.Duration) error {
	flushStarted := time.Now()
	if err := m.flushLitestreamWrites(ctx); err != nil {
		return err
	}
	logger.Infof("litestream barrier active_flush took %s", time.Since(flushStarted))
	return m.waitForLitestreamBarrier(ctx, timeout)
}

func (m *dbMeta) waitForLitestreamBarrier(ctx context.Context, timeout time.Duration) error {
	if !m.litestream.Enabled {
		return nil
	}
	started := time.Now()
	var (
		firstSize int64 = -1
		lastSize  int64
		polls     int
	)
	deadline := time.Now().Add(timeout)
	for {
		size, err := m.litestreamWriteBufferSize(ctx)
		if err != nil {
			return err
		}
		if firstSize < 0 {
			firstSize = size
		}
		lastSize = size
		polls++
		if size == 0 {
			logger.Infof("litestream barrier drained buffer: first=%d last=%d polls=%d duration=%s", firstSize, lastSize, polls, time.Since(started))
			return nil
		}
		if timeout > 0 && time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for litestream write buffer to drain")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (m *dbMeta) CheckpointBarrierState(ctx context.Context) (*CheckpointBarrierState, error) {
	if !m.litestream.Enabled {
		return nil, fmt.Errorf("checkpoint barrier state is only available for sqlite litestream mode")
	}

	globalTXID, err := m.litestreamGlobalTXID(ctx)
	if err != nil {
		return nil, err
	}
	globalReplicatedTXID, err := m.litestreamGlobalReplicatedTXID(ctx)
	if err != nil {
		return nil, err
	}
	localTXID, err := m.litestreamTXID(ctx)
	if err != nil {
		return nil, err
	}
	localReplicatedTXID, err := m.litestreamReplicatedTXID(ctx)
	if err != nil {
		return nil, err
	}
	writeBufferSize, err := m.litestreamWriteBufferSize(ctx)
	if err != nil {
		return nil, err
	}

	return &CheckpointBarrierState{
		RequestedCutID:       globalTXID,
		RequestedCutTXID:     globalTXID,
		DurableCutID:         globalReplicatedTXID,
		LocalTXID:            localTXID,
		LocalReplicatedTXID:  localReplicatedTXID,
		GlobalTXID:           globalTXID,
		GlobalReplicatedTXID: globalReplicatedTXID,
		WriteBufferSize:      writeBufferSize,
		ObservedAt:           time.Now().UTC(),
	}, nil
}

func (m *dbMeta) litestreamWriteBufferSize(ctx context.Context) (int64, error) {
	var size int64
	err := m.simpleTxn(ctx, func(s *xorm.Session) error {
		rows, err := s.QueryString("SELECT litestream_write_buffer_size() AS value")
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return fmt.Errorf("litestream_write_buffer_size returned no rows")
		}
		v, err := strconv.ParseInt(rows[0]["value"], 10, 64)
		if err != nil {
			return err
		}
		size = v
		return nil
	})
	return size, err
}

func (m *dbMeta) litestreamGlobalTXID(ctx context.Context) (uint64, error) {
	value, err := m.litestreamPragmaValue(ctx, "PRAGMA litestream_global_txid")
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(value, 16, 64)
}

func (m *dbMeta) litestreamTXID(ctx context.Context) (uint64, error) {
	value, err := m.litestreamPragmaValue(ctx, "PRAGMA litestream_txid")
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(value, 16, 64)
}

func (m *dbMeta) litestreamReplicatedTXID(ctx context.Context) (uint64, error) {
	value, err := m.litestreamPragmaValue(ctx, "PRAGMA litestream_replicated_txid")
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(value, 16, 64)
}

func (m *dbMeta) litestreamGlobalReplicatedTXID(ctx context.Context) (uint64, error) {
	value, err := m.litestreamPragmaValue(ctx, "PRAGMA litestream_global_replicated_txid")
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(value, 16, 64)
}

func (m *dbMeta) litestreamPragmaValue(ctx context.Context, query string) (string, error) {
	var value string
	err := m.simpleTxn(ctx, func(s *xorm.Session) error {
		rows, err := s.QueryString(query)
		if err != nil {
			return err
		}
		v, err := firstQueryStringValue(rows)
		if err != nil {
			return err
		}
		value = v
		return nil
	})
	return value, err
}

func (m *dbMeta) probeLitestreamFunctions(ctx context.Context) error {
	if !m.litestream.Enabled {
		return nil
	}
	return m.simpleTxn(ctx, func(s *xorm.Session) error {
		rows, err := s.QueryString("PRAGMA litestream_txid")
		if err != nil {
			return err
		}
		if _, err := firstQueryStringValue(rows); err != nil {
			return fmt.Errorf("litestream txid probe failed: %w", err)
		}
		rows, err = s.QueryString("PRAGMA litestream_lag")
		if err != nil {
			return err
		}
		if _, err := firstQueryStringValue(rows); err != nil {
			return fmt.Errorf("litestream lag probe failed: %w", err)
		}
		rows, err = s.QueryString("PRAGMA litestream_replicated_txid")
		if err != nil {
			return err
		}
		if _, err := firstQueryStringValue(rows); err != nil {
			return fmt.Errorf("litestream replicated txid probe failed: %w", err)
		}
		rows, err = s.QueryString("PRAGMA litestream_global_txid")
		if err != nil {
			return err
		}
		if _, err := firstQueryStringValue(rows); err != nil {
			return fmt.Errorf("litestream global txid probe failed: %w", err)
		}
		rows, err = s.QueryString("PRAGMA litestream_global_replicated_txid")
		if err != nil {
			return err
		}
		if _, err := firstQueryStringValue(rows); err != nil {
			return fmt.Errorf("litestream global replicated txid probe failed: %w", err)
		}
		rows, err = s.QueryString("SELECT litestream_write_buffer_size() AS buffer_size")
		if err != nil {
			return err
		}
		if _, err := firstQueryStringValue(rows); err != nil {
			return fmt.Errorf("litestream write-buffer probe failed: %w", err)
		}
		return nil
	})
}

func firstQueryStringValue(rows []map[string]string) (string, error) {
	if len(rows) == 0 {
		return "", fmt.Errorf("query returned no rows")
	}
	for _, v := range rows[0] {
		return v, nil
	}
	if len(rows[0]) == 0 {
		return "", fmt.Errorf("query returned an empty row")
	}
	return "", fmt.Errorf("query returned no values")
}
