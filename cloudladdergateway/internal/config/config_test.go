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

func TestLoadAppliesRouteBaseURLOverride(t *testing.T) {
	t.Setenv("CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_BASE_URL", "https://api-sandbox-kr-1.lightclaw.tech")
	t.Setenv("CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_JP_BASE_URL", "https://api-sandbox-kr-1.lightclaw.tech")
	t.Setenv("CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_SG_BASE_URL", "https://api-sandbox-kr-1.lightclaw.tech")
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: jifei-callback
    upstream:
      base_url: "https://lightclaw.tech"
  - id: jifei-callback-jp
    upstream:
      base_url: "https://kr.lightclaw.tech"
  - id: jifei-callback-sg
    upstream:
      base_url: "https://api.lightvela.ai"
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := cfg.Routes[0].Upstream.BaseURL; got != "https://api-sandbox-kr-1.lightclaw.tech" {
		t.Fatalf("route base_url override = %q", got)
	}
	if got := cfg.Routes[1].Upstream.BaseURL; got != "https://api-sandbox-kr-1.lightclaw.tech" {
		t.Fatalf("regional route base_url override = %q", got)
	}
	if got := cfg.Routes[2].Upstream.BaseURL; got != "https://api-sandbox-kr-1.lightclaw.tech" {
		t.Fatalf("singapore route base_url override = %q", got)
	}
}

func TestLoadAppliesRouteHostHeaderOverride(t *testing.T) {
	t.Setenv("CLOUDLADDERGATEWAY_ROUTE_JIFEI_TEST_HOST_HEADER", "test.trade-intl.billing.tencentyun.com")
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
backends:
  - alias: jifei-test
    upstream:
      base_url: "http://9.139.137.40"
      headers:
        Host: trade.itd.com
routes:
  - id: jifei-test
    upstream:
      backend: jifei-test
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	upstream, err := cfg.ResolveUpstream("jifei-test", cfg.Routes[0].Upstream)
	if err != nil {
		t.Fatalf("resolve upstream: %v", err)
	}
	if got := upstream.Headers["Host"]; got != "test.trade-intl.billing.tencentyun.com" {
		t.Fatalf("route Host override = %q", got)
	}
}

func TestLoadAppliesBackendBaseURLOverride(t *testing.T) {
	t.Setenv("CLOUDLADDERGATEWAY_TENCENTCLOUD_ACCOUNT_CALLBACK_BASE_URL", "https://api.lightvela.com")
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
backends:
  - alias: lightclaw-auth-beijing-sandbox
    env_prefix: CLOUDLADDERGATEWAY_TENCENTCLOUD_ACCOUNT_CALLBACK
    upstream:
      base_url: "https://lightclaw.tech"
      timeout: 10s
routes:
  - id: tencentcloud-account-callback-beijing-sandbox
    upstream:
      backend: lightclaw-auth-beijing-sandbox
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	upstream, err := cfg.ResolveUpstream("tencentcloud-account-callback-beijing-sandbox", cfg.Routes[0].Upstream)
	if err != nil {
		t.Fatalf("resolve upstream: %v", err)
	}
	if got := upstream.BaseURL; got != "https://api.lightvela.com" {
		t.Fatalf("backend base_url override = %q", got)
	}
	if got := cfg.Routes[0].Upstream.Backend; got != "lightclaw-auth-beijing-sandbox" {
		t.Fatalf("route backend = %q", got)
	}
}

func TestExampleConfigLoads(t *testing.T) {
	t.Setenv("CLOUDLADDER_PAYMENT_HMAC_SECRET", "test-secret")
	cfg, err := Load("../../config.example.yaml")
	if err != nil {
		t.Fatalf("load example config: %v", err)
	}
	wantRoutes := map[string]bool{
		"billing-trade-cn-test":                false,
		"billing-trade-cn-pre":                 false,
		"billing-trade-cn-prod":                false,
		"billing-trade-intl-test":              false,
		"billing-trade-intl-pre":               false,
		"billing-trade-intl-prod":              false,
		"tcapi-account-cn-dev":                 false,
		"tcapi-billing-cn-dev":                 false,
		"tcapi-account-cn-test":                false,
		"tcapi-cam-cn-test":                    false,
		"tcapi-sts-cn-test":                    false,
		"tcapi-account-cn-prod":                false,
		"tcapi-cam-cn-prod":                    false,
		"tcapi-sts-cn-prod":                    false,
		"jifei-test":                           false,
		"shadow-account-test":                  false,
		"shadow-cam-test":                      false,
		"shadow-sts-test":                      false,
		"shadow-account-prod":                  false,
		"shadow-cam-prod":                      false,
		"shadow-sts-prod":                      false,
		"shadow-billing-api-test":              false,
		"tencentcloud-account-callback-bjsbx":  false,
		"tencentcloud-account-callback-krsbx":  false,
		"tencentcloud-account-callback-shprod": false,
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
			case "tencentcloud-account-callback-bjsbx":
				wantBackend = "lightclaw-auth-bjsbx"
			case "tencentcloud-account-callback-krsbx":
				wantBackend = "lightclaw-auth-krsbx"
			case "tencentcloud-account-callback-shprod":
				wantBackend = "lightclaw-auth-shprod"
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
	tencentCallback := findExternalRouteForTest(cfg.External, "/internal/tencentcloud/account")
	if tencentCallback == nil {
		t.Fatalf("example config missing TencentCloud callback external route: %+v", cfg.External)
	}
	if got := tencentCallback.AuthCodeRoutes; len(got) != 3 ||
		got[0].Prefix != "bjsbx." || got[0].RouteID != "tencentcloud-account-callback-bjsbx" ||
		got[1].Prefix != "krsbx." || got[1].RouteID != "tencentcloud-account-callback-krsbx" ||
		got[2].Prefix != "shprod." || got[2].RouteID != "tencentcloud-account-callback-shprod" {
		t.Fatalf("example config missing auth-code callback routes: %+v", got)
	}
	if got := tencentCallback.UserIDRoutes; len(got) != 1 || got[0].UserID != "u4912323654" || got[0].RouteID != "tencentcloud-account-callback-bjsbx" {
		t.Fatalf("example config missing legacy user-id callback route: %+v", got)
	}
	if got := tencentCallback.UserIDPrefixRoutes; len(got) != 2 ||
		got[0].Prefix != "bjsbx_" || got[0].RouteID != "tencentcloud-account-callback-bjsbx" ||
		got[1].Prefix != "krsbx_" || got[1].RouteID != "tencentcloud-account-callback-krsbx" {
		t.Fatalf("example config missing user-id prefix callback route: %+v", got)
	}
	cloudapi := findExternalRouteForTest(cfg.External, "/cloudapi")
	if cloudapi == nil || cloudapi.RouteID != "lightvela-cloudapi-sh" || cloudapi.UpstreamPath != "/cloudapi" {
		t.Fatalf("example config missing LightVela cloud api external route: %+v", cfg.External)
	}
	if got := cloudapi.HeaderRoutes; len(got) != 2 ||
		got[0].Name != "X-TC-Region" || got[0].Value != "ap-beijing" || got[0].RouteID != "lightvela-cloudapi-bj" ||
		got[1].Name != "X-TC-Region" || got[1].Value != "ap-shanghai" || got[1].RouteID != "lightvela-cloudapi-sh" {
		t.Fatalf("example config missing cloud api region header routes: %+v", got)
	}
}

func findExternalRouteForTest(routes []ExternalRoute, path string) *ExternalRoute {
	for i := range routes {
		if routes[i].Path == path {
			return &routes[i]
		}
	}
	return nil
}

func TestExampleConfigIncludesRegionalJifeiCallbacks(t *testing.T) {
	cfg, err := Load("../../config.example.yaml")
	if err != nil {
		t.Fatalf("load example config: %v", err)
	}

	wantBaseURL := map[string]string{
		"jifei-callback-bj":  "https://lightclaw.tech",
		"jifei-callback-sh":  "https://api.lightvela.com",
		"jifei-callback-gz":  "https://lightclaw.tech",
		"jifei-callback-cd":  "https://lightclaw.tech",
		"jifei-callback-nj":  "https://lightclaw.tech",
		"jifei-callback-hk":  "https://kr.lightclaw.tech",
		"jifei-callback-jp":  "https://kr.lightclaw.tech",
		"jifei-callback-kr":  "https://kr.lightclaw.tech",
		"jifei-callback-jkt": "https://kr.lightclaw.tech",
		"jifei-callback-sg":  "https://api.lightvela.ai",
		"jifei-callback-th":  "https://kr.lightclaw.tech",
	}

	for _, route := range cfg.Routes {
		want, ok := wantBaseURL[route.ID]
		if !ok {
			continue
		}
		if route.Condition != `request.method == "POST"` {
			t.Fatalf("route %q condition = %q", route.ID, route.Condition)
		}
		if got := route.Upstream.BaseURL; got != want {
			t.Fatalf("route %q base_url = %q, want %q", route.ID, got, want)
		}
		if len(route.Upstream.AllowedMethods) != 1 || route.Upstream.AllowedMethods[0] != "POST" {
			t.Fatalf("route %q allowed_methods = %#v", route.ID, route.Upstream.AllowedMethods)
		}
		delete(wantBaseURL, route.ID)
	}
	for routeID := range wantBaseURL {
		t.Fatalf("example config missing regional callback route %q", routeID)
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
