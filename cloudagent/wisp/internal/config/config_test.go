package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadAppliesDefaultsAndOverrides(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.jsonnet")
	content := "{\n" +
		"  \"WISP_NAME\": \"tester\",\n" +
		"  \"REMOTE_BACKEND\": \"smh\",\n" +
		"  \"SMH_LIBRARY_ID\": \"lib\",\n" +
		"  \"SMH_ACCESS_DOMAIN\": \"https://example.api.tencentsmh.cn\",\n" +
		"  \"SMH_SPACE_ID\": \"space-a\",\n" +
		"  \"JFS_ROOT\": \"/data/jfs\",\n" +
		"  \"ROOT_UPPER_SIZE\": \"2G\",\n" +
		"  \"WISP_UID\": 2001\n" +
		"}\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.WispName != "tester" {
		t.Fatalf("WispName=%q", cfg.WispName)
	}
	if cfg.RemoteBackend != "smh" {
		t.Fatalf("RemoteBackend=%q", cfg.RemoteBackend)
	}
	if cfg.SMHLibraryID != "lib" || cfg.SMHAccessDomain != "https://example.api.tencentsmh.cn" || cfg.SMHSpaceID != "space-a" {
		t.Fatalf("SMH config mismatch: %+v", cfg)
	}
	if cfg.StateRoot != "/data/jfs/wisp/tester" {
		t.Fatalf("StateRoot=%q", cfg.StateRoot)
	}
	if cfg.RootUpperSize != "2G" {
		t.Fatalf("RootUpperSize=%q", cfg.RootUpperSize)
	}
	if cfg.WispUID != 2001 {
		t.Fatalf("WispUID=%d", cfg.WispUID)
	}
	if cfg.CrunBinaryPath != "/var/lib/wisp/shared/tools/crun" {
		t.Fatalf("CrunBinaryPath=%q", cfg.CrunBinaryPath)
	}
	if cfg.AdminRoot != "/run/envd" {
		t.Fatalf("AdminRoot=%q", cfg.AdminRoot)
	}
	if cfg.AdminSocketPath != "/run/envd/admin.sock" {
		t.Fatalf("AdminSocketPath=%q", cfg.AdminSocketPath)
	}
	if cfg.DaemonLockFile != "/run/envd/wisp.lock" {
		t.Fatalf("DaemonLockFile=%q", cfg.DaemonLockFile)
	}
}

func TestLoadFileOverridesProcessEnv(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.jsonnet")
	content := "{\n" +
		"  \"WISP_NAME\": \"file-name\",\n" +
		"  \"REMOTE_BACKEND\": \"smh\",\n" +
		"  \"CRUN_BINARY\": \"/file/crun\",\n" +
		"  \"WISPENV_BINARY\": \"/file/wispenv\",\n" +
		"  \"WISP_FS_AGENT_BINARY\": \"/file/wisp-fs-agent\",\n" +
		"  \"JFS_META_URL\": \"sqlite3:///file/meta.db\",\n" +
		"  \"JFS_BUCKET_URL\": \"s3://bucket/data\"\n" +
		"}\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	t.Setenv("WISP_NAME", "process-name")
	t.Setenv("CRUN_BINARY", "/process/crun")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.WispName != "file-name" {
		t.Fatalf("WispName=%q", cfg.WispName)
	}
	if cfg.CrunBinary != "/file/crun" {
		t.Fatalf("CrunBinary=%q", cfg.CrunBinary)
	}
	if cfg.RemoteBackend != "smh" {
		t.Fatalf("RemoteBackend=%q", cfg.RemoteBackend)
	}
	if cfg.WispEnvBinary != "/file/wispenv" {
		t.Fatalf("WispEnvBinary=%q", cfg.WispEnvBinary)
	}
	if cfg.WispFSAgentBinary != "/file/wisp-fs-agent" {
		t.Fatalf("WispFSAgentBinary=%q", cfg.WispFSAgentBinary)
	}
	if cfg.JFSMetaURL != "sqlite3:///file/meta.db" {
		t.Fatalf("JFSMetaURL=%q", cfg.JFSMetaURL)
	}
	if cfg.JFSBucketURL != "s3://bucket/data" {
		t.Fatalf("JFSBucketURL=%q", cfg.JFSBucketURL)
	}
}

func TestLoadAdminRootDerivesAdminPaths(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.jsonnet")
	content := "{\n" +
		"  \"WISP_NAME\": \"admin-root\",\n" +
		"  \"ADMIN_ROOT\": \"/tmp/admin-root\"\n" +
		"}\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.AdminRoot != "/tmp/admin-root" {
		t.Fatalf("AdminRoot=%q", cfg.AdminRoot)
	}
	if cfg.AdminSocketPath != "/tmp/admin-root/admin.sock" {
		t.Fatalf("AdminSocketPath=%q", cfg.AdminSocketPath)
	}
	if cfg.DaemonLockFile != "/tmp/admin-root/wisp.lock" {
		t.Fatalf("DaemonLockFile=%q", cfg.DaemonLockFile)
	}
}

func TestDefaultConfigPathFindsConfigSubdirInWorkingDirectory(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	dir := t.TempDir()
	configDir := filepath.Join(dir, "config")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	path := filepath.Join(configDir, "config.jsonnet")
	if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir temp dir: %v", err)
	}
	defer func() {
		_ = os.Chdir(wd)
	}()

	got := DefaultConfigPath()
	gotEval, _ := filepath.EvalSymlinks(got)
	pathEval, _ := filepath.EvalSymlinks(path)
	if gotEval != pathEval {
		t.Fatalf("DefaultConfigPath=%q want %q", got, path)
	}
}

func TestSetWorkspaceLayoutPersistsBackendIdentity(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.jsonnet")
	content := "{\n" +
		"  \"WISP_NAME\": \"base\",\n" +
		"  \"REMOTE_BACKEND\": \"smh\",\n" +
		"  \"SMH_ENABLED\": true,\n" +
		"  \"SMH_LIBRARY_ID\": \"lib-1\",\n" +
		"  \"SMH_ACCESS_DOMAIN\": \"https://example.api.tencentsmh.cn\",\n" +
		"  \"SMH_SPACE_ID\": \"space-1\"\n" +
		"}\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if err := SetWorkspaceLayout(path, cfg, "demo"); err != nil {
		t.Fatalf("SetWorkspaceLayout: %v", err)
	}
	overlayPath := ContainerOverlayPath(path, "demo")
	data, err := os.ReadFile(overlayPath)
	if err != nil {
		t.Fatalf("read overlay: %v", err)
	}
	text := string(data)
	for _, want := range []string{
		`"REMOTE_BACKEND": "smh"`,
		`"SMH_ENABLED": "true"`,
		`"SMH_LIBRARY_ID": "lib-1"`,
		`"SMH_ACCESS_DOMAIN": "https://example.api.tencentsmh.cn"`,
		`"SMH_SPACE_ID": "space-1"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("overlay missing %q: %s", want, text)
		}
	}
}
