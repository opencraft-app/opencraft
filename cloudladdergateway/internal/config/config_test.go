package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadEnablesOTLPAuditFromStandardEnv(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "http://otel-collector:4318/v1/logs")
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: billing.query_bill
    upstream:
      base_url: "http://idc-billing.internal"
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !cfg.Audit.OTLP.Enabled {
		t.Fatal("expected OTLP audit logs to be enabled from env")
	}
}

func TestExampleConfigLoads(t *testing.T) {
	t.Setenv("CLOUDLADDER_PAYMENT_HMAC_SECRET", "test-secret")
	cfg, err := Load("../../config.example.yaml")
	if err != nil {
		t.Fatalf("load example config: %v", err)
	}
	wantRoutes := map[string]bool{
		"billing-trade-cn-test":                      false,
		"billing-trade-cn-pre":                       false,
		"billing-trade-cn-prod":                      false,
		"billing-trade-intl-test":                    false,
		"billing-trade-intl-pre":                     false,
		"billing-trade-intl-prod":                    false,
		"tcapi-account-cn-dev":                       false,
		"tcapi-billing-cn-dev":                       false,
		"tcapi-account-cn-test":                      false,
		"tcapi-cam-cn-test":                          false,
		"tcapi-sts-cn-test":                          false,
		"tcapi-account-cn-prod":                      false,
		"tcapi-cam-cn-prod":                          false,
		"tcapi-sts-cn-prod":                          false,
		"jifei-test":                                 false,
		"shadow-account-test":                        false,
		"shadow-cam-test":                            false,
		"shadow-sts-test":                            false,
		"shadow-account-prod":                        false,
		"shadow-cam-prod":                            false,
		"shadow-sts-prod":                            false,
		"shadow-billing-api-test":                    false,
		"tencentcloud-account-callback-sandbox-bj-7": false,
	}
	for _, route := range cfg.Routes {
		if _, ok := wantRoutes[route.ID]; ok {
			wantRoutes[route.ID] = true
			wantBackend := route.ID
			switch route.ID {
			case "shadow-account-test":
				wantBackend = "tcapi-account-cn-test"
			case "shadow-cam-test":
				wantBackend = "tcapi-cam-cn-test"
			case "shadow-sts-test":
				wantBackend = "tcapi-sts-cn-test"
			case "shadow-account-prod":
				wantBackend = "tcapi-account-cn-prod"
			case "shadow-cam-prod":
				wantBackend = "tcapi-cam-cn-prod"
			case "shadow-sts-prod":
				wantBackend = "tcapi-sts-cn-prod"
			case "shadow-billing-api-test":
				wantBackend = "tcapi-billing-cn-dev"
			case "tencentcloud-account-callback-sandbox-bj-7":
				wantBackend = "lightclaw-auth-sandbox-bj-7"
			}
			if route.Upstream.Backend != wantBackend {
				t.Fatalf("route %q should use matching backend alias, got %q", route.ID, route.Upstream.Backend)
			}
			if (strings.HasPrefix(route.ID, "tcapi-") || strings.HasPrefix(route.ID, "shadow-")) && route.Mode != RouteModeSignedHTTPTunnel {
				t.Fatalf("route %q should use signed tunnel mode, got %q", route.ID, route.Mode)
			}
		}
	}
	for routeID, found := range wantRoutes {
		if !found {
			t.Fatalf("example config missing route %q", routeID)
		}
	}
	if len(cfg.External) != 1 || cfg.External[0].Path != "/internal/tencentcloud/account" {
		t.Fatalf("example config missing TencentCloud callback external route: %+v", cfg.External)
	}
}

func TestLoadValidatesSignedHTTPRouteMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: tcapi-billing-cn-dev
    mode: signed_http_tunnel
    upstream:
      base_url: https://billing.dev.tencentcloudapi.com
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if _, err := Load(path); err != nil {
		t.Fatalf("load signed tunnel route: %v", err)
	}
}

func TestLoadRejectsUnknownRouteMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: tcapi-billing-cn-dev
    mode: magic_tunnel
    upstream:
      base_url: https://billing.dev.tencentcloudapi.com
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected unknown route mode to fail")
	}
}

func TestLoadRejectsSignedHTTPRouteWithoutTrustedHost(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: tcapi-billing-cn-dev
    mode: signed_http_tunnel
    upstream:
      scheme: https
      polaris:
        service: billing
        namespace: Test
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected signed tunnel without trusted host to fail")
	}
}

func TestLoadRejectsSignedHTTPRouteWithWebhook(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: tcapi-billing-cn-dev
    mode: signed_http_tunnel
    upstream:
      base_url: https://billing.dev.tencentcloudapi.com
    webhooks:
      - id: mirror
        url: https://example.com/webhook
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected signed tunnel webhook to fail")
	}
}

func TestLoadAcceptsPolarisUpstreamAndDefaultsDiscovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: billing.query_bill
    upstream:
      scheme: http
      polaris:
        service: billing
        namespace: Production
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Discovery.Polaris.SidecarURL != "http://127.0.0.1:8080" {
		t.Fatalf("unexpected sidecar default %q", cfg.Discovery.Polaris.SidecarURL)
	}
	if cfg.Discovery.Polaris.StaleOnError == nil || !*cfg.Discovery.Polaris.StaleOnError {
		t.Fatal("expected stale_on_error to default true")
	}
	if cfg.Transport.MaxIdleConns != 100 || cfg.Transport.MaxIdleConnsPerHost != 20 {
		t.Fatalf("unexpected transport defaults %+v", cfg.Transport)
	}
}

func TestLoadRejectsAmbiguousUpstream(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: billing.query_bill
    upstream:
      base_url: http://billing.internal
      polaris:
        service: billing
        namespace: Production
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("expected ambiguous upstream config to fail")
	}
}

func TestLoadResolvesBackendAlias(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
backends:
  - alias: billing-trade-cn-prod
    upstream:
      scheme: http
      polaris:
        service: "1333953:131072"
        namespace: Production
      timeout: 5s
      allowed_methods: ["POST"]
      headers:
        Host: trade.tencentyun.com
routes:
  - id: qcbuy.price.get_price
    upstream:
      backend: billing-trade-cn-prod
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	upstream, err := cfg.ResolveUpstream("qcbuy.price.get_price", cfg.Routes[0].Upstream)
	if err != nil {
		t.Fatalf("resolve upstream: %v", err)
	}
	if upstream.Polaris.Service != "1333953:131072" || upstream.Polaris.Namespace != "Production" {
		t.Fatalf("unexpected polaris upstream %+v", upstream.Polaris)
	}
	if upstream.Headers["Host"] != "trade.tencentyun.com" {
		t.Fatalf("expected Host header, got %+v", upstream.Headers)
	}
	if len(upstream.AllowedMethods) != 1 || upstream.AllowedMethods[0] != "POST" {
		t.Fatalf("unexpected allowed methods %+v", upstream.AllowedMethods)
	}
}

func TestLoadRejectsUnknownBackendAlias(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: qcbuy.price.get_price
    upstream:
      backend: billing-trade-cn-prod
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("expected unknown backend alias to fail")
	}
}
