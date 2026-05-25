package wrapper

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestReadConnectCommandStream(t *testing.T) {
	var body bytes.Buffer
	writeConnectJSON(t, &body, map[string]any{"event": map[string]any{"start": map[string]any{"pid": 123}}}, 0)
	writeConnectJSON(t, &body, map[string]any{"event": map[string]any{"data": map[string]any{"stdout": base64.StdEncoding.EncodeToString([]byte("hello "))}}}, 0)
	writeConnectJSON(t, &body, map[string]any{"event": map[string]any{"data": map[string]any{"stderr": base64.StdEncoding.EncodeToString([]byte("warn\n"))}}}, 0)
	writeConnectJSON(t, &body, map[string]any{"event": map[string]any{"data": map[string]any{"stdout": base64.StdEncoding.EncodeToString([]byte("world\n"))}}}, 0)
	writeConnectJSON(t, &body, map[string]any{"event": map[string]any{"end": map[string]any{"exitCode": 0, "exited": true, "status": "done"}}}, 0)
	writeConnectJSON(t, &body, map[string]any{}, 0b00000010)

	var stdoutChunks []string
	var stderrChunks []string
	result, err := readConnectCommandStream(&body, func(text string) error {
		stdoutChunks = append(stdoutChunks, text)
		return nil
	}, func(text string) error {
		stderrChunks = append(stderrChunks, text)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Stdout != "hello world\n" {
		t.Fatalf("stdout=%q", result.Stdout)
	}
	if result.Stderr != "warn\n" {
		t.Fatalf("stderr=%q", result.Stderr)
	}
	if result.ExitCode != 0 || !result.Exited {
		t.Fatalf("result=%#v", result)
	}
	if strings.Join(stdoutChunks, "") != result.Stdout {
		t.Fatalf("stdout chunks=%#v", stdoutChunks)
	}
	if strings.Join(stderrChunks, "") != result.Stderr {
		t.Fatalf("stderr chunks=%#v", stderrChunks)
	}
}

func TestAGSClientCreateSandboxUsesE2BShape(t *testing.T) {
	var gotPath string
	var gotAPIKey string
	var gotBody map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAPIKey = r.Header.Get("X-API-Key")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"templateID":      "tmpl",
			"sandboxID":       "sb_mock",
			"envdVersion":     "0.2.10",
			"envdAccessToken": "envd_token",
			"domain":          "mock.example",
		})
	}))
	defer api.Close()

	client, err := NewAGSClient(AGSClientConfig{
		Domain:     "ap-beijing.tencentags.com",
		APIURL:     api.URL,
		APIKey:     "key",
		HTTPClient: api.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	sb, err := client.CreateSandbox(context.Background(), CreateSandboxOptions{
		TemplateID:          "tmpl",
		TimeoutSeconds:      120,
		Secure:              true,
		AllowInternetAccess: true,
		Metadata:            map[string]string{"response_id": "resp_1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/sandboxes" {
		t.Fatalf("path=%s", gotPath)
	}
	if gotAPIKey != "key" {
		t.Fatalf("api key header=%q", gotAPIKey)
	}
	if gotBody["templateID"] != "tmpl" || gotBody["autoPause"] != false || gotBody["secure"] != true {
		t.Fatalf("body=%#v", gotBody)
	}
	if sb.SandboxID != "sb_mock" || sb.EnvdAccessToken != "envd_token" || sb.Domain != "mock.example" {
		t.Fatalf("sandbox=%#v", sb)
	}
}

func TestAGSClientDeleteSandboxTreatsStoppedAsDeleted(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/sandboxes/sb_stopped" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"message": "[UnsupportedOperation.SandboxInstance] Instance sb_stopped is in STOPPED state, only RUNNING, PAUSING, PAUSED, PAUSE_FAILED, RESUME_FAILED, STOPPING_FAILED or FAILED instances can be stopped",
		})
	}))
	defer api.Close()

	client, err := NewAGSClient(AGSClientConfig{
		Domain:     "ap-beijing.tencentags.com",
		APIURL:     api.URL,
		APIKey:     "key",
		HTTPClient: api.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteSandbox(context.Background(), "sb_stopped"); err != nil {
		t.Fatalf("DeleteSandbox returned %v", err)
	}
}

func TestAGSClientDeleteSandboxReturnsUnexpectedError(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"message": "[InvalidParameter] bad sandbox id",
		})
	}))
	defer api.Close()

	client, err := NewAGSClient(AGSClientConfig{
		Domain:     "ap-beijing.tencentags.com",
		APIURL:     api.URL,
		APIKey:     "key",
		HTTPClient: api.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteSandbox(context.Background(), "sb_bad"); err == nil {
		t.Fatal("DeleteSandbox returned nil")
	}
}

func TestAGSClientAuthErrorIncludesOperationContext(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code":    "AUTHENTICATION_FAILED",
			"message": "Authentication failed",
		})
	}))
	defer api.Close()

	client, err := NewAGSClient(AGSClientConfig{
		Domain:     "ap-beijing.tencentags.com",
		APIURL:     api.URL,
		APIKey:     "key",
		HTTPClient: api.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.CreateSandbox(context.Background(), CreateSandboxOptions{TemplateID: "tmpl"})
	if err == nil {
		t.Fatal("CreateSandbox returned nil")
	}
	message := err.Error()
	for _, want := range []string{
		"ags http 401",
		"op=create_sandbox",
		"template_id=tmpl",
		"domain=ap-beijing.tencentags.com",
		"AUTHENTICATION_FAILED",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("error %q missing %q", message, want)
		}
	}
}

func TestAGSClientLiveCreateRunDeleteIntegration(t *testing.T) {
	client, template := liveAGSClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	sb, err := client.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:          template,
		TimeoutSeconds:      300,
		Secure:              true,
		AllowInternetAccess: true,
		Metadata:            map[string]string{"test": "go-client"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer deleteCancel()
		if err := client.DeleteSandbox(deleteCtx, sb.SandboxID); err != nil {
			t.Logf("delete sandbox: %v", err)
		}
	}()
	result, err := client.RunCommand(ctx, sb, `python3 - <<'PY'
print("ags-go-ok", flush=True)
PY`, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Stdout, "ags-go-ok") {
		t.Fatalf("stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
}

func TestAgentSidecarWorkerRunsSidecarBinaryDirectly(t *testing.T) {
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:          &AGSClient{apiKey: "test", domain: "example.com"},
		OuterTemplateID: "outer-template",
		InnerTemplateID: "inner-template",
		SidecarURL:      "https://example.com/hermes-sidecar",
		SidecarSHA256:   "54ecc6642308b8fb71bb5b856d801c2f1da03ec47d0052bdbbaf44a821c8ba81",
		TokenHubAPIKey:  "tokenhub-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	command := worker.sidecarCommand("/tmp/hermes-sidecar")
	if strings.Contains(command, "python3 ") {
		t.Fatalf("sidecar command must not use python runner: %s", command)
	}
	if !strings.Contains(command, "/tmp/hermes-sidecar") {
		t.Fatalf("expected binary path in command: %s", command)
	}
	if !strings.Contains(command, "sha256sum -c -") {
		t.Fatalf("expected sidecar sha256 verification in command: %s", command)
	}
}

func TestAgentSidecarWorkerUsesLoaderForSignedArtifact(t *testing.T) {
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:          &AGSClient{apiKey: "test", domain: "example.com"},
		OuterTemplateID: "outer-template",
		InnerTemplateID: "inner-template",
		SidecarURL:      "https://example.com/hermes-sidecar",
		SidecarSHA256:   "54ecc6642308b8fb71bb5b856d801c2f1da03ec47d0052bdbbaf44a821c8ba81",
		AgentLoaderPath: "/usr/local/bin/cloudagent-agent-loader",
		TokenHubAPIKey:  "tokenhub-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	artifact := worker.defaultSidecarArtifact()
	artifact.SigURL = "https://example.com/hermes-sidecar.sig"
	artifact.SigningKeyID = "cloudagent-agent-release-v1"
	command := sidecarLoaderCommand(worker.agentLoaderPath, "/tmp/hermes-sidecar", artifact, "daemon", "--addr", "127.0.0.1:38000")
	for _, want := range []string{"/usr/local/bin/cloudagent-agent-loader", "--sig-url", "--key-id", "cloudagent-agent-release-v1", "daemon", "--addr"} {
		if !strings.Contains(command, want) {
			t.Fatalf("expected %q in command: %s", want, command)
		}
	}
}

func writeConnectJSON(t *testing.T, w io.Writer, value any, flags byte) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(connectEnvelope(raw, flags)); err != nil {
		t.Fatal(err)
	}
}

func liveAGSClient(t *testing.T) (*AGSClient, string) {
	t.Helper()
	if os.Getenv("AGS_INTEGRATION") != "1" {
		t.Skip("set AGS_INTEGRATION=1 to run live AGS tests")
	}
	apiKey := firstEnv("GATEWAY_AGS_API_KEY", "E2B_API_KEY")
	if apiKey == "" {
		t.Skip("set E2B_API_KEY or GATEWAY_AGS_API_KEY")
	}
	template := firstEnv("GATEWAY_AGS_TEMPLATE", "INNER_SANDBOX_TEMPLATE", "E2B_TEMPLATE")
	if template == "" {
		t.Skip("set GATEWAY_AGS_TEMPLATE or INNER_SANDBOX_TEMPLATE")
	}
	client, err := NewAGSClient(AGSClientConfig{
		APIKey:         apiKey,
		Domain:         firstEnv("GATEWAY_AGS_DOMAIN", "E2B_DOMAIN"),
		APIURL:         firstEnv("GATEWAY_AGS_API_URL", "E2B_API_URL"),
		RequestTimeout: 120 * time.Second,
		HTTPClient:     &http.Client{Timeout: 120 * time.Second},
	})
	if err != nil {
		t.Fatal(err)
	}
	return client, template
}
