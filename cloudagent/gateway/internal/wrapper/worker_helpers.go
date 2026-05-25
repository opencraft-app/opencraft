package wrapper

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type remoteInputFile struct {
	FileID     string `json:"file_id"`
	Filename   string `json:"filename"`
	RemotePath string `json:"remote_path"`
	SHA256     string `json:"sha256"`
}

type agentRunEnvelope struct {
	OutputText           string `json:"output_text"`
	InnerSandboxID       string `json:"inner_sandbox_id"`
	InnerSandboxDomain   string `json:"inner_sandbox_domain"`
	InnerEnvdAccessToken string `json:"inner_envd_access_token"`
}

func parseAgentOutput(stdout string) string {
	envelope, ok := parseAgentRunEnvelope(stdout)
	if ok {
		return envelope.OutputText
	}
	return strings.TrimSpace(stdout)
}

func marshalInputManifest(inputs []remoteInputFile) (string, error) {
	raw, err := json.Marshal(inputs)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func logRemoteStderr(start time.Time, job workerJob, text string) {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fmt.Fprintf(
			os.Stderr,
			"timeline source=outer_stderr t=%.3fs event=stderr job_id=%s response_id=%s message=%s\n",
			time.Since(start).Seconds(),
			job.JobID,
			job.ResponseID,
			quoteTimelineField(line),
		)
	}
}

func quoteTimelineField(value string) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

func uploadWorkerInputs(ctx context.Context, client *AGSClient, sb AGSSandbox, job workerJob) ([]remoteInputFile, error) {
	out := make([]remoteInputFile, 0, len(job.InputFiles))
	for _, input := range job.InputFiles {
		content, err := os.ReadFile(input.Path)
		if err != nil {
			return nil, err
		}
		remotePath := path.Join("/tmp/gateway", job.JobID, "inputs", sanitizeRemoteName(input.Filename))
		if err := client.UploadFile(ctx, sb, remotePath, input.Filename, content); err != nil {
			return nil, err
		}
		out = append(out, remoteInputFile{
			FileID:     input.FileID,
			Filename:   input.Filename,
			RemotePath: remotePath,
			SHA256:     input.SHA256,
		})
	}
	return out, nil
}

func writeWorkerArtifact(content []byte) (string, error) {
	path := filepath.Join(os.TempDir(), "ags-worker-"+randomHex(10)+".artifact")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	var parsed int
	if _, err := fmt.Sscanf(value, "%d", &parsed); err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func envDurationSeconds(key string, fallback time.Duration) time.Duration {
	value := envInt(key, 0)
	if value <= 0 {
		return fallback
	}
	return time.Duration(value) * time.Second
}
