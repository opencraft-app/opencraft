package ingressproxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"cvm-mock-e2b/internal/route"
	"cvm-mock-e2b/internal/serverstate"
	"github.com/gorilla/websocket"
)

func TestParseTargetHost(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		host       string
		ipBackdoor bool
		wantPort   string
		wantID     string
		wantIP     string
		wantError  bool
	}{
		{
			name:     "sandbox host",
			host:     "49983-21eb8aa9-df44-48ba-a27a-797e4a27c200.e2b.app",
			wantPort: "49983",
			wantID:   "21eb8aa9-df44-48ba-a27a-797e4a27c200",
		},
		{
			name:     "sandbox host with suffix token",
			host:     "49983-21eb8aa9-df44-48ba-a27a-797e4a27c200-00000000.e2b.app",
			wantPort: "49983",
			wantID:   "21eb8aa9-df44-48ba-a27a-797e4a27c200",
		},
		{
			name:       "ip backdoor host",
			host:       "49983-ip-10.0.1.140.internal.sandbox",
			ipBackdoor: true,
			wantPort:   "49983",
			wantIP:     "10.0.1.140",
		},
		{
			name:      "invalid sandbox port zero",
			host:      "0-21eb8aa9-df44-48ba-a27a-797e4a27c200.e2b.app",
			wantError: true,
		},
		{
			name:      "invalid sandbox port too large",
			host:      "65536-21eb8aa9-df44-48ba-a27a-797e4a27c200.e2b.app",
			wantError: true,
		},
		{
			name:       "invalid ip backdoor port zero",
			host:       "0-ip-10.0.1.140.internal.sandbox",
			ipBackdoor: true,
			wantError:  true,
		},
		{
			name:       "invalid ip backdoor port too large",
			host:       "65536-ip-10.0.1.140.internal.sandbox",
			ipBackdoor: true,
			wantError:  true,
		},
		{
			name:      "invalid host",
			host:      "invalid.example.com",
			wantError: true,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			target, err := ParseTargetHost(tt.host, tt.ipBackdoor)
			if tt.wantError {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if target.Port != tt.wantPort {
				t.Fatalf("port mismatch: got %q want %q", target.Port, tt.wantPort)
			}
			if target.SandboxID != tt.wantID {
				t.Fatalf("sandbox id mismatch: got %q want %q", target.SandboxID, tt.wantID)
			}
			if target.IP != tt.wantIP {
				t.Fatalf("ip mismatch: got %q want %q", target.IP, tt.wantIP)
			}
		})
	}
}

func TestShardForKey(t *testing.T) {
	t.Parallel()

	first, err := ShardForKey("sandbox-a", 4)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	second, err := ShardForKey("sandbox-a", 4)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if first != second {
		t.Fatalf("expected deterministic shard, got %d then %d", first, second)
	}
	if first < 0 || first > 3 {
		t.Fatalf("expected shard in [0,3], got %d", first)
	}
}

func TestRouterHandlerRoutesBySandboxShard(t *testing.T) {
	t.Parallel()

	var hosts []string
	upstreams := make([]*httptest.Server, 2)
	for shard := range upstreams {
		shard := shard
		upstreams[shard] = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hosts = append(hosts, fmt.Sprintf("%d|%s", shard, r.Host))
			_, _ = io.WriteString(w, fmt.Sprintf("shard=%d", shard))
		}))
		defer upstreams[shard].Close()
	}

	handler, err := NewRouterHandler(RouterConfig{
		ShardCount: 2,
		ShardServiceURLFn: func(shard int) (*url.URL, error) {
			return url.Parse(upstreams[shard].URL)
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://router.local/proxy", nil)
	req.Host = "49983-sandbox-a.e2b.app"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}
	expectedShard, err := ShardForKey("sandbox-a", 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if body := strings.TrimSpace(rr.Body.String()); body != fmt.Sprintf("shard=%d", expectedShard) {
		t.Fatalf("unexpected body %q", body)
	}
	if len(hosts) != 1 || !strings.Contains(hosts[0], req.Host) {
		t.Fatalf("expected forwarded host %q, got %v", req.Host, hosts)
	}
}

func TestRouterHandlerHealthIgnoresInvalidHost(t *testing.T) {
	t.Parallel()

	handler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(shard int) (*url.URL, error) {
			return url.Parse("http://example.invalid")
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	req := httptest.NewRequest(http.MethodHead, "http://router.local/health", nil)
	req.Host = "sandbox.lightclaw.tech"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}
}

type stubRouteStore struct {
	get func(sandboxID string) (Rule, error)
}

func (s stubRouteStore) Get(_ context.Context, sandboxID string) (Rule, error) {
	return s.get(sandboxID)
}

func startManagedIngressServer(t *testing.T, handler http.Handler) (*http.Server, *TrackedListener, string, *serverstate.DrainState) {
	t.Helper()

	drain := serverstate.NewDrainState()
	mux := http.NewServeMux()
	mux.Handle("/health", HealthHandler())
	mux.Handle("/ready", ReadyHandler(drain))
	mux.Handle("/drain", DrainHandler(drain))
	mux.Handle("/", handler)

	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen managed ingress server: %v", err)
	}

	tracked := NewTrackedListener(base, nil)
	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}
	go func() {
		if err := srv.Serve(tracked); err != nil && err != http.ErrServerClosed {
			t.Errorf("managed ingress serve: %v", err)
		}
	}()

	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		_ = tracked.CloseActive()
	})

	return srv, tracked, "http://" + base.Addr().String(), drain
}

func TestShardHandlerRoutesViaRedisAddress(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok:"+r.URL.Path)
	}))
	defer upstream.Close()

	targetURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	handler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(sandboxID string) (Rule, error) {
				if sandboxID != "sandbox-a" {
					t.Fatalf("unexpected sandbox id %q", sandboxID)
				}
				return Rule{InstanceID: "instance-a", Address: targetURL.Hostname()}, nil
			},
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://shard.local/test", nil)
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", targetURL.Port())
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d body=%q", rr.Code, rr.Body.String())
	}
	if body := strings.TrimSpace(rr.Body.String()); body != "ok:/test" {
		t.Fatalf("unexpected body %q", body)
	}
}

func TestShardHandlerHealthIgnoresInvalidHost(t *testing.T) {
	t.Parallel()

	handler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(sandboxID string) (Rule, error) {
				return Rule{}, route.ErrRouteNotFound
			},
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	req := httptest.NewRequest(http.MethodHead, "http://shard.local/health", nil)
	req.Host = "sandbox.lightclaw.tech"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}
}

func TestShardHandlerSupportsIPBackdoor(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ip-backdoor")
	}))
	defer upstream.Close()

	targetURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	handler, err := NewShardHandler(ShardConfig{
		Routes:           stubRouteStore{get: func(string) (Rule, error) { return Rule{}, nil }},
		EnableIPBackdoor: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://shard.local/test", nil)
	req.Host = fmt.Sprintf("%s-ip-%s.internal.sandbox", targetURL.Port(), targetURL.Hostname())
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d body=%q", rr.Code, rr.Body.String())
	}
	if body := strings.TrimSpace(rr.Body.String()); body != "ip-backdoor" {
		t.Fatalf("unexpected body %q", body)
	}
}

func TestShardHandlerBlocksWhenInFlightLimitExceeded(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()

	targetURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	handler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(sandboxID string) (Rule, error) {
				return Rule{Address: targetURL.Hostname()}, nil
			},
		},
		ConnectionLimiter:    NewConnectionLimiter(),
		MaxConnectionsPerKey: 1,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		req := httptest.NewRequest(http.MethodGet, "http://shard.local/first", nil)
		req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", targetURL.Port())
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
	}()

	<-started

	req := httptest.NewRequest(http.MethodGet, "http://shard.local/second", nil)
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", targetURL.Port())
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("expected status 429, got %d body=%q", rr.Code, rr.Body.String())
	}

	close(release)
	wg.Wait()
}

func TestShardHandlerUsesLifecycleKeyFromInstanceID(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()

	targetURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	pool := NewProxyPool(ProxyPoolOptions{})
	var calls atomic.Int32
	handler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(sandboxID string) (Rule, error) {
				calls.Add(1)
				return Rule{InstanceID: "instance-a", Address: targetURL.Hostname()}, nil
			},
		},
		Proxies: pool,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://shard.local/test", nil)
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", targetURL.Port())
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d body=%q", rr.Code, rr.Body.String())
	}
	if !pool.Has("instance-a") {
		t.Fatalf("expected lifecycle key instance-a to exist in pool")
	}
	if pool.Has("shard:upstream:" + upstream.URL) {
		t.Fatalf("expected upstream URL key not to be used")
	}
}

func TestShardHandlerClearsLifecycleKeyOnRouteMiss(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()

	targetURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	pool := NewProxyPool(ProxyPoolOptions{})
	var calls atomic.Int32
	handler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(sandboxID string) (Rule, error) {
				if calls.Add(1) == 1 {
					return Rule{InstanceID: "instance-a", Address: targetURL.Hostname()}, nil
				}
				return Rule{}, route.ErrRouteNotFound
			},
		},
		Proxies: pool,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	firstReq := httptest.NewRequest(http.MethodGet, "http://shard.local/first", nil)
	firstReq.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", targetURL.Port())
	firstResp := httptest.NewRecorder()
	handler.ServeHTTP(firstResp, firstReq)
	if firstResp.Code != http.StatusOK {
		t.Fatalf("expected first request status 200, got %d body=%q", firstResp.Code, firstResp.Body.String())
	}
	if !pool.Has("instance-a") {
		t.Fatalf("expected lifecycle key instance-a after first request")
	}

	secondReq := httptest.NewRequest(http.MethodGet, "http://shard.local/second", nil)
	secondReq.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", targetURL.Port())
	secondResp := httptest.NewRecorder()
	handler.ServeHTTP(secondResp, secondReq)
	if secondResp.Code != http.StatusNotFound {
		t.Fatalf("expected second request status 404, got %d body=%q", secondResp.Code, secondResp.Body.String())
	}
	if pool.Has("instance-a") {
		t.Fatalf("expected lifecycle key instance-a to be cleared after route miss")
	}
}

func TestEndToEndWebSocketViaRouterAndShard(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade upstream websocket: %v", err)
			return
		}
		defer conn.Close()

		mt, msg, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("read websocket message: %v", err)
			return
		}
		if err := conn.WriteMessage(mt, append([]byte("echo:"), msg...)); err != nil {
			t.Errorf("write websocket message: %v", err)
		}
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(sandboxID string) (Rule, error) {
				if sandboxID != "sandbox-a" {
					t.Fatalf("unexpected sandbox id %q", sandboxID)
				}
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	routerURL, err := url.Parse(routerServer.URL)
	if err != nil {
		t.Fatalf("parse router url: %v", err)
	}

	wsURL := "ws://" + routerURL.Host + "/ws"
	headers := http.Header{}
	headers.Set("Host", fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port()))
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatalf("dial websocket via router: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, []byte("hello")); err != nil {
		t.Fatalf("write websocket message: %v", err)
	}
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read websocket response: %v", err)
	}
	if got := string(msg); got != "echo:hello" {
		t.Fatalf("unexpected websocket response %q", got)
	}
}

func TestEndToEndGracefulShutdownKeepsExistingWebSocketUntilClientCloses(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade upstream websocket: %v", err)
			return
		}
		defer conn.Close()

		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if err := conn.WriteMessage(mt, append([]byte("echo:"), msg...)); err != nil {
				return
			}
		}
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}

	srv, tracked, baseURL, _ := startManagedIngressServer(t, routerHandler)
	routerURL, err := url.Parse(baseURL)
	if err != nil {
		t.Fatalf("parse managed router url: %v", err)
	}

	hostHeader := fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())
	wsURL := url.URL{Scheme: "ws", Host: routerURL.Host, Path: "/ws"}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL.String(), http.Header{"Host": []string{hostHeader}})
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	drainReq, err := http.NewRequest(http.MethodPost, baseURL+"/drain", nil)
	if err != nil {
		t.Fatalf("new drain request: %v", err)
	}
	drainResp, err := http.DefaultClient.Do(drainReq)
	if err != nil {
		t.Fatalf("do drain request: %v", err)
	}
	_ = drainResp.Body.Close()
	if drainResp.StatusCode != http.StatusOK {
		t.Fatalf("expected drain status 200, got %d", drainResp.StatusCode)
	}

	readyResp, err := http.Get(baseURL + "/ready")
	if err != nil {
		t.Fatalf("do ready request: %v", err)
	}
	_ = readyResp.Body.Close()
	if readyResp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected readiness status 503 while draining, got %d", readyResp.StatusCode)
	}

	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil && err != http.ErrServerClosed {
			shutdownDone <- err
			return
		}
		if !tracked.WaitForZero(ctx) {
			shutdownDone <- fmt.Errorf("tracked listener did not reach zero")
			return
		}
		shutdownDone <- nil
	}()

	if err := conn.WriteMessage(websocket.TextMessage, []byte("still-alive")); err != nil {
		t.Fatalf("write websocket after drain: %v", err)
	}
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read websocket after drain: %v", err)
	}
	if string(msg) != "echo:still-alive" {
		t.Fatalf("unexpected websocket response after drain %q", string(msg))
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("close websocket client: %v", err)
	}

	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("shutdown result: %v", err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("timed out waiting for graceful shutdown to finish")
	}
}

func TestEndToEndForceCloseClosesLingeringWebSocket(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade upstream websocket: %v", err)
			return
		}
		defer conn.Close()

		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if err := conn.WriteMessage(mt, append([]byte("echo:"), msg...)); err != nil {
				return
			}
		}
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}

	srv, tracked, baseURL, _ := startManagedIngressServer(t, routerHandler)
	routerURL, err := url.Parse(baseURL)
	if err != nil {
		t.Fatalf("parse managed router url: %v", err)
	}

	hostHeader := fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())
	wsURL := url.URL{Scheme: "ws", Host: routerURL.Host, Path: "/ws"}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL.String(), http.Header{"Host": []string{hostHeader}})
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	drainReq, err := http.NewRequest(http.MethodPost, baseURL+"/drain", nil)
	if err != nil {
		t.Fatalf("new drain request: %v", err)
	}
	drainResp, err := http.DefaultClient.Do(drainReq)
	if err != nil {
		t.Fatalf("do drain request: %v", err)
	}
	_ = drainResp.Body.Close()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && err != http.ErrServerClosed {
		t.Fatalf("shutdown server: %v", err)
	}
	if tracked.WaitForZero(shutdownCtx) {
		t.Fatal("expected lingering websocket to keep downstream count non-zero before force close")
	}

	if err := tracked.CloseActive(); err != nil {
		t.Fatalf("force close active downstream connections: %v", err)
	}

	waitCtx, waitCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer waitCancel()
	if !tracked.WaitForZero(waitCtx) {
		t.Fatal("expected tracked listener to reach zero after force close")
	}

	if err := conn.WriteMessage(websocket.TextMessage, []byte("after-force-close")); err == nil {
		_, _, readErr := conn.ReadMessage()
		if readErr == nil {
			t.Fatal("expected websocket connection to be closed after force close")
		}
	}
}

func TestEndToEndStreamingViaRouterAndShard(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatalf("expected flusher")
		}
		_, _ = io.WriteString(w, "chunk-1\n")
		flusher.Flush()
		time.Sleep(150 * time.Millisecond)
		_, _ = io.WriteString(w, "chunk-2\n")
		flusher.Flush()
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/stream", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	firstChunk, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read first chunk: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("first chunk arrived too late: %v", elapsed)
	}
	if firstChunk != "chunk-1\n" {
		t.Fatalf("unexpected first chunk %q", firstChunk)
	}

	secondChunk, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read second chunk: %v", err)
	}
	if secondChunk != "chunk-2\n" {
		t.Fatalf("unexpected second chunk %q", secondChunk)
	}
}

func TestEndToEndWSSViaRouterAndShard(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade upstream websocket: %v", err)
			return
		}
		defer conn.Close()

		if err := conn.WriteMessage(websocket.TextMessage, []byte("secure-echo")); err != nil {
			t.Errorf("write websocket message: %v", err)
		}
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewTLSServer(routerHandler)
	defer routerServer.Close()

	routerURL, err := url.Parse(routerServer.URL)
	if err != nil {
		t.Fatalf("parse router url: %v", err)
	}

	dialer := websocket.Dialer{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	headers := http.Header{}
	headers.Set("Host", fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port()))
	conn, _, err := dialer.Dial("wss://"+routerURL.Host+"/ws", headers)
	if err != nil {
		t.Fatalf("dial wss via router: %v", err)
	}
	defer conn.Close()

	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read websocket response: %v", err)
	}
	if got := string(msg); got != "secure-echo" {
		t.Fatalf("unexpected websocket response %q", got)
	}
}

func TestEndToEndRoutesDifferentSandboxesToDifferentUpstreams(t *testing.T) {
	t.Parallel()

	upstreamA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "upstream-a")
	}))
	defer upstreamA.Close()
	upstreamB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "upstream-b")
	}))
	defer upstreamB.Close()

	upstreamAURL, _ := url.Parse(upstreamA.URL)
	upstreamBURL, _ := url.Parse(upstreamB.URL)

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(sandboxID string) (Rule, error) {
				switch sandboxID {
				case "sandbox-a":
					return Rule{InstanceID: "instance-a", Address: upstreamAURL.Hostname()}, nil
				case "sandbox-b":
					return Rule{InstanceID: "instance-b", Address: upstreamBURL.Hostname()}, nil
				default:
					return Rule{}, fmt.Errorf("unknown sandbox")
				}
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	for sandboxID, tc := range map[string]struct {
		port string
		want string
	}{
		"sandbox-a": {port: upstreamAURL.Port(), want: "upstream-a"},
		"sandbox-b": {port: upstreamBURL.Port(), want: "upstream-b"},
	} {
		req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/route", nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		req.Host = fmt.Sprintf("%s-%s.e2b.app", tc.port, sandboxID)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("do request for %s: %v", sandboxID, err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if got := strings.TrimSpace(string(body)); got != tc.want {
			t.Fatalf("sandbox %s routed to %q want %q", sandboxID, got, tc.want)
		}
	}
}

func TestEndToEndLargePayloadViaRouterAndShard(t *testing.T) {
	t.Parallel()

	payload := bytes.Repeat([]byte("a"), 512*1024)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read upstream body: %v", err)
		}
		if len(body) != len(payload) {
			t.Fatalf("unexpected payload size: got %d want %d", len(body), len(payload))
		}
		w.Header().Set("X-Upstream-Size", fmt.Sprintf("%d", len(body)))
		_, _ = w.Write(body[:32])
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	req, err := http.NewRequest(http.MethodPost, routerServer.URL+"/payload", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("X-Upstream-Size"); got != fmt.Sprintf("%d", len(payload)) {
		t.Fatalf("unexpected upstream size header %q", got)
	}
}

func TestEndToEndLongLivedWebSocketViaRouterAndShard(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade upstream websocket: %v", err)
			return
		}
		defer conn.Close()

		for i := 0; i < 3; i++ {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				t.Errorf("read websocket message %d: %v", i, err)
				return
			}
			time.Sleep(150 * time.Millisecond)
			if err := conn.WriteMessage(mt, append([]byte("ack:"), msg...)); err != nil {
				t.Errorf("write websocket message %d: %v", i, err)
				return
			}
		}
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	routerURL, _ := url.Parse(routerServer.URL)
	headers := http.Header{}
	headers.Set("Host", fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port()))
	conn, _, err := websocket.DefaultDialer.Dial("ws://"+routerURL.Host+"/ws", headers)
	if err != nil {
		t.Fatalf("dial websocket via router: %v", err)
	}
	defer conn.Close()

	for i := 0; i < 3; i++ {
		msg := fmt.Sprintf("msg-%d", i)
		if err := conn.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
			t.Fatalf("write websocket message %d: %v", i, err)
		}
		_, got, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read websocket response %d: %v", i, err)
		}
		if string(got) != "ack:"+msg {
			t.Fatalf("unexpected websocket response %q", string(got))
		}
	}
}

func TestEndToEndWebSocketConnectionsReturnToZeroViaRouterAndShard(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade upstream websocket: %v", err)
			return
		}
		defer conn.Close()

		mt, msg, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("read websocket message: %v", err)
			return
		}
		if err := conn.WriteMessage(mt, append([]byte("ack:"), msg...)); err != nil {
			t.Errorf("write websocket response: %v", err)
		}
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	shardPool := NewProxyPool(ProxyPoolOptions{})
	routerPool := NewProxyPool(ProxyPoolOptions{})
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: shardPool,
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: routerPool,
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	routerURL, _ := url.Parse(routerServer.URL)
	headers := http.Header{}
	headers.Set("Host", fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port()))
	conn, _, err := websocket.DefaultDialer.Dial("ws://"+routerURL.Host+"/ws", headers)
	if err != nil {
		t.Fatalf("dial websocket via router: %v", err)
	}

	if err := conn.WriteMessage(websocket.TextMessage, []byte("hello")); err != nil {
		t.Fatalf("write websocket message: %v", err)
	}
	_, got, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read websocket response: %v", err)
	}
	if string(got) != "ack:hello" {
		t.Fatalf("unexpected websocket response %q", string(got))
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("close websocket: %v", err)
	}

	waitForConnectionsToDrop(t, "router pool", routerPool.CurrentConnections)
	waitForConnectionsToDrop(t, "shard pool", shardPool.CurrentConnections)
}

func TestEndToEndIdleWebSocketSurvivesGapViaRouterAndShard(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade upstream websocket: %v", err)
			return
		}
		defer conn.Close()

		mt, msg, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("read first websocket message: %v", err)
			return
		}
		if err := conn.WriteMessage(mt, append([]byte("ack:"), msg...)); err != nil {
			t.Errorf("write first websocket message: %v", err)
			return
		}

		time.Sleep(1200 * time.Millisecond)

		mt, msg, err = conn.ReadMessage()
		if err != nil {
			t.Errorf("read second websocket message: %v", err)
			return
		}
		if err := conn.WriteMessage(mt, append([]byte("ack:"), msg...)); err != nil {
			t.Errorf("write second websocket message: %v", err)
		}
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	routerURL, _ := url.Parse(routerServer.URL)
	headers := http.Header{}
	headers.Set("Host", fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port()))
	conn, _, err := websocket.DefaultDialer.Dial("ws://"+routerURL.Host+"/ws", headers)
	if err != nil {
		t.Fatalf("dial websocket via router: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, []byte("first")); err != nil {
		t.Fatalf("write first websocket message: %v", err)
	}
	_, got, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read first websocket response: %v", err)
	}
	if string(got) != "ack:first" {
		t.Fatalf("unexpected first websocket response %q", string(got))
	}

	if err := conn.WriteMessage(websocket.TextMessage, []byte("second")); err != nil {
		t.Fatalf("write second websocket message: %v", err)
	}
	_, got, err = conn.ReadMessage()
	if err != nil {
		t.Fatalf("read second websocket response: %v", err)
	}
	if string(got) != "ack:second" {
		t.Fatalf("unexpected second websocket response %q", string(got))
	}
}

func TestEndToEndRouteMissViaRouterAndShard(t *testing.T) {
	t.Parallel()

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{}, route.ErrRouteNotFound
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/missing", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = "8080-missing-sandbox.e2b.app"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}

func TestEndToEndRouteLookupFailureViaRouterAndShard(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	shardPool := NewProxyPool(ProxyPoolOptions{})
	var calls int
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				calls++
				if calls == 1 {
					return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
				}
				return Rule{}, fmt.Errorf("redis timeout")
			},
		},
		Proxies: shardPool,
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	firstReq, err := http.NewRequest(http.MethodGet, routerServer.URL+"/ok", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	firstReq.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())
	firstResp, err := http.DefaultClient.Do(firstReq)
	if err != nil {
		t.Fatalf("do first request: %v", err)
	}
	_, _ = io.ReadAll(firstResp.Body)
	_ = firstResp.Body.Close()
	if firstResp.StatusCode != http.StatusOK {
		t.Fatalf("expected first request 200, got %d", firstResp.StatusCode)
	}
	if !shardPool.Has("instance-a") {
		t.Fatalf("expected lifecycle key instance-a after first request")
	}

	secondReq, err := http.NewRequest(http.MethodGet, routerServer.URL+"/fail", nil)
	if err != nil {
		t.Fatalf("new second request: %v", err)
	}
	secondReq.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())
	secondResp, err := http.DefaultClient.Do(secondReq)
	if err != nil {
		t.Fatalf("do second request: %v", err)
	}
	body, _ := io.ReadAll(secondResp.Body)
	_ = secondResp.Body.Close()
	if secondResp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502 on route lookup failure, got %d body=%q", secondResp.StatusCode, string(body))
	}
	if !shardPool.Has("instance-a") {
		t.Fatalf("expected lifecycle key instance-a to be preserved on route lookup failure")
	}
}

func TestEndToEndProvidedRequestIDPropagatesViaRouterAndShard(t *testing.T) {
	t.Parallel()

	const wantReqID = "req-fixed-123"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get(requestIDHeader); got != wantReqID {
			t.Fatalf("unexpected request id header: got %q want %q", got, wantReqID)
		}
		w.Header().Set("X-Upstream-Request-Id", gotRequestID(r))
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/trace", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())
	req.Header.Set(requestIDHeader, wantReqID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get(requestIDHeader); got != wantReqID {
		t.Fatalf("unexpected response request id header: got %q want %q", got, wantReqID)
	}
}

func TestRouterRejectsInvalidHostWithBadRequest(t *testing.T) {
	t.Parallel()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse("http://example.com")
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://router.local/invalid", nil)
	req.Host = "invalid"
	rr := httptest.NewRecorder()
	routerHandler.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%q", rr.Code, rr.Body.String())
	}
}

func gotRequestID(r *http.Request) string {
	return r.Header.Get(requestIDHeader)
}

func TestEndToEndTruncatedHTTPResponseViaRouterAndShard(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 32\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\npartial-body")
	}()

	upstreamHost, upstreamPort, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split host port: %v", err)
	}

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamHost}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/truncated", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamPort)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if !strings.Contains(strings.ToLower(err.Error()), "eof") {
			t.Fatalf("expected EOF-style error or partial response, got %v", err)
		}
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	switch resp.StatusCode {
	case http.StatusOK:
		if !strings.Contains(string(body), "partial-body") {
			t.Fatalf("expected partial body on 200 truncated response, got %q", string(body))
		}
	case http.StatusBadGateway:
	default:
		t.Fatalf("expected 200 or 502 on truncated upstream response, got %d body=%q", resp.StatusCode, string(body))
	}
}

func TestEndToEndUpstreamDropsConnectionBeforeHeadersViaRouterAndShard(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		_ = conn.Close()
	}()

	upstreamHost, upstreamPort, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split host port: %v", err)
	}

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamHost}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/drop", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamPort)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d body=%q", resp.StatusCode, string(body))
	}
}

func TestEndToEndLifecycleSwitchResetsOldWebSocketAndRoutesNewRequests(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	upstreamA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade upstreamA websocket: %v", err)
			return
		}
		defer conn.Close()

		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if err := conn.WriteMessage(mt, append([]byte("a:"), msg...)); err != nil {
				return
			}
		}
	}))
	defer upstreamA.Close()

	upstreamB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "upstream-b")
	}))
	defer upstreamB.Close()

	upstreamAURL, _ := url.Parse(upstreamA.URL)
	upstreamBURL, _ := url.Parse(upstreamB.URL)

	var (
		mu          sync.RWMutex
		currentRule = Rule{InstanceID: "instance-a", Address: upstreamAURL.Hostname()}
	)

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				mu.RLock()
				defer mu.RUnlock()
				return currentRule, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	routerURL, _ := url.Parse(routerServer.URL)
	headers := http.Header{}
	headers.Set("Host", fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamAURL.Port()))
	conn, _, err := websocket.DefaultDialer.Dial("ws://"+routerURL.Host+"/ws", headers)
	if err != nil {
		t.Fatalf("dial websocket via router: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, []byte("hello")); err != nil {
		t.Fatalf("write initial websocket message: %v", err)
	}
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read initial websocket response: %v", err)
	}
	if string(msg) != "a:hello" {
		t.Fatalf("unexpected initial websocket response %q", string(msg))
	}

	mu.Lock()
	currentRule = Rule{InstanceID: "instance-b", Address: upstreamBURL.Hostname()}
	mu.Unlock()

	req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/switch", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamBURL.Port())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do switched request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from switched request, got %d body=%q", resp.StatusCode, string(body))
	}
	if strings.TrimSpace(string(body)) != "upstream-b" {
		t.Fatalf("expected switched request to hit upstream-b, got %q", string(body))
	}

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = conn.ReadMessage()
	if err == nil {
		t.Fatalf("expected old websocket connection to be reset after lifecycle switch")
	}
}

func TestEndToEndClientCancelReleasesLimiterAndCancelsUpstream(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	canceled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(canceled)
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	limiter := NewConnectionLimiter()
	shardPool := NewProxyPool(ProxyPoolOptions{})
	routerPool := NewProxyPool(ProxyPoolOptions{})
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies:              shardPool,
		ConnectionLimiter:    limiter,
		MaxConnectionsPerKey: 1,
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: routerPool,
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	routerURL, _ := url.Parse(routerServer.URL)
	rawConn, err := net.Dial("tcp", routerURL.Host)
	if err != nil {
		t.Fatalf("dial router: %v", err)
	}
	_, err = fmt.Fprintf(rawConn, "GET /cancel HTTP/1.1\r\nHost: %s-sandbox-a.e2b.app\r\nConnection: close\r\n\r\n", upstreamURL.Port())
	if err != nil {
		t.Fatalf("write raw request: %v", err)
	}

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for upstream request start")
	}

	_ = rawConn.Close()

	select {
	case <-canceled:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for upstream context cancellation")
	}

	deadline := time.Now().Add(2 * time.Second)
	for limiter.Count("sandbox-a") != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := limiter.Count("sandbox-a"); got != 0 {
		t.Fatalf("expected limiter count to return to zero, got %d", got)
	}
	waitForConnectionsToDrop(t, "router pool", routerPool.CurrentConnections)
	waitForConnectionsToDrop(t, "shard pool", shardPool.CurrentConnections)
}

func TestEndToEndUpstreamNoHeadersHonorsClientTimeout(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		time.Sleep(2 * time.Second)
	}()

	upstreamHost, upstreamPort, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split host port: %v", err)
	}

	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamHost}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	client := &http.Client{Timeout: 200 * time.Millisecond}
	req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/no-headers", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamPort)

	_, err = client.Do(req)
	if err == nil {
		t.Fatalf("expected client timeout waiting for upstream headers")
	}
}

func TestEndToEndSlowHeadersHonorsClientTimeout(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(500 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "slow-header")
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	client := &http.Client{Timeout: 200 * time.Millisecond}
	req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/slow-headers", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())

	_, err = client.Do(req)
	if err == nil {
		t.Fatalf("expected client timeout waiting for slow upstream headers")
	}
}

func TestEndToEndIdleHTTPStreamSurvivesGapViaRouterAndShard(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatalf("expected flusher")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "chunk-1\n")
		flusher.Flush()
		time.Sleep(1200 * time.Millisecond)
		_, _ = io.WriteString(w, "chunk-2\n")
		flusher.Flush()
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: NewProxyPool(ProxyPoolOptions{}),
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/idle-stream", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	firstChunk, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read first chunk: %v", err)
	}
	if firstChunk != "chunk-1\n" {
		t.Fatalf("unexpected first chunk %q", firstChunk)
	}
	secondChunk, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read second chunk after idle gap: %v", err)
	}
	if secondChunk != "chunk-2\n" {
		t.Fatalf("unexpected second chunk %q", secondChunk)
	}
}

func TestEndToEndRepeatedShortConnectionsNoLeakViaRouterAndShard(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	shardPool := NewProxyPool(ProxyPoolOptions{})
	routerPool := NewProxyPool(ProxyPoolOptions{})
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: shardPool,
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: routerPool,
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	for i := 0; i < 200; i++ {
		req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/short", nil)
		if err != nil {
			t.Fatalf("new request %d: %v", i, err)
		}
		req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("do request %d: %v", i, err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 on request %d, got %d body=%q", i, resp.StatusCode, string(body))
		}
		if strings.TrimSpace(string(body)) != "ok" {
			t.Fatalf("unexpected body on request %d: %q", i, string(body))
		}
	}

	if routerPool.TotalConnections() == 0 {
		t.Fatalf("expected router pool to establish upstream connections")
	}
	if shardPool.TotalConnections() == 0 {
		t.Fatalf("expected shard pool to establish upstream connections")
	}
	if err := routerPool.Close("router:shard:0"); err != nil {
		t.Fatalf("close router pool key: %v", err)
	}
	if err := shardPool.Close("instance-a"); err != nil {
		t.Fatalf("close shard pool key: %v", err)
	}
	waitForConnectionsToDrop(t, "router pool", routerPool.CurrentConnections)
	waitForConnectionsToDrop(t, "shard pool", shardPool.CurrentConnections)
}

func TestEndToEndConcurrentMixedTrafficNoLeakViaRouterAndShard(t *testing.T) {
	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if websocket.IsWebSocketUpgrade(r) {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close()

			for {
				mt, msg, err := conn.ReadMessage()
				if err != nil {
					return
				}
				if err := conn.WriteMessage(mt, append([]byte("ws:"), msg...)); err != nil {
					return
				}
			}
		}

		_, _ = io.WriteString(w, "http:"+r.URL.Path)
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)
	shardPool := NewProxyPool(ProxyPoolOptions{})
	routerPool := NewProxyPool(ProxyPoolOptions{})
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				return Rule{InstanceID: "instance-a", Address: upstreamURL.Hostname()}, nil
			},
		},
		Proxies: shardPool,
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: routerPool,
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()
	routerURL, _ := url.Parse(routerServer.URL)

	errCh := make(chan error, 64)
	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		worker := worker
		wg.Add(1)
		go func() {
			defer wg.Done()

			for i := 0; i < 10; i++ {
				if worker%2 == 0 {
					req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/http-%d-%d", routerServer.URL, worker, i), nil)
					if err != nil {
						errCh <- fmt.Errorf("new http request: %w", err)
						return
					}
					req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())
					resp, err := http.DefaultClient.Do(req)
					if err != nil {
						errCh <- fmt.Errorf("do http request: %w", err)
						return
					}
					body, _ := io.ReadAll(resp.Body)
					_ = resp.Body.Close()
					want := fmt.Sprintf("http:/http-%d-%d", worker, i)
					if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != want {
						errCh <- fmt.Errorf("unexpected http response status=%d body=%q want=%q", resp.StatusCode, string(body), want)
						return
					}
					continue
				}

				headers := http.Header{}
				headers.Set("Host", fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port()))
				conn, _, err := websocket.DefaultDialer.Dial("ws://"+routerURL.Host+"/ws", headers)
				if err != nil {
					errCh <- fmt.Errorf("dial ws: %w", err)
					return
				}
				msg := fmt.Sprintf("worker-%d-%d", worker, i)
				if err := conn.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
					_ = conn.Close()
					errCh <- fmt.Errorf("write ws: %w", err)
					return
				}
				_, got, err := conn.ReadMessage()
				_ = conn.Close()
				if err != nil {
					errCh <- fmt.Errorf("read ws: %w", err)
					return
				}
				if string(got) != "ws:"+msg {
					errCh <- fmt.Errorf("unexpected ws response %q want %q", string(got), "ws:"+msg)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}

	if err := routerPool.Close("router:shard:0"); err != nil {
		t.Fatalf("close router pool key: %v", err)
	}
	if err := shardPool.Close("instance-a"); err != nil {
		t.Fatalf("close shard pool key: %v", err)
	}
	waitForConnectionsToDrop(t, "router pool", routerPool.CurrentConnections)
	waitForConnectionsToDrop(t, "shard pool", shardPool.CurrentConnections)
}

func TestEndToEndRepeatedLifecycleSwitchABNoLeakViaRouterAndShard(t *testing.T) {
	upstreamA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "upstream-a")
	}))
	defer upstreamA.Close()
	upstreamB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "upstream-b")
	}))
	defer upstreamB.Close()

	upstreamAURL, _ := url.Parse(upstreamA.URL)
	upstreamBURL, _ := url.Parse(upstreamB.URL)

	var (
		mu          sync.RWMutex
		currentRule = Rule{InstanceID: "instance-a", Address: upstreamAURL.Hostname()}
	)

	shardPool := NewProxyPool(ProxyPoolOptions{})
	routerPool := NewProxyPool(ProxyPoolOptions{})
	shardHandler, err := NewShardHandler(ShardConfig{
		Routes: stubRouteStore{
			get: func(string) (Rule, error) {
				mu.RLock()
				defer mu.RUnlock()
				return currentRule, nil
			},
		},
		Proxies: shardPool,
	})
	if err != nil {
		t.Fatalf("new shard handler: %v", err)
	}
	shardServer := httptest.NewServer(shardHandler)
	defer shardServer.Close()

	routerHandler, err := NewRouterHandler(RouterConfig{
		ShardCount: 1,
		ShardServiceURLFn: func(int) (*url.URL, error) {
			return url.Parse(shardServer.URL)
		},
		Proxies: routerPool,
	})
	if err != nil {
		t.Fatalf("new router handler: %v", err)
	}
	routerServer := httptest.NewServer(routerHandler)
	defer routerServer.Close()

	seenKeys := map[string]struct{}{}
	for i := 0; i < 20; i++ {
		var (
			upstreamURL *url.URL
			instanceID  string
			wantBody    string
		)
		if i%2 == 0 {
			upstreamURL = upstreamAURL
			instanceID = "instance-a"
			wantBody = "upstream-a"
		} else {
			upstreamURL = upstreamBURL
			instanceID = "instance-b"
			wantBody = "upstream-b"
		}

		mu.Lock()
		currentRule = Rule{InstanceID: instanceID, Address: upstreamURL.Hostname()}
		mu.Unlock()
		seenKeys[routeConnectionKey("sandbox-a", instanceID, upstreamURL.Hostname(), upstreamURL.Port())] = struct{}{}

		req, err := http.NewRequest(http.MethodGet, routerServer.URL+"/switch", nil)
		if err != nil {
			t.Fatalf("new request %d: %v", i, err)
		}
		req.Host = fmt.Sprintf("%s-sandbox-a.e2b.app", upstreamURL.Port())
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("do request %d: %v", i, err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != wantBody {
			t.Fatalf("unexpected switch response at %d status=%d body=%q want=%q", i, resp.StatusCode, string(body), wantBody)
		}
	}

	if shardPool.Size() != 1 {
		t.Fatalf("expected only the latest shard lifecycle key to remain in pool, got size=%d", shardPool.Size())
	}
	keysPresent := 0
	var remainingKey string
	for key := range seenKeys {
		if shardPool.Has(key) {
			keysPresent++
			remainingKey = key
		}
	}
	if keysPresent != 1 {
		t.Fatalf("expected exactly one lifecycle key to remain after repeated switches, got %d", keysPresent)
	}
	if err := routerPool.Close("router:shard:0"); err != nil {
		t.Fatalf("close router pool key: %v", err)
	}
	if err := shardPool.Close(remainingKey); err != nil {
		t.Fatalf("close shard pool key: %v", err)
	}
	waitForConnectionsToDrop(t, "router pool", routerPool.CurrentConnections)
	waitForConnectionsToDrop(t, "shard pool", shardPool.CurrentConnections)
}

func waitForConnectionsToDrop(t *testing.T, name string, current func() int64) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if current() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}

	t.Fatalf("expected %s current connections to return to zero, got %d", name, current())
}
