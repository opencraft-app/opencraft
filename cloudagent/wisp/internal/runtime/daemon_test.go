package runtime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"wisp/internal/config"
)

func TestClassifyError(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{
			name:   "container not found",
			err:    errors.New("container demo not found"),
			status: http.StatusNotFound,
			code:   "container_not_found",
		},
		{
			name:   "bootstrap required",
			err:    errors.New("runtime is not bootstrapped; run bootstrap first (missing: prepared crun binary)"),
			status: http.StatusPreconditionFailed,
			code:   "bootstrap_required",
		},
		{
			name:   "runtime not running",
			err:    errors.New("runtime is not started; run start first"),
			status: http.StatusConflict,
			code:   "runtime_not_running",
		},
		{
			name:   "dependency missing",
			err:    errors.New("could not prepare crun; configure CRUN_BINARY or install crun on the host"),
			status: http.StatusFailedDependency,
			code:   "dependency_missing",
		},
		{
			name:   "bad request",
			err:    badRequest("container name is required", nil),
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:   "invalid workspace name",
			err:    errors.New(`workspace name "../escape" contains unsupported character '/'`),
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:   "already running",
			err:    errors.New("wisp daemon already running (pid 123)"),
			status: http.StatusConflict,
			code:   "already_running",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyError(tc.err)
			if got.Status != tc.status || got.Code != tc.code {
				t.Fatalf("classifyError(%q) = status=%d code=%q; want status=%d code=%q",
					tc.err, got.Status, got.Code, tc.status, tc.code)
			}
		})
	}
}

func TestRuntimeForWispRejectsTraversalName(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.jsonnet")
	if err := os.WriteFile(configPath, []byte(`{
  WISP_NAME: "default",
}
`), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConfigFile = configPath
	d := NewDaemon(New(cfg))
	if _, err := d.runtimeForWispLocked("../escape"); err == nil {
		t.Fatal("runtimeForWispLocked should reject traversal workspace name")
	} else if got := classifyError(err); got.Status != http.StatusBadRequest {
		t.Fatalf("status=%d code=%s err=%v", got.Status, got.Code, err)
	}
}

func TestNormalizeWispPath(t *testing.T) {
	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "/tmp/demo", want: "/tmp/demo"},
		{in: "/tmp//demo/../x", wantErr: true},
		{in: "tmp/demo", wantErr: true},
		{in: "/", want: "/"},
	}

	for _, tc := range tests {
		got, err := normalizeWispPath(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("normalizeWispPath(%q) expected error", tc.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("normalizeWispPath(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("normalizeWispPath(%q)=%q want %q", tc.in, got, tc.want)
		}
	}
}

func TestWispResourceFromStatus(t *testing.T) {
	cold := wispResourceFromStatus("demo", RuntimeStatus{})
	if cold.State != "cold" {
		t.Fatalf("cold.State=%q", cold.State)
	}
	running := wispResourceFromStatus("demo", RuntimeStatus{Running: true})
	if running.State != "running" {
		t.Fatalf("running.State=%q", running.State)
	}
	if !running.Capabilities["exec"] || !running.Capabilities["checkpoints"] || !running.Capabilities["filesystem"] {
		t.Fatalf("capabilities=%v", running.Capabilities)
	}
}

func TestParseBoolQuery(t *testing.T) {
	for _, raw := range []string{"force=1", "force=true", "force=yes", "force=on"} {
		req := httptest.NewRequest(http.MethodPost, "/v1/wisps/demo/stop?"+raw, nil)
		if !parseBoolQuery(req, "force") {
			t.Fatalf("parseBoolQuery(%q)=false", raw)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/wisps/demo/stop?force=0", nil)
	if parseBoolQuery(req, "force") {
		t.Fatal("force=0 should be false")
	}
}

func TestDaemonWispLockIsolation(t *testing.T) {
	d := NewDaemon(&Runtime{})

	unlockA := d.lockWisp("a")
	defer unlockA()

	aLocked := make(chan struct{})
	go func() {
		unlock := d.lockWisp("a")
		close(aLocked)
		unlock()
	}()

	select {
	case <-aLocked:
		t.Fatal("same wisp lock should block")
	case <-time.After(50 * time.Millisecond):
	}

	bLocked := make(chan struct{})
	go func() {
		unlock := d.lockWisp("b")
		close(bLocked)
		unlock()
	}()

	select {
	case <-bLocked:
	case <-time.After(time.Second):
		t.Fatal("different wisp lock should not block")
	}
}

func TestRuntimeStatusIncludesRemoteBackend(t *testing.T) {
	rt := New(config.Config{
		WispName:        "demo",
		RemoteBackend:   "smh",
		AdminSocketPath: "/tmp/admin.sock",
		AdminListenAddr: "127.0.0.1:18527",
		EnvSocketPath:   "/.wisp/api.sock",
		JFSRoot:         "/mnt/mock",
	})
	status := rt.runtimeStatus(context.Background())
	if status.RemoteBackend != "smh" {
		t.Fatalf("RemoteBackend=%q", status.RemoteBackend)
	}
}

func TestWorkspaceLayoutConfigForCreatePreservesBoundBackend(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.jsonnet")
	if err := os.WriteFile(configPath, []byte(`{
  WISP_NAME: "default",
  REMOTE_BACKEND: "cos",
  COS_ENABLED: false,
  JFS_ROOT: "/mnt/cloudagent-wisp",
  TEMP_ROOT: "/tmp/wisp/default",
  RUNTIME_ROOT: "/var/lib/wisp-runtime/default",
}
`), 0o644); err != nil {
		t.Fatal(err)
	}

	baseCfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	name := "agent-session-demo"
	if err := config.SetWorkspaceLayout(configPath, baseCfg, name); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{
		"REMOTE_BACKEND":    "smh",
		"SMH_ENABLED":       "true",
		"SMH_LIBRARY_ID":    "lib",
		"SMH_ACCESS_DOMAIN": "https://example.api.tencentsmh.cn",
		"SMH_SPACE_ID":      "space-1",
		"JFS_PREFIX":        "host",
	} {
		if err := config.SetContainerEnvValue(configPath, name, key, value); err != nil {
			t.Fatal(err)
		}
	}

	layoutCfg, err := workspaceLayoutConfigForCreate(configPath, baseCfg, name)
	if err != nil {
		t.Fatal(err)
	}
	if err := config.SetWorkspaceLayout(configPath, layoutCfg, name); err != nil {
		t.Fatal(err)
	}

	got, err := config.LoadContainer(configPath, name)
	if err != nil {
		t.Fatal(err)
	}
	if got.RemoteBackend != "smh" || !got.SMHEnabled || got.SMHLibraryID != "lib" || got.SMHSpaceID != "space-1" || got.JFSPrefix != "host" {
		t.Fatalf("bound backend was not preserved: backend=%q smh=%t library=%q space=%q prefix=%q",
			got.RemoteBackend, got.SMHEnabled, got.SMHLibraryID, got.SMHSpaceID, got.JFSPrefix)
	}
	if got.COSWorkspace != name || got.WispName != name {
		t.Fatalf("workspace layout was not refreshed: wisp_name=%q cos_workspace=%q", got.WispName, got.COSWorkspace)
	}
}

func TestHandleWispCreatePreservesBoundBackendOverlay(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.jsonnet")
	if err := os.WriteFile(configPath, []byte(`{
  WISP_NAME: "default",
  REMOTE_BACKEND: "cos",
  COS_ENABLED: false,
  JFS_ROOT: "/mnt/cloudagent-wisp",
  TEMP_ROOT: "/tmp/wisp/default",
  RUNTIME_ROOT: "/var/lib/wisp-runtime/default",
}
`), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConfigFile = configPath
	d := NewDaemon(New(cfg))
	name := "agent-session-demo"
	if err := d.bindWorkspaceBackend(context.Background(), backendBindRequest{
		Name:            name,
		RemoteBackend:   "smh",
		SMHLibraryID:    "lib",
		SMHAccessDomain: "https://example.api.tencentsmh.cn",
		SMHSpaceID:      "space-1",
		JFSPrefix:       "host",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/wisps", strings.NewReader(`{"name":"`+name+`"}`))
	rec := httptest.NewRecorder()
	d.handleWispCreate(rec, req)

	got, err := config.LoadContainer(configPath, name)
	if err != nil {
		t.Fatal(err)
	}
	if got.RemoteBackend != "smh" || !got.SMHEnabled || got.SMHLibraryID != "lib" || got.SMHSpaceID != "space-1" || got.JFSPrefix != "host" {
		t.Fatalf("wisp.create overwrote bound backend: status=%d backend=%q smh=%t library=%q space=%q prefix=%q body=%s",
			rec.Code, got.RemoteBackend, got.SMHEnabled, got.SMHLibraryID, got.SMHSpaceID, got.JFSPrefix, rec.Body.String())
	}
}
