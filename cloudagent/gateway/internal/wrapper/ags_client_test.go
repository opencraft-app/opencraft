package wrapper

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
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

func TestSandboxAPIAuthHeaderUsesTalosTokenPrefix(t *testing.T) {
	tests := []struct {
		name   string
		key    string
		header string
		want   string
		absent []string
	}{
		{
			name:   "team key",
			key:    "talos_team",
			header: "X-API-Key",
			want:   "talos_team",
			absent: []string{"Authorization", "X-Admin-Token"},
		},
		{
			name:   "personal token",
			key:    "sk_talos_personal",
			header: "Authorization",
			want:   "Bearer sk_talos_personal",
			absent: []string{"X-API-Key", "X-Admin-Token"},
		},
		{
			name:   "admin token",
			key:    "admin_talos_admin",
			header: "X-Admin-Token",
			want:   "admin_talos_admin",
			absent: []string{"Authorization", "X-API-Key"},
		},
		{
			name:   "ags key",
			key:    "ags_key",
			header: "X-API-Key",
			want:   "ags_key",
			absent: []string{"Authorization", "X-Admin-Token"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, "https://example.test", nil)
			if err != nil {
				t.Fatal(err)
			}
			applySandboxAPIAuth(req, tt.key)
			if got := req.Header.Get(tt.header); got != tt.want {
				t.Fatalf("%s=%q, want %q", tt.header, got, tt.want)
			}
			for _, header := range tt.absent {
				if got := req.Header.Get(header); got != "" {
					t.Fatalf("%s should be absent, got %q", header, got)
				}
			}
		})
	}
}

func TestTalosDataAuthUsesSandboxAccessTokenWithoutBasicOrUsername(t *testing.T) {
	client := &AGSClient{apiKey: "talos_team", domain: "api.talos.ren", envdUser: "user"}
	sb := AGSSandbox{SandboxID: "sandbox", EnvdAccessToken: "envd-token"}
	req, err := http.NewRequest(http.MethodPost, "https://example.test", nil)
	if err != nil {
		t.Fatal(err)
	}
	client.applyDataAuth(req, sb)
	if got := req.Header.Get("X-Access-Token"); got != "envd-token" {
		t.Fatalf("X-Access-Token=%q, want sandbox access token", got)
	}
	if got := req.Header.Get("X-API-Key"); got != "" {
		t.Fatalf("X-API-Key should be absent for Talos data plane when sandbox access token is available, got %q", got)
	}
	if got := req.Header.Get("Authorization"); got != "" {
		t.Fatalf("Authorization should be absent for Talos team-key data plane, got %q", got)
	}
	if got := client.fileURL(sb, "/tmp/a.txt"); strings.Contains(got, "username=") {
		t.Fatalf("Talos file URL should not include envd username: %s", got)
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

func TestAGSClientRefreshSandboxTimeoutUsesE2BShape(t *testing.T) {
	var gotPath string
	var gotAPIKey string
	var gotBody map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAPIKey = r.Header.Get("X-API-Key")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusNoContent)
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
	if err := client.RefreshSandboxTimeout(context.Background(), "sb_keepalive", 300); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/sandboxes/sb_keepalive/timeout" {
		t.Fatalf("path=%s", gotPath)
	}
	if gotAPIKey != "key" {
		t.Fatalf("api key header=%q", gotAPIKey)
	}
	if gotBody["timeout"] != float64(300) {
		t.Fatalf("body=%#v", gotBody)
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

func TestAGSClientLiveFileUploadDownloadIntegration(t *testing.T) {
	client, template := liveAGSClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	sb, err := client.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:          template,
		TimeoutSeconds:      300,
		Secure:              false,
		AllowInternetAccess: true,
		Metadata:            map[string]string{"test": "go-client-file"},
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

	remotePath := "/tmp/cloudagent-talos-file-roundtrip.txt"
	body := []byte("cloudagent-talos-file-roundtrip-" + strings.ReplaceAll(sb.SandboxID, "-", "") + "\n")
	if err := client.UploadFile(ctx, sb, remotePath, "cloudagent-talos-file-roundtrip.txt", body); err != nil {
		t.Fatalf("upload file: %v", err)
	}
	got, err := client.DownloadFile(ctx, sb, remotePath)
	if err != nil {
		t.Fatalf("download file: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("downloaded body mismatch: want=%q got=%q", string(body), string(got))
	}
	result, err := client.RunCommand(ctx, sb, "cat "+shellQuote(remotePath), nil, nil, nil)
	if err != nil {
		t.Fatalf("cat uploaded file: %v", err)
	}
	if !strings.Contains(result.Stdout, string(bytes.TrimSpace(body))) {
		t.Fatalf("cat stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
}

func TestTalosClientLiveCreateRunFileDeleteIntegration(t *testing.T) {
	client, template := liveTalosClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	sb, err := client.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:          template,
		TimeoutSeconds:      300,
		Secure:              false,
		AllowInternetAccess: true,
		Metadata:            map[string]string{"test": "talos-go-client-file"},
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

	remotePath := "/tmp/cloudagent-talos-direct-roundtrip.txt"
	body := []byte("cloudagent-talos-direct-roundtrip-" + strings.ReplaceAll(sb.SandboxID, "-", "") + "\n")
	if err := client.UploadFile(ctx, sb, remotePath, "cloudagent-talos-direct-roundtrip.txt", body); err != nil {
		t.Fatalf("upload file: %v", err)
	}
	got, err := client.DownloadFile(ctx, sb, remotePath)
	if err != nil {
		t.Fatalf("download file: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("downloaded body mismatch: want=%q got=%q", string(body), string(got))
	}
	result, err := client.RunCommand(ctx, sb, "cat "+shellQuote(remotePath), nil, nil, nil)
	if err != nil {
		t.Fatalf("cat uploaded file: %v", err)
	}
	if !strings.Contains(result.Stdout, string(bytes.TrimSpace(body))) {
		t.Fatalf("cat stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
}

func TestAGSClientLiveSandboxPortProxyIntegration(t *testing.T) {
	client, template := liveAGSClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	sb, err := client.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:          template,
		TimeoutSeconds:      300,
		Secure:              true,
		AllowInternetAccess: true,
		Metadata:            map[string]string{"test": "go-client-port-proxy"},
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

	const port = 19091
	prestarted := strings.EqualFold(os.Getenv("AGS_PORT_PROXY_PRESTARTED"), "1")
	marker := "ags-port-proxy-ok-19091"
	externalPath := "/"
	if prestarted {
		marker = "Directory listing"
	}
	if configured := strings.TrimSpace(os.Getenv("AGS_PORT_PROXY_MARKER")); configured != "" {
		marker = configured
	}
	if configured := strings.TrimSpace(os.Getenv("AGS_PORT_PROXY_PATH")); configured != "" {
		externalPath = configured
	}
	if !prestarted {
		result, err := client.RunCommand(ctx, sb, `cat >/tmp/cloudagent-port-proxy-smoke.py <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"ags-port-proxy-ok-19091\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, format, *args):
        return

ThreadingHTTPServer(("0.0.0.0", 19091), Handler).serve_forever()
PY
nohup python3 /tmp/cloudagent-port-proxy-smoke.py >/tmp/cloudagent-port-proxy-smoke.log 2>&1 &
`, nil, nil, nil)
		if err != nil {
			t.Fatalf("start sandbox service: %v stdout=%q stderr=%q", err, result.Stdout, result.Stderr)
		}
	}
	time.Sleep(2 * time.Second)
	localCheck, err := client.RunCommand(ctx, sb, `python3 - <<'PY'
import urllib.request
print(urllib.request.urlopen("http://127.0.0.1:19091/", timeout=3).read().decode(), end="")
PY
`, nil, nil, nil)
	if err != nil {
		diagnostic, diagErr := client.RunCommand(ctx, sb, `echo '--- proc tcp ---'; cat /proc/net/tcp || true; echo '--- log ---'; cat /tmp/cloudagent-port-proxy-smoke.log || true`, nil, nil, nil)
		if diagErr != nil {
			t.Logf("diagnostic failed: %v", diagErr)
		} else {
			t.Logf("diagnostic stdout=%s stderr=%s", diagnostic.Stdout, diagnostic.Stderr)
		}
		t.Fatalf("sandbox service is not reachable inside sandbox: %v stdout=%q stderr=%q", err, localCheck.Stdout, localCheck.Stderr)
	}
	if !strings.Contains(localCheck.Stdout, marker) {
		t.Fatalf("sandbox local service returned stdout=%q stderr=%q", localCheck.Stdout, localCheck.Stderr)
	}
	t.Logf("sandbox local service reachable: %s", strings.TrimSpace(localCheck.Stdout))

	endpoint := fmt.Sprintf("https://%d-%s.%s%s", port, sb.SandboxID, sandboxDomain(sb, client.domain), externalPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	if sb.EnvdAccessToken != "" {
		req.Header.Set("X-Access-Token", sb.EnvdAccessToken)
	}
	if sb.TrafficAccessToken != "" {
		req.Header.Set("e2b-traffic-access-token", sb.TrafficAccessToken)
		q := req.URL.Query()
		q.Set("access_token", sb.TrafficAccessToken)
		req.URL.RawQuery = q.Encode()
	}
	deadline := time.Now().Add(60 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := client.httpClient.Do(req.Clone(ctx))
		if err == nil {
			body, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK && strings.Contains(string(body), marker) {
				return
			}
			if readErr != nil {
				lastErr = readErr
			} else {
				lastErr = fmt.Errorf("status=%d body=%q", resp.StatusCode, string(body))
			}
		} else {
			lastErr = err
		}
		time.Sleep(time.Second)
	}
	diagnostic, diagErr := client.RunCommand(ctx, sb, `echo '--- proc tcp ---'; cat /proc/net/tcp || true; echo '--- log ---'; cat /tmp/cloudagent-port-proxy-smoke.log || true`, nil, nil, nil)
	if diagErr != nil {
		t.Logf("diagnostic failed: %v", diagErr)
	} else {
		t.Logf("diagnostic stdout=%s stderr=%s", diagnostic.Stdout, diagnostic.Stderr)
	}
	t.Fatalf("sandbox port proxy did not become reachable at %s: %v", req.URL.String(), lastErr)
}

func TestAgentSidecarWorkerRunsResponseThroughRuntimeSession(t *testing.T) {
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
	command, err := worker.responseRuntimeCommand(
		"/tmp/hermes-sidecar",
		worker.defaultSidecarArtifact(),
		agentSidecarBackend{
			name:            "default",
			client:          &AGSClient{envdUser: "user"},
			outerTemplateID: "outer-template",
			innerTemplateID: "inner-template",
		},
		workerJob{JobID: "job_1", ResponseID: "resp_1", Instruction: "hello"},
		sidecarStageFilesManifest{SessionID: "response_resp_1", WorkspaceRoot: acpRuntimeCWD},
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(command, "python3 /tmp/hermes-sidecar") || strings.Contains(command, "python /tmp/hermes-sidecar") {
		t.Fatalf("sidecar command must execute the sidecar binary directly, not through a python runner: %s", command)
	}
	if !strings.Contains(command, "/tmp/hermes-sidecar") {
		t.Fatalf("expected binary path in command: %s", command)
	}
	for _, want := range []string{"daemon", "session-create", "session-input", "--session-id", "response_resp_1"} {
		if !strings.Contains(command, want) {
			t.Fatalf("expected %q in runtime command: %s", want, command)
		}
	}
	if strings.Contains(command, "&& exit 0") {
		t.Fatalf("inline health check must not exit before session-input: %s", command)
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

func liveTalosClient(t *testing.T) (*AGSClient, string) {
	t.Helper()
	if os.Getenv("TALOS_INTEGRATION") != "1" {
		t.Skip("set TALOS_INTEGRATION=1 to run live Talos tests")
	}
	apiKey := firstEnv("GATEWAY_TALOS_API_KEY", "TALOS_API_KEY")
	if apiKey == "" {
		t.Skip("set GATEWAY_TALOS_API_KEY or TALOS_API_KEY")
	}
	template := firstNonEmpty(firstEnv("GATEWAY_TALOS_TEMPLATE", "TALOS_TEMPLATE"), defaultTalosTemplateID)
	client, err := NewAGSClient(AGSClientConfig{
		APIKey:         apiKey,
		Domain:         firstNonEmpty(firstEnv("GATEWAY_TALOS_DOMAIN", "TALOS_DOMAIN"), "api.talos.ren"),
		APIURL:         firstNonEmpty(firstEnv("GATEWAY_TALOS_API_URL", "TALOS_API_URL"), "https://api.talos.ren"),
		RequestTimeout: 120 * time.Second,
		HTTPClient:     &http.Client{Timeout: 120 * time.Second},
	})
	if err != nil {
		t.Fatal(err)
	}
	return client, template
}
