package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	gatewayv1 "github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1/gatewayv1connect"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/audit"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/proxy"
)

func TestConnectClientInvoke(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("connect-ok"))
	}))
	defer upstream.Close()

	engine := testEngine(t, upstream.URL)
	mux := http.NewServeMux()
	path, handler := gatewayv1connect.NewCloudLadderGatewayServiceHandler(NewConnectService(engine, testAuthenticator(t, false)))
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	defer server.Close()

	client := gatewayv1connect.NewCloudLadderGatewayServiceClient(server.Client(), server.URL)
	resp, err := client.Invoke(t.Context(), connect.NewRequest(&gatewayv1.ProxyRequest{
		RouteId: "default",
		Method:  http.MethodPost,
		Path:    "/anything",
		Body:    []byte("hello"),
	}))
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if got := string(resp.Msg.GetBody()); got != "connect-ok" {
		t.Fatalf("unexpected body %q", got)
	}
}

func TestGinHTTPInvoke(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/http-path" {
			t.Fatalf("expected /http-path, got %s", got)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("gin-ok"))
	}))
	defer upstream.Close()

	engine := testEngine(t, upstream.URL)
	router := NewGinRouter(engine, testAuthenticator(t, false), config.DefaultMaxBodyBytes)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/proxy/default/http-path", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "gin-ok" {
		t.Fatalf("unexpected body %q", got)
	}
}

func TestGinHTTPSignedTunnelUsesExistingProxyRoute(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/sdk-path" {
			t.Fatalf("expected /sdk-path, got %s", got)
		}
		if got := r.Host; got != "billing.dev.tencentcloudapi.com" {
			t.Fatalf("expected trusted upstream Host, got %q", got)
		}
		if got := r.Header.Get("X-CloudLadder-Route"); got != "" {
			t.Fatalf("expected route header stripped, got %q", got)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("signed-gin-ok"))
	}))
	defer upstream.Close()

	engine, err := proxy.NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:   "tcapi-billing-cn-dev",
			Mode: config.RouteModeSignedHTTPTunnel,
			Upstream: config.UpstreamConfig{
				BaseURL: upstream.URL,
				Headers: map[string]string{
					"Host": "billing.dev.tencentcloudapi.com",
				},
			},
		}},
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	router := NewGinRouter(engine, testAuthenticator(t, false), config.DefaultMaxBodyBytes)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/proxy/tcapi-billing-cn-dev/sdk-path?x=1", nil)
	req.Header.Set("X-CloudLadder-Signed-Host", "billing.dev.tencentcloudapi.com")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "signed-gin-ok" {
		t.Fatalf("unexpected body %q", got)
	}
}

func TestGinHTTPSignedTunnelPreservesEscapedPathForAuthAndUpstream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.EscapedPath(); got != "/sdk/a%2Fb" {
			t.Fatalf("expected escaped upstream path /sdk/a%%2Fb, got %s", got)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("escaped-ok"))
	}))
	defer upstream.Close()

	engine, err := proxy.NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:   "tcapi-billing-cn-dev",
			Mode: config.RouteModeSignedHTTPTunnel,
			Upstream: config.UpstreamConfig{
				BaseURL: upstream.URL,
				Headers: map[string]string{
					"Host": "billing.dev.tencentcloudapi.com",
				},
			},
		}},
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	t.Setenv("TEST_SHADOW_SECRET", "secret")
	authenticator, err := auth.New(config.Config{
		Auth: config.AuthConfig{
			Enabled:       true,
			TimestampSkew: "5m",
			Callers: []config.CallerConfig{{
				ID:        "shadow",
				SecretEnv: "TEST_SHADOW_SECRET",
				Routes:    []string{"tcapi-billing-cn-dev"},
			}},
		},
		Routes: []config.RouteConfig{{ID: "tcapi-billing-cn-dev"}},
	})
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}
	router := NewGinRouter(engine, authenticator, config.DefaultMaxBodyBytes)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/proxy/tcapi-billing-cn-dev/sdk/a%2Fb?Action=CreateOrders", nil)
	timestamp := time.Now().UTC().Format(time.RFC3339)
	req.Header.Set("X-CloudLadder-Signed-Host", "billing.dev.tencentcloudapi.com")
	req.Header.Set("X-CloudLadder-Caller", "shadow")
	req.Header.Set("X-CloudLadder-Timestamp", timestamp)
	req.Header.Set("X-CloudLadder-Signature", auth.Sign("secret", auth.Request{
		Caller:    "shadow",
		RouteID:   "tcapi-billing-cn-dev",
		Method:    http.MethodPost,
		Path:      "/sdk/a%2Fb",
		Query:     "Action=CreateOrders",
		Timestamp: timestamp,
	}))
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		body, _ := io.ReadAll(rec.Body)
		t.Fatalf("expected 200, got %d body=%s", rec.Code, body)
	}
	if got := rec.Body.String(); got != "escaped-ok" {
		t.Fatalf("unexpected body %q", got)
	}
}

func TestGinHTTPRejectsUnsignedRequestWhenAuthEnabled(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called")
	}))
	defer upstream.Close()

	router := NewGinRouter(testEngine(t, upstream.URL), testAuthenticator(t, true), config.DefaultMaxBodyBytes)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/proxy/default/http-path", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGinHTTPExternalRouteForwardsToConfiguredUpstreamPath(t *testing.T) {
	t.Setenv("TEST_CALLBACK_TOKEN", "callback-token")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/auth/internal/tencentcloud/account" {
			t.Fatalf("expected callback upstream path, got %s", got)
		}
		if got := r.Header.Get("X-Shadow-Callback-Token"); got != "callback-token" {
			t.Fatalf("expected callback token header, got %q", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if got := string(body); got != `{"interface":{"interfaceName":"qcloud.saas.checkSaaSAccountExist"}}` {
			t.Fatalf("unexpected body %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"returnCode":0}`))
	}))
	defer upstream.Close()

	cfg := config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Auth: config.AuthConfig{
			Enabled:              true,
			TimestampSkew:        "5m",
			AllowUnauthenticated: []string{"tencentcloud-account-callback-sandbox-bj-7"},
		},
		Routes: []config.RouteConfig{{
			ID: "tencentcloud-account-callback-sandbox-bj-7",
			Upstream: config.UpstreamConfig{
				BaseURL:        upstream.URL,
				AllowedMethods: []string{http.MethodPost},
				HeadersFromEnv: map[string]string{
					"X-Shadow-Callback-Token": "TEST_CALLBACK_TOKEN",
				},
			},
		}},
		External: []config.ExternalRoute{{
			Path:         "/internal/tencentcloud/account",
			Methods:      []string{http.MethodPost},
			RouteID:      "tencentcloud-account-callback-sandbox-bj-7",
			UpstreamPath: "/auth/internal/tencentcloud/account",
		}},
	}
	engine, err := proxy.NewEngine(cfg)
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	authenticator, err := auth.New(cfg)
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}
	router := NewGinRouter(engine, authenticator, config.DefaultMaxBodyBytes, cfg.External...)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/internal/tencentcloud/account", strings.NewReader(`{"interface":{"interfaceName":"qcloud.saas.checkSaaSAccountExist"}}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != `{"returnCode":0}` {
		t.Fatalf("unexpected body %q", got)
	}
}

func TestGinHTTPUnknownRouteIsQuiet404(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called")
	}))
	defer upstream.Close()

	capture := &captureAuditor{}
	engine, err := proxy.NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:       "default",
			Upstream: config.UpstreamConfig{BaseURL: upstream.URL},
		}},
	}, proxy.WithAuditor(capture))
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	router := NewGinRouter(engine, testAuthenticator(t, false), config.DefaultMaxBodyBytes)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/proxy/internet-scan/wp-login.php", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
	if capture.count != 0 {
		t.Fatalf("expected no audit events for unknown route, got %d", capture.count)
	}
}

func testEngine(t *testing.T, upstreamURL string) *proxy.Engine {
	t.Helper()
	engine, err := proxy.NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:       "default",
			Upstream: config.UpstreamConfig{BaseURL: upstreamURL},
		}},
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	return engine
}

func testAuthenticator(t *testing.T, enabled bool) *auth.Authenticator {
	t.Helper()
	t.Setenv("TEST_CALLER_SECRET", "secret")
	authenticator, err := auth.New(config.Config{
		Auth: config.AuthConfig{
			Enabled:       enabled,
			TimestampSkew: "5m",
			Callers: []config.CallerConfig{{
				ID:        "test",
				SecretEnv: "TEST_CALLER_SECRET",
				Routes:    []string{"default"},
			}},
		},
		Routes: []config.RouteConfig{{ID: "default"}},
	})
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}
	return authenticator
}

type captureAuditor struct {
	count int
}

func (a *captureAuditor) Record(_ context.Context, _ audit.Event) {
	a.count++
}
