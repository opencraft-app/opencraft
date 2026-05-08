package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

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
