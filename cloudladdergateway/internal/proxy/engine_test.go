package proxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/audit"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
)

func TestEngineInvokeRoutesByStarlarkAndMirrorsWebhook(t *testing.T) {
	webhookCalls := 0
	webhook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		webhookCalls++
		if r.URL.Path != "/v1/tasks" {
			t.Fatalf("expected mirrored path /v1/tasks, got %s", r.URL.Path)
		}
		if got := r.Header.Get("X-CloudLadder-Webhook"); got != "mirror" {
			t.Fatalf("expected webhook header, got %q", got)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer webhook.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if got := r.Header.Get("X-CloudLadder-Route"); got != "sandbox" {
			t.Fatalf("expected route header, got %q", got)
		}
		w.Header().Set("X-Upstream", "ok")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	engine, err := NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:        "sandbox",
			Condition: `request.method == "POST" and request.attributes.get("env") == "sandbox"`,
			Upstream: config.UpstreamConfig{
				BaseURL:        upstream.URL,
				AllowedMethods: []string{http.MethodPost},
			},
			Webhooks: []config.WebhookConfig{{
				ID:              "mirror",
				URL:             webhook.URL,
				Mode:            "sync",
				ForwardOriginal: true,
				Condition:       "response.status_code == 201",
			}},
		}},
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	resp, err := engine.Invoke(context.Background(), Request{
		Method:     http.MethodPost,
		Path:       "/v1/tasks",
		Headers:    http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{"name":"demo"}`),
		Attributes: map[string]string{"env": "sandbox"},
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", resp.StatusCode)
	}
	if string(resp.Body) != `{"ok":true}` {
		t.Fatalf("unexpected body %s", resp.Body)
	}
	if webhookCalls != 1 {
		t.Fatalf("expected one webhook call, got %d", webhookCalls)
	}
	if len(resp.WebhookDeliveries) != 1 || resp.WebhookDeliveries[0].Status != "delivered" {
		t.Fatalf("unexpected deliveries %+v", resp.WebhookDeliveries)
	}
}

func TestEngineSignedHTTPTunnelPreservesSignedRequestAndStripsControlHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/v1/orders" || r.URL.RawQuery != "region=ap-guangzhou" {
			t.Fatalf("unexpected target %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"order":1}` {
			t.Fatalf("unexpected body %q", body)
		}
		if r.Host != "billing.dev.tencentcloudapi.com" {
			t.Fatalf("expected trusted upstream Host, got %q", r.Host)
		}
		if got := r.Header.Get("Authorization"); got != "TC3-HMAC-SHA256 signed" {
			t.Fatalf("expected Authorization preserved, got %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("expected Content-Type preserved, got %q", got)
		}
		if got := r.Header.Get("X-TC-Action"); got != "CreateOrders" {
			t.Fatalf("expected X-TC-Action preserved, got %q", got)
		}
		for _, name := range []string{
			"X-CloudLadder-Caller",
			"X-CloudLadder-Timestamp",
			"X-CloudLadder-Signature",
			"X-CloudLadder-Signed-Host",
			"X-CloudLadder-Route",
			"X-CloudLadder-Request-ID",
			"X-Caller",
			"X-Service-Name",
		} {
			if got := r.Header.Get(name); got != "" {
				t.Fatalf("expected %s stripped, got %q", name, got)
			}
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("signed-ok"))
	}))
	defer upstream.Close()

	engine, err := NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:   "tcapi-billing-cn-dev",
			Mode: config.RouteModeSignedHTTPTunnel,
			Upstream: config.UpstreamConfig{
				BaseURL: upstream.URL,
				Headers: map[string]string{
					"Host": "billing.dev.tencentcloudapi.com",
				},
				AllowedMethods: []string{http.MethodPost},
			},
		}},
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	resp, err := engine.Invoke(context.Background(), Request{
		RouteID: "tcapi-billing-cn-dev",
		Method:  http.MethodPost,
		Path:    "/v1/orders",
		Query:   "region=ap-guangzhou",
		Headers: http.Header{
			"Authorization":             []string{"TC3-HMAC-SHA256 signed"},
			"Content-Type":              []string{"application/json"},
			"X-TC-Action":               []string{"CreateOrders"},
			"X-CloudLadder-Caller":      []string{"shadow"},
			"X-CloudLadder-Timestamp":   []string{"2026-05-11T00:00:00Z"},
			"X-CloudLadder-Signature":   []string{"sha256=test"},
			"X-CloudLadder-Signed-Host": []string{"BILLING.DEV.TENCENTCLOUDAPI.COM:80"},
			"X-CloudLadder-Route":       []string{"spoofed"},
			"X-CloudLadder-Request-ID":  []string{"req-1"},
			"X-Caller":                  []string{"alias-caller"},
			"X-Service-Name":            []string{"alias-service"},
		},
		Body: []byte(`{"order":1}`),
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if string(resp.Body) != "signed-ok" {
		t.Fatalf("unexpected body %q", resp.Body)
	}
}

func TestEngineSignedHTTPTunnelPreservesEscapedPath(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.EscapedPath(); got != "/v1/a%2Fb" {
			t.Fatalf("expected escaped path /v1/a%%2Fb, got %s", got)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("escaped-ok"))
	}))
	defer upstream.Close()

	engine, err := NewEngine(config.Config{
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

	resp, err := engine.Invoke(context.Background(), Request{
		RouteID: "tcapi-billing-cn-dev",
		Method:  http.MethodPost,
		Path:    "/v1/a%2Fb",
		Headers: http.Header{
			"X-CloudLadder-Signed-Host": []string{"billing.dev.tencentcloudapi.com"},
		},
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if string(resp.Body) != "escaped-ok" {
		t.Fatalf("unexpected body %q", resp.Body)
	}
}

func TestEngineSignedHTTPTunnelRejectsSignedHostMismatch(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called")
	}))
	defer upstream.Close()

	engine, err := NewEngine(config.Config{
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

	_, err = engine.Invoke(context.Background(), Request{
		RouteID: "tcapi-billing-cn-dev",
		Method:  http.MethodPost,
		Path:    "/",
		Headers: http.Header{"X-CloudLadder-Signed-Host": []string{"account.dev.tencentcloudapi.com"}},
	})
	if !errors.Is(err, ErrSignedHostMismatch) {
		t.Fatalf("expected ErrSignedHostMismatch, got %v", err)
	}
}

func TestEngineSignedHTTPTunnelRequiresSignedHost(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called")
	}))
	defer upstream.Close()

	engine, err := NewEngine(config.Config{
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

	_, err = engine.Invoke(context.Background(), Request{
		RouteID: "tcapi-billing-cn-dev",
		Method:  http.MethodPost,
		Path:    "/",
	})
	if !errors.Is(err, ErrSignedHostMismatch) {
		t.Fatalf("expected ErrSignedHostMismatch, got %v", err)
	}
}

func TestEngineRejectsUnmatchedCondition(t *testing.T) {
	engine, err := NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:        "sandbox",
			Condition: `request.attributes.get("env") == "sandbox"`,
			Upstream:  config.UpstreamConfig{BaseURL: "http://127.0.0.1"},
		}},
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	_, err = engine.Invoke(context.Background(), Request{
		Method:     http.MethodPost,
		Path:       "/v1/tasks",
		Attributes: map[string]string{"env": "prod"},
	})
	if err == nil {
		t.Fatal("expected no route error")
	}
}

func TestEngineRejectsUnsupportedRequestMethodBeforeProxy(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called")
	}))
	defer upstream.Close()

	engine, err := NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:       "billing.query_bill",
			Upstream: config.UpstreamConfig{BaseURL: upstream.URL},
		}},
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	_, err = engine.Invoke(context.Background(), Request{
		RouteID: "billing.query_bill",
		Method:  "BREW",
		Path:    "/bill/query",
	})
	if !errors.Is(err, ErrInvalidMethod) {
		t.Fatalf("expected ErrInvalidMethod, got %v", err)
	}
}

func TestNewEngineRejectsUnsupportedConfiguredMethod(t *testing.T) {
	_, err := NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID: "billing.query_bill",
			Upstream: config.UpstreamConfig{
				BaseURL:        "http://127.0.0.1",
				AllowedMethods: []string{"BREW"},
			},
		}},
	})
	if !errors.Is(err, ErrInvalidMethod) {
		t.Fatalf("expected ErrInvalidMethod for upstream method, got %v", err)
	}

	_, err = NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:       "billing.query_bill",
			Upstream: config.UpstreamConfig{BaseURL: "http://127.0.0.1"},
			Webhooks: []config.WebhookConfig{{
				ID:     "mirror",
				URL:    "http://127.0.0.1/webhook",
				Method: "BREW",
			}},
		}},
	})
	if !errors.Is(err, ErrInvalidMethod) {
		t.Fatalf("expected ErrInvalidMethod for webhook method, got %v", err)
	}
}

func TestEngineEmitsAuditEvent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()

	capture := &captureAuditor{}
	engine, err := NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:       "billing.query_bill",
			Upstream: config.UpstreamConfig{BaseURL: upstream.URL},
		}},
	}, WithAuditor(capture))
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	_, err = engine.Invoke(context.Background(), Request{
		RequestID: "req-123",
		Caller:    "payment",
		RouteID:   "billing.query_bill",
		Method:    http.MethodPost,
		Path:      "/bill/query",
		Body:      []byte(`{"account_id":"redacted-in-audit"}`),
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if len(capture.events) != 1 {
		t.Fatalf("expected one audit event, got %d", len(capture.events))
	}
	event := capture.events[0]
	if event.RequestID != "req-123" || event.Caller != "payment" || event.Operation != "billing.query_bill" {
		t.Fatalf("unexpected audit identity: %+v", event)
	}
	if event.StatusCode != http.StatusOK || event.DurationMS < 0 {
		t.Fatalf("unexpected audit status/duration: %+v", event)
	}
	if event.RequestBodyBytes == 0 || event.RequestBodySHA256 == "" {
		t.Fatalf("expected request body summary, got %+v", event)
	}
	if event.Error != "" {
		t.Fatalf("unexpected audit error %q", event.Error)
	}
}

func TestEngineResolvesPolarisUpstream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/bill/query" {
			t.Fatalf("expected /bill/query, got %s", got)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("polaris-ok"))
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}

	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"info":"ok","instances":[{"host":"` + upstreamURL.Hostname() + `","port":` + upstreamURL.Port() + `}]}`))
	}))
	defer sidecar.Close()

	engine, err := NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Discovery: config.DiscoveryConfig{
			Polaris: config.PolarisDiscoveryConfig{SidecarURL: sidecar.URL, CacheTTL: "30s"},
		},
		Routes: []config.RouteConfig{{
			ID: "billing.query_bill",
			Upstream: config.UpstreamConfig{
				Scheme: "http",
				Polaris: config.PolarisUpstreamConfig{
					Service:   "billing",
					Namespace: "Production",
				},
			},
		}},
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	resp, err := engine.Invoke(context.Background(), Request{
		RouteID: "billing.query_bill",
		Method:  http.MethodPost,
		Path:    "/bill/query",
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if string(resp.Body) != "polaris-ok" {
		t.Fatalf("unexpected body %q", resp.Body)
	}
	if resp.UpstreamURL != upstream.URL+"/bill/query" {
		t.Fatalf("unexpected upstream url %q", resp.UpstreamURL)
	}
}

func TestEngineUsesBackendAlias(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Host; got != "trade.tencentyun.com" {
			t.Fatalf("expected Host header trade.tencentyun.com, got %q", got)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("backend-ok"))
	}))
	defer upstream.Close()

	engine, err := NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Backends: []config.BackendConfig{{
			Alias: "billing-trade-cn-prod",
			Upstream: config.UpstreamConfig{
				BaseURL:        upstream.URL,
				AllowedMethods: []string{http.MethodPost},
				Headers:        map[string]string{"Host": "trade.tencentyun.com"},
			},
		}},
		Routes: []config.RouteConfig{{
			ID:       "qcbuy.price.get_price",
			Upstream: config.UpstreamConfig{Backend: "billing-trade-cn-prod"},
		}},
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	resp, err := engine.Invoke(context.Background(), Request{
		RouteID: "qcbuy.price.get_price",
		Method:  http.MethodPost,
		Path:    "/interfaces/interface.php",
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if string(resp.Body) != "backend-ok" {
		t.Fatalf("unexpected body %q", resp.Body)
	}
}

type captureAuditor struct {
	events []audit.Event
}

func (a *captureAuditor) Record(_ context.Context, event audit.Event) {
	a.events = append(a.events, event)
}
