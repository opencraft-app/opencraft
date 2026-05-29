package wrapper

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httputil"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type workspaceFileDownloadCommandResponse struct {
	OK         bool   `json:"ok"`
	ContentB64 string `json:"content_b64"`
}

type workspaceFileUploadCommandResponse struct {
	OK          bool `json:"ok"`
	InnerSynced bool `json:"inner_synced"`
}

func (w *AgentSidecarWorker) UploadSessionWorkspaceFile(ctx context.Context, runtime ACPSessionRuntime, remotePath string, content []byte) error {
	target, err := normalizeWorkspaceTransferPath(remotePath)
	if err != nil {
		return err
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	if runtime.OuterSandboxID == "" || runtime.OuterEnvdAccessToken == "" {
		return fmt.Errorf("runtime outer sandbox identity is incomplete")
	}
	tempPath := workspaceUploadContentTempPath(runtime, target, content)
	sb := runtimeOuterSandbox(runtime)
	start := time.Now()
	fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_upload_stage_start session_runtime=%s target=%q bytes=%d wisp=%t\n", runtime.RuntimeID, target, len(content), runtime.isWispOuterRuntime())
	if shouldUseWorkspaceWispTransfer(runtime) {
		workspaceSandbox, err := runtimeWorkspaceSandbox(runtime)
		if err != nil {
			return err
		}
		hostTempPath := workspaceTransferHostTempPath(runtime, "upload", target)
		if err := stageWorkspaceUploadContentOnHost(ctx, backend.client, workspaceSandbox, hostTempPath, content); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_upload_host_stage_done session_runtime=%s target=%q elapsed_ms=%d\n", runtime.RuntimeID, target, time.Since(start).Milliseconds())
		defer cleanupWorkspaceUploadHostContent(context.Background(), backend.client, workspaceSandbox, hostTempPath)
		workspaceRuntime := runtime
		workspaceRuntime.WispName = runtime.WorkspaceWispName
		workspaceRuntime.WispClientPath = ""
		if err := stageWorkspaceUploadContentIntoWisp(ctx, backend.client, workspaceSandbox, workspaceRuntime, hostTempPath, target); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_upload_workspace_wisp_done session_runtime=%s workspace_wisp=%q target=%q elapsed_ms=%d\n", runtime.RuntimeID, runtime.WorkspaceWispName, target, time.Since(start).Milliseconds())
		return nil
	}
	if runtime.isWispOuterRuntime() {
		hostTempPath := workspaceUploadHostContentTempPath(runtime, target, content)
		if err := stageWorkspaceUploadContentOnHost(ctx, backend.client, sb, hostTempPath, content); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_upload_host_stage_done session_runtime=%s target=%q elapsed_ms=%d\n", runtime.RuntimeID, target, time.Since(start).Milliseconds())
		defer cleanupWorkspaceUploadHostContent(context.Background(), backend.client, sb, hostTempPath)
		if err := stageWorkspaceUploadContentIntoWisp(ctx, backend.client, sb, runtime, hostTempPath, tempPath); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_upload_wisp_stage_done session_runtime=%s target=%q elapsed_ms=%d\n", runtime.RuntimeID, target, time.Since(start).Milliseconds())
	} else {
		if err := stageWorkspaceUploadContentOnHost(ctx, backend.client, sb, tempPath, content); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_upload_host_stage_done session_runtime=%s target=%q elapsed_ms=%d\n", runtime.RuntimeID, target, time.Since(start).Milliseconds())
	}
	command := sidecarPlainCommand(
		runtime.RemoteBinary,
		"client",
		"--addr",
		runtime.DaemonAddr,
		"workspace-file-upload",
		"--path-b64",
		base64.StdEncoding.EncodeToString([]byte(target)),
		"--content-file-b64",
		base64.StdEncoding.EncodeToString([]byte(tempPath)),
	)
	command += "; status=$?; rm -f " + shellQuote(tempPath) + "; exit $status"
	fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_upload_sidecar_start session_runtime=%s target=%q elapsed_ms=%d\n", runtime.RuntimeID, target, time.Since(start).Milliseconds())
	result, err := w.runOuterCommand(ctx, backend.client, sb, runtime, command, nil, nil, nil)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("workspace upload failed exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
	}
	var uploadResponse workspaceFileUploadCommandResponse
	if err := json.Unmarshal([]byte(strings.TrimSpace(result.Stdout)), &uploadResponse); err != nil {
		return fmt.Errorf("workspace upload returned invalid JSON stdout=%q stderr=%q: %w", result.Stdout, result.Stderr, err)
	}
	if !uploadResponse.OK {
		return fmt.Errorf("workspace upload returned ok=false stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
	if !uploadResponse.InnerSynced {
		return fmt.Errorf("workspace upload did not sync to inner workspace runtime stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_upload_sidecar_done session_runtime=%s target=%q elapsed_ms=%d\n", runtime.RuntimeID, target, time.Since(start).Milliseconds())
	return nil
}

func workspaceUploadContentTempPath(runtime ACPSessionRuntime, target string, content []byte) string {
	sessionRoot := path.Dir(runtime.RemoteBinary)
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d", target, len(content), time.Now().UnixNano())))
	name := "upload-" + hex.EncodeToString(sum[:8]) + ".bin"
	return path.Join(sessionRoot, "workspace-upload", name)
}

func workspaceUploadHostContentTempPath(runtime ACPSessionRuntime, target string, content []byte) string {
	sessionRoot := path.Dir(runtime.RemoteBinary)
	sum := sha256.Sum256([]byte(fmt.Sprintf("host:%s:%d:%d", target, len(content), time.Now().UnixNano())))
	name := "upload-" + hex.EncodeToString(sum[:8]) + ".bin"
	return path.Join(sessionRoot, "workspace-upload-host", name)
}

func stageWorkspaceUploadContentOnHost(ctx context.Context, client *AGSClient, sb AGSSandbox, tempPath string, content []byte) error {
	tempDir := path.Dir(tempPath)
	mkdirResult, err := client.RunCommand(ctx, sb, "mkdir -p "+shellQuote(tempDir), nil, nil, nil)
	if err != nil {
		return err
	}
	if mkdirResult.ExitCode != 0 {
		return fmt.Errorf("workspace upload temp dir failed exit=%d stdout=%q stderr=%q", mkdirResult.ExitCode, mkdirResult.Stdout, mkdirResult.Stderr)
	}
	if err := client.UploadFile(ctx, sb, tempPath, path.Base(tempPath), content); err != nil {
		return fmt.Errorf("workspace upload content staging failed: %w", err)
	}
	return nil
}

func stageWorkspaceRuntimeContent(ctx context.Context, client *AGSClient, runtime ACPSessionRuntime, target string, content []byte) error {
	workspaceSandbox, err := runtimeWorkspaceSandbox(runtime)
	if err != nil {
		return err
	}
	hostTempPath := workspaceTransferHostTempPath(runtime, "stage", target)
	if err := stageWorkspaceUploadContentOnHost(ctx, client, workspaceSandbox, hostTempPath, content); err != nil {
		return err
	}
	defer cleanupWorkspaceUploadHostContent(context.Background(), client, workspaceSandbox, hostTempPath)
	return stageWorkspaceUploadContentIntoWisp(ctx, client, workspaceSandbox, runtime, hostTempPath, target)
}

func stageWorkspaceUploadContentIntoWisp(ctx context.Context, client *AGSClient, sb AGSSandbox, runtime ACPSessionRuntime, hostTempPath, wispTempPath string) error {
	if strings.TrimSpace(runtime.WispClientPath) != "" {
		targetB64 := base64.StdEncoding.EncodeToString([]byte(wispTempPath))
		command := "set -euo pipefail\n" +
			"client=" + shellQuote(runtime.WispClientPath) + "\n" +
			"name=" + shellQuote(runtime.WispName) + "\n" +
			"host_temp=" + shellQuote(hostTempPath) + "\n" +
			"target_b64=" + shellQuote(targetB64) + "\n" +
			"{\n" +
			"  printf '%s\\n' 'set -euo pipefail'\n" +
			"  printf 'target=$(printf %s " + shellQuote(targetB64) + " | base64 -d)\\n'\n" +
			"  printf '%s\\n' 'mkdir -p \"$(dirname \"$target\")\"'\n" +
			"  printf '%s\\n' 'base64 -d > \"$target\" <<CLOUDAGENT_WISP_FILE_B64'\n" +
			"  base64 \"$host_temp\"\n" +
			"  printf '%s\\n' 'CLOUDAGENT_WISP_FILE_B64'\n" +
			"  printf '%s\\n' 'chmod 0644 \"$target\" || true'\n" +
			"} | \"$client\" -server " + shellQuote(defaultWispOuterAdminAddr) + " exec --stream \"$name\" -- /bin/sh >/dev/null\n" +
			"target=\"$(printf '%s' \"$target_b64\" | base64 -d)\"\n" +
			"\"$client\" -server " + shellQuote(defaultWispOuterAdminAddr) + " exec \"$name\" -- /bin/sh -lc 'test -f \"$1\" && wc -c \"$1\" >&2' sh \"$target\" >/dev/null\n" +
			"echo CLOUDAGENT_WISP_UPLOAD_STAGED\n"
		result, err := client.RunCommand(ctx, sb, command, nil, nil, func(text string) error {
			logRemoteStderr(time.Now(), workerJob{JobID: "workspace_upload_wisp_stage", ResponseID: runtime.RuntimeID}, text)
			return nil
		})
		if err != nil {
			return fmt.Errorf("workspace upload wisp shell staging failed: %w stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
		}
		if result.ExitCode != 0 || !strings.Contains(result.Stdout, "CLOUDAGENT_WISP_UPLOAD_STAGED") {
			return fmt.Errorf("workspace upload wisp shell staging failed exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
		}
		return nil
	}
	hostRootfsPath, err := wispRuntimeRootfsHostPath(runtime.WispName, wispTempPath)
	if err != nil {
		return err
	}
	command := "set -euo pipefail\n" +
		"host_temp=" + shellQuote(hostTempPath) + "\n" +
		"rootfs_temp=" + shellQuote(hostRootfsPath) + "\n" +
		"sudo -n mkdir -p \"$(dirname \"$rootfs_temp\")\"\n" +
		"sudo -n cp \"$host_temp\" \"$rootfs_temp\"\n" +
		"sudo -n chmod 0644 \"$rootfs_temp\" || true\n" +
		"sudo -n test -f \"$rootfs_temp\"\n" +
		"echo CLOUDAGENT_WISP_UPLOAD_STAGED\n"
	result, err := client.RunCommand(ctx, sb, command, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "workspace_upload_wisp_stage", ResponseID: runtime.RuntimeID}, text)
		return nil
	})
	if err != nil {
		return fmt.Errorf("workspace upload wisp staging failed: %w stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("workspace upload wisp staging failed exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
	}
	return nil
}

func wispRuntimeRootfsHostPath(wispName, runtimePath string) (string, error) {
	wispName = strings.TrimSpace(wispName)
	if wispName == "" {
		return "", fmt.Errorf("wisp runtime name is required")
	}
	if strings.Contains(wispName, "/") || strings.Contains(wispName, "..") {
		return "", fmt.Errorf("invalid wisp runtime name %q", wispName)
	}
	runtimePath = path.Clean("/" + strings.TrimSpace(runtimePath))
	if runtimePath == "/" {
		return "", fmt.Errorf("runtime path is required")
	}
	return path.Join("/var/lib/wisp-runtime", wispName, "rootfs", runtimePath), nil
}

func cleanupWorkspaceUploadHostContent(ctx context.Context, client *AGSClient, sb AGSSandbox, tempPath string) {
	if strings.TrimSpace(tempPath) == "" {
		return
	}
	_, _ = client.RunCommand(ctx, sb, "rm -f "+shellQuote(tempPath), nil, nil, nil)
}

func (w *AgentSidecarWorker) DownloadSessionWorkspaceFile(ctx context.Context, runtime ACPSessionRuntime, remotePath string) ([]byte, error) {
	target, err := normalizeWorkspaceTransferPath(remotePath)
	if err != nil {
		return nil, err
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return nil, err
	}
	if runtime.OuterSandboxID == "" || runtime.OuterEnvdAccessToken == "" {
		return nil, fmt.Errorf("runtime outer sandbox identity is incomplete")
	}
	if shouldUseWorkspaceWispTransfer(runtime) {
		workspaceSandbox, err := runtimeWorkspaceSandbox(runtime)
		if err != nil {
			return nil, err
		}
		workspaceRuntime := runtime
		workspaceRuntime.WispName = runtime.WorkspaceWispName
		workspaceRuntime.WispClientPath = ""
		return w.downloadSessionWorkspaceFileFromWisp(ctx, backend.client, workspaceSandbox, workspaceRuntime, target)
	}
	command := sidecarPlainCommand(
		runtime.RemoteBinary,
		"client",
		"--addr",
		runtime.DaemonAddr,
		"workspace-file-download",
		"--path-b64",
		base64.StdEncoding.EncodeToString([]byte(target)),
	)
	result, err := w.runOuterCommand(ctx, backend.client, runtimeOuterSandbox(runtime), runtime, command, nil, nil, nil)
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		detail := fmt.Sprintf("stdout=%q stderr=%q", result.Stdout, result.Stderr)
		if isWorkspaceFileNotFoundText(detail) {
			return nil, fmt.Errorf("workspace file not found: %s: %s", target, detail)
		}
		return nil, fmt.Errorf("workspace download failed exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
	}
	if isWorkspaceFileNotFoundText(result.Stdout) || isWorkspaceFileNotFoundText(result.Stderr) {
		return nil, fmt.Errorf("workspace file not found: %s: stdout=%q stderr=%q", target, result.Stdout, result.Stderr)
	}
	out, err := parseWorkspaceFileDownloadCommandResponse(result.Stdout)
	if err != nil {
		return nil, fmt.Errorf("workspace download returned invalid JSON: %w stdout_tail=%q", err, commandOutputTail(result.Stdout, 800))
	}
	if !out.OK {
		if isWorkspaceFileNotFoundText(result.Stdout) {
			return nil, fmt.Errorf("workspace file not found: %s", target)
		}
		return nil, fmt.Errorf("workspace download returned ok=false")
	}
	decoded, err := base64.StdEncoding.DecodeString(out.ContentB64)
	if err != nil {
		return nil, fmt.Errorf("workspace download returned invalid base64: %w", err)
	}
	return decoded, nil
}

func (w *AgentSidecarWorker) downloadSessionWorkspaceFileFromWisp(ctx context.Context, client *AGSClient, sb AGSSandbox, runtime ACPSessionRuntime, target string) ([]byte, error) {
	if strings.TrimSpace(runtime.WispClientPath) != "" {
		tempPath := workspaceTransferHostTempPath(runtime, "download", target)
		b64Path := tempPath + ".b64"
		command := "set -euo pipefail\n" +
			"client=" + shellQuote(runtime.WispClientPath) + "\n" +
			"name=" + shellQuote(runtime.WorkspaceWispName) + "\n" +
			"target=" + shellQuote(target) + "\n" +
			"host_temp=" + shellQuote(tempPath) + "\n" +
			"host_b64=" + shellQuote(b64Path) + "\n" +
			"mkdir -p \"$(dirname \"$host_temp\")\"\n" +
			"set +e\n" +
			"\"$client\" -server " + shellQuote(defaultWispOuterAdminAddr) + " exec \"$name\" -- /bin/sh -lc 'test -f \"$1\" || exit 44; base64 \"$1\"' sh \"$target\" >\"$host_b64\"\n" +
			"code=$?\n" +
			"set -e\n" +
			"if [ \"$code\" = 44 ]; then echo CLOUDAGENT_WISP_DOWNLOAD_NOT_FOUND; exit 44; fi\n" +
			"if [ \"$code\" != 0 ]; then echo CLOUDAGENT_WISP_DOWNLOAD_FAILED exit=$code >&2; exit \"$code\"; fi\n" +
			"base64 -d \"$host_b64\" >\"$host_temp\"\n" +
			"echo CLOUDAGENT_WISP_DOWNLOAD_STAGED\n"
		result, err := client.RunCommand(ctx, sb, command, nil, nil, func(text string) error {
			logRemoteStderr(time.Now(), workerJob{JobID: "workspace_download_wisp_stage", ResponseID: runtime.RuntimeID}, text)
			return nil
		})
		defer cleanupWorkspaceUploadHostContent(context.Background(), client, sb, tempPath)
		defer cleanupWorkspaceUploadHostContent(context.Background(), client, sb, b64Path)
		if err != nil {
			if result.ExitCode == 44 || strings.Contains(result.Stdout, "CLOUDAGENT_WISP_DOWNLOAD_NOT_FOUND") {
				return nil, fmt.Errorf("workspace file not found: %s", target)
			}
			return nil, fmt.Errorf("workspace download wisp shell staging failed: %w stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
		}
		if result.ExitCode == 44 || strings.Contains(result.Stdout, "CLOUDAGENT_WISP_DOWNLOAD_NOT_FOUND") {
			return nil, fmt.Errorf("workspace file not found: %s", target)
		}
		if result.ExitCode != 0 || !strings.Contains(result.Stdout, "CLOUDAGENT_WISP_DOWNLOAD_STAGED") {
			return nil, fmt.Errorf("workspace download wisp shell staging failed exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
		}
		content, err := client.DownloadFile(ctx, sb, tempPath)
		if err != nil {
			return nil, fmt.Errorf("workspace download staged content failed: %w", err)
		}
		return content, nil
	}
	hostPath, err := wispRuntimeRootfsHostPath(firstNonEmpty(runtime.WorkspaceWispName, runtime.WispName), target)
	if err != nil {
		return nil, err
	}
	tempPath := workspaceTransferHostTempPath(runtime, "download", target)
	command := "set -euo pipefail\n" +
		"rootfs_path=" + shellQuote(hostPath) + "\n" +
		"host_temp=" + shellQuote(tempPath) + "\n" +
		"if ! sudo -n test -f \"$rootfs_path\"; then echo CLOUDAGENT_WISP_DOWNLOAD_NOT_FOUND; exit 44; fi\n" +
		"sudo -n mkdir -p \"$(dirname \"$host_temp\")\"\n" +
		"sudo -n cp \"$rootfs_path\" \"$host_temp\"\n" +
		"sudo -n chmod 0644 \"$host_temp\" || true\n" +
		"echo CLOUDAGENT_WISP_DOWNLOAD_STAGED\n"
	result, err := client.RunCommand(ctx, sb, command, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "workspace_download_wisp_stage", ResponseID: runtime.RuntimeID}, text)
		return nil
	})
	defer cleanupWorkspaceUploadHostContent(context.Background(), client, sb, tempPath)
	if err != nil {
		if result.ExitCode == 44 || strings.Contains(result.Stdout, "CLOUDAGENT_WISP_DOWNLOAD_NOT_FOUND") {
			return nil, fmt.Errorf("workspace file not found: %s", target)
		}
		return nil, fmt.Errorf("workspace download wisp staging failed: %w stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
	}
	if result.ExitCode == 44 || strings.Contains(result.Stdout, "CLOUDAGENT_WISP_DOWNLOAD_NOT_FOUND") {
		return nil, fmt.Errorf("workspace file not found: %s", target)
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("workspace download wisp staging failed exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
	}
	content, err := client.DownloadFile(ctx, sb, tempPath)
	if err != nil {
		return nil, fmt.Errorf("workspace download staged content failed: %w", err)
	}
	return content, nil
}

func workspaceTransferHostTempPath(runtime ACPSessionRuntime, prefix, target string) string {
	root := firstNonEmpty(runtime.WorkspaceRuntimeID, runtime.RuntimeID, "workspace-runtime")
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d", prefix, target, time.Now().UnixNano())))
	name := prefix + "-" + hex.EncodeToString(sum[:8]) + ".bin"
	return path.Join("/tmp/cloudagent-workspace-transfer", root, name)
}

func shouldUseWorkspaceWispTransfer(runtime ACPSessionRuntime) bool {
	return runtime.isWispOuterRuntime() && strings.TrimSpace(runtime.WorkspaceWispName) != ""
}

func runtimeWorkspaceSandbox(runtime ACPSessionRuntime) (AGSSandbox, error) {
	if runtime.InnerSandboxID == "" || runtime.InnerEnvdAccessToken == "" {
		return AGSSandbox{}, fmt.Errorf("runtime inner sandbox identity is incomplete")
	}
	return AGSSandbox{
		SandboxID:       runtime.InnerSandboxID,
		Domain:          runtime.InnerSandboxDomain,
		EnvdAccessToken: runtime.InnerEnvdAccessToken,
	}, nil
}

func isWorkspaceFileNotFoundText(value string) bool {
	text := strings.ToLower(value)
	return strings.Contains(text, "workspace file not found") ||
		strings.Contains(text, "no such file or directory") ||
		strings.Contains(text, "file does not exist")
}

func parseWorkspaceFileDownloadCommandResponse(output string) (workspaceFileDownloadCommandResponse, error) {
	var lastErr error
	for _, candidate := range workspaceDownloadJSONCandidates(output) {
		var out workspaceFileDownloadCommandResponse
		if err := json.Unmarshal([]byte(candidate), &out); err != nil {
			lastErr = err
			continue
		}
		return out, nil
	}
	if lastErr != nil {
		return workspaceFileDownloadCommandResponse{}, lastErr
	}
	return workspaceFileDownloadCommandResponse{}, fmt.Errorf("no JSON object found")
}

func workspaceDownloadJSONCandidates(output string) []string {
	var candidates []string
	seen := map[string]bool{}
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			return
		}
		seen[value] = true
		candidates = append(candidates, value)
	}
	add(lastJSONLine(output))
	if decoded, ok := decodeChunkedWorkspaceCommandOutput(output); ok {
		add(lastJSONLine(decoded))
		add(decoded)
	}
	return candidates
}

func decodeChunkedWorkspaceCommandOutput(output string) (string, bool) {
	text := strings.TrimLeft(output, " \t\r\n")
	if text == "" {
		return "", false
	}
	starts := []int{0}
	for offset := 0; offset < len(text); {
		lineEnd := strings.IndexByte(text[offset:], '\n')
		if lineEnd < 0 {
			break
		}
		line := strings.TrimSpace(strings.TrimSuffix(text[offset:offset+lineEnd], "\r"))
		if isHTTPChunkSizeLine(line) {
			starts = append(starts, offset)
		}
		offset += lineEnd + 1
	}
	for _, start := range starts {
		decoded, err := io.ReadAll(httputil.NewChunkedReader(strings.NewReader(text[start:])))
		if err == nil && len(decoded) > 0 {
			return string(decoded), true
		}
	}
	return "", false
}

func isHTTPChunkSizeLine(line string) bool {
	if line == "" || len(line) > 16 {
		return false
	}
	if semi := strings.IndexByte(line, ';'); semi >= 0 {
		line = line[:semi]
	}
	if line == "" {
		return false
	}
	if _, err := strconv.ParseInt(line, 16, 64); err != nil {
		return false
	}
	for _, ch := range line {
		if (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F') {
			continue
		}
		return false
	}
	return true
}

func lastJSONLine(output string) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if strings.HasPrefix(line, "{") && strings.HasSuffix(line, "}") {
			return line
		}
	}
	return strings.TrimSpace(output)
}

func normalizeWorkspaceTransferPath(remotePath string) (string, error) {
	remotePath = strings.TrimSpace(remotePath)
	if remotePath == "" {
		return "", fmt.Errorf("workspace path is required")
	}
	if strings.ContainsRune(remotePath, '\x00') || !utf8.ValidString(remotePath) {
		return "", fmt.Errorf("workspace path is invalid")
	}
	if !strings.HasPrefix(remotePath, "/") {
		remotePath = "/workspace/" + remotePath
	}
	clean := path.Clean(remotePath)
	if clean == "/workspace" || !strings.HasPrefix(clean, "/workspace/") {
		return "", fmt.Errorf("workspace path must be under /workspace")
	}
	return clean, nil
}
