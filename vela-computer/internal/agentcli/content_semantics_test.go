package agentcli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAttachmentViewWritesBinary(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet ||
			request.URL.Path != "/internal/agent-api/attachments/attachment-1" {
			t.Fatalf("download request = %s %s", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/octet-stream")
		_, _ = response.Write([]byte("attachment bytes"))
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	outputPath := filepath.Join(t.TempDir(), "download.bin")
	if err := os.WriteFile(outputPath, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if exitCode := app.Run(context.Background(), []string{
		"attachment", "view", "attachment-1", "--output", outputPath,
	}); exitCode != 0 {
		t.Fatalf("view exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	data, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "attachment bytes" {
		t.Fatalf("downloaded bytes = %q", data)
	}
	info, err := os.Stat(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("download mode = %#o, want 0600", info.Mode().Perm())
	}
}

func TestAttachmentUploadRejectsChannelAliasAndOversizeBeforeResolve(t *testing.T) {
	t.Parallel()

	_, err := parseAttachmentUploadArgs([]string{
		"--path", "/tmp/synthetic.bin",
		"--channel", "#general",
	})
	if err == nil {
		t.Fatal("removed --channel alias was accepted")
	}

	oversizePath := filepath.Join(t.TempDir(), "oversize.bin")
	file, err := os.OpenFile(oversizePath, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(50*1024*1024 + 1); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	exitCode := app.Run(context.Background(), []string{
		"attachment", "upload",
		"--path", oversizePath,
		"--target", "#general",
	})
	if exitCode != 2 {
		t.Fatalf("exit code = %d, want 2; stderr = %q", exitCode, stderr.String())
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("cloud calls = %d, want 0", got)
	}
	realPath := filepath.Join(t.TempDir(), "real.txt")
	if err := os.WriteFile(realPath, []byte("sensitive"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlinkPath := filepath.Join(t.TempDir(), "linked.txt")
	if err := os.Symlink(realPath, symlinkPath); err != nil {
		t.Fatal(err)
	}
	exitCode = app.Run(context.Background(), []string{
		"attachment", "upload",
		"--path", symlinkPath,
		"--target", "#general",
	})
	if exitCode != 2 || !strings.Contains(stderr.String(), "symbolic link") {
		t.Fatalf("symlink exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("symlink cloud calls = %d, want 0", got)
	}
}
