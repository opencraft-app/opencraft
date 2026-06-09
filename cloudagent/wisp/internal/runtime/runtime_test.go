package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"wisp/internal/config"
)

func TestJuiceFSScriptEnvDoesNotLeakSMHSecret(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("UNRELATED_SECRET", "do-not-leak")
	t.Setenv("SMH_ACCESS_TOKEN", "short-token")
	t.Setenv("SMH_META_REPLICA_URL", "file:///tmp/smh-meta")
	t.Setenv("LITESTREAM_S3_ENDPOINT", "https://cos.example.test")
	t.Setenv("LITESTREAM_S3_FORCE_PATH_STYLE", "false")
	rt := New(config.Config{
		RemoteBackend:    "smh",
		SMHEnabled:       true,
		SMHLibraryID:     "lib",
		SMHAccessDomain:  "https://example.api.tencentsmh.cn",
		SMHLibrarySecret: "super-secret",
		SMHSpaceID:       "space-1",
	})
	values, err := rt.juiceFSScriptEnv(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	env := strings.Join(values, "\n")
	if !strings.Contains(env, "REMOTE_BACKEND=smh") ||
		!strings.Contains(env, "SMH_LIBRARY_ID=lib") ||
		!strings.Contains(env, "SMH_ACCESS_DOMAIN=https://example.api.tencentsmh.cn") ||
		!strings.Contains(env, "SMH_SPACE_ID=space-1") ||
		!strings.Contains(env, "SMH_ACCESS_TOKEN=short-token") ||
		!strings.Contains(env, "SMH_META_REPLICA_URL=file:///tmp/smh-meta") ||
		!strings.Contains(env, "LITESTREAM_S3_ENDPOINT=https://cos.example.test") ||
		!strings.Contains(env, "LITESTREAM_S3_FORCE_PATH_STYLE=false") {
		t.Fatalf("env missing expected keys: %s", env)
	}
	if strings.Contains(env, "SMH_LIBRARY_SECRET") || strings.Contains(env, "UNRELATED_SECRET") {
		t.Fatalf("env leaked secret: %s", env)
	}
}

func TestJuiceFSAssertMountAvailableRequiresExecutableWithSubcommand(t *testing.T) {
	dir := t.TempDir()
	supported := filepath.Join(dir, "juicefs-supported")
	if err := os.WriteFile(supported, []byte("#!/bin/sh\n[ \"$1\" = assertmount ] && [ \"$2\" = --help ] && exit 0\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	rt := New(config.Config{JFSBin: supported})
	if ok, reason := rt.juiceFSAssertMountAvailable(context.Background()); !ok {
		t.Fatalf("expected assertmount available, reason=%s", reason)
	}

	unsupported := filepath.Join(dir, "juicefs-unsupported")
	if err := os.WriteFile(unsupported, []byte("#!/bin/sh\necho 'unknown command' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	rt = New(config.Config{JFSBin: unsupported})
	if ok, _ := rt.juiceFSAssertMountAvailable(context.Background()); ok {
		t.Fatal("old binary without assertmount should be unavailable")
	}

	notExecutable := filepath.Join(dir, "juicefs-not-executable")
	if err := os.WriteFile(notExecutable, []byte("#!/bin/sh\nexit 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	rt = New(config.Config{JFSBin: notExecutable})
	if ok, reason := rt.juiceFSAssertMountAvailable(context.Background()); ok || !strings.Contains(reason, "not executable") {
		t.Fatalf("expected not executable reason, ok=%t reason=%s", ok, reason)
	}
}

func TestRunJuiceFSAssertMountPassesStartupSyncInterval(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "args")
	envFile := filepath.Join(dir, "env")
	bin := filepath.Join(dir, "juicefs")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + argsFile + "\nprintf '%s\\n' \"${JFS_NO_CHECK_OBJECT_STORAGE:-}\" > " + envFile + "\nexit 0\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("JFS_ASSERTMOUNT_SYNC_INTERVAL", "250ms")
	t.Setenv("JFS_ASSERTMOUNT_SKIP_OBJECT_STORAGE_CHECK", "1")
	t.Setenv("JFS_MOUNT_WRITEBACK", "1")
	t.Setenv("JFS_MOUNT_UPLOAD_DELAY", "30s")
	t.Setenv("JFS_MOUNT_MAX_UPLOADS", "20")
	t.Setenv("JFS_MOUNT_FREE_SPACE_RATIO", "0.3")
	rt := New(config.Config{
		JFSBin:       bin,
		JFSPrefix:    "workspace-fast",
		JFSLocalRoot: filepath.Join(dir, "local"),
	})
	if err := rt.runJuiceFSAssertMount(context.Background(), "default", filepath.Join(dir, "mnt")); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Split(strings.TrimSpace(string(raw)), "\n")
	want := []string{
		"assertmount",
		"default",
		"--mountpoint",
		filepath.Join(dir, "mnt"),
		"--managed",
		"-d",
		"--workspace-prefix",
		"workspace-fast",
		"--local-root",
		filepath.Join(dir, "local"),
		"--bootstrap-sync-interval",
		"250ms",
		"--writeback",
		"--upload-delay",
		"30s",
		"--max-uploads",
		"20",
		"--free-space-ratio",
		"0.3",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args=%q want %q", args, want)
	}
	envRaw, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(envRaw)); got != "1" {
		t.Fatalf("JFS_NO_CHECK_OBJECT_STORAGE=%q want 1", got)
	}
}

func TestAdaptiveWritebackFreeSpaceRatioKeepsMinFreeForSmallDisk(t *testing.T) {
	ratio, ok := adaptiveWritebackFreeSpaceRatio(1100<<20, 200<<20)
	if !ok {
		t.Fatal("adaptiveWritebackFreeSpaceRatio returned false")
	}
	if ratio < 0.36 || ratio > 0.37 {
		t.Fatalf("ratio=%f want about 0.3636", ratio)
	}
}

func TestAdaptiveWritebackFreeSpaceRatioKeepsDefaultRatioForLargeDisk(t *testing.T) {
	ratio, ok := adaptiveWritebackFreeSpaceRatio(100<<30, 200<<20)
	if !ok {
		t.Fatal("adaptiveWritebackFreeSpaceRatio returned false")
	}
	if ratio != 0.1 {
		t.Fatalf("ratio=%f want 0.1", ratio)
	}
}

func TestStaleRuntimeRootsExcludesCurrentAndFiles(t *testing.T) {
	parent := t.TempDir()
	current := filepath.Join(parent, "current")
	if err := os.MkdirAll(current, 0o755); err != nil {
		t.Fatalf("mkdir current: %v", err)
	}
	for _, dir := range []string{"old-a", "old-b"} {
		if err := os.MkdirAll(filepath.Join(parent, dir), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(parent, "not-a-dir"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	rt := New(config.Config{})
	got := rt.staleRuntimeRoots(parent, current)
	want := []string{
		filepath.Join(parent, "old-a"),
		filepath.Join(parent, "old-b"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("staleRuntimeRoots=%v want %v", got, want)
	}
}

func TestStaleRuntimeRootsForCleanupSkipsEmptyLegacyRoot(t *testing.T) {
	root := t.TempDir()
	runtimeParent := filepath.Join(root, "runtime")
	current := filepath.Join(runtimeParent, "current")
	if err := os.MkdirAll(current, 0o755); err != nil {
		t.Fatal(err)
	}
	workspaceDir := filepath.Join(root, "workspace")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(workspaceDir); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = os.Chdir(oldWD)
	}()
	for _, dir := range []string{".ssh", ".cache", "code"} {
		if err := os.MkdirAll(filepath.Join(workspaceDir, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	rt := New(config.Config{
		RuntimeRoot:       current,
		LegacyRuntimeRoot: "",
	})
	roots := rt.staleRuntimeRootsForCleanup()
	if len(roots) != 0 {
		t.Fatalf("stale runtime roots=%v; empty legacy root must not scan cwd", roots)
	}
	for _, dir := range []string{".ssh", ".cache", "code"} {
		if _, err := os.Stat(filepath.Join(workspaceDir, dir)); err != nil {
			t.Fatalf("cleanup removed cwd dir %s: %v", dir, err)
		}
	}
}

func TestRequireBootstrapReadyReportsMissingPrerequisites(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		WispName:        "demo",
		LowerSystemBase: filepath.Join(root, "shared", "lower", "system-base"),
		LowerSystem:     filepath.Join(root, "shared", "lower", "system"),
		ActiveImg:       filepath.Join(root, "state", "active", "root-upper.img"),
		CrunBinaryPath:  filepath.Join(root, "tools", "crun"),
	}

	rt := New(cfg)
	err := rt.requireBootstrapReady()
	if err == nil {
		t.Fatal("expected bootstrap readiness error")
	}
	msg := err.Error()
	for _, want := range []string{
		"run bootstrap first",
		"lower system base",
		"lower system overlay",
		"active root-upper image",
		"prepared crun binary",
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("missing %q in error: %s", want, msg)
		}
	}
}

func TestEnsureBaseRootfsUsesPackagedDirectoryDirectly(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "package", "assets", "rootfs", "rootfs")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, ".wisp-base-ready"), []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}

	rt := New(config.Config{
		LowerSystemBase: base,
		BaseRootFSDir:   base,
	})
	direct, err := rt.ensureBaseRootfs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !direct {
		t.Fatal("packaged base rootfs directory should be treated as a direct lower layer")
	}
}

func TestWorkspaceCleanupPathsIncludeWorkspaceStateAndSkipProtectedRoots(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		JFSRoot:           filepath.Join(root, "jfs"),
		StateRoot:         filepath.Join(root, "jfs", "wisp", "demo"),
		RuntimeRoot:       filepath.Join(root, "runtime", "demo"),
		LegacyRuntimeRoot: filepath.Join(root, "runtime-legacy", "demo"),
		TempRoot:          filepath.Join(root, "temp", "demo"),
	}

	rt := New(cfg)
	got := rt.workspaceCleanupPaths()
	want := []string{
		filepath.Join(root, "runtime", "demo"),
		filepath.Join(root, "runtime-legacy", "demo"),
		filepath.Join(root, "temp", "demo"),
		filepath.Join(root, "jfs", "wisp", "demo"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("workspaceCleanupPaths=%v want %v", got, want)
	}

	cfg.StateRoot = cfg.JFSRoot
	rt = New(cfg)
	got = rt.workspaceCleanupPaths()
	for _, path := range got {
		if filepath.Clean(path) == filepath.Clean(cfg.JFSRoot) {
			t.Fatalf("protected root %s should not be removable: %v", cfg.JFSRoot, got)
		}
	}
}

func TestCleanupWorkspaceStateRemovesWorkspaceTrees(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		JFSRoot:     filepath.Join(root, "jfs"),
		StateRoot:   filepath.Join(root, "jfs", "wisp", "demo"),
		RuntimeRoot: filepath.Join(root, "runtime", "demo"),
		TempRoot:    filepath.Join(root, "temp", "demo"),
	}
	for _, path := range []string{cfg.StateRoot, cfg.RuntimeRoot, cfg.TempRoot} {
		if err := os.MkdirAll(filepath.Join(path, "nested"), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", path, err)
		}
		if err := os.WriteFile(filepath.Join(path, "nested", "x"), []byte("1"), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	rt := New(cfg)
	if err := rt.cleanupWorkspaceState(context.Background()); err != nil {
		t.Fatalf("cleanupWorkspaceState: %v", err)
	}

	for _, path := range []string{cfg.StateRoot, cfg.RuntimeRoot, cfg.TempRoot} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("expected %s removed, stat err=%v", path, err)
		}
	}
}

func TestParseByteSize(t *testing.T) {
	tests := []struct {
		in   string
		want int64
	}{
		{"1", 1},
		{"1K", 1 << 10},
		{"2M", 2 << 20},
		{"3G", 3 << 30},
		{"4T", 4 << 40},
	}
	for _, tc := range tests {
		got, err := parseByteSize(tc.in)
		if err != nil {
			t.Fatalf("parseByteSize(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("parseByteSize(%q)=%d want %d", tc.in, got, tc.want)
		}
	}
	if _, err := parseByteSize(""); err == nil {
		t.Fatal("expected error for empty size")
	}
	if _, err := parseByteSize("-1G"); err == nil {
		t.Fatal("expected error for negative size")
	}
}

func TestActiveImageMke2fsArgsScaleJournalSize(t *testing.T) {
	tests := []struct {
		name        string
		size        int64
		wantJournal string
	}{
		{name: "tiny", size: 256 << 20, wantJournal: "size=16"},
		{name: "medium", size: 512 << 20, wantJournal: "size=32"},
		{name: "one-gig", size: 1 << 30, wantJournal: "size=32"},
		{name: "two-gig", size: 2 << 30, wantJournal: "size=32"},
		{name: "large", size: 16 << 30, wantJournal: "size=128"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := activeImageMke2fsArgs(tc.size, "/tmp/root-upper.img")
			if !reflect.DeepEqual(got[len(got)-1:], []string{"/tmp/root-upper.img"}) {
				t.Fatalf("image path must be last arg: %v", got)
			}
			joined := strings.Join(got, " ")
			if !strings.Contains(joined, "-J "+tc.wantJournal) {
				t.Fatalf("mke2fs args %q do not contain journal %s", joined, tc.wantJournal)
			}
			if !strings.Contains(joined, "sparse_super2,^64bit,^metadata_csum") {
				t.Fatalf("mke2fs args %q do not disable incompatible ext4 features", joined)
			}
			for _, want := range []string{"lazy_itable_init=1", "lazy_journal_init=1", "assume_storage_prezeroed=1"} {
				if !strings.Contains(joined, want) {
					t.Fatalf("mke2fs args %q do not contain %s", joined, want)
				}
			}
			if strings.Contains(joined, "nodiscard") {
				t.Fatalf("mke2fs args %q must not disable discard for reclaimable workspace images", joined)
			}
		})
	}
}

func TestEnsureActiveImageUsesBlankTemplateWhenRootUpperSizeUnset(t *testing.T) {
	root := t.TempDir()
	template := filepath.Join(root, "package", "assets", "rootfs", "blank-ext4", "root-upper-default.img")
	if err := os.MkdirAll(filepath.Dir(template), 0o755); err != nil {
		t.Fatal(err)
	}
	want := append([]byte("ext4-seed"), make([]byte, 4096)...)
	want = append(want, []byte("tail")...)
	if err := os.WriteFile(template, want, 0o644); err != nil {
		t.Fatal(err)
	}
	active := filepath.Join(root, "state", "active", "root-upper.img")
	rt := New(config.Config{
		ActiveImg:            active,
		RootUpperSize:        "",
		DefaultRootUpperSize: "5G",
		BlankRootUpperImage:  template,
	})
	if err := rt.ensureActiveImage(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(active)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("active image content mismatch")
	}
}

func TestEnsureActiveImageUsesBlankTemplateTarWhenRootUpperSizeUnset(t *testing.T) {
	root := t.TempDir()
	tarRoot := filepath.Join(root, "template")
	if err := os.MkdirAll(tarRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	seed := filepath.Join(tarRoot, "root-upper-default.img")
	want := []byte("blank-ext4-template")
	if err := os.WriteFile(seed, want, 0o644); err != nil {
		t.Fatal(err)
	}
	tarPath := filepath.Join(root, "root-upper-default.tar")
	cmd := exec.Command("tar", "-cf", tarPath, "-C", tarRoot, "root-upper-default.img")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create tar: %v: %s", err, string(out))
	}
	active := filepath.Join(root, "state", "active", "root-upper.img")
	rt := New(config.Config{
		ActiveImg:            active,
		RootUpperSize:        "",
		DefaultRootUpperSize: "5G",
		BlankRootUpperTar:    tarPath,
	})
	if err := rt.ensureActiveImage(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(active)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("active image content mismatch")
	}
}

func TestEnsureActiveImageUsesBlankSparseTemplateWhenRootUpperSizeUnset(t *testing.T) {
	root := t.TempDir()
	template := filepath.Join(root, "root-upper-default.sparse")
	payload := sparseRootUpperMagic + "\n" +
		`{"size":1024,"extents":[{"offset":0,"length":3},{"offset":100,"length":4}]}` + "\n" +
		"abc" + "tail"
	if err := os.WriteFile(template, []byte(payload), 0o644); err != nil {
		t.Fatal(err)
	}
	active := filepath.Join(root, "state", "active", "root-upper.img")
	rt := New(config.Config{
		ActiveImg:            active,
		RootUpperSize:        "",
		DefaultRootUpperSize: "5G",
		BlankRootUpperSparse: template,
	})
	if err := rt.ensureActiveImage(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(active)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1024 {
		t.Fatalf("active image len=%d want 1024", len(got))
	}
	if string(got[:3]) != "abc" || string(got[100:104]) != "tail" {
		t.Fatalf("sparse extents not restored correctly")
	}
}

func TestDeleteCheckpointRemovesCheckpointDir(t *testing.T) {
	root := t.TempDir()
	rt := New(config.Config{
		WispName:        "demo",
		CheckpointsRoot: filepath.Join(root, "checkpoints"),
	})
	checkpointDir := filepath.Join(rt.cfg.CheckpointsRoot, "ck1")
	if err := os.MkdirAll(checkpointDir, 0o755); err != nil {
		t.Fatalf("mkdir checkpoint: %v", err)
	}
	if err := os.WriteFile(filepath.Join(checkpointDir, "metadata.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write metadata: %v", err)
	}
	if err := rt.DeleteCheckpoint(context.Background(), "ck1"); err != nil {
		t.Fatalf("DeleteCheckpoint: %v", err)
	}
	if _, err := os.Stat(checkpointDir); !os.IsNotExist(err) {
		t.Fatalf("checkpoint dir still exists: err=%v", err)
	}
}

func TestGetAndListCheckpointsFromCloneNames(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		CheckpointsRoot: filepath.Join(root, "checkpoints"),
		ActiveImg:       filepath.Join(root, "active", "root-upper.img"),
	}
	for _, id := range []string{
		"manual-20260527T010000.000000000Z",
		"system-graceful-stop-20260527T020000.000000000Z",
	} {
		dir := filepath.Join(cfg.CheckpointsRoot, id)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
		if err := os.WriteFile(filepath.Join(dir, "metadata.json"), []byte(`{"corrupt"`), 0o644); err != nil {
			t.Fatal(err)
		}
		writeTestCheckpointImage(t, dir)
	}

	rt := New(cfg)
	got, err := rt.ListCheckpoints(context.Background())
	if err != nil {
		t.Fatalf("ListCheckpoints: %v", err)
	}
	if len(got) != 2 || got[0].ID != "manual-20260527T010000.000000000Z" || got[1].ID != "system-graceful-stop-20260527T020000.000000000Z" {
		t.Fatalf("ListCheckpoints=%v", got)
	}

	item, err := rt.GetCheckpoint(context.Background(), "system-graceful-stop-20260527T020000.000000000Z")
	if err != nil {
		t.Fatalf("GetCheckpoint: %v", err)
	}
	if item.Class != checkpointClassSystem || item.Trigger != checkpointTriggerGracefulStop || item.CreatedAt != "2026-05-27T02:00:00Z" ||
		item.Source != cfg.ActiveImg || item.Format != "juicefs-clone-v1" || item.Backend != "juicefs-clone" || item.State != checkpointStateCommitted {
		t.Fatalf("GetCheckpoint=%+v", item)
	}
}

func TestListCheckpointsHidesIncompleteAndHiddenDirs(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{CheckpointsRoot: filepath.Join(root, "checkpoints")}
	for _, id := range []string{"system-graceful-stop-20260527T010000.000000000Z", ".staging"} {
		dir := filepath.Join(cfg.CheckpointsRoot, id)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(id, ".") {
			writeTestCheckpointImage(t, dir)
		}
	}
	if err := os.MkdirAll(filepath.Join(cfg.CheckpointsRoot, "incomplete"), 0o755); err != nil {
		t.Fatal(err)
	}

	rt := New(cfg)
	got, err := rt.ListCheckpoints(context.Background())
	if err != nil {
		t.Fatalf("ListCheckpoints: %v", err)
	}
	if len(got) != 1 || got[0].ID != "system-graceful-stop-20260527T010000.000000000Z" {
		t.Fatalf("ListCheckpoints=%+v", got)
	}
	if _, err := rt.GetCheckpoint(context.Background(), "incomplete"); err == nil || !strings.Contains(err.Error(), "checkpoint not found") {
		t.Fatalf("GetCheckpoint incomplete err=%v", err)
	}
}

func TestGetCheckpointIgnoresCorruptMetadataJSON(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{CheckpointsRoot: filepath.Join(root, "checkpoints")}
	dir := filepath.Join(cfg.CheckpointsRoot, "manual-20260527T010000.000000000Z")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "metadata.json"), []byte(`{"id":"corrupt"`), 0o644); err != nil {
		t.Fatal(err)
	}
	writeTestCheckpointImage(t, dir)

	rt := New(cfg)
	if _, err := rt.GetCheckpoint(context.Background(), "manual-20260527T010000.000000000Z"); err != nil {
		t.Fatalf("corrupt metadata should be ignored: %v", err)
	}
	if _, err := rt.ListCheckpoints(context.Background()); err != nil {
		t.Fatalf("corrupt metadata should not fail checkpoint listing: %v", err)
	}
}

func TestCheckpointManifestIsIgnoredForRecoveryIndex(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		ActiveImg:       filepath.Join(root, "jfs", "wisp", "default", "active", "root-upper.img"),
		CheckpointsRoot: filepath.Join(root, "jfs", "wisp", "default", "checkpoints"),
		PolicyRoot:      filepath.Join(root, "jfs", "wisp", "default", "policy"),
	}
	dir := filepath.Join(cfg.CheckpointsRoot, "system-graceful-stop-20260527T010000.000000000Z")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cfg.PolicyRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg.PolicyRoot, "checkpoint-manifest.json"), []byte(`{"latest_committed_checkpoint_id":"missing","state":`), 0o644); err != nil {
		t.Fatal(err)
	}
	writeTestCheckpointImage(t, dir)
	rt := New(cfg)

	meta, err := rt.GetCheckpoint(context.Background(), "system-graceful-stop-20260527T010000.000000000Z")
	if err != nil {
		t.Fatalf("GetCheckpoint should ignore manifest: %v", err)
	}
	if meta.ID != "system-graceful-stop-20260527T010000.000000000Z" || meta.State != checkpointStateCommitted {
		t.Fatalf("checkpoint metadata=%+v", meta)
	}
	got, err := rt.ListCheckpoints(context.Background())
	if err != nil {
		t.Fatalf("ListCheckpoints: %v", err)
	}
	if len(got) != 1 || got[0].ID != meta.ID || got[0].State != checkpointStateCommitted {
		t.Fatalf("ListCheckpoints=%+v", got)
	}
}

func TestGetCheckpointRejectsMissingAndEmptyImages(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{CheckpointsRoot: filepath.Join(root, "checkpoints")}
	for _, tc := range []struct {
		id         string
		writeImage bool
	}{
		{id: "missing-image"},
		{id: "empty-image", writeImage: true},
	} {
		dir := filepath.Join(cfg.CheckpointsRoot, tc.id)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if tc.writeImage {
			if err := os.WriteFile(filepath.Join(dir, "root-upper.img"), nil, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	rt := New(cfg)
	for _, id := range []string{"missing-image", "empty-image"} {
		if _, err := rt.GetCheckpoint(context.Background(), id); err == nil || !strings.Contains(err.Error(), "checkpoint not found") {
			t.Fatalf("GetCheckpoint(%s) err=%v", id, err)
		}
	}
	got, err := rt.ListCheckpoints(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("broken image checkpoints should be hidden, got %+v", got)
	}
}

func TestRetainSystemCheckpointsKeepsNewestAndManual(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		CheckpointsRoot: filepath.Join(root, "checkpoints"),
	}
	rt := New(cfg)
	for _, id := range []string{
		"manual-20260527T000000.000000000Z",
		"system-graceful-stop-20260527T010000.000000000Z",
		"system-graceful-stop-20260527T020000.000000000Z",
		"system-graceful-stop-20260527T030000.000000000Z",
	} {
		dir := filepath.Join(cfg.CheckpointsRoot, id)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		writeTestCheckpointImage(t, dir)
	}
	if err := rt.retainSystemCheckpoints(context.Background(), 1); err != nil {
		t.Fatalf("retainSystemCheckpoints: %v", err)
	}
	for _, id := range []string{"manual-20260527T000000.000000000Z", "system-graceful-stop-20260527T030000.000000000Z"} {
		if _, err := os.Stat(filepath.Join(cfg.CheckpointsRoot, id)); err != nil {
			t.Fatalf("checkpoint %s should be preserved: %v", id, err)
		}
	}
	for _, id := range []string{"system-graceful-stop-20260527T010000.000000000Z", "system-graceful-stop-20260527T020000.000000000Z"} {
		if _, err := os.Stat(filepath.Join(cfg.CheckpointsRoot, id)); !os.IsNotExist(err) {
			t.Fatalf("checkpoint %s should be deleted, err=%v", id, err)
		}
	}
}

func TestRetainSystemCheckpointsKeepsNewestThreeAndManual(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		CheckpointsRoot: filepath.Join(root, "checkpoints"),
	}
	rt := New(cfg)
	for _, id := range []string{
		"manual-20260527T000000.000000000Z",
		"system-graceful-stop-20260527T010000.000000000Z",
		"system-graceful-stop-20260527T020000.000000000Z",
		"system-graceful-stop-20260527T030000.000000000Z",
		"system-graceful-stop-20260527T040000.000000000Z",
		"system-graceful-stop-20260527T050000.000000000Z",
	} {
		dir := filepath.Join(cfg.CheckpointsRoot, id)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		writeTestCheckpointImage(t, dir)
	}
	if err := rt.retainSystemCheckpoints(context.Background(), 3); err != nil {
		t.Fatalf("retainSystemCheckpoints: %v", err)
	}

	for _, id := range []string{"manual-20260527T000000.000000000Z", "system-graceful-stop-20260527T030000.000000000Z", "system-graceful-stop-20260527T040000.000000000Z", "system-graceful-stop-20260527T050000.000000000Z"} {
		if _, err := os.Stat(filepath.Join(cfg.CheckpointsRoot, id)); err != nil {
			t.Fatalf("checkpoint %s should be preserved: %v", id, err)
		}
	}
	for _, id := range []string{"system-graceful-stop-20260527T010000.000000000Z", "system-graceful-stop-20260527T020000.000000000Z"} {
		if _, err := os.Stat(filepath.Join(cfg.CheckpointsRoot, id)); !os.IsNotExist(err) {
			t.Fatalf("checkpoint %s should be deleted, err=%v", id, err)
		}
	}
}

func TestCreateCheckpointPublishesCloneWithMetaBarrier(t *testing.T) {
	root := t.TempDir()
	callsPath := filepath.Join(root, "jfs-calls")
	script := `#!/bin/sh
echo "$@" >> "$JFS_CALL_LOG"
if [ "$1" = "clone" ]; then
  cp "$2" "$3"
fi
exit 0
`
	rt := newCheckpointCreateTestRuntime(t, root, script)
	t.Setenv("JFS_CALL_LOG", callsPath)

	id := "manual-20260527T010203.000000000Z"
	meta, err := rt.createCheckpoint(context.Background(), id, checkpointClassManual, checkpointTriggerManual, false)
	if err != nil {
		t.Fatalf("createCheckpoint: %v", err)
	}
	if meta.ID != id || meta.State != checkpointStateCommitted {
		t.Fatalf("meta=%+v", meta)
	}
	if _, err := os.Stat(filepath.Join(rt.cfg.CheckpointsRoot, id, "metadata.json")); !os.IsNotExist(err) {
		t.Fatalf("metadata.json should not be written, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(rt.cfg.PolicyRoot, "checkpoint-manifest.json")); !os.IsNotExist(err) {
		t.Fatalf("checkpoint manifest should not be written, err=%v", err)
	}
	rawCalls, err := os.ReadFile(callsPath)
	if err != nil {
		t.Fatal(err)
	}
	calls := strings.Split(strings.TrimSpace(string(rawCalls)), "\n")
	checkpointImg := filepath.Join(rt.cfg.CheckpointsRoot, id, "root-upper.img")
	if len(calls) != 5 ||
		calls[0] != "file-barrier "+rt.cfg.ActiveImg ||
		calls[1] != "clone "+rt.cfg.ActiveImg+" "+checkpointImg ||
		calls[2] != "file-barrier "+checkpointImg ||
		calls[3] != "writeback-cut-barrier --timeout 120s --poll-interval 30ms "+rt.cfg.JFSRoot ||
		calls[4] != "meta-barrier "+rt.cfg.JFSRoot {
		t.Fatalf("unexpected barrier order: %q", calls)
	}
}

func TestCreateCheckpointFileBarrierFailureRemovesCandidate(t *testing.T) {
	root := t.TempDir()
	rt := newCheckpointCreateTestRuntime(t, root, "#!/bin/sh\nif [ \"$1\" = file-barrier ]; then exit 17; fi\nexit 0\n")

	_, err := rt.createCheckpoint(context.Background(), "manual-20260527T010203.000000000Z", checkpointClassManual, checkpointTriggerManual, false)
	if err == nil || !strings.Contains(err.Error(), "file-barrier") {
		t.Fatalf("createCheckpoint err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(rt.cfg.CheckpointsRoot, "manual-20260527T010203.000000000Z")); !os.IsNotExist(err) {
		t.Fatalf("failed before clone should not publish checkpoint dir, err=%v", err)
	}
}

func TestCreateCheckpointUnsupportedCloneRemovesCandidate(t *testing.T) {
	root := t.TempDir()
	rt := newCheckpointCreateTestRuntime(t, root, "#!/bin/sh\nexit 0\n")
	rt.cfg.JFSBin = ""

	id := "manual-20260527T010203.000000000Z"
	_, err := rt.createCheckpoint(context.Background(), id, checkpointClassManual, checkpointTriggerManual, false)
	if err == nil || !strings.Contains(err.Error(), "JFS_BIN") {
		t.Fatalf("createCheckpoint err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(rt.cfg.CheckpointsRoot, id)); !os.IsNotExist(err) {
		t.Fatalf("unsupported clone should not leave checkpoint dir, err=%v", err)
	}
}

func TestEnsureJuiceFSCloneSupportedIncludesMountDiagnostics(t *testing.T) {
	root := t.TempDir()
	rt := newCheckpointCreateTestRuntime(t, root, "#!/bin/sh\nexit 0\n")
	mountInfoPath := filepath.Join(root, "overlay-mountinfo")
	if err := os.WriteFile(mountInfoPath, []byte("1 2 0:1 / / rw - overlay overlay rw\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	previous := runtimeMountInfoPathOverride
	runtimeMountInfoPathOverride = func() string {
		return mountInfoPath
	}
	t.Cleanup(func() {
		runtimeMountInfoPathOverride = previous
	})

	err := rt.ensureJuiceFSCloneSupported(rt.cfg.ActiveImg)
	if err == nil {
		t.Fatal("expected non-JuiceFS mount to reject clone")
	}
	for _, want := range []string{`observed_mountpoint="/"`, `observed_fs_type="overlay"`, "mountinfo_ok=true"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got %v", want, err)
		}
	}
}

func TestCreateCheckpointCloneFailureRemovesCandidate(t *testing.T) {
	root := t.TempDir()
	rt := newCheckpointCreateTestRuntime(t, root, "#!/bin/sh\nif [ \"$1\" = clone ]; then exit 18; fi\nexit 0\n")

	_, err := rt.createCheckpoint(context.Background(), "manual-20260527T010203.000000000Z", checkpointClassManual, checkpointTriggerManual, false)
	if err == nil || !strings.Contains(err.Error(), "exit status 18") {
		t.Fatalf("createCheckpoint err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(rt.cfg.CheckpointsRoot, "manual-20260527T010203.000000000Z")); !os.IsNotExist(err) {
		t.Fatalf("failed clone should not publish checkpoint dir, err=%v", err)
	}
}

func TestCreateCheckpointMetaBarrierFailureReturnsErrorButLeavesVisibleClone(t *testing.T) {
	root := t.TempDir()
	script := "#!/bin/sh\nif [ \"$1\" = clone ]; then cp \"$2\" \"$3\"; exit 0; fi\nif [ \"$1\" = meta-barrier ]; then exit 9; fi\nexit 0\n"
	rt := newCheckpointCreateTestRuntime(t, root, script)

	id := "manual-20260527T010203.000000000Z"
	_, err := rt.createCheckpoint(context.Background(), id, checkpointClassManual, checkpointTriggerManual, false)
	if err == nil {
		t.Fatal("expected meta-barrier failure")
	}
	if _, statErr := os.Stat(filepath.Join(rt.cfg.CheckpointsRoot, id, "root-upper.img")); statErr != nil {
		t.Fatalf("clone should be visible after meta-barrier failure for diagnostics: %v", statErr)
	}
}

func TestPreStartRecoveryRestoresLatestCheckpointByName(t *testing.T) {
	root := t.TempDir()
	jfsRoot := filepath.Join(root, "jfs")
	stateRoot := filepath.Join(jfsRoot, "wisp", "default")
	activeImg := filepath.Join(stateRoot, "active", "root-upper.img")
	binDir := filepath.Join(root, "bin")
	oldDir := filepath.Join(stateRoot, "checkpoints", "system-graceful-stop-20260527T010000.000000000Z")
	newDir := filepath.Join(stateRoot, "checkpoints", "system-graceful-stop-20260527T020000.000000000Z")
	for _, dir := range []string{filepath.Dir(activeImg), binDir, oldDir, newDir, filepath.Join(stateRoot, "policy")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(oldDir, "root-upper.img"), []byte("old-checkpoint"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(newDir, "root-upper.img"), []byte("new-checkpoint"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(newDir, "metadata.json"), []byte(`{"id":"ignored"`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateRoot, "policy", "checkpoint-manifest.json"), []byte(`{"latest_committed_checkpoint_id":"old","state":`), 0o644); err != nil {
		t.Fatal(err)
	}
	rt := New(config.Config{
		RemoteBackend:   "",
		ActiveImg:       activeImg,
		CheckpointsRoot: filepath.Join(stateRoot, "checkpoints"),
		PolicyRoot:      filepath.Join(stateRoot, "policy"),
		JFSBin:          filepath.Join(binDir, "juicefs"),
		JFSRoot:         jfsRoot,
	})
	if err := os.WriteFile(rt.cfg.JFSBin, []byte("#!/bin/sh\nif [ \"$1\" = clone ]; then cp \"$2\" \"$3\"; exit 0; fi\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "e2fsck"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	writeFakeJuiceFSMountInfo(t, root, jfsRoot)

	if err := rt.preStartRecovery(context.Background()); err != nil {
		t.Fatalf("preStartRecovery: %v", err)
	}
	raw, err := os.ReadFile(activeImg)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "new-checkpoint" {
		t.Fatalf("active image was not restored from newest checkpoint, got %q", string(raw))
	}
}

func TestRestoreCheckpointFencesActiveCloneBeforeValidation(t *testing.T) {
	root := t.TempDir()
	jfsRoot := filepath.Join(root, "jfs")
	stateRoot := filepath.Join(jfsRoot, "wisp", "default")
	activeImg := filepath.Join(stateRoot, "active", "root-upper.img")
	checkpointID := "system-graceful-stop-20260527T010000.000000000Z"
	checkpointDir := filepath.Join(stateRoot, "checkpoints", checkpointID)
	binDir := filepath.Join(root, "bin")
	callsPath := filepath.Join(root, "jfs-calls")
	for _, dir := range []string{filepath.Dir(activeImg), checkpointDir, binDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(checkpointDir, "root-upper.img"), []byte("checkpoint-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	jfsBin := filepath.Join(binDir, "juicefs")
	if err := os.WriteFile(jfsBin, []byte(`#!/bin/sh
echo "$@" >> "$JFS_CALL_LOG"
if [ "$1" = "clone" ]; then
  cp "$2" "$3"
fi
exit 0
`), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "crun"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "e2fsck"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JFS_CALL_LOG", callsPath)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	writeFakeJuiceFSMountInfo(t, root, jfsRoot)

	rt := New(config.Config{
		WispName:        "default",
		RemoteBackend:   remoteBackendSMH,
		ActiveImg:       activeImg,
		ActiveRoot:      filepath.Dir(activeImg),
		StateRoot:       stateRoot,
		CheckpointsRoot: filepath.Join(stateRoot, "checkpoints"),
		JFSBin:          jfsBin,
		JFSRoot:         jfsRoot,
		CrunBinaryPath:  filepath.Join(binDir, "crun"),
		CrunStateRoot:   filepath.Join(root, "crun-state"),
		ContainerID:     "wisp-default",
	})
	if err := rt.RestoreCheckpoint(context.Background(), checkpointID); err != nil {
		t.Fatalf("RestoreCheckpoint: %v", err)
	}
	rawCalls, err := os.ReadFile(callsPath)
	if err != nil {
		t.Fatal(err)
	}
	calls := strings.Split(strings.TrimSpace(string(rawCalls)), "\n")
	checkpointImg := filepath.Join(checkpointDir, "root-upper.img")
	if len(calls) != 4 ||
		calls[0] != "clone "+checkpointImg+" "+activeImg ||
		calls[1] != "file-barrier "+activeImg ||
		calls[2] != "writeback-cut-barrier --timeout 120s --poll-interval 30ms "+jfsRoot ||
		calls[3] != "meta-barrier "+jfsRoot {
		t.Fatalf("unexpected restore barrier order: %q", calls)
	}
}

func TestWriteOCIConfigUsesPerTargetCgroupPath(t *testing.T) {
	root := t.TempDir()
	bundle := filepath.Join(root, "bundle")
	if err := os.MkdirAll(bundle, 0o755); err != nil {
		t.Fatal(err)
	}
	rt := New(config.Config{
		WispName:          "agent-session-a",
		ContainerID:       "wisp-agent-session-a",
		CrunBundleRoot:    bundle,
		EnvSocketPath:     "/.wisp/api.sock",
		EnvSocketHostPath: filepath.Join(root, "api.sock"),
		WispUser:          "root",
		WispPath:          "/usr/bin:/bin",
		WispLang:          "C.UTF-8",
	})

	if err := rt.writeOCIConfig(); err != nil {
		t.Fatalf("writeOCIConfig: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(bundle, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	linux := cfg["linux"].(map[string]any)
	if linux["cgroupsPath"] != "wisp/agent-session-a/user/wisp-agent-session-a" {
		t.Fatalf("cgroupsPath=%q", linux["cgroupsPath"])
	}
	namespaces := linux["namespaces"].([]any)
	foundCgroupNamespace := false
	for _, item := range namespaces {
		if item.(map[string]any)["type"] == "cgroup" {
			foundCgroupNamespace = true
			break
		}
	}
	if !foundCgroupNamespace {
		t.Fatalf("OCI config should request a cgroup namespace: %#v", linux["namespaces"])
	}
}

func TestRunStopLitestreamMaintenanceUsesShutdownDefaults(t *testing.T) {
	root := t.TempDir()
	callsPath := filepath.Join(root, "jfs-calls")
	bin := filepath.Join(root, "juicefs")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho \"$@\" >> \"$JFS_CALL_LOG\"\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JFS_CALL_LOG", callsPath)

	rt := New(config.Config{
		RemoteBackend: remoteBackendSMH,
		JFSBin:        bin,
		JFSRoot:       filepath.Join(root, "jfs"),
	})
	if err := rt.runStopLitestreamMaintenance(context.Background()); err != nil {
		t.Fatalf("runStopLitestreamMaintenance: %v", err)
	}
	raw, err := os.ReadFile(callsPath)
	if err != nil {
		t.Fatal(err)
	}
	call := strings.TrimSpace(string(raw))
	want := "litestream-maintenance --snapshot=false --compact-level 1 --snapshot-retention-age 5m --l0-retention-age 0s " + rt.cfg.JFSRoot
	if call != want {
		t.Fatalf("call = %q, want %q", call, want)
	}
}

func TestRunStopLitestreamMaintenanceCanBeDisabled(t *testing.T) {
	root := t.TempDir()
	callsPath := filepath.Join(root, "jfs-calls")
	bin := filepath.Join(root, "juicefs")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho \"$@\" >> \"$JFS_CALL_LOG\"\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JFS_CALL_LOG", callsPath)
	t.Setenv("WISP_LITESTREAM_MAINTENANCE_ON_STOP", "false")

	rt := New(config.Config{
		RemoteBackend: remoteBackendSMH,
		JFSBin:        bin,
		JFSRoot:       filepath.Join(root, "jfs"),
	})
	if err := rt.runStopLitestreamMaintenance(context.Background()); err != nil {
		t.Fatalf("runStopLitestreamMaintenance: %v", err)
	}
	if _, err := os.Stat(callsPath); !os.IsNotExist(err) {
		t.Fatalf("maintenance should be disabled, calls file err=%v", err)
	}
}

func TestPreStartRecoverySkipsValidActiveImage(t *testing.T) {
	root := t.TempDir()
	jfsRoot := filepath.Join(root, "jfs")
	stateRoot := filepath.Join(jfsRoot, "wisp", "default")
	activeImg := filepath.Join(stateRoot, "active", "root-upper.img")
	checkpointDir := filepath.Join(stateRoot, "checkpoints", "system-graceful-stop-20260527T010000.000000000Z")
	binDir := filepath.Join(root, "bin")
	for _, dir := range []string{filepath.Dir(activeImg), checkpointDir, binDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(activeImg, []byte("valid-active"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeTestCheckpointImage(t, checkpointDir)
	rt := New(config.Config{
		ActiveImg:       activeImg,
		CheckpointsRoot: filepath.Join(stateRoot, "checkpoints"),
		JFSBin:          filepath.Join(binDir, "juicefs"),
		JFSRoot:         jfsRoot,
	})
	if err := os.WriteFile(filepath.Join(binDir, "e2fsck"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rt.cfg.JFSBin, []byte("#!/bin/sh\necho unexpected clone >&2\nexit 9\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	if err := rt.preStartRecovery(context.Background()); err != nil {
		t.Fatalf("preStartRecovery: %v", err)
	}
	raw, err := os.ReadFile(activeImg)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "valid-active" {
		t.Fatalf("active image should have been trusted, got %q", string(raw))
	}
}

func TestPreStartRecoveryIgnoresManifestFilesWhenNoRestoreNeeded(t *testing.T) {
	root := t.TempDir()
	stateRoot := filepath.Join(root, "state")
	activeImg := filepath.Join(stateRoot, "active", "root-upper.img")
	policyRoot := filepath.Join(stateRoot, "policy")
	if err := os.MkdirAll(filepath.Dir(activeImg), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(policyRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activeImg, []byte("active"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(policyRoot, "checkpoint-manifest.json"), []byte(`{"latest_committed_checkpoint_id":`), 0o644); err != nil {
		t.Fatal(err)
	}
	rt := New(config.Config{
		ActiveImg:       activeImg,
		CheckpointsRoot: filepath.Join(stateRoot, "checkpoints"),
		PolicyRoot:      policyRoot,
	})
	if err := rt.preStartRecovery(context.Background()); err != nil {
		t.Fatalf("preStartRecovery: %v", err)
	}
}

func TestPreStartRecoveryDoesNothingWithoutUsableCheckpoint(t *testing.T) {
	root := t.TempDir()
	stateRoot := filepath.Join(root, "state")
	checkpointDir := filepath.Join(stateRoot, "checkpoints", "system-graceful-stop-20260527T010000.000000000Z")
	if err := os.MkdirAll(checkpointDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rt := New(config.Config{
		ActiveImg:       filepath.Join(stateRoot, "active", "root-upper.img"),
		CheckpointsRoot: filepath.Join(stateRoot, "checkpoints"),
	})
	if err := rt.preStartRecovery(context.Background()); err != nil {
		t.Fatalf("preStartRecovery: %v", err)
	}
}

func writeFakeJuiceFSMountInfo(t *testing.T, root, mountpoint string) {
	t.Helper()
	path := filepath.Join(root, "mountinfo")
	line := fmt.Sprintf("1 2 0:1 / %s rw - fuse.juicefs juicefs rw\n", mountpoint)
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	previous := runtimeMountInfoPathOverride
	runtimeMountInfoPathOverride = func() string {
		return path
	}
	t.Cleanup(func() {
		runtimeMountInfoPathOverride = previous
	})
}

func writeTestCheckpointImage(t *testing.T, checkpointDir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(checkpointDir, "root-upper.img"), []byte("checkpoint-image"), 0o644); err != nil {
		t.Fatalf("write checkpoint image: %v", err)
	}
}

func newCheckpointCreateTestRuntime(t *testing.T, root, jfsScript string) *Runtime {
	t.Helper()
	jfsRoot := filepath.Join(root, "jfs")
	stateRoot := filepath.Join(jfsRoot, "wisp", "default")
	activeImg := filepath.Join(stateRoot, "active", "root-upper.img")
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(filepath.Dir(activeImg), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activeImg, []byte("active-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	jfsBin := filepath.Join(binDir, "juicefs")
	if err := os.WriteFile(jfsBin, []byte(jfsScript), 0o755); err != nil {
		t.Fatal(err)
	}
	crunBin := filepath.Join(binDir, "crun")
	if err := os.WriteFile(crunBin, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFakeJuiceFSMountInfo(t, root, jfsRoot)
	return New(config.Config{
		WispName:        "default",
		RemoteBackend:   remoteBackendSMH,
		ActiveImg:       activeImg,
		ActiveRoot:      filepath.Dir(activeImg),
		StateRoot:       stateRoot,
		CheckpointsRoot: filepath.Join(stateRoot, "checkpoints"),
		PolicyRoot:      filepath.Join(stateRoot, "policy"),
		JFSBin:          jfsBin,
		JFSRoot:         jfsRoot,
		CrunBinaryPath:  crunBin,
		CrunStateRoot:   filepath.Join(root, "crun-state"),
		ContainerID:     "wisp-default",
		UpperImageMount: filepath.Join(root, "upper-mount"),
		LoopDeviceFile:  filepath.Join(root, "loop-device"),
	})
}

func TestRestoreCheckpointUsesCloneImageWithoutMetadata(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "juicefs")
	jfsRoot := filepath.Join(root, "jfs")
	activeImg := filepath.Join(jfsRoot, "wisp", "default", "active", "root-upper.img")
	cfg := config.Config{
		ActiveImg:       activeImg,
		CheckpointsRoot: filepath.Join(jfsRoot, "wisp", "default", "checkpoints"),
		JFSBin:          bin,
		JFSRoot:         jfsRoot,
	}
	rt := New(cfg)
	dir := filepath.Join(cfg.CheckpointsRoot, "manual-20260527T010000.000000000Z")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(activeImg), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "root-upper.img"), []byte("checkpoint"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nif [ \"$1\" = clone ]; then cp \"$2\" \"$3\"; exit 0; fi\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "e2fsck"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
	writeFakeJuiceFSMountInfo(t, root, cfg.JFSRoot)

	if err := rt.RestoreCheckpoint(context.Background(), "manual-20260527T010000.000000000Z"); err != nil {
		t.Fatalf("RestoreCheckpoint: %v", err)
	}
	raw, err := os.ReadFile(activeImg)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "checkpoint" {
		t.Fatalf("restored active=%q", string(raw))
	}
}

func TestRestoreCheckpointRejectsMissingCommittedImage(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{CheckpointsRoot: filepath.Join(root, "checkpoints")}
	rt := New(cfg)
	dir := filepath.Join(cfg.CheckpointsRoot, "committed")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	err := rt.RestoreCheckpoint(context.Background(), "committed")
	if err == nil || !strings.Contains(err.Error(), "checkpoint image not found") {
		t.Fatalf("RestoreCheckpoint err=%v", err)
	}
}

func TestIsDisconnectedMountError(t *testing.T) {
	if !isDisconnectedMountError(errors.New("transport endpoint is not connected")) {
		t.Fatal("expected disconnected mount error to be detected")
	}
	if isDisconnectedMountError(errors.New("permission denied")) {
		t.Fatal("unexpected match for non-mount error")
	}
}

func TestGetCheckpointIgnoresLegacyMetadataWithoutImage(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		CheckpointsRoot: filepath.Join(root, "checkpoints"),
	}
	dir := filepath.Join(cfg.CheckpointsRoot, "legacy")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "metadata.txt"), []byte("id=legacy\n"), 0o644); err != nil {
		t.Fatalf("write legacy metadata: %v", err)
	}

	rt := New(cfg)
	_, err := rt.GetCheckpoint(context.Background(), "legacy")
	if err == nil || !strings.Contains(err.Error(), "checkpoint not found") {
		t.Fatalf("GetCheckpoint legacy error=%v", err)
	}
}
