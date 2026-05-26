package wrapper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"unicode/utf8"
)

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
	command := sidecarPlainCommand(
		runtime.RemoteBinary,
		"client",
		"--addr",
		runtime.DaemonAddr,
		"workspace-file-upload",
		"--path-b64",
		base64.StdEncoding.EncodeToString([]byte(target)),
		"--content-b64",
		base64.StdEncoding.EncodeToString(content),
	)
	result, err := w.runOuterCommand(ctx, backend.client, runtimeOuterSandbox(runtime), runtime, command, nil, nil, nil)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("workspace upload failed exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
	}
	return nil
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
		return nil, fmt.Errorf("workspace download failed exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
	}
	var out struct {
		OK         bool   `json:"ok"`
		ContentB64 string `json:"content_b64"`
	}
	if err := json.Unmarshal([]byte(lastJSONLine(result.Stdout)), &out); err != nil {
		return nil, fmt.Errorf("workspace download returned invalid JSON: %w", err)
	}
	if !out.OK {
		return nil, fmt.Errorf("workspace download returned ok=false")
	}
	decoded, err := base64.StdEncoding.DecodeString(out.ContentB64)
	if err != nil {
		return nil, fmt.Errorf("workspace download returned invalid base64: %w", err)
	}
	return decoded, nil
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
