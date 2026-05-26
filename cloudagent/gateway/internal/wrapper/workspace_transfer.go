package wrapper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httputil"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"
)

type workspaceFileDownloadCommandResponse struct {
	OK         bool   `json:"ok"`
	ContentB64 string `json:"content_b64"`
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
	out, err := parseWorkspaceFileDownloadCommandResponse(result.Stdout)
	if err != nil {
		return nil, fmt.Errorf("workspace download returned invalid JSON: %w stdout_tail=%q", err, commandOutputTail(result.Stdout, 800))
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
