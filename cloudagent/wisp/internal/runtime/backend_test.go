package runtime

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"wisp/internal/config"
)

func TestEnsureWorkspaceBackendProvisionedSMH(t *testing.T) {
	var tokenSeen, createSeen bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/token":
			tokenSeen = true
			_, _ = w.Write([]byte(`{"accessToken":"tok","expiresIn":600}`))
		case r.URL.Path == "/api/v1/space/lib":
			createSeen = true
			_, _ = w.Write([]byte(`{"spaceId":"space-new"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.jsonnet")
	content := fmt.Sprintf("{\n  \"WISP_NAME\": \"base\",\n  \"REMOTE_BACKEND\": \"smh\",\n  \"SMH_LIBRARY_ID\": \"lib\",\n  \"SMH_ACCESS_DOMAIN\": %q,\n  \"SMH_LIBRARY_SECRET\": \"secret\"\n}\n", srv.URL)
	if err := os.WriteFile(configPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ensureWorkspaceBackendProvisioned(context.Background(), configPath, cfg, "demo"); err != nil {
		t.Fatal(err)
	}
	if !tokenSeen || !createSeen {
		t.Fatalf("tokenSeen=%v createSeen=%v", tokenSeen, createSeen)
	}
	overlay, err := config.ContainerOverlayPath(configPath, "demo")
	if err != nil {
		t.Fatalf("ContainerOverlayPath: %v", err)
	}
	data, err := os.ReadFile(overlay)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{`"REMOTE_BACKEND": "smh"`, `"SMH_LIBRARY_ID": "lib"`, `"SMH_ACCESS_DOMAIN": "` + srv.URL + `"`, `"SMH_SPACE_ID": "space-new"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("overlay missing %q: %s", want, text)
		}
	}
	if strings.Contains(text, "SMH_LIBRARY_SECRET") {
		t.Fatalf("overlay leaked secret: %s", text)
	}
}

func TestEnsureWorkspaceBackendProvisionedSMHSkipsWhenSpaceExists(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.jsonnet")
	content := "{\n  \"WISP_NAME\": \"base\",\n  \"REMOTE_BACKEND\": \"smh\",\n  \"SMH_LIBRARY_ID\": \"lib\",\n  \"SMH_ACCESS_DOMAIN\": \"https://example.api.tencentsmh.cn\",\n  \"SMH_SPACE_ID\": \"space-existing\"\n}\n"
	if err := os.WriteFile(configPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ensureWorkspaceBackendProvisioned(context.Background(), configPath, cfg, "demo"); err != nil {
		t.Fatal(err)
	}
	overlay, err := config.ContainerOverlayPath(configPath, "demo")
	if err != nil {
		t.Fatalf("ContainerOverlayPath: %v", err)
	}
	data, err := os.ReadFile(overlay)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"SMH_SPACE_ID": "space-existing"`) {
		t.Fatalf("overlay=%s", string(data))
	}
}

func TestDaemonBackendBindWritesIdentityAndKeepsTokenInMemory(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.jsonnet")
	content := "{\n  \"WISP_NAME\": \"base\",\n  \"REMOTE_BACKEND\": \"cos\",\n  \"COS_ENABLED\": false\n}\n"
	if err := os.WriteFile(configPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConfigFile = configPath
	d := NewDaemon(New(cfg))
	err = d.bindWorkspaceBackend(context.Background(), backendBindRequest{
		Name:            "demo",
		RemoteBackend:   "smh",
		SMHLibraryID:    "lib",
		SMHAccessDomain: "https://example.api.tencentsmh.cn",
		SMHSpaceID:      "space-existing",
		SMHAccessToken:  "short-token",
		JFSPrefix:       "sessions/demo",
	})
	if err != nil {
		t.Fatal(err)
	}
	overlay, err := config.ContainerOverlayPath(configPath, "demo")
	if err != nil {
		t.Fatalf("ContainerOverlayPath: %v", err)
	}
	data, err := os.ReadFile(overlay)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{`"REMOTE_BACKEND": "smh"`, `"SMH_SPACE_ID": "space-existing"`, `"JFS_PREFIX": "sessions/demo"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("overlay missing %q: %s", want, text)
		}
	}
	if strings.Contains(text, "short-token") || strings.Contains(text, "SMH_ACCESS_TOKEN") {
		t.Fatalf("overlay must not persist short-lived token: %s", text)
	}
	rt, err := d.runtimeForNameLocked("demo")
	if err != nil {
		t.Fatal(err)
	}
	if got := rt.cfg.SMHAccessToken; got != "short-token" {
		t.Fatalf("runtime token=%q, want in-memory token", got)
	}
}

func TestValidateRemoteBackendConfig(t *testing.T) {
	tests := []struct {
		name    string
		cfg     config.Config
		wantErr string
	}{
		{name: "cos ok", cfg: config.Config{RemoteBackend: "cos"}},
		{name: "smh ok", cfg: config.Config{RemoteBackend: "smh", SMHLibraryID: "lib", SMHAccessDomain: "https://example.api.tencentsmh.cn"}},
		{name: "smh missing library", cfg: config.Config{RemoteBackend: "smh", SMHAccessDomain: "https://example.api.tencentsmh.cn"}, wantErr: "SMH_LIBRARY_ID"},
		{name: "smh missing domain", cfg: config.Config{RemoteBackend: "smh", SMHLibraryID: "lib"}, wantErr: "SMH_ACCESS_DOMAIN"},
		{name: "bad backend", cfg: config.Config{RemoteBackend: "weird"}, wantErr: "unsupported remote backend"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateRemoteBackendConfig(tc.cfg)
			if tc.wantErr == "" && err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err=%v want contains %q", err, tc.wantErr)
				}
			}
		})
	}
}
