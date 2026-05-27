package cmd

import (
	"errors"
	"flag"
	"path/filepath"
	"strings"
	"testing"

	"github.com/superfly/ltx"
	"github.com/urfave/cli/v2"
)

func TestDeriveLocalRootPaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), "local-root")
	paths, err := deriveLocalRootPaths(root, "demo1")
	if err != nil {
		t.Fatalf("deriveLocalRootPaths: %v", err)
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		t.Fatalf("abs root: %v", err)
	}
	workspaceRoot := filepath.Join(absRoot, "demo1")
	if paths.metaBase != filepath.Join(workspaceRoot, "meta") {
		t.Fatalf("metaBase mismatch: %q", paths.metaBase)
	}
	if paths.mountBase != filepath.Join(workspaceRoot, "mnt") {
		t.Fatalf("mountBase mismatch: %q", paths.mountBase)
	}
	if paths.cacheDir != filepath.Join(workspaceRoot, "cache") {
		t.Fatalf("cacheDir mismatch: %q", paths.cacheDir)
	}
	if paths.logPath != filepath.Join(workspaceRoot, "log", "juicefs.log") {
		t.Fatalf("logPath mismatch: %q", paths.logPath)
	}
}

func TestBuildSMountRemoteTargetsSMHRequiresConfig(t *testing.T) {
	_, _, err := buildSMountRemoteTargets("smh", "workspace", "demo")
	if err == nil {
		t.Fatal("expected error for smh backend without config")
	}
}

func TestBuildSMountRemoteTargetsSMH(t *testing.T) {
	t.Setenv("SMH_ACCESS_DOMAIN", "https://example.api.tencentsmh.cn")
	t.Setenv("SMH_LIBRARY_ID", "lib123")
	t.Setenv("SMH_SPACE_ID", "space123")
	t.Setenv("SMH_PERMANENT_DELETE", "0")
	replica, bucket, err := buildSMountRemoteTargets("smh", "workspace", "demo")
	if err != nil {
		t.Fatal(err)
	}
	wantReplica := "smh://example.api.tencentsmh.cn/workspace/demo/meta.db?endpoint=https%3A%2F%2Fexample.api.tencentsmh.cn&layout=flat&library_id=lib123&permanent=0&space_id=space123"
	if replica != wantReplica {
		t.Fatalf("replica=%q want %q", replica, wantReplica)
	}
	want := "https://example.api.tencentsmh.cn?library_id=lib123&permanent=0&prefix=workspace%2Fdemo%2Fdata&space_id=space123"
	if bucket != want {
		t.Fatalf("bucket=%q want %q", bucket, want)
	}
}

func TestBuildSMountRemoteTargetsSMHUsesExplicitReplicaOverride(t *testing.T) {
	t.Setenv("SMH_META_REPLICA_URL", "file:///tmp/meta-replica")
	t.Setenv("SMH_ACCESS_DOMAIN", "https://example.api.tencentsmh.cn")
	t.Setenv("SMH_LIBRARY_ID", "lib123")
	t.Setenv("SMH_SPACE_ID", "space123")
	replica, _, err := buildSMountRemoteTargets("smh", "workspace", "demo")
	if err != nil {
		t.Fatal(err)
	}
	if replica != "file:///tmp/meta-replica" {
		t.Fatalf("replica=%q", replica)
	}
}

func TestResolveRemoteBackend(t *testing.T) {
	t.Setenv("REMOTE_BACKEND", "smh")
	if got := resolveRemoteBackend(); got != "smh" {
		t.Fatalf("resolveRemoteBackend=%q", got)
	}
	t.Setenv("REMOTE_BACKEND", "")
	if got := resolveRemoteBackend(); got != "cos" {
		t.Fatalf("resolveRemoteBackend default=%q", got)
	}
}

func TestBuildSMountTargetUsesExplicitOverridesForSMH(t *testing.T) {
	t.Setenv("REMOTE_BACKEND", "smh")
	t.Setenv("JFS_META_URL", "sqlite3:///tmp/custom.db")
	t.Setenv("JFS_BUCKET_URL", "smh://example")
	app := cmdSMount()
	set := flagSetForTest(t, app)
	if err := set.Set("meta-base", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	ctx := cli.NewContext(&cli.App{}, set, nil)
	addr, _, bucket, err := buildSMountTarget(ctx, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if addr != "sqlite3:///tmp/custom.db" || bucket != "smh://example" {
		t.Fatalf("addr=%q bucket=%q", addr, bucket)
	}
}

func TestAssertMountCommandFlags(t *testing.T) {
	app := cmdAssertMount()
	set := flagSetForTest(t, app)
	if err := set.Set("managed", "true"); err != nil {
		t.Fatal(err)
	}
	if err := set.Set("mountpoint", "/mnt/demo"); err != nil {
		t.Fatal(err)
	}
	if err := set.Set("trash-days", "0"); err != nil {
		t.Fatal(err)
	}
	if err := set.Set("bootstrap-sync-interval", "250ms"); err != nil {
		t.Fatal(err)
	}
	ctx := cli.NewContext(&cli.App{}, set, nil)
	if !ctx.Bool("managed") {
		t.Fatal("managed flag should be true")
	}
	if ctx.String("mountpoint") != "/mnt/demo" {
		t.Fatalf("mountpoint=%q", ctx.String("mountpoint"))
	}
	if ctx.Int("trash-days") != 0 {
		t.Fatalf("trash-days=%d", ctx.Int("trash-days"))
	}
	if ctx.String("bootstrap-sync-interval") != "250ms" {
		t.Fatalf("bootstrap-sync-interval=%q", ctx.String("bootstrap-sync-interval"))
	}
}

func TestLitestreamReplicaURLFromSQLiteAddr(t *testing.T) {
	got, err := litestreamReplicaURLFromSQLiteAddr("sqlite3:///tmp/meta.db?litestream_replica_url=smh%3A%2F%2Fexample%2Fworkspace%2Fdemo%2Fmeta.db")
	if err != nil {
		t.Fatal(err)
	}
	if got != "smh://example/workspace/demo/meta.db" {
		t.Fatalf("replica URL=%q", got)
	}
	if _, err := litestreamReplicaURLFromSQLiteAddr("sqlite3:///tmp/meta.db"); err == nil {
		t.Fatal("expected missing replica URL error")
	}
}

func TestMarkSQLiteAssumeEmpty(t *testing.T) {
	got := markSQLiteAssumeEmpty("sqlite3:///tmp/meta.db?litestream_write=true")
	if !strings.Contains(got, "litestream_assume_empty=true") {
		t.Fatalf("assume-empty flag missing from %q", got)
	}
	if !strings.Contains(got, "litestream_write=true") {
		t.Fatalf("existing query missing from %q", got)
	}
}

func TestSetSQLiteLitestreamSyncIntervalOnlyChangesFormatAddr(t *testing.T) {
	addr := "sqlite3:///tmp/meta.db?litestream_write=true&litestream_sync_interval=3s"
	formatAddr := setSQLiteLitestreamSyncInterval(markSQLiteAssumeEmpty(addr), "250ms")
	if !strings.Contains(formatAddr, "litestream_sync_interval=250ms") {
		t.Fatalf("format sync interval missing from %q", formatAddr)
	}
	if !strings.Contains(formatAddr, "litestream_assume_empty=true") {
		t.Fatalf("assume-empty flag missing from %q", formatAddr)
	}
	if !strings.Contains(addr, "litestream_sync_interval=3s") {
		t.Fatalf("long-lived mount addr should be unchanged, got %q", addr)
	}
}

func TestAssertMountShouldBootstrapOnlyInOuterStage(t *testing.T) {
	cases := []struct {
		name       string
		stage      int
		supervisor string
		want       bool
	}{
		{name: "outer stage", stage: 0, want: true},
		{name: "daemon stage one", stage: 1, want: false},
		{name: "daemon stage two", stage: 2, want: false},
		{name: "supervised mount", stage: 0, supervisor: "123", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := assertMountShouldBootstrap(tc.stage, tc.supervisor); got != tc.want {
				t.Fatalf("assertMountShouldBootstrap(%d, %q)=%t want %t", tc.stage, tc.supervisor, got, tc.want)
			}
		})
	}
}

func TestFileIteratorHasNextReturnsIteratorError(t *testing.T) {
	want := errors.New("delayed iterator error")
	_, err := fileIteratorHasNext(&errorFileIterator{err: want})
	if !errors.Is(err, want) {
		t.Fatalf("err=%v want %v", err, want)
	}
}

func TestApplyBackendStorageFlagDefaultsSMH(t *testing.T) {
	app := cmdSFormat()
	set := flagSetForTest(t, app)
	ctx := cli.NewContext(&cli.App{}, set, nil)
	if err := applyBackendStorageFlagDefaults(ctx, "smh", "https://example?library_id=lib&space_id=space"); err != nil {
		t.Fatal(err)
	}
	if ctx.String("storage") != "smh" {
		t.Fatalf("storage=%q", ctx.String("storage"))
	}
	if ctx.String("bucket") != "https://example?library_id=lib&space_id=space" {
		t.Fatalf("bucket=%q", ctx.String("bucket"))
	}
	if ctx.String("session-token") != "" {
		t.Fatalf("session-token should stay empty, got %q", ctx.String("session-token"))
	}
	if ctx.String("access-key") != "" {
		t.Fatalf("access-key should stay empty, got %q", ctx.String("access-key"))
	}
}

type errorFileIterator struct {
	err error
}

func (i *errorFileIterator) Close() error { return nil }
func (i *errorFileIterator) Next() bool   { return false }
func (i *errorFileIterator) Err() error   { return i.err }
func (i *errorFileIterator) Item() *ltx.FileInfo {
	return nil
}

func flagSetForTest(t *testing.T, app *cli.Command) *flag.FlagSet {
	t.Helper()
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	for _, f := range app.Flags {
		if err := f.Apply(fs); err != nil {
			t.Fatal(err)
		}
	}
	return fs
}
