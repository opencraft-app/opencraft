package wrapper

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type envdProxyRuntimeManager struct {
	recordingACPRuntimeManager
	innerDomains []string
	innerDomain  string
	mu           sync.Mutex
	ensures      int
	forceCalls   []bool
	lastRuntime  ACPSessionRuntime
	workspace    map[string][]byte
}

func (m *envdProxyRuntimeManager) StartSessionRuntime(ctx context.Context, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	if strings.TrimSpace(req.OuterRuntime) == "" {
		req.OuterRuntime = outerRuntimeAGS
	}
	return m.recordingACPRuntimeManager.StartSessionRuntime(ctx, req)
}

func (m *envdProxyRuntimeManager) EnsureSessionEnvdRuntime(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimeEnsureRequest) (ACPSessionRuntimeUpdate, error) {
	m.mu.Lock()
	m.ensures++
	m.forceCalls = append(m.forceCalls, req.Force)
	m.lastRuntime = runtime
	domain := m.innerDomain
	if len(m.innerDomains) > 0 {
		domain = m.innerDomains[0]
		m.innerDomains = m.innerDomains[1:]
	}
	m.mu.Unlock()
	return ACPSessionRuntimeUpdate{
		InnerSandboxID:       "inner_1",
		InnerSandboxDomain:   domain,
		InnerEnvdAccessToken: "inner-token",
	}, nil
}

func (m *envdProxyRuntimeManager) UploadSessionWorkspaceFile(ctx context.Context, runtime ACPSessionRuntime, remotePath string, content []byte) error {
	normalized, err := normalizeWorkspaceTransferPath(remotePath)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.workspace == nil {
		m.workspace = map[string][]byte{}
	}
	m.workspace[normalized] = append([]byte(nil), content...)
	return nil
}

func (m *envdProxyRuntimeManager) DownloadSessionWorkspaceFile(ctx context.Context, runtime ACPSessionRuntime, remotePath string) ([]byte, error) {
	normalized, err := normalizeWorkspaceTransferPath(remotePath)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	content, ok := m.workspace[normalized]
	if !ok {
		return nil, fmt.Errorf("workspace file not found: %s", normalized)
	}
	return append([]byte(nil), content...), nil
}

func TestEnvdProxyEnsuresInnerAndRewritesAuth(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	t.Setenv("GATEWAY_ENVD_USER", "env-user")

	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		if r.URL.Path != "/process.Process/Start" {
			t.Fatalf("inner path = %s", r.URL.Path)
		}
		if got := r.Header.Get("X-Access-Token"); got != "inner-token" {
			t.Fatalf("inner X-Access-Token = %q", got)
		}
		user, _, ok := r.BasicAuth()
		if !ok || user != "env-user" {
			t.Fatalf("inner basic auth user=%q ok=%t", user, ok)
		}
		query := r.URL.Query()
		if query.Get("access_token") != "" || query.Get("X-Amz-Signature") != "" {
			t.Fatalf("credential query leaked: %s", r.URL.RawQuery)
		}
		if query.Get("username") != "env-user" || query.Get("path") != "/workspace/a.txt" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "connect-body" {
			t.Fatalf("inner body = %q", string(body))
		}
		w.Header().Set("Content-Type", "application/connect+json")
		_, _ = w.Write([]byte("ok"))
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	proxyID, _ := cloudAgentResultMeta(t, result)["session_proxy_id"].(string)
	if proxyID == "" {
		t.Fatalf("session/new did not return session_proxy_id: %#v", result)
	}

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/process.Process/Start?path=/workspace/a.txt&access_token=bad&username=evil&X-Amz-Signature=sig", strings.NewReader("connect-body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = fmt.Sprintf("49983-%s.proxy.test", proxyID)
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", "application/connect+json")
	req.Header.Set("X-Access-Token", "caller-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "ok" {
		t.Fatalf("proxy response status=%d body=%q", resp.StatusCode, string(body))
	}
	if !sawInner {
		t.Fatal("inner envd was not called")
	}
	manager.mu.Lock()
	ensures := manager.ensures
	manager.mu.Unlock()
	if ensures != 1 {
		t.Fatalf("ensure calls = %d, want 1", ensures)
	}
}

func TestSessionScopedWispWorkspaceUploadUsesWorkspaceManager(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		http.Error(w, "inner envd should not receive Wisp workspace transfer", http.StatusTeapot)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/upload.txt", bytes.NewBufferString("upload-body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
	if sawInner {
		t.Fatal("Wisp workspace upload was incorrectly proxied to inner envd")
	}
	manager.mu.Lock()
	got := string(manager.workspace["/workspace/upload.txt"])
	manager.mu.Unlock()
	if got != "upload-body" {
		t.Fatalf("workspace upload body = %q", got)
	}
}

func TestSessionScopedWispWorkspaceDownloadUsesWorkspaceManager(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		http.Error(w, "inner envd should not receive Wisp workspace transfer", http.StatusTeapot)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{
		innerDomain: inner.URL,
		workspace:   map[string][]byte{"/workspace/download.txt": []byte("download-body")},
	}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/download.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "download-body" {
		t.Fatalf("status=%d body=%q", resp.StatusCode, string(body))
	}
	if sawInner {
		t.Fatal("Wisp workspace download was incorrectly proxied to inner envd")
	}
}

func TestSessionScopedWispWorkspaceDownloadMissingFileReturnsNotFound(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		http.Error(w, "inner envd should not receive Wisp workspace transfer", http.StatusTeapot)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/missing.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusNotFound || !strings.Contains(string(body), "workspace_file_not_found") {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
	if sawInner {
		t.Fatal("Wisp workspace download was incorrectly proxied to inner envd")
	}
}

func TestSessionScopedWispWorkspaceUploadOverwriteThenDownloadReturnsLatest(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		http.Error(w, "inner envd should not receive Wisp workspace transfer", http.StatusTeapot)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	for _, body := range []string{"old-body", "latest-body"} {
		req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/overwrite.txt", bytes.NewBufferString(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer test-key")
		req.Header.Set("Content-Type", "application/octet-stream")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		respBody, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("upload body=%q status=%d response=%s", body, resp.StatusCode, string(respBody))
		}
	}

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/overwrite.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "latest-body" {
		t.Fatalf("download status=%d body=%q", resp.StatusCode, string(body))
	}
	if sawInner {
		t.Fatal("Wisp workspace overwrite/download was incorrectly proxied to inner envd")
	}
}

func TestSessionScopedWispWorkspaceRelativePathNormalizesToWorkspace(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		http.Error(w, "inner envd should not receive Wisp workspace transfer", http.StatusTeapot)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=relative/upload.txt", bytes.NewBufferString("relative-body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("relative upload status=%d body=%s", resp.StatusCode, string(respBody))
	}

	req, err = http.NewRequest(http.MethodGet, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/relative/upload.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "relative-body" {
		t.Fatalf("relative download status=%d body=%q", resp.StatusCode, string(body))
	}
	manager.mu.Lock()
	got := string(manager.workspace["/workspace/relative/upload.txt"])
	manager.mu.Unlock()
	if got != "relative-body" {
		t.Fatalf("relative upload normalized content=%q", got)
	}
	if sawInner {
		t.Fatal("relative Wisp workspace transfer was incorrectly proxied to inner envd")
	}
}

func TestSessionScopedWispWorkspaceMultipartUploadUsesFilePart(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		http.Error(w, "inner envd should not receive Wisp workspace transfer", http.StatusTeapot)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("ignored", "field-value")
	part, err := writer.CreateFormFile("file", "multipart.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("multipart-body")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/multipart.txt", &body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("multipart upload status=%d body=%s", resp.StatusCode, string(respBody))
	}
	manager.mu.Lock()
	got := string(manager.workspace["/workspace/multipart.txt"])
	manager.mu.Unlock()
	if got != "multipart-body" {
		t.Fatalf("multipart upload body=%q", got)
	}
	if sawInner {
		t.Fatal("multipart Wisp workspace transfer was incorrectly proxied to inner envd")
	}
}

func TestSessionScopedWispWorkspaceMultipartUploadRejectsMissingFile(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		http.Error(w, "inner envd should not receive invalid Wisp workspace transfer", http.StatusTeapot)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("ignored", "field-value"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/missing-file-part.txt", &body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(respBody), "multipart upload missing file part") {
		t.Fatalf("missing multipart file status=%d body=%s", resp.StatusCode, string(respBody))
	}
	if sawInner {
		t.Fatal("invalid multipart Wisp workspace transfer was incorrectly proxied to inner envd")
	}
	manager.mu.Lock()
	workspaceFiles := len(manager.workspace)
	manager.mu.Unlock()
	if workspaceFiles != 0 {
		t.Fatalf("invalid multipart upload mutated workspace: files=%d", workspaceFiles)
	}
}

func TestSessionScopedWispWorkspaceUploadRejectsPathOutsideWorkspace(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		http.Error(w, "inner envd should not receive invalid Wisp workspace transfer", http.StatusTeapot)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/tmp/outside.txt", bytes.NewBufferString("outside-body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusOK || !strings.Contains(string(body), "workspace path must be under /workspace") {
		t.Fatalf("invalid workspace path status=%d body=%s", resp.StatusCode, string(body))
	}
	if sawInner {
		t.Fatal("invalid Wisp workspace upload was incorrectly proxied to inner envd")
	}
	manager.mu.Lock()
	workspaceFiles := len(manager.workspace)
	manager.mu.Unlock()
	if workspaceFiles != 0 {
		t.Fatalf("invalid workspace upload mutated workspace: files=%d", workspaceFiles)
	}
}

func TestSessionScopedWispWorkspaceDownloadRejectsPathTraversal(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		http.Error(w, "inner envd should not receive invalid Wisp workspace transfer", http.StatusTeapot)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/../etc/passwd", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusOK || !strings.Contains(string(body), "workspace path must be under /workspace") {
		t.Fatalf("path traversal download status=%d body=%s", resp.StatusCode, string(body))
	}
	if sawInner {
		t.Fatal("invalid Wisp workspace download was incorrectly proxied to inner envd")
	}
}

func TestSessionScopedWispWorkspaceTransferRejectsUnsupportedMethod(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		http.Error(w, "inner envd should not receive unsupported Wisp workspace transfer", http.StatusTeapot)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "session/new",
		"params":  map[string]any{"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodDelete, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/delete.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusMethodNotAllowed || !strings.Contains(string(body), "method_not_allowed") {
		t.Fatalf("unsupported method status=%d body=%s", resp.StatusCode, string(body))
	}
	if sawInner {
		t.Fatal("unsupported Wisp workspace transfer was incorrectly proxied to inner envd")
	}
}

func TestEnvdProxyFailsClosedWhenDomainUnset(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "")
	srv, _ := newTestServer(t, FakeWorker{OutputText: "unused"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "49983-spx-test.proxy.test"
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(body), "envd_proxy_not_configured") {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
}

func TestEnvdProxyRejectsUnsupportedHostPort(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	srv, _ := newTestServer(t, FakeWorker{OutputText: "unused"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "49983-spx-test.proxy.test:1234"
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusServiceUnavailable {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("unsupported host port was treated as envd proxy: status=%d body=%s", resp.StatusCode, string(body))
	}
}

func TestEnvdProxyRejectsMissingIdentity(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	srv, _ := newTestServer(t, FakeWorker{OutputText: "unused"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "49983-spx-missing.proxy.test"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(string(body), "identity_missing") {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
}

func TestEnvdProxyRejectsUnknownProxy(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	srv, _ := newTestServer(t, FakeWorker{OutputText: "unused"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "49983-spx-missing.proxy.test"
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusNotFound || !strings.Contains(string(body), "session_proxy_not_found") {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
}

func TestEnvdProxyRejectsScopeMismatch(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	manager := &envdProxyRuntimeManager{innerDomain: "http://127.0.0.1:1"}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"X-Tenant-ID": "tenant-a", "X-Project-ID": "project-a"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	proxyID := cloudAgentResultMeta(t, result)["session_proxy_id"].(string)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = fmt.Sprintf("49983-%s.proxy.test", proxyID)
	req.Header.Set("X-Tenant-ID", "tenant-b")
	req.Header.Set("X-Project-ID", "project-a")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusForbidden || !strings.Contains(string(body), "scope_mismatch") {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
}

func TestSessionScopedEnvdProxyForwardsFilesAPI(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		if r.URL.Path != "/files" {
			t.Fatalf("inner path = %s", r.URL.Path)
		}
		if r.URL.Query().Get("path") != "/workspace/a.txt" {
			t.Fatalf("inner query = %s", r.URL.RawQuery)
		}
		if got := r.Header.Get("X-Access-Token"); got != "inner-token" {
			t.Fatalf("inner X-Access-Token = %q", got)
		}
		user, _, ok := r.BasicAuth()
		if !ok || user != "user" {
			t.Fatalf("inner basic auth user=%q ok=%t", user, ok)
		}
		_, _ = w.Write([]byte("file-body"))
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "file-body" {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
	if !sawInner {
		t.Fatal("inner envd was not called")
	}
}

func TestSessionScopedEnvdProxyRefreshesCachedInnerRuntimeAfterIdle(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		if r.URL.Path != "/files" {
			t.Fatalf("inner path = %s", r.URL.Path)
		}
		if got := r.Header.Get("X-Access-Token"); got != "cached-token" {
			t.Fatalf("inner X-Access-Token = %q", got)
		}
		_, _ = w.Write([]byte("cached-file-body"))
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	srv.acpGate.mu.Lock()
	session := srv.acpGate.sessions[sessionID]
	idleAt := time.Now().Add(-46 * time.Second)
	session.History = append(session.History, acpHistoryEntry{Role: "user", Text: "old prompt", At: idleAt})
	session.LastRuntimeActivityAt = idleAt
	session.Runtime.InnerSandboxID = "inner_cached_1"
	session.Runtime.InnerSandboxDomain = inner.URL
	session.Runtime.InnerEnvdAccessToken = "cached-token"
	srv.acpGate.persistSession(session)
	srv.acpGate.mu.Unlock()

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "cached-file-body" {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
	if !sawInner {
		t.Fatal("inner envd was not called")
	}
	refreshes := manager.recordedRefreshes()
	if len(refreshes) != 1 || refreshes[0].InnerSandboxID != "inner_cached_1" {
		t.Fatalf("expected cached inner runtime refresh, got %#v", refreshes)
	}
	manager.mu.Lock()
	ensures := manager.ensures
	manager.mu.Unlock()
	if ensures != 0 {
		t.Fatalf("cached target should not force ensure, got ensures=%d", ensures)
	}
}

func TestSessionScopedEnvdProxySkipsRefreshWhenEnvdActivityIsRecent(t *testing.T) {
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("recent-file-body"))
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	srv.acpGate.mu.Lock()
	session := srv.acpGate.sessions[sessionID]
	session.History = append(session.History, acpHistoryEntry{Role: "user", Text: "old prompt", At: time.Now().Add(-46 * time.Second)})
	session.LastRuntimeActivityAt = time.Now().Add(-10 * time.Second)
	session.Runtime.InnerSandboxID = "inner_recent_api_1"
	session.Runtime.InnerSandboxDomain = inner.URL
	session.Runtime.InnerEnvdAccessToken = "cached-token"
	srv.acpGate.persistSession(session)
	srv.acpGate.mu.Unlock()

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
	if refreshes := manager.recordedRefreshes(); len(refreshes) != 0 {
		t.Fatalf("recent envd activity must not refresh runtime, got %#v", refreshes)
	}
}

func TestSessionScopedEnvdProxyForwardsRawFileUpload(t *testing.T) {
	var sawInner bool
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawInner = true
		if r.Method != http.MethodPost {
			t.Fatalf("inner method = %s", r.Method)
		}
		if r.URL.Path != "/files" {
			t.Fatalf("inner path = %s", r.URL.Path)
		}
		if r.URL.Query().Get("path") != "/workspace/upload.txt" {
			t.Fatalf("inner query = %s", r.URL.RawQuery)
		}
		if got := r.Header.Get("Content-Type"); !strings.HasPrefix(got, "multipart/form-data;") {
			t.Fatalf("inner content-type = %q", got)
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		body, _ := io.ReadAll(file)
		if string(body) != "upload-body" {
			t.Fatalf("inner body = %q", string(body))
		}
		_, _ = w.Write([]byte(`[{"path":"/workspace/upload.txt","name":"upload.txt","type":"file"}]`))
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/upload.txt", bytes.NewBufferString("upload-body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
	if !sawInner {
		t.Fatal("inner envd was not called")
	}
}

func TestSessionScopedEnvdProxyStripsUpstreamCORS(t *testing.T) {
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Access-Control-Allow-Origin", "http://inner.example")
		w.Header().Add("Access-Control-Expose-Headers", "Grpc-Status")
		w.Header().Add("Vary", "Origin, Accept-Encoding")
		_, _ = w.Write([]byte("file-body"))
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", nil)
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if values := resp.Header.Values("Access-Control-Allow-Origin"); len(values) != 1 || values[0] != "*" {
		t.Fatalf("allow origin values=%v", values)
	}
	if got := resp.Header.Get("Access-Control-Expose-Headers"); got != "Content-Disposition, Content-Type" {
		t.Fatalf("expose headers=%q", got)
	}
	if got := resp.Header.Values("Vary"); len(got) != 2 || got[0] != "Origin" || got[1] != "Accept-Encoding" {
		t.Fatalf("vary=%v", got)
	}
}

func TestSessionScopedEnvdProxyRejectsScopeMismatch(t *testing.T) {
	manager := &envdProxyRuntimeManager{innerDomain: "http://127.0.0.1:1"}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"X-Tenant-ID": "tenant-a", "X-Project-ID": "project-a"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/acp/sessions/"+sessionID+"/envd/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Tenant-ID", "tenant-b")
	req.Header.Set("X-Project-ID", "project-a")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusForbidden || !strings.Contains(string(body), "scope_mismatch") {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
}

func TestEnvdProxyRetriesStaleAuthOnce(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("expired"))
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok-after-retry"))
	}))
	defer second.Close()

	manager := &envdProxyRuntimeManager{innerDomains: []string{first.URL, second.URL}}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	proxyID := cloudAgentResultMeta(t, result)["session_proxy_id"].(string)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/process.Process/Start", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = fmt.Sprintf("49983-%s.proxy.test", proxyID)
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "ok-after-retry" {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
	manager.mu.Lock()
	ensures := manager.ensures
	manager.mu.Unlock()
	if ensures != 2 {
		t.Fatalf("ensure calls = %d, want 2", ensures)
	}
	if got, want := fmt.Sprint(manager.forceCalls), "[false true]"; got != want {
		t.Fatalf("force calls = %s, want %s", got, want)
	}
}

func TestEnvdProxyDoesNotRetryBodyRequest(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("expired"))
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok-after-next-request"))
	}))
	defer second.Close()

	manager := &envdProxyRuntimeManager{innerDomains: []string{first.URL, second.URL}}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	proxyID := cloudAgentResultMeta(t, result)["session_proxy_id"].(string)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/process.Process/Start", strings.NewReader("body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = fmt.Sprintf("49983-%s.proxy.test", proxyID)
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusUnauthorized || string(body) != "expired" {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
	manager.mu.Lock()
	ensures := manager.ensures
	forceCalls := fmt.Sprint(manager.forceCalls)
	manager.mu.Unlock()
	if ensures != 1 {
		t.Fatalf("ensure calls = %d, want 1", ensures)
	}
	if forceCalls != "[false]" {
		t.Fatalf("force calls = %s, want [false]", forceCalls)
	}

	nextReq, err := http.NewRequest(http.MethodPost, ts.URL+"/process.Process/Start", strings.NewReader("body"))
	if err != nil {
		t.Fatal(err)
	}
	nextReq.Host = fmt.Sprintf("49983-%s.proxy.test", proxyID)
	nextReq.Header.Set("Authorization", "Bearer test-key")
	nextResp, err := http.DefaultClient.Do(nextReq)
	if err != nil {
		t.Fatal(err)
	}
	defer nextResp.Body.Close()
	nextBody, _ := io.ReadAll(nextResp.Body)
	if nextResp.StatusCode != http.StatusOK || string(nextBody) != "ok-after-next-request" {
		t.Fatalf("next status=%d body=%s", nextResp.StatusCode, string(nextBody))
	}
	manager.mu.Lock()
	ensures = manager.ensures
	forceCalls = fmt.Sprint(manager.forceCalls)
	manager.mu.Unlock()
	if ensures != 2 {
		t.Fatalf("ensure calls after next request = %d, want 2", ensures)
	}
	if forceCalls != "[false true]" {
		t.Fatalf("force calls after next request = %s, want [false true]", forceCalls)
	}
}

func TestEnvdProxyInvalidationSurvivesGatewayRestart(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("expired"))
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok-after-restart"))
	}))
	defer second.Close()

	manager := &envdProxyRuntimeManager{innerDomains: []string{first.URL, second.URL}}
	srv := newACPTestServerWithRuntimeAndStore(store, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	proxyID := cloudAgentResultMeta(t, result)["session_proxy_id"].(string)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/process.Process/Start", strings.NewReader("body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = fmt.Sprintf("49983-%s.proxy.test", proxyID)
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", resp.StatusCode)
	}

	reloaded := newACPTestServerWithRuntimeAndStore(store, manager)
	ts2 := httptest.NewServer(reloaded.Handler())
	defer ts2.Close()
	nextReq, err := http.NewRequest(http.MethodPost, ts2.URL+"/process.Process/Start", strings.NewReader("body"))
	if err != nil {
		t.Fatal(err)
	}
	nextReq.Host = fmt.Sprintf("49983-%s.proxy.test", proxyID)
	nextReq.Header.Set("Authorization", "Bearer test-key")
	nextResp, err := http.DefaultClient.Do(nextReq)
	if err != nil {
		t.Fatal(err)
	}
	defer nextResp.Body.Close()
	nextBody, _ := io.ReadAll(nextResp.Body)
	if nextResp.StatusCode != http.StatusOK || string(nextBody) != "ok-after-restart" {
		t.Fatalf("next status=%d body=%s", nextResp.StatusCode, string(nextBody))
	}
	manager.mu.Lock()
	ensures := manager.ensures
	forceCalls := fmt.Sprint(manager.forceCalls)
	innerWasEmpty := !manager.lastRuntime.hasInnerEnvdTarget()
	manager.mu.Unlock()
	if ensures != 2 {
		t.Fatalf("ensure calls = %d, want 2", ensures)
	}
	if forceCalls != "[false false]" {
		t.Fatalf("force calls = %s, want [false false]", forceCalls)
	}
	if !innerWasEmpty {
		t.Fatal("reloaded ensure did not receive persisted empty inner envd identity")
	}
}

func TestEnvdProxyPassesThroughFilesNotFoundWithoutRetry(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/files" {
			t.Fatalf("inner path = %s", r.URL.Path)
		}
		http.NotFound(w, r)
	}))
	defer inner.Close()

	manager := &envdProxyRuntimeManager{innerDomain: inner.URL}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	proxyID := cloudAgentResultMeta(t, result)["session_proxy_id"].(string)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/files?path=/workspace/missing.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = fmt.Sprintf("49983-%s.proxy.test", proxyID)
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
	manager.mu.Lock()
	ensures := manager.ensures
	manager.mu.Unlock()
	if ensures != 1 {
		t.Fatalf("ensure calls = %d, want 1", ensures)
	}
}

func TestEnvdProxyStaleHostReturnsGone(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	manager := &envdProxyRuntimeManager{innerDomain: "http://127.0.0.1:1"}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)
	proxyID := cloudAgentResultMeta(t, result)["session_proxy_id"].(string)

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	_ = waitForRPCID(t, client, float64(2))

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = fmt.Sprintf("49983-%s.proxy.test", proxyID)
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusGone || !strings.Contains(string(body), "stale_session_proxy") {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
}

func TestEnvdProxyDeletedSessionStaysGoneAfterReload(t *testing.T) {
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "proxy.test")
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager := &envdProxyRuntimeManager{innerDomain: "http://127.0.0.1:1"}
	srv := &Server{
		store:  store,
		worker: FakeWorker{OutputText: "unused"},
		acpGate: &ACPGateway{
			store:          store,
			worker:         FakeWorker{OutputText: "unused"},
			runtimeManager: manager,
			sessions:       map[string]*acpSession{},
			cleanups:       map[string]*acpRuntimeCleanup{},
			envdEnsures:    map[string]*envdEnsureCall{},
			staleProxyIDs:  map[string]struct{}{},
		},
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	sessionID := result["sessionId"].(string)
	proxyID := cloudAgentResultMeta(t, result)["session_proxy_id"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/delete", "params": map[string]any{"sessionId": sessionID}})
	_ = waitForRPCID(t, client, float64(2))
	client.close()

	reloaded := NewServer(store, FakeWorker{OutputText: "unused"})
	ts2 := httptest.NewServer(reloaded.Handler())
	defer ts2.Close()

	req, err := http.NewRequest(http.MethodGet, ts2.URL+"/files?path=/workspace/a.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = fmt.Sprintf("49983-%s.proxy.test", proxyID)
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusGone || !strings.Contains(string(body), "stale_session_proxy") {
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(body))
	}
}
