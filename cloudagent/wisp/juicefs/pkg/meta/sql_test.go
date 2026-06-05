/*
 * JuiceFS, Copyright 2020 Juicedata, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

//nolint:errcheck
package meta

import (
	"context"
	"net/url"
	"os"
	"path"
	"strings"
	"syscall"
	"testing"
	"time"

	"xorm.io/xorm"
)

func TestSQLiteClient(t *testing.T) {
	m, err := newSQLMeta("sqlite3", path.Join(t.TempDir(), "jfs-unit-test.db"), testConfig())
	if err != nil || m.Name() != "sqlite3" {
		t.Fatalf("create meta: %s", err)
	}
	testMeta(t, m)
}

func TestMySQLClient(t *testing.T) { //skip mutate
	m, err := newSQLMeta("mysql", "root:@/dev", testConfig())
	if err != nil || m.Name() != "mysql" {
		t.Fatalf("create meta: %s", err)
	}
	testMeta(t, m)
}

func TestPostgreSQLClient(t *testing.T) { //skip mutate
	if os.Getenv("SKIP_NON_CORE") == "true" {
		t.Skipf("skip non-core test")
	}
	m, err := newSQLMeta("postgres", "localhost:5432/test?sslmode=disable", testConfig())
	if err != nil || m.Name() != "postgres" {
		t.Fatalf("create meta: %s", err)
	}
	testMeta(t, m)
}

func TestPostgreSQLClientWithSearchPath(t *testing.T) { //skip mutate
	_, err := newSQLMeta("postgres", "localhost:5432/test?sslmode=disable&search_path=juicefs,public", testConfig())
	if !strings.Contains(err.Error(), "currently, only one schema is supported in search_path") {
		t.Fatalf("TestPostgreSQLClientWithSearchPath error: %s", err)
	}
}

func TestRecoveryMysqlPwd(t *testing.T) { //skip mutate
	testCase := []struct {
		addr   string
		expect string
	}{
		// no password
		{"root@(localhost:3306)/db1",
			"root@(localhost:3306)/db1",
		},
		// no password
		{"root:@(localhost:3306)/db1",
			"root:@(localhost:3306)/db1",
		},

		{"root::@@(localhost:3306)/db1",
			"root::@@(localhost:3306)/db1",
		},

		{"root:@:@(localhost:3306)/db1",
			"root:@:@(localhost:3306)/db1",
		},

		// no special char
		{"root:password@(localhost:3306)/db1",
			"root:password@(localhost:3306)/db1",
		},

		// set from env @
		{"root:pass%40word@(localhost:3306)/db1",
			"root:pass@word@(localhost:3306)/db1",
		},

		// direct pass special char @
		{"root:pass@word@(localhost:3306)/db1",
			"root:pass@word@(localhost:3306)/db1",
		},

		// set from env |
		{"root:pass%7Cword@(localhost:3306)/db1",
			"root:pass|word@(localhost:3306)/db1",
		},

		// direct pass special char |
		{"root:pass|word@(localhost:3306)/db1",
			"root:pass|word@(localhost:3306)/db1",
		},

		// set from env :
		{"root:pass%3Aword@(localhost:3306)/db1",
			"root:pass:word@(localhost:3306)/db1",
		},

		// direct pass special char :
		{"root:pass:word@(localhost:3306)/db1",
			"root:pass:word@(localhost:3306)/db1",
		},
	}
	for _, tc := range testCase {
		if got := recoveryMysqlPwd(tc.addr); got != tc.expect {
			t.Fatalf("recoveryMysqlPwd error: expect %s but got %s", tc.expect, got)
		}
	}
}

func TestGetCustomConfig(t *testing.T) {
	u := "mysql://root:password@tcp(localhost:3306)/db1?max_open_conns=100&notDefine=str"
	_, after, _ := strings.Cut(u, "?")
	query, err := url.ParseQuery(after)
	if err != nil {
		t.Fatalf("url parse query error: %s", err)
	}
	maxOpenConns, err := extractCustomConfig(&query, "max_open_conns", 1)
	if err != nil {
		t.Fatalf("getCustomConfig error: %s", err)
	}
	if maxOpenConns != 100 {
		t.Fatalf("getCustomConfig error: expect 100 but got %d", maxOpenConns)
	}
	if query.Has("max_open_conns") {
		t.Fatalf("getCustomConfig error: expect not found but found")
	}

	not, err := extractCustomConfig(&query, "notSetKey", "default")
	if err != nil {
		t.Fatalf("getCustomConfig error: %s", err)
	}
	if not != "default" {
		t.Fatalf("getCustomConfig error: expect default but got %s", not)
	}
	if !query.Has("notDefine") {
		t.Fatalf("getCustomConfig error: expect found but not")
	}

}

func TestParseSQLiteLitestreamConfig(t *testing.T) {
	t.Setenv("LITESTREAM_REPLICA_URL", "")
	t.Setenv("COS_BUCKET", "test-bucket")
	t.Setenv("COS_REGION", "ap-guangzhou")
	t.Setenv("COS_ENDPOINT", "http://cos.ap-guangzhou.myqcloud.com")
	t.Setenv("TENCENTCLOUD_SECRET_ID", "id")
	t.Setenv("TENCENTCLOUD_SECRET_KEY", "secret")

	query := url.Values{}
	query.Set("litestream_write", "true")
	query.Set("litestream_path", "metadata/test.db")
	query.Set("litestream_sync_interval", "500ms")
	query.Set("litestream_poll_interval", "2s")
	query.Set("litestream_cache_size", "1048576")
	query.Set("litestream_barrier_timeout", "9s")
	query.Set("litestream_runtime_maintenance", "snapshot_only")
	query.Set("litestream_snapshot_interval", "2m")
	query.Set("litestream_snapshot_retention", "7m")
	query.Set("litestream_l0_retention", "11m")
	query.Set("litestream_assume_empty", "true")

	cfg, err := parseSQLiteLitestreamConfig("/tmp/meta.db", &query)
	if err != nil {
		t.Fatalf("parse litestream config: %s", err)
	}
	if !cfg.Enabled {
		t.Fatalf("litestream should be enabled")
	}
	if cfg.SyncInterval != 500*time.Millisecond {
		t.Fatalf("sync interval = %s", cfg.SyncInterval)
	}
	if cfg.PollInterval != 2*time.Second {
		t.Fatalf("poll interval = %s", cfg.PollInterval)
	}
	if cfg.CacheSize != 1048576 {
		t.Fatalf("cache size = %d", cfg.CacheSize)
	}
	if cfg.BarrierTimeout != 9*time.Second {
		t.Fatalf("barrier timeout = %s", cfg.BarrierTimeout)
	}
	if cfg.HydrationEnable {
		t.Fatalf("hydration should be disabled by default")
	}
	if !cfg.AssumeEmpty {
		t.Fatalf("assume empty should be enabled")
	}
	if cfg.RuntimeMaintenance != "snapshot_only" {
		t.Fatalf("runtime maintenance = %q", cfg.RuntimeMaintenance)
	}
	if !cfg.CompactionEnabled {
		t.Fatalf("compaction should be enabled by default")
	}
	if cfg.SnapshotInterval != 2*time.Minute {
		t.Fatalf("snapshot interval = %s", cfg.SnapshotInterval)
	}
	if cfg.SnapshotRetention != 7*time.Minute {
		t.Fatalf("snapshot retention = %s", cfg.SnapshotRetention)
	}
	if cfg.L0Retention != 0 {
		t.Fatalf("l0 retention = %s", cfg.L0Retention)
	}
	if cfg.ReplicaURL != "s3://test-bucket/metadata/test.db?endpoint=http%3A%2F%2Fcos.ap-guangzhou.myqcloud.com&force-path-style=false&region=ap-guangzhou&sign-payload=true" {
		t.Fatalf("replica url = %s", cfg.ReplicaURL)
	}
	if !strings.Contains(cfg.BufferPath, ".litestream") || !strings.HasSuffix(cfg.BufferPath, ".buffer.db") {
		t.Fatalf("unexpected buffer path: %s", cfg.BufferPath)
	}
	if cfg.HydrationPath != "" {
		t.Fatalf("hydration path should be empty when hydration is disabled by default: %s", cfg.HydrationPath)
	}
	if query.Has("litestream_write") || query.Has("litestream_path") || query.Has("litestream_sync_interval") || query.Has("litestream_poll_interval") || query.Has("litestream_cache_size") || query.Has("litestream_barrier_timeout") || query.Has("litestream_runtime_maintenance") || query.Has("litestream_snapshot_interval") || query.Has("litestream_snapshot_retention") || query.Has("litestream_l0_retention") || query.Has("litestream_assume_empty") {
		t.Fatalf("litestream query params should be consumed")
	}
}

func TestParseSQLiteLitestreamRuntimeMaintenanceModes(t *testing.T) {
	t.Setenv("LITESTREAM_REPLICA_URL", "file:///tmp/litestream-runtime-mode")

	cases := []struct {
		name            string
		mode            string
		wantCompaction  bool
		wantSnapshot    time.Duration
		wantRetention   time.Duration
		wantL0Retention time.Duration
	}{
		{name: "off", mode: "off", wantCompaction: false, wantSnapshot: 0, wantRetention: 0, wantL0Retention: 0},
		{name: "full", mode: "full", wantCompaction: true, wantSnapshot: defaultLitestreamSnapshotInterval, wantRetention: defaultLitestreamSnapshotRetention, wantL0Retention: defaultLitestreamL0Retention},
		{name: "snapshot_only", mode: "snapshot_only", wantCompaction: true, wantSnapshot: defaultLitestreamSnapshotInterval, wantRetention: defaultLitestreamSnapshotRetention, wantL0Retention: 0},
		{name: "compaction_only", mode: "compaction_only", wantCompaction: true, wantSnapshot: 0, wantRetention: 0, wantL0Retention: defaultLitestreamL0Retention},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			query := url.Values{}
			query.Set("litestream_write", "true")
			query.Set("litestream_runtime_maintenance", tc.mode)
			cfg, err := parseSQLiteLitestreamConfig("/tmp/meta.db", &query)
			if err != nil {
				t.Fatalf("parse litestream config: %s", err)
			}
			if cfg.RuntimeMaintenance != tc.mode {
				t.Fatalf("runtime maintenance = %q", cfg.RuntimeMaintenance)
			}
			if cfg.CompactionEnabled != tc.wantCompaction {
				t.Fatalf("compaction enabled = %v", cfg.CompactionEnabled)
			}
			if cfg.SnapshotInterval != tc.wantSnapshot {
				t.Fatalf("snapshot interval = %s", cfg.SnapshotInterval)
			}
			if cfg.SnapshotRetention != tc.wantRetention {
				t.Fatalf("snapshot retention = %s", cfg.SnapshotRetention)
			}
			if cfg.L0Retention != tc.wantL0Retention {
				t.Fatalf("l0 retention = %s", cfg.L0Retention)
			}
		})
	}
}

func TestApplyLitestreamEnvironment(t *testing.T) {
	t.Setenv("LITESTREAM_REPLICA_URL", "")
	t.Setenv("LITESTREAM_S3_BUCKET", "")
	t.Setenv("LITESTREAM_S3_REGION", "")
	t.Setenv("LITESTREAM_S3_ENDPOINT", "")
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	t.Setenv("COS_BUCKET", "agentsessiongz-1388575217")
	t.Setenv("COS_REGION", "ap-guangzhou")
	t.Setenv("COS_ENDPOINT", "http://cos.ap-guangzhou.myqcloud.com")
	t.Setenv("TENCENTCLOUD_SECRET_ID", "akid")
	t.Setenv("TENCENTCLOUD_SECRET_KEY", "secret")

	cfg := sqliteLitestreamConfig{
		Enabled:         true,
		ReplicaURL:      "s3://agentsessiongz-1388575217/juicefs/meta.db",
		SyncInterval:    250 * time.Millisecond,
		BufferPath:      path.Join(t.TempDir(), ".litestream", "meta.buffer.db"),
		HydrationPath:   path.Join(t.TempDir(), ".litestream", "meta.hydrated.db"),
		BarrierTimeout:  30 * time.Second,
		HydrationEnable: true,
	}
	if err := applyLitestreamEnvironment(cfg); err != nil {
		t.Fatalf("apply env: %s", err)
	}
	if os.Getenv("LITESTREAM_WRITE_ENABLED") != "true" {
		t.Fatalf("write mode env not set")
	}
	if os.Getenv("LITESTREAM_REPLICA_URL") != cfg.ReplicaURL {
		t.Fatalf("replica url env = %s", os.Getenv("LITESTREAM_REPLICA_URL"))
	}
	if os.Getenv("LITESTREAM_S3_BUCKET") != "agentsessiongz-1388575217" {
		t.Fatalf("s3 bucket env = %s", os.Getenv("LITESTREAM_S3_BUCKET"))
	}
	if os.Getenv("AWS_ACCESS_KEY_ID") != "akid" || os.Getenv("AWS_SECRET_ACCESS_KEY") != "secret" {
		t.Fatalf("aws credential fallback not set")
	}
}

func TestBuildLitestreamReplicaURLFromEnvCOS(t *testing.T) {
	t.Setenv("LITESTREAM_REPLICA_URL", "")
	t.Setenv("LITESTREAM_S3_BUCKET", "")
	t.Setenv("LITESTREAM_S3_PATH", "")
	t.Setenv("LITESTREAM_S3_ENDPOINT", "")
	t.Setenv("LITESTREAM_S3_REGION", "")
	t.Setenv("LITESTREAM_S3_FORCE_PATH_STYLE", "")
	t.Setenv("LITESTREAM_S3_SIGN_PAYLOAD", "")
	t.Setenv("COS_BUCKET", "agentsessiongz-1388575217")
	t.Setenv("COS_REGION", "ap-guangzhou")
	t.Setenv("COS_ENDPOINT", "http://cos.ap-guangzhou.myqcloud.com")

	got := buildLitestreamReplicaURLFromEnv("juicefs/meta.db")
	want := "s3://agentsessiongz-1388575217/juicefs/meta.db?endpoint=https%3A%2F%2Fcos.ap-guangzhou.myqcloud.com&force-path-style=false&region=ap-guangzhou&sign-payload=true"
	if got != want {
		t.Fatalf("replica url = %s, want %s", got, want)
	}
}

func TestSQLiteLitestreamRequiresBuildTag(t *testing.T) {
	addr := path.Join(t.TempDir(), "litestream.db")
	replicaDir := path.Join(t.TempDir(), "replica")
	m, err := newSQLMeta("sqlite3", addr+"?litestream_write=true&litestream_replica_url=file://"+replicaDir, testConfig())
	if litestreamBuildEnabled() {
		if err != nil {
			t.Fatalf("create litestream sqlite meta: %s", err)
		}
		_ = m.Shutdown()
		return
	}
	if err == nil {
		_ = m.Shutdown()
		t.Fatalf("expected litestream build-tag error")
	}
	if !strings.Contains(err.Error(), "litestreamvfs") {
		t.Fatalf("unexpected error: %s", err)
	}
}

func TestSQLiteLitestreamCheckpointBarrier(t *testing.T) {
	if !litestreamBuildEnabled() {
		t.Skip("litestream VFS build tags are not enabled")
	}

	addr := path.Join(t.TempDir(), "litestream-barrier.db")
	replicaDir := path.Join(t.TempDir(), "replica")
	m, err := newSQLMeta("sqlite3", addr+"?litestream_write=true&litestream_replica_url=file://"+replicaDir, testConfig())
	if err != nil {
		t.Fatalf("create litestream sqlite meta: %s", err)
	}
	defer func() { _ = m.Shutdown() }()

	barrier, ok := m.(CheckpointBarrier)
	if !ok {
		t.Fatalf("meta %T does not implement CheckpointBarrier", m)
	}

	lease, err := barrier.BeginCheckpoint(context.Background())
	if err != nil {
		t.Fatalf("begin checkpoint barrier: %s", err)
	}
	if err := lease.Release(); err != nil {
		t.Fatalf("release checkpoint barrier: %s", err)
	}
}

func TestSQLiteLitestreamCheckpointBarrierDrainsPendingWrites(t *testing.T) {
	if !litestreamBuildEnabled() {
		t.Skip("litestream VFS build tags are not enabled")
	}

	addr := path.Join(t.TempDir(), "litestream-barrier-drain.db")
	replicaDir := path.Join(t.TempDir(), "replica")
	m, err := newSQLMeta("sqlite3", addr+"?litestream_write=true&litestream_sync_interval=1h&litestream_replica_url=file://"+replicaDir, testConfig())
	if err != nil {
		t.Fatalf("create litestream sqlite meta: %s", err)
	}
	defer func() { _ = m.Shutdown() }()
	if err := m.Init(testFormat(), false); err != nil {
		t.Fatalf("init litestream sqlite meta: %s", err)
	}

	var inode Ino
	var attr Attr
	ctx := NewContext(1, 0, []uint32{0})
	if st := m.Create(ctx, RootInode, "pending.txt", 0o644, 0, uint32(syscall.O_RDWR), &inode, &attr); st != 0 {
		t.Fatalf("create pending file: %s", st)
	}

	barrier, ok := m.(CheckpointBarrier)
	if !ok {
		t.Fatalf("meta %T does not implement CheckpointBarrier", m)
	}
	started := time.Now()
	lease, err := barrier.BeginCheckpoint(context.Background())
	if err != nil {
		t.Fatalf("begin checkpoint barrier: %s", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("checkpoint barrier waited for periodic sync instead of active flush: %s", elapsed)
	}
	if err := lease.Release(); err != nil {
		t.Fatalf("release checkpoint barrier: %s", err)
	}

	observer, ok := m.(CheckpointBarrierObserver)
	if !ok {
		t.Fatalf("meta %T does not implement CheckpointBarrierObserver", m)
	}
	state, err := observer.CheckpointBarrierState(context.Background())
	if err != nil {
		t.Fatalf("checkpoint barrier state: %s", err)
	}
	if state.WriteBufferSize != 0 {
		t.Fatalf("checkpoint barrier left write buffer size=%d", state.WriteBufferSize)
	}
	if state.LocalReplicatedTXID < state.LocalTXID {
		t.Fatalf("checkpoint barrier did not replicate local txid: local=%d replicated=%d", state.LocalTXID, state.LocalReplicatedTXID)
	}
}

func TestSQLiteLitestreamPragmaProbe(t *testing.T) {
	if !litestreamBuildEnabled() {
		t.Skip("litestream VFS build tags are not enabled")
	}

	addr := path.Join(t.TempDir(), "litestream-pragma.db")
	replicaDir := path.Join(t.TempDir(), "replica")
	m, err := newSQLMeta("sqlite3", addr+"?litestream_write=true&litestream_replica_url=file://"+replicaDir, testConfig())
	if err != nil {
		t.Fatalf("create litestream sqlite meta: %s", err)
	}
	defer func() { _ = m.Shutdown() }()

	dbm, ok := m.(*dbMeta)
	if !ok {
		t.Fatalf("unexpected meta type %T", m)
	}
	if err := dbm.simpleTxn(context.Background(), func(s *xorm.Session) error {
		rows, err := s.QueryString("PRAGMA litestream_txid")
		if err != nil {
			return err
		}
		if _, err := firstQueryStringValue(rows); err != nil {
			return err
		}
		rows, err = s.QueryString("PRAGMA litestream_lag")
		if err != nil {
			return err
		}
		_, err = firstQueryStringValue(rows)
		return err
	}); err != nil {
		t.Fatalf("pragma probe failed: %s", err)
	}
}

func TestSQLiteLitestreamCheckpointBarrierState(t *testing.T) {
	if !litestreamBuildEnabled() {
		t.Skip("litestream VFS build tags are not enabled")
	}

	addr := path.Join(t.TempDir(), "litestream-state.db")
	replicaDir := path.Join(t.TempDir(), "replica")
	m, err := newSQLMeta("sqlite3", addr+"?litestream_write=true&litestream_replica_url=file://"+replicaDir, testConfig())
	if err != nil {
		t.Fatalf("create litestream sqlite meta: %s", err)
	}
	defer func() { _ = m.Shutdown() }()

	observer, ok := m.(CheckpointBarrierObserver)
	if !ok {
		t.Fatalf("meta %T does not implement CheckpointBarrierObserver", m)
	}

	state, err := observer.CheckpointBarrierState(context.Background())
	if err != nil {
		t.Fatalf("checkpoint barrier state: %s", err)
	}
	if state == nil {
		t.Fatal("checkpoint barrier state is nil")
	}
	if state.ObservedAt.IsZero() {
		t.Fatal("checkpoint barrier state missing observed_at")
	}
	if state.LocalReplicatedTXID > state.LocalTXID {
		t.Fatalf("local replicated txid %d cannot be ahead of local txid %d", state.LocalReplicatedTXID, state.LocalTXID)
	}
	if state.DurableCutID > state.GlobalTXID {
		t.Fatalf("durable cut %d cannot be ahead of global txid %d", state.DurableCutID, state.GlobalTXID)
	}
	if state.WriteBufferSize < 0 {
		t.Fatalf("unexpected negative write buffer size: %d", state.WriteBufferSize)
	}
}
