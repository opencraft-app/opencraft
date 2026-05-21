package wrapper

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type envdProxyRuntimeManager struct {
	recordingACPRuntimeManager
	innerDomains []string
	innerDomain  string
	mu           sync.Mutex
	ensures      int
	forceCalls   []bool
	lastRuntime  ACPSessionRuntime
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
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": map[string]any{}})
	result := waitForRPCID(t, client, float64(1))["result"].(map[string]any)
	proxyID, _ := result["session_proxy_id"].(string)
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
	proxyID := result["session_proxy_id"].(string)

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
	proxyID := result["session_proxy_id"].(string)

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
	proxyID := result["session_proxy_id"].(string)

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
	proxyID := result["session_proxy_id"].(string)

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
	proxyID := result["session_proxy_id"].(string)

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
	proxyID := result["session_proxy_id"].(string)

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
	proxyID := result["session_proxy_id"].(string)
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
