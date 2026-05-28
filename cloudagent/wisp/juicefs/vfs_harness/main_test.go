//go:build linux

package main

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFuzzModelHardlinkObjectIdentity(t *testing.T) {
	model := newFuzzModel()
	model.addDir("links")
	objectID := model.createFile("links/base.txt", []byte("hello"))
	model.filePaths["links/alias.txt"] = objectID

	state := model.getFileObject("links/alias.txt")
	state.Content = []byte("world")
	state.Xattrs["user.flag"] = []byte("set")
	model.setFileObject("links/alias.txt", state)

	base := model.getFileObject("links/base.txt")
	if string(base.Content) != "world" {
		t.Fatalf("base content mismatch: %q", string(base.Content))
	}
	if string(base.Xattrs["user.flag"]) != "set" {
		t.Fatalf("base xattr mismatch: %q", string(base.Xattrs["user.flag"]))
	}

	model.removeFilePath("links/base.txt")
	if _, ok := model.fileObjects[objectID]; !ok {
		t.Fatalf("object removed while alias still exists")
	}

	model.removeFilePath("links/alias.txt")
	if _, ok := model.fileObjects[objectID]; ok {
		t.Fatalf("object still present after last alias removal")
	}
}

func TestFuzzModelRenameDirTree(t *testing.T) {
	model := newFuzzModel()
	model.addDir("matrix/src")
	model.addDir("matrix/src/nested")
	model.createFile("matrix/src/nested/payload.txt", []byte("payload"))
	model.symlinks["matrix/src/link.lnk"] = "../target"

	if err := model.renameDirOrFile("matrix/src", "matrix/dst"); err != nil {
		t.Fatalf("renameDirOrFile: %v", err)
	}

	if _, ok := model.dirs["matrix/dst/nested"]; !ok {
		t.Fatalf("renamed nested dir missing")
	}
	if _, ok := model.filePaths["matrix/dst/nested/payload.txt"]; !ok {
		t.Fatalf("renamed payload missing")
	}
	if _, ok := model.symlinks["matrix/dst/link.lnk"]; !ok {
		t.Fatalf("renamed symlink missing")
	}
	if _, ok := model.dirs["matrix/src"]; ok {
		t.Fatalf("old source dir still present")
	}
}

func TestFuzzModelDigestStableAndSensitive(t *testing.T) {
	model := newFuzzModel()
	model.addDir("a")
	model.createFile("a/file.txt", []byte("abc"))
	model.symlinks["a/link.lnk"] = "file.txt"

	d1 := model.digest()
	d2 := model.clone().digest()
	if d1 != d2 {
		t.Fatalf("digest changed after clone: %s vs %s", d1, d2)
	}

	state := model.getFileObject("a/file.txt")
	state.Content = []byte("abcd")
	model.setFileObject("a/file.txt", state)
	d3 := model.digest()
	if d3 == d1 {
		t.Fatalf("digest did not change after content mutation")
	}
}

func TestApplyWriteAtAndTruncate(t *testing.T) {
	got := applyWriteAt([]byte("abc"), 5, []byte("xy"))
	want := []byte{'a', 'b', 'c', 0, 0, 'x', 'y'}
	if string(got) != string(want) {
		t.Fatalf("applyWriteAt mismatch: got=%v want=%v", got, want)
	}

	got = applyTruncate(got, 4)
	want = []byte{'a', 'b', 'c', 0}
	if string(got) != string(want) {
		t.Fatalf("applyTruncate shrink mismatch: got=%v want=%v", got, want)
	}

	got = applyTruncate([]byte("ab"), 5)
	want = []byte{'a', 'b', 0, 0, 0}
	if string(got) != string(want) {
		t.Fatalf("applyTruncate grow mismatch: got=%v want=%v", got, want)
	}
}

func TestLargeFilePath(t *testing.T) {
	if got, want := largeFilePath(1), "large/large-01.bin"; got != want {
		t.Fatalf("largeFilePath mismatch: got=%q want=%q", got, want)
	}
}

func TestRenamePathOverwritesEmptyDir(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "src")
	dst := filepath.Join(root, "dst")
	if err := os.MkdirAll(filepath.Join(src, "nested"), 0o755); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}
	if err := os.WriteFile(filepath.Join(src, "nested", "payload.txt"), []byte("payload"), 0o644); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	if err := os.Mkdir(dst, 0o755); err != nil {
		t.Fatalf("mkdir dst: %v", err)
	}
	if err := renamePath(src, dst); err != nil {
		t.Fatalf("renamePath: %v", err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("src still exists or unexpected err: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(dst, "nested", "payload.txt")); err != nil || string(got) != "payload" {
		t.Fatalf("dst payload: got=%q err=%v", string(got), err)
	}
}

func TestVerifyMissingXattr(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if err := verifyMissingXattr(path, "user.missing"); err != nil {
		t.Fatalf("verifyMissingXattr missing: %v", err)
	}
}

func TestOrderedScenariosDefaultIncludesCompatibility(t *testing.T) {
	got := orderedScenarios(harnessConfig{Profile: "quick"})
	want := []string{
		"mount_smoke",
		"barrier_cut",
		"crash_before_barrier",
		"crash_after_barrier",
		"snapshot_restore",
		"tree_restore",
		"session_churn",
		"metadata_restore_matrix",
		"rename_semantics_matrix",
		"xattr_restore_matrix",
		"cross_mode_restore",
		"chaos_crash_fuzz",
		"periodic_commit_chaos",
	}
	if len(got) != len(want) {
		t.Fatalf("scenario count mismatch: got=%v want=%v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("scenario[%d] mismatch: got=%q want=%q", i, got[i], want[i])
		}
	}
}

func TestBuildHarnessMetaURLSMH(t *testing.T) {
	cfg := harnessConfig{
		RemoteBackend:      "smh",
		SMHAccessDomain:    "https://example.api.tencentsmh.cn",
		SMHLibraryID:       "lib",
		SMHSpaceID:         "space",
		RuntimeMaintenance: "full",
		SnapshotInterval:   "1m",
	}
	metaURL, err := buildHarnessMetaURL(cfg, "/tmp/meta.db", "workspace/demo/meta.db", "3s")
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(strings.TrimPrefix(metaURL, "sqlite3://"))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("litestream_path") != "" {
		t.Fatalf("litestream_path should be empty for smh: %q", q.Get("litestream_path"))
	}
	replica := q.Get("litestream_replica_url")
	if replica == "" {
		t.Fatal("missing smh litestream_replica_url")
	}
	ru, err := url.Parse(replica)
	if err != nil {
		t.Fatal(err)
	}
	if ru.Scheme != "smh" || ru.Host != "example.api.tencentsmh.cn" || ru.Path != "/workspace/demo/meta.db" {
		t.Fatalf("unexpected replica URL: %s", replica)
	}
	rq := ru.Query()
	if rq.Get("endpoint") != "https://example.api.tencentsmh.cn" || rq.Get("library_id") != "lib" || rq.Get("space_id") != "space" {
		t.Fatalf("unexpected replica query: %s", replica)
	}
}

func TestBuildHarnessMetaURLCOS(t *testing.T) {
	cfg := harnessConfig{RemoteBackend: "cos", RuntimeMaintenance: "full"}
	metaURL, err := buildHarnessMetaURL(cfg, "/tmp/meta.db", "workspace/demo/meta.db", "3s")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(metaURL, "litestream_path=workspace%2Fdemo%2Fmeta.db") {
		t.Fatalf("missing cos litestream_path: %s", metaURL)
	}
	if strings.Contains(metaURL, "litestream_replica_url=") {
		t.Fatalf("cos meta URL should not use explicit replica URL: %s", metaURL)
	}
}

func TestSafeHarnessWorkspaceName(t *testing.T) {
	got := safeHarnessWorkspaceName("local_meta_write_failure_recover-1779231002-2009")
	if strings.Contains(got, "_") {
		t.Fatalf("workspace contains underscore: %q", got)
	}
	if len(got) > 63 {
		t.Fatalf("workspace too long: %q len=%d", got, len(got))
	}
	for _, r := range got {
		if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-') {
			t.Fatalf("workspace contains invalid rune %q in %q", r, got)
		}
	}
}

func TestCrashBeforeBarrierUsesLongSyncInterval(t *testing.T) {
	run := &scenarioRun{name: "crash_before_barrier"}
	if got := run.currentSyncInterval(); got != "30s" {
		t.Fatalf("sync interval=%q", got)
	}
	run.syncIntervalOverride = "1s"
	if got := run.currentSyncInterval(); got != "1s" {
		t.Fatalf("override sync interval=%q", got)
	}
}

func TestPeriodicCommitChaosSettleDelayIsConfigurable(t *testing.T) {
	cfg := harnessConfig{PeriodicSettleDelay: 9 * time.Second}
	run := &scenarioRun{cfg: cfg}
	if run.cfg.PeriodicSettleDelay != 9*time.Second {
		t.Fatalf("periodic settle delay=%s", run.cfg.PeriodicSettleDelay)
	}
}

func TestSyncMount(t *testing.T) {
	if err := syncMount(t.TempDir()); err != nil {
		t.Fatalf("syncMount: %v", err)
	}
}
