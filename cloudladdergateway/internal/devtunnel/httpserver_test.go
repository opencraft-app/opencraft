package devtunnel

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// startAgent 起一个后台 goroutine 模拟 DevCloud agent：循环 poll，取到请求后回放到
// replay(把请求交给测试提供的回放函数)，再 reply。srvURL 是 httptest server 地址。
func startAgent(t *testing.T, srvURL, token, env string, replay func(TunneledRequest) TunneledResponse, stop <-chan struct{}) {
	t.Helper()
	client := &http.Client{Timeout: 30 * time.Second}
	auth := func(r *http.Request) {
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
	}
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			pollReq, _ := http.NewRequest(http.MethodGet, srvURL+reservedPrefix+"poll?env="+env, nil)
			auth(pollReq)
			resp, err := client.Do(pollReq)
			if err != nil {
				return
			}
			if resp.StatusCode == http.StatusNoContent {
				resp.Body.Close()
				continue
			}
			var req TunneledRequest
			_ = json.NewDecoder(resp.Body).Decode(&req)
			resp.Body.Close()

			out := replay(req)
			payload, _ := json.Marshal(out)
			replyReq, _ := http.NewRequest(http.MethodPost, srvURL+reservedPrefix+"reply?rid="+req.RID, bytes.NewReader(payload))
			auth(replyReq)
			rr, err := client.Do(replyReq)
			if err == nil {
				rr.Body.Close()
			}
		}
	}()
}

// TestHTTPEndToEnd 打通 ingest → poll → 回放 → reply → ingest 应答 全链路。
func TestHTTPEndToEnd(t *testing.T) {
	hub := NewHub()
	defer hub.Close()
	srv := httptest.NewServer(NewServer(hub, ServerOptions{DispatchTimeout: 2 * time.Second, PollTimeout: time.Second}))
	defer srv.Close()

	const env = "dev1.tunnel.internal"
	stop := make(chan struct{})
	defer close(stop)

	var seenPath, seenBody string
	startAgent(t, srv.URL, "", env, func(req TunneledRequest) TunneledResponse {
		seenPath = req.Path
		seenBody = string(req.Body)
		return TunneledResponse{Status: 201, Headers: map[string][]string{"X-Echo": {"1"}}, Body: []byte(`{"returnCode":0}`)}
	}, stop)

	// 模拟云梯 ingest：Host 决定分流到 env。
	ingest, _ := http.NewRequest(http.MethodPost, srv.URL+"/trade/jifei/callback", strings.NewReader(`{"interface":{"para":{"uin":"700003135209"}}}`))
	ingest.Host = env
	resp, err := http.DefaultClient.Do(ingest)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 201 {
		t.Fatalf("status: got %d want 201", resp.StatusCode)
	}
	if resp.Header.Get("X-Echo") != "1" {
		t.Fatalf("echo header not propagated back")
	}
	if string(body) != `{"returnCode":0}` {
		t.Fatalf("body: got %q", body)
	}
	if seenPath != "/trade/jifei/callback" {
		t.Fatalf("agent saw path %q", seenPath)
	}
	if !strings.Contains(seenBody, "700003135209") {
		t.Fatalf("agent saw body %q", seenBody)
	}
}

// TestHTTPIngestTimeoutNoAgent 验证：没有 agent 时 ingest 返 504，云梯据此记失败。
func TestHTTPIngestTimeoutNoAgent(t *testing.T) {
	hub := NewHub()
	defer hub.Close()
	srv := httptest.NewServer(NewServer(hub, ServerOptions{DispatchTimeout: 80 * time.Millisecond}))
	defer srv.Close()

	ingest, _ := http.NewRequest(http.MethodPost, srv.URL+"/trade/jifei/callback", strings.NewReader(`{}`))
	ingest.Host = "dev-nobody"
	resp, err := http.DefaultClient.Do(ingest)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusGatewayTimeout {
		t.Fatalf("status: got %d want 504", resp.StatusCode)
	}
}

// TestHTTPAuthRequired 验证：配了 token 时，无 Bearer 的请求全被拒。
func TestHTTPAuthRequired(t *testing.T) {
	hub := NewHub()
	defer hub.Close()
	srv := httptest.NewServer(NewServer(hub, ServerOptions{Token: "s3cr3t", DispatchTimeout: 100 * time.Millisecond}))
	defer srv.Close()

	// 无 token 的 poll → 401
	pollReq, _ := http.NewRequest(http.MethodGet, srv.URL+reservedPrefix+"poll?env=dev1", nil)
	resp, _ := http.DefaultClient.Do(pollReq)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("poll without token: got %d want 401", resp.StatusCode)
	}
	resp.Body.Close()

	// healthz 不需要 token
	hz, _ := http.Get(srv.URL + "/healthz")
	if hz.StatusCode != http.StatusOK {
		t.Fatalf("healthz: got %d want 200", hz.StatusCode)
	}
	hz.Body.Close()

	// 带正确 token 的 poll → 204（空闲）
	pollReq2, _ := http.NewRequest(http.MethodGet, srv.URL+reservedPrefix+"poll?env=dev1", nil)
	pollReq2.Header.Set("Authorization", "Bearer s3cr3t")
	resp2, _ := http.DefaultClient.Do(pollReq2)
	if resp2.StatusCode != http.StatusNoContent {
		t.Fatalf("authed idle poll: got %d want 204", resp2.StatusCode)
	}
	resp2.Body.Close()
}

// TestHTTPReplyUnknownRID 验证：对未知 rid 的 reply 返 410。
func TestHTTPReplyUnknownRID(t *testing.T) {
	hub := NewHub()
	defer hub.Close()
	srv := httptest.NewServer(NewServer(hub, ServerOptions{}))
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+reservedPrefix+"reply?rid=ghost", strings.NewReader(`{"status":200}`))
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("reply unknown rid: got %d want 410", resp.StatusCode)
	}
	resp.Body.Close()
}

// TestHTTPAuthNotLeakedToAgent 验证：云梯→hub 的 Authorization 不会透传进回放请求。
func TestHTTPAuthNotLeakedToAgent(t *testing.T) {
	hub := NewHub()
	defer hub.Close()
	srv := httptest.NewServer(NewServer(hub, ServerOptions{Token: "tok", DispatchTimeout: 2 * time.Second, PollTimeout: time.Second}))
	defer srv.Close()

	const env = "dev1"
	stop := make(chan struct{})
	defer close(stop)

	var sawAuth bool
	startAgent(t, srv.URL, "tok", env, func(req TunneledRequest) TunneledResponse {
		if _, ok := req.Headers["Authorization"]; ok {
			sawAuth = true
		}
		return TunneledResponse{Status: 200}
	}, stop)

	ingest, _ := http.NewRequest(http.MethodPost, srv.URL+"/trade/jifei/callback", strings.NewReader(`{}`))
	ingest.Host = env
	ingest.Header.Set("Authorization", "Bearer tok")
	resp, err := http.DefaultClient.Do(ingest)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	resp.Body.Close()

	// 给 agent 回放留出时间窗
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if resp.StatusCode == 200 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if sawAuth {
		t.Fatalf("Authorization header leaked into replayed request")
	}
}
