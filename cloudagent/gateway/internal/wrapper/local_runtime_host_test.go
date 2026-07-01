package wrapper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLocalRuntimeHostPersistsHandleAndFiles(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:     "local-template",
		TimeoutSeconds: 60,
		Metadata:       map[string]string{"session_id": "session_local"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if target.ID == "" || target.HostType != runtimeHostTypeLocalWisp {
		t.Fatalf("unexpected local target: %#v", target)
	}
	if target.EnvdAccessToken == "" {
		t.Fatalf("local target should carry a sentinel envd token for legacy runtime guards: %#v", target)
	}
	if _, err := os.Stat(filepath.Join(root, "handles", target.ID+".json")); err != nil {
		t.Fatalf("local handle was not persisted: %v", err)
	}
	if err := host.UploadFile(ctx, target, "/workspace/hello.txt", "hello.txt", []byte("local-wisp-file")); err != nil {
		t.Fatal(err)
	}
	data, err := host.DownloadFile(ctx, target, "/workspace/hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "local-wisp-file" {
		t.Fatalf("downloaded content=%q", string(data))
	}
	before, err := host.readHandle(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	if err := host.RefreshSandboxTimeout(ctx, target.ID, 120); err != nil {
		t.Fatal(err)
	}
	after, err := host.readHandle(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ExpiresAt.After(before.ExpiresAt) {
		t.Fatalf("refresh did not extend expiry: before=%s after=%s", before.ExpiresAt, after.ExpiresAt)
	}
	if err := host.DeleteSandbox(ctx, target.ID); err != nil {
		t.Fatal(err)
	}
	if err := host.DeleteSandbox(ctx, target.ID); err != nil {
		t.Fatalf("delete should be idempotent: %v", err)
	}
}

func TestLocalRuntimeTrackedCommandUsesConfiguredShellForPrefixedCommands(t *testing.T) {
	command := localRuntimeTrackedCommand("set -euo pipefail\necho ok", "/tmp/pid", "/tmp/pgid", "/bin/bash", true)
	if !strings.Contains(command, "setsid --wait '/bin/bash' -lc") {
		t.Fatalf("prefixed local runtime command should use configured shell, got:\n%s", command)
	}
	if strings.Contains(command, "setsid /bin/sh -lc") {
		t.Fatalf("prefixed local runtime command must not force /bin/sh, got:\n%s", command)
	}
}

func TestLocalRuntimeHostHandleSurvivesHostRecreation(t *testing.T) {
	root := t.TempDir()
	firstHost, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := firstHost.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:     "local-template",
		TimeoutSeconds: 90,
		Metadata:       map[string]string{"session_id": "session_recreate"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := firstHost.UploadFile(ctx, target, "/workspace/persist.txt", "persist.txt", []byte("persisted-through-handle")); err != nil {
		t.Fatal(err)
	}

	secondHost, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	data, err := secondHost.DownloadFile(ctx, target, "/workspace/persist.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "persisted-through-handle" {
		t.Fatalf("recreated host downloaded content=%q", string(data))
	}
	handle, err := secondHost.readHandle(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if handle.TemplateID != "local-template" || handle.Metadata["session_id"] != "session_recreate" || handle.AllowHostPaths {
		t.Fatalf("recreated host lost handle metadata: %#v", handle)
	}
	result, err := secondHost.RunCommand(ctx, target, "printf '%s' \"$CLOUDAGENT_LOCAL_TARGET_ROOT\"", nil, nil, nil)
	if err != nil {
		t.Fatalf("recreated host command failed: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	if !sameFilesystemPathForTest(t, result.Stdout, filepath.Join(root, "targets", target.ID)) {
		t.Fatalf("recreated host target root=%q", result.Stdout)
	}
}

func TestLocalRuntimeHostAcceptsEquivalentSymlinkedRuntimeRoot(t *testing.T) {
	realRoot := filepath.Join(t.TempDir(), "real-root")
	if err := os.MkdirAll(realRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	linkRoot := filepath.Join(t.TempDir(), "link-root")
	if err := os.Symlink(realRoot, linkRoot); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	firstHost, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: linkRoot, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := firstHost.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := firstHost.UploadFile(ctx, target, "/workspace/persist.txt", "persist.txt", []byte("same-root")); err != nil {
		t.Fatal(err)
	}

	secondHost, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: realRoot, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	got, err := secondHost.DownloadFile(ctx, target, "/workspace/persist.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "same-root" {
		t.Fatalf("downloaded content=%q", string(got))
	}
	handle, err := secondHost.readHandle(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !sameFilesystemPathForTest(t, handle.TargetRoot, filepath.Join(realRoot, "targets", target.ID)) {
		t.Fatalf("target root not normalized to active runtime root: %q", handle.TargetRoot)
	}
}

func TestLocalRuntimeHostRejectsPoisonedHandleTargetRoot(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	outsideRoot := filepath.Join(t.TempDir(), "outside-target")
	if err := os.MkdirAll(outsideRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(outsideRoot, "must-not-delete.txt")
	if err := os.WriteFile(marker, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	poisoned := localRuntimeHostHandle{
		ID:         target.ID,
		CreatedAt:  time.Now().UTC(),
		ExpiresAt:  time.Now().UTC().Add(time.Hour),
		TargetRoot: outsideRoot,
	}
	data, err := json.Marshal(poisoned)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "handles", target.ID+".json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := host.DownloadFile(ctx, target, "/workspace/a.txt"); err == nil || !strings.Contains(err.Error(), "does not match target id") {
		t.Fatalf("poisoned handle download should fail safely, got %v", err)
	}
	if _, err := host.RunCommand(ctx, target, "printf should-not-run", nil, nil, nil); err == nil || !strings.Contains(err.Error(), "does not match target id") {
		t.Fatalf("poisoned handle command should fail safely, got %v", err)
	}
	if err := host.DeleteSandbox(ctx, target.ID); err == nil || !strings.Contains(err.Error(), "does not match target id") {
		t.Fatalf("poisoned handle delete should refuse unsafe target root, got %v", err)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "outside" {
		t.Fatalf("poisoned handle delete touched outside target root: data=%q err=%v", string(data), err)
	}
}

func TestLocalRuntimeHostRejectsHandlePointingAtDifferentTargetRoot(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	first, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local-a"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local-b"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.UploadFile(ctx, second, "/workspace/keep.txt", "keep.txt", []byte("second-target")); err != nil {
		t.Fatal(err)
	}
	poisoned := localRuntimeHostHandle{
		ID:         first.ID,
		CreatedAt:  time.Now().UTC(),
		ExpiresAt:  time.Now().UTC().Add(time.Hour),
		TargetRoot: filepath.Join(root, "targets", second.ID),
	}
	data, err := json.Marshal(poisoned)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "handles", first.ID+".json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := host.DeleteSandbox(ctx, first.ID); err == nil || !strings.Contains(err.Error(), "does not match target id") {
		t.Fatalf("delete should reject handle pointing at another target root, got %v", err)
	}
	got, err := host.DownloadFile(ctx, second, "/workspace/keep.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "second-target" {
		t.Fatalf("second target was mutated: %q", string(got))
	}
}

func TestLocalRuntimeHostRejectsHandleIDMismatch(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	handle, err := host.readHandle(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	handle.ID = "local-different"
	data, err := json.Marshal(handle)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "handles", target.ID+".json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := host.RunCommand(ctx, target, "printf should-not-run", nil, nil, nil); err == nil || !strings.Contains(err.Error(), "handle id mismatch") {
		t.Fatalf("handle id mismatch should fail safely, got %v", err)
	}
}

func TestLocalRuntimeHostRejectsPathLikeRuntimeID(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.UploadFile(ctx, target, "/workspace/keep.txt", "keep.txt", []byte("keep")); err != nil {
		t.Fatal(err)
	}
	badID := "local-evil/" + target.ID
	if err := host.DeleteSandbox(ctx, badID); err == nil || !strings.Contains(err.Error(), "invalid local runtime id") {
		t.Fatalf("path-like id delete should be rejected, got %v", err)
	}
	got, err := host.DownloadFile(ctx, target, "/workspace/keep.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "keep" {
		t.Fatalf("path-like id delete mutated target: %q", string(got))
	}
	if _, err := host.RunCommand(ctx, RuntimeHostTarget{ID: badID}, "printf should-not-run", nil, nil, nil); err == nil || !strings.Contains(err.Error(), "invalid local runtime id") {
		t.Fatalf("path-like id command should be rejected, got %v", err)
	}
}

func TestLocalRuntimeHostFromEnvDefaultsToHostPaths(t *testing.T) {
	root := t.TempDir()
	hostPath := filepath.Join(t.TempDir(), "host-path-file.txt")
	t.Setenv("GATEWAY_LOCAL_RUNTIME_ROOT", root)
	t.Setenv("GATEWAY_LOCAL_RUNTIME_ALLOW_HOST_PATHS", "")

	host, err := NewLocalRuntimeHostFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.UploadFile(context.Background(), target, hostPath, "ignored.txt", []byte("host-path-content")); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(hostPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "host-path-content" {
		t.Fatalf("host path content=%q", string(data))
	}
}

func TestLocalRuntimeHostRelativePathsUseTargetRootWhenHostPathsEnabled(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: true})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	hostCWDFile := filepath.Join(cwd, "relative-host-path-should-not-exist.txt")
	_ = os.Remove(hostCWDFile)
	t.Cleanup(func() { _ = os.Remove(hostCWDFile) })
	if err := host.UploadFile(context.Background(), target, "relative-host-path-should-not-exist.txt", "ignored.txt", []byte("target-relative")); err != nil {
		t.Fatal(err)
	}
	got, err := host.DownloadFile(context.Background(), target, "relative-host-path-should-not-exist.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "target-relative" {
		t.Fatalf("relative host-path mode content=%q", string(got))
	}
	if _, err := os.Stat(filepath.Join(root, "targets", target.ID, "relative-host-path-should-not-exist.txt")); err != nil {
		t.Fatalf("relative path should materialize under target root: %v", err)
	}
	if _, err := os.Stat(hostCWDFile); err == nil {
		t.Fatalf("relative path leaked into gateway cwd: %s", hostCWDFile)
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stat gateway cwd relative file: %v", err)
	}
}

func TestLocalRuntimeHostIsolatesTargetPathsWhenHostPathsDisabled(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	first, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local-a"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local-b"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.UploadFile(ctx, first, "/workspace/shared.txt", "shared.txt", []byte("first-target")); err != nil {
		t.Fatal(err)
	}
	if err := host.UploadFile(ctx, second, "/workspace/shared.txt", "shared.txt", []byte("second-target")); err != nil {
		t.Fatal(err)
	}
	firstData, err := host.DownloadFile(ctx, first, "/workspace/shared.txt")
	if err != nil {
		t.Fatal(err)
	}
	secondData, err := host.DownloadFile(ctx, second, "/workspace/shared.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(firstData) != "first-target" || string(secondData) != "second-target" {
		t.Fatalf("target content leaked: first=%q second=%q", string(firstData), string(secondData))
	}
	if _, err := os.Stat(filepath.Join(root, "targets", first.ID, "workspace", "shared.txt")); err != nil {
		t.Fatalf("first target file not materialized under target root: %v", err)
	}
	if err := host.UploadFile(ctx, first, "../../escape.txt", "escape.txt", []byte("escape")); err == nil {
		t.Fatal("path traversal upload should be rejected when host paths are disabled")
	}
}

func TestLocalRuntimeHostRelativePathsStayInsideTargetRoot(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.UploadFile(ctx, target, "notes/relative.txt", "relative.txt", []byte("relative-content")); err != nil {
		t.Fatal(err)
	}
	data, err := host.DownloadFile(ctx, target, "notes/relative.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "relative-content" {
		t.Fatalf("relative path content=%q", string(data))
	}
	hostPath := filepath.Join(root, "targets", target.ID, "notes", "relative.txt")
	if _, err := os.Stat(hostPath); err != nil {
		t.Fatalf("relative upload should materialize under target root: %v", err)
	}
	if _, err := host.DownloadFile(ctx, target, "../../etc/passwd"); err == nil {
		t.Fatal("path traversal download should be rejected when host paths are disabled")
	}
}

func TestLocalRuntimeHostWorkspaceAbsolutePathDoesNotTouchHostWhenDisabled(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	remotePath := "/workspace/no-host-leak-cloudagent-local-runtime-test.txt"
	if err := host.UploadFile(ctx, target, remotePath, "ignored.txt", []byte("target-only")); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "targets", target.ID, "workspace", "no-host-leak-cloudagent-local-runtime-test.txt"))
	if err != nil {
		t.Fatalf("target-root /workspace file missing: %v", err)
	}
	if string(data) != "target-only" {
		t.Fatalf("target-root file content=%q", string(data))
	}
	if _, err := os.Stat(remotePath); err == nil {
		t.Fatalf("disabled host paths must not write host %s", remotePath)
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stat host %s: %v", remotePath, err)
	}
}

func TestLocalRuntimeHostDirectoryUploadUsesBaseFilename(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.UploadFile(ctx, target, "/workspace/uploads/", "../../actual.txt", []byte("directory-upload")); err != nil {
		t.Fatal(err)
	}
	data, err := host.DownloadFile(ctx, target, "/workspace/uploads/actual.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "directory-upload" {
		t.Fatalf("directory upload content=%q", string(data))
	}
	if _, err := host.DownloadFile(ctx, target, "/workspace/actual.txt"); err == nil {
		t.Fatal("directory upload should not escape destination directory")
	}
}

func TestLocalRuntimeHostDirectoryUploadRejectsParentFilename(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir(), AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.UploadFile(context.Background(), target, "/workspace/uploads/", "..", []byte("bad")); err == nil || !strings.Contains(err.Error(), "invalid upload filename") {
		t.Fatalf("directory upload should reject parent filename, got %v", err)
	}
}

func TestLocalRuntimeHostRejectsEmptyFilePaths(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir(), AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.UploadFile(ctx, target, " \t\n ", "empty.txt", []byte("empty")); err == nil || !strings.Contains(err.Error(), "path is required") {
		t.Fatalf("empty upload path should be rejected, got %v", err)
	}
	if _, err := host.DownloadFile(ctx, target, " \t\n "); err == nil || !strings.Contains(err.Error(), "path is required") {
		t.Fatalf("empty download path should be rejected, got %v", err)
	}
}

func TestLocalRuntimeHostRejectsSymlinkEscapeWhenHostPathsDisabled(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	outsideDir := t.TempDir()
	targetRoot := filepath.Join(root, "targets", target.ID)
	if err := os.MkdirAll(filepath.Join(targetRoot, "workspace"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDir, filepath.Join(targetRoot, "workspace", "escape")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := host.UploadFile(ctx, target, "/workspace/escape/outside.txt", "outside.txt", []byte("should-not-write")); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlink escape upload should be rejected, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(outsideDir, "outside.txt")); err == nil {
		t.Fatal("symlink escape upload wrote outside target root")
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stat outside file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(outsideDir, "read.txt"), []byte("outside-read"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := host.DownloadFile(ctx, target, "/workspace/escape/read.txt"); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlink escape download should be rejected, got %v", err)
	}
}

func TestLocalRuntimeHostDeleteMakesTargetUnavailable(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.DeleteSandbox(ctx, target.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := host.RunCommand(ctx, target, "printf should-not-run", nil, nil, nil); err == nil {
		t.Fatal("run command should fail after local runtime target is deleted")
	}
	if _, err := host.DownloadFile(ctx, target, "/workspace/missing.txt"); err == nil {
		t.Fatal("download should fail after local runtime target is deleted")
	}
}

func TestLocalRuntimeHostDeleteCancelsActiveCommand(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "delete-active-command-marker.txt")
	started := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		_, err := host.RunCommand(context.Background(), target, "(printf started; sleep 0.4; printf leaked > "+shellQuote(marker)+")", nil, func(text string) error {
			if strings.Contains(text, "started") {
				select {
				case started <- struct{}{}:
				default:
				}
			}
			return nil
		}, nil)
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("active command did not start")
	}
	if err := host.DeleteSandbox(context.Background(), target.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("deleted local runtime target should cancel active command")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("delete did not cancel active command")
	}
	if data, err := os.ReadFile(marker); err == nil {
		t.Fatalf("deleted local runtime target left command running, marker=%q", string(data))
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read marker after delete: %v", err)
	}
}

func TestLocalRuntimeHostDeleteFromRecreatedHostCancelsActiveCommand(t *testing.T) {
	root := t.TempDir()
	firstHost, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	target, err := firstHost.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	secondHost, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "cross-host-delete-marker.txt")
	started := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		_, err := firstHost.RunCommand(context.Background(), target, "(printf started; sleep 0.4; printf leaked > "+shellQuote(marker)+")", nil, func(text string) error {
			if strings.Contains(text, "started") {
				select {
				case started <- struct{}{}:
				default:
				}
			}
			return nil
		}, nil)
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("active command did not start")
	}
	if err := secondHost.DeleteSandbox(context.Background(), target.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("delete from recreated host should cancel active command")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("delete from recreated host did not cancel active command")
	}
	if data, err := os.ReadFile(marker); err == nil {
		t.Fatalf("cross-host delete left command running, marker=%q", string(data))
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read marker after cross-host delete: %v", err)
	}
}

func TestLocalRuntimeHostDeleteRemovesTargetRoot(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	targetRoot := filepath.Join(root, "targets", target.ID)
	if err := host.UploadFile(ctx, target, "/workspace/delete-me.txt", "delete-me.txt", []byte("delete-root")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(targetRoot, "workspace", "delete-me.txt")); err != nil {
		t.Fatalf("target root file missing before delete: %v", err)
	}
	if err := host.DeleteSandbox(ctx, target.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(targetRoot); err == nil {
		t.Fatalf("delete should remove target root %s", targetRoot)
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stat target root after delete: %v", err)
	}
}

func TestLocalRuntimeHostRefreshAfterDeleteFails(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	target, err := host.CreateSandbox(ctx, CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.DeleteSandbox(ctx, target.ID); err != nil {
		t.Fatal(err)
	}
	if err := host.RefreshSandboxTimeout(ctx, target.ID, 120); err == nil {
		t.Fatal("refresh should fail after local runtime target is deleted")
	}
}

func TestLocalRuntimeHostConcurrentRefreshDoesNotResurrectDeletedHandle(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir(), AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for j := 0; j < 50; j++ {
				_ = host.RefreshSandboxTimeout(context.Background(), target.ID, 120)
			}
		}()
	}
	close(start)
	if err := host.DeleteSandbox(context.Background(), target.ID); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if _, err := host.readHandle(target.ID); err == nil {
		t.Fatal("concurrent refresh resurrected deleted local runtime handle")
	}
	if _, err := os.Stat(filepath.Join(host.root, "targets", target.ID)); err == nil {
		t.Fatal("concurrent refresh/delete left target root behind")
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stat target root after concurrent refresh/delete: %v", err)
	}
}

func TestLocalRuntimeHostHonorsCanceledContext(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir(), AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := host.CreateSandbox(canceled, CreateSandboxOptions{TemplateID: "local"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("create should honor canceled context, got %v", err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.UploadFile(canceled, target, "/workspace/a.txt", "a.txt", []byte("a")); !errors.Is(err, context.Canceled) {
		t.Fatalf("upload should honor canceled context, got %v", err)
	}
	if _, err := host.DownloadFile(canceled, target, "/workspace/a.txt"); !errors.Is(err, context.Canceled) {
		t.Fatalf("download should honor canceled context, got %v", err)
	}
	if err := host.RefreshSandboxTimeout(canceled, target.ID, 120); !errors.Is(err, context.Canceled) {
		t.Fatalf("refresh should honor canceled context, got %v", err)
	}
	if err := host.DeleteSandbox(canceled, target.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("delete should honor canceled context, got %v", err)
	}
	if _, err := host.RunCommand(canceled, target, "printf still-canceled", nil, nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("run command should honor canceled context, got %v", err)
	}
	if _, err := host.readHandle(target.ID); err != nil {
		t.Fatalf("canceled delete should not remove handle: %v", err)
	}
}

func TestLocalRuntimeHostCommandFailureCapturesOutput(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := host.RunCommand(context.Background(), target, "printf local-stdout; printf local-stderr >&2; exit 7", nil, nil, nil)
	if err == nil {
		t.Fatalf("expected command failure, got result=%#v", result)
	}
	if result.Status != "failed" || result.ExitCode != 7 {
		t.Fatalf("unexpected failed command result: %#v", result)
	}
	if result.Stdout != "local-stdout" || result.Stderr != "local-stderr" {
		t.Fatalf("failed command output not captured: stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
}

func TestLocalRuntimeHostCommandPIDFileCleanedAfterSuccess(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.RunCommand(context.Background(), target, "printf ok", nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "targets", target.ID, ".cloudagent-local-runs"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".pid") {
			t.Fatalf("successful command left pid file behind: %s", entry.Name())
		}
	}
}

func TestLocalRuntimeHostNormalBackgroundCommandSurvivesCommandExit(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "native-background-marker.txt")
	result, err := host.RunCommand(context.Background(), target, "(sleep 0.2; printf daemon-ok > "+shellQuote(marker)+") &", nil, nil, nil)
	if err != nil {
		t.Fatalf("start native background command: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	time.Sleep(500 * time.Millisecond)
	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("native normal background command did not survive command exit: %v", err)
	}
	if string(data) != "daemon-ok" {
		t.Fatalf("native background marker=%q", string(data))
	}
}

func TestLocalRuntimeHostDeleteKillsBackgroundCommandAfterCommandExit(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "native-background-delete-marker.txt")
	result, err := host.RunCommand(context.Background(), target, "(sleep 0.4; printf leaked > "+shellQuote(marker)+") &", nil, nil, nil)
	if err != nil {
		t.Fatalf("start native background command: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	entries, err := os.ReadDir(filepath.Join(root, "targets", target.ID, ".cloudagent-local-runs"))
	if err != nil {
		t.Fatal(err)
	}
	hasGroupLedger := false
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".pgid") {
			hasGroupLedger = true
		}
	}
	if !hasGroupLedger {
		t.Fatal("background command should leave process-group ledger for sandbox delete")
	}
	if err := host.DeleteSandbox(context.Background(), target.ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(700 * time.Millisecond)
	if data, err := os.ReadFile(marker); err == nil {
		t.Fatalf("delete left background command running, marker=%q", string(data))
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read marker after delete: %v", err)
	}
}

func TestLocalRuntimeHostCommandsRunFromTargetRoot(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: root, AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := host.RunCommand(context.Background(), target, "pwd; printf cwd-file > relative-from-cwd.txt", nil, nil, nil)
	if err != nil {
		t.Fatalf("run command from target root: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	lines := strings.Split(strings.TrimSpace(result.Stdout), "\n")
	wantCWD := filepath.Join(root, "targets", target.ID)
	if realWant, err := filepath.EvalSymlinks(wantCWD); err == nil {
		wantCWD = realWant
	}
	gotCWD := ""
	if len(lines) > 0 {
		gotCWD = lines[0]
	}
	if realGot, err := filepath.EvalSymlinks(gotCWD); err == nil {
		gotCWD = realGot
	}
	if gotCWD != wantCWD {
		t.Fatalf("command cwd stdout=%q", result.Stdout)
	}
	data, err := os.ReadFile(filepath.Join(root, "targets", target.ID, "relative-from-cwd.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "cwd-file" {
		t.Fatalf("cwd file content=%q", string(data))
	}
}

func TestLocalRuntimeHostRejectsEmptyCommand(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := host.RunCommand(context.Background(), target, " \t\n ", nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "command is required") {
		t.Fatalf("empty command should be rejected, err=%v result=%#v", err, result)
	}
}

func TestLocalRuntimeHostCommandContextTimeoutFailsFast(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	result, err := host.RunCommand(ctx, target, "sleep 5", nil, nil, nil)
	if err == nil {
		t.Fatalf("expected timeout failure, got result=%#v", result)
	}
	if result.Status != "failed" {
		t.Fatalf("timeout command should be failed, got %#v", result)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("timeout command did not fail fast: elapsed=%s result=%#v err=%v", elapsed, result, err)
	}
}

func TestLocalRuntimeHostTimeoutKillsChildProcesses(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "child-leak-marker.txt")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	result, err := host.RunCommand(ctx, target, "(sleep 0.25; printf leaked > "+shellQuote(marker)+") & wait", nil, nil, nil)
	if err == nil {
		t.Fatalf("expected timeout failure, got result=%#v", result)
	}
	time.Sleep(500 * time.Millisecond)
	if data, err := os.ReadFile(marker); err == nil {
		t.Fatalf("timed out command left child process running, marker=%q", string(data))
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read marker after timeout: %v", err)
	}
}

func TestLocalRuntimeHostStreamCallbackErrorPropagates(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("stream callback rejected chunk")
	result, err := host.RunCommand(context.Background(), target, "printf callback-hit", nil, func(text string) error {
		if strings.Contains(text, "callback-hit") {
			return sentinel
		}
		return nil
	}, nil)
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected callback error, got err=%v result=%#v", err, result)
	}
	if result.Stdout != "callback-hit" || result.Status != "failed" {
		t.Fatalf("callback error should preserve command output/result: %#v", result)
	}
}

func TestLocalRuntimeHostStreamCallbackErrorCancelsLargeOutput(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("stop streaming")
	done := make(chan error, 1)
	go func() {
		_, err := host.RunCommand(context.Background(), target, "yes local-runtime-stream | head -c 10485760", nil, func(text string) error {
			if strings.Contains(text, "local-runtime-stream") {
				return sentinel
			}
			return nil
		}, nil)
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, sentinel) {
			t.Fatalf("expected stream callback error, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream callback error did not cancel large-output command")
	}
}

func TestLocalRuntimeHostCommandPrefixExpandsPlaceholders(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{
		Root:           root,
		CommandPrefix:  "env CLOUDAGENT_PREFIX_TARGET={target_id} CLOUDAGENT_PREFIX_TARGET_ROOT={target_root} CLOUDAGENT_PREFIX_RUNTIME_ROOT={runtime_root} /bin/sh -lc",
		AllowHostPaths: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := host.RunCommand(context.Background(), target, "printf '%s|%s|%s|%s' \"$CLOUDAGENT_PREFIX_TARGET\" \"$CLOUDAGENT_PREFIX_TARGET_ROOT\" \"$CLOUDAGENT_PREFIX_RUNTIME_ROOT\" \"$CLOUDAGENT_PREFIX_ENV\"", map[string]string{
		"CLOUDAGENT_PREFIX_ENV": "env-ok",
	}, nil, nil)
	if err != nil {
		t.Fatalf("run prefixed command: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	want := target.ID + "|" + filepath.Join(root, "targets", target.ID) + "|" + root + "|env-ok"
	if result.Stdout != want {
		t.Fatalf("prefix expansion stdout=%q, want %q", result.Stdout, want)
	}
}

func TestLocalRuntimeHostCommandPrefixQuotesRootsWithSpaces(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime root with spaces")
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{
		Root:          root,
		CommandPrefix: "env CLOUDAGENT_PREFIX_RUNTIME_ROOT={runtime_root} CLOUDAGENT_PREFIX_TARGET_ROOT={target_root} /bin/sh -lc",
	})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := host.RunCommand(context.Background(), target, "printf '%s|%s' \"$CLOUDAGENT_PREFIX_RUNTIME_ROOT\" \"$CLOUDAGENT_PREFIX_TARGET_ROOT\"", nil, nil, nil)
	if err != nil {
		t.Fatalf("run prefixed command with spaced paths: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	want := root + "|" + filepath.Join(root, "targets", target.ID)
	if result.Stdout != want {
		t.Fatalf("quoted prefix stdout=%q, want %q", result.Stdout, want)
	}
}

func TestLocalRuntimeHostRapidCommandsDoNotReportClosedPipe(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ {
		result, err := host.RunCommand(context.Background(), target, "printf rapid-command", nil, nil, nil)
		if err != nil {
			t.Fatalf("rapid command %d failed: %v stdout=%q stderr=%q", i, err, result.Stdout, result.Stderr)
		}
		if result.Status != "completed" || result.Stdout != "rapid-command" {
			t.Fatalf("rapid command %d result=%#v", i, result)
		}
	}
}

func TestLocalRuntimeHostConcurrentCommandsAndRefresh(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir(), AllowHostPaths: false})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errCh := make(chan error, 32)
	for i := 0; i < 16; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			command := "printf " + shellQuote(fmt.Sprintf("cmd-%02d", i)) + " > " + shellQuote(fmt.Sprintf("concurrent-%02d.txt", i))
			result, err := host.RunCommand(context.Background(), target, command, nil, nil, nil)
			if err != nil {
				errCh <- fmt.Errorf("command %d failed: %w stdout=%q stderr=%q", i, err, result.Stdout, result.Stderr)
			}
		}()
	}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := host.RefreshSandboxTimeout(context.Background(), target.ID, 120); err != nil {
				errCh <- fmt.Errorf("refresh failed: %w", err)
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
	for i := 0; i < 16; i++ {
		want := fmt.Sprintf("cmd-%02d", i)
		got, err := host.DownloadFile(context.Background(), target, fmt.Sprintf("concurrent-%02d.txt", i))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Fatalf("concurrent file %d=%q, want %q", i, string(got), want)
		}
	}
}

func TestLocalRuntimeHostStreamsCommandOutputBeforeExit(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local"})
	if err != nil {
		t.Fatal(err)
	}
	firstChunk := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		_, err := host.RunCommand(context.Background(), target, "printf CLOUDAGENT_STREAM_BEGIN; sleep 1; printf CLOUDAGENT_STREAM_DONE", nil, func(text string) error {
			if strings.Contains(text, "CLOUDAGENT_STREAM_BEGIN") {
				select {
				case firstChunk <- text:
				default:
				}
			}
			return nil
		}, nil)
		done <- err
	}()
	select {
	case <-firstChunk:
	case <-time.After(750 * time.Millisecond):
		t.Fatal("stdout callback did not receive first chunk before command exit")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("local command did not finish")
	}
}

func TestAgentSidecarWorkerFromEnvCanUseLocalRuntimeHostWithoutAGS(t *testing.T) {
	t.Setenv("GATEWAY_RUNTIME_HOST", runtimeHostTypeLocalWisp)
	t.Setenv("GATEWAY_LOCAL_RUNTIME_ROOT", t.TempDir())
	t.Setenv("GATEWAY_AGENT_SIDECAR_URL", "https://example.com/cloudagent-sidecar")
	t.Setenv("GATEWAY_TOKENHUB_API_KEY", "tokenhub-key")
	t.Setenv("GATEWAY_AGS_API_KEY", "")
	t.Setenv("E2B_API_KEY", "")

	worker, err := NewAgentSidecarWorkerFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if worker.client != nil {
		t.Fatalf("local runtime host should not create an AGS client")
	}
	if worker.defaultBackendName != runtimeHostTypeLocalWisp {
		t.Fatalf("default backend=%q, want local_wisp", worker.defaultBackendName)
	}
	failures := strings.Join(worker.readinessFailures(), "\n")
	if strings.Contains(failures, "AGS") || strings.Contains(failures, "GATEWAY_AGS") {
		t.Fatalf("local runtime readiness should not require AGS config: %s", failures)
	}
}

func TestRuntimeTargetsPreserveLocalHostType(t *testing.T) {
	runtime := ACPSessionRuntime{
		SandboxBackend:     runtimeHostTypeLocalWisp,
		OuterSandboxID:     "local-outer",
		OuterSandboxDomain: runtimeHostTypeLocalWisp,
		InnerSandboxID:     "local-inner",
		InnerSandboxDomain: runtimeHostTypeLocalWisp,
	}
	if !runtimeHasOuterHostTarget(runtime) {
		t.Fatal("local host target should not require AGS envd token")
	}
	outer := runtimeOuterSandbox(runtime)
	if outer.HostType != runtimeHostTypeLocalWisp || outer.ID != "local-outer" {
		t.Fatalf("outer target did not preserve local host type: %#v", outer)
	}
	inner, err := runtimeWorkspaceSandbox(runtime)
	if err != nil {
		t.Fatal(err)
	}
	if inner.HostType != runtimeHostTypeLocalWisp || inner.ID != "local-inner" {
		t.Fatalf("inner target did not preserve local host type: %#v", inner)
	}
}

func TestEnsureSessionEnvdRuntimeUsesCachedLocalTarget(t *testing.T) {
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		RuntimeHost:     host,
		RuntimeHostName: runtimeHostTypeLocalWisp,
		OuterTemplateID: "local-outer",
		InnerTemplateID: "local-inner",
		SidecarURL:      "https://example.com/cloudagent-sidecar",
		TokenHubAPIKey:  "tokenhub-key",
		OuterRuntime:    outerRuntimeWisp,
		WispPackageURL:  "https://example.com/wisp.erofs",
	})
	if err != nil {
		t.Fatal(err)
	}
	update, err := worker.EnsureSessionEnvdRuntime(context.Background(), ACPSessionRuntime{
		SandboxBackend:     runtimeHostTypeLocalWisp,
		OuterSandboxID:     "local-outer-1",
		OuterSandboxDomain: runtimeHostTypeLocalWisp,
		RemoteBinary:       "/missing/sidecar",
		DaemonAddr:         "http://127.0.0.1:1",
		InnerSandboxID:     "local-inner-1",
		InnerSandboxDomain: runtimeHostTypeLocalWisp,
	}, ACPSessionRuntimeEnsureRequest{
		SessionID:  "session_local_cached",
		Generation: 1,
		Force:      false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if update.InnerSandboxID != "local-inner-1" || update.InnerSandboxDomain != runtimeHostTypeLocalWisp || update.InnerEnvdAccessToken != localRuntimeHostToken {
		t.Fatalf("unexpected cached update: %+v", update)
	}
}

func TestLocalRuntimeHostLinuxCommandPrefixE2E(t *testing.T) {
	if os.Getenv("CLOUDAGENT_LOCAL_RUNTIME_HOST_LINUX_E2E") != "1" {
		t.Skip("set CLOUDAGENT_LOCAL_RUNTIME_HOST_LINUX_E2E=1")
	}
	root := os.Getenv("CLOUDAGENT_LOCAL_LINUX_SHARED_ROOT")
	if root == "" {
		root = t.TempDir()
	}
	prefix := os.Getenv("CLOUDAGENT_LOCAL_LINUX_COMMAND_PREFIX")
	if prefix == "" {
		t.Fatal("CLOUDAGENT_LOCAL_LINUX_COMMAND_PREFIX is required")
	}
	host, err := NewLocalRuntimeHost(LocalRuntimeHostConfig{
		Root:           root,
		CommandPrefix:  prefix,
		AllowHostPaths: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	target, err := host.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "local-linux"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := host.RunCommand(context.Background(), target, "uname -s", nil, nil, nil)
	if err != nil {
		t.Fatalf("run uname through local linux prefix: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	if strings.TrimSpace(result.Stdout) != "Linux" {
		t.Fatalf("runtime command prefix must execute on Linux, got stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
	filePath := filepath.Join(root, "local-linux-e2e.txt")
	if err := host.UploadFile(context.Background(), target, filePath, "local-linux-e2e.txt", []byte("cloudagent-local-linux-e2e")); err != nil {
		t.Fatal(err)
	}
	result, err = host.RunCommand(context.Background(), target, "cat "+shellQuote(filePath), nil, nil, nil)
	if err != nil {
		t.Fatalf("read uploaded file through linux prefix: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	if strings.TrimSpace(result.Stdout) != "cloudagent-local-linux-e2e" {
		t.Fatalf("linux runtime did not see uploaded content: stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
	result, err = host.RunCommand(context.Background(), target, "printf '%s' \"$CLOUDAGENT_LOCAL_E2E_ENV\"", map[string]string{
		"CLOUDAGENT_LOCAL_E2E_ENV": "remote-env-ok",
	}, nil, nil)
	if err != nil {
		t.Fatalf("read propagated env through linux prefix: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	if result.Stdout != "remote-env-ok" {
		t.Fatalf("linux runtime did not receive command env: stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
	targetFile := filepath.Join(root, "targets", target.ID, "linux-target-root.txt")
	result, err = host.RunCommand(context.Background(), target, "mkdir -p \"$CLOUDAGENT_LOCAL_TARGET_ROOT\" && printf linux-target-root-ok > \"$CLOUDAGENT_LOCAL_TARGET_ROOT/linux-target-root.txt\"", nil, nil, nil)
	if err != nil {
		t.Fatalf("write target-root file through linux prefix: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	data, err := os.ReadFile(targetFile)
	if err != nil {
		t.Fatalf("host could not see linux-created target-root file: %v", err)
	}
	if string(data) != "linux-target-root-ok" {
		t.Fatalf("target-root file content=%q", string(data))
	}

	remoteLeakMarker := filepath.Join(root, "local-linux-timeout-leak.txt")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	result, err = host.RunCommand(ctx, target, "(sleep 0.25; printf leaked > "+shellQuote(remoteLeakMarker)+") & wait", nil, nil, nil)
	if err == nil {
		t.Fatalf("expected linux prefix timeout failure, got result=%#v", result)
	}
	time.Sleep(500 * time.Millisecond)
	if data, err := os.ReadFile(remoteLeakMarker); err == nil {
		t.Fatalf("linux prefix timeout left remote command running, marker=%q", string(data))
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read linux timeout marker: %v", err)
	}

	daemonMarker := filepath.Join(root, "local-linux-background-survives.txt")
	result, err = host.RunCommand(context.Background(), target, "(sleep 0.2; printf daemon-ok > "+shellQuote(daemonMarker)+") &", nil, nil, nil)
	if err != nil {
		t.Fatalf("start linux prefix background command: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	time.Sleep(500 * time.Millisecond)
	data, err = os.ReadFile(daemonMarker)
	if err != nil {
		t.Fatalf("linux prefix normal background command did not survive command exit: %v", err)
	}
	if string(data) != "daemon-ok" {
		t.Fatalf("linux prefix background marker=%q", string(data))
	}
}

func sameFilesystemPathForTest(t *testing.T, got, want string) bool {
	t.Helper()
	got = strings.TrimSpace(got)
	want = strings.TrimSpace(want)
	if got == want {
		return true
	}
	realGot, gotErr := filepath.EvalSymlinks(got)
	realWant, wantErr := filepath.EvalSymlinks(want)
	if gotErr != nil || wantErr != nil {
		return false
	}
	realGot, gotErr = filepath.Abs(realGot)
	realWant, wantErr = filepath.Abs(realWant)
	return gotErr == nil && wantErr == nil && realGot == realWant
}
