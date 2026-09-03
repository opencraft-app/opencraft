package gateway

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func deployConfigPaths(t *testing.T, repoRoot string) []string {
	t.Helper()

	matches, err := filepath.Glob(filepath.Join(repoRoot, "argocd/services/service-gateway/*/config.yaml"))
	if err != nil {
		t.Fatalf("find deploy configs: %v", err)
	}
	if len(matches) == 0 {
		t.Fatal("no service-gateway deploy configs found")
	}
	sort.Strings(matches)
	return matches
}

func TestDeployConfigsExposeOnlyExactFederationPublicPaths(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	want := map[string]struct{}{
		http.MethodGet + " /auth/federation/context":                    {},
		http.MethodPost + " /auth/federation/tickets":                   {},
		http.MethodPost + " /auth/federation/exchange":                  {},
		http.MethodPost + " /auth/federation/bots/{bot_id}/tat/session": {},
	}

	for _, configFile := range deployConfigPaths(t, repoRoot) {
		configFile := configFile
		t.Run(filepath.Base(filepath.Dir(configFile)), func(t *testing.T) {
			cfg, err := LoadConfigFile(configFile)
			if err != nil {
				t.Fatalf("load config: %v", err)
			}

			got := make(map[string]struct{}, len(want))
			for _, route := range cfg.Routes {
				if route.Prefix != "/auth" {
					continue
				}
				for _, rule := range route.PublicAllow {
					if !strings.HasPrefix(rule.Path, "/auth/federation") {
						continue
					}
					key := rule.Method + " " + rule.Path
					if _, allowed := want[key]; !allowed {
						t.Fatalf("unexpected federation public path %s", key)
					}
					got[key] = struct{}{}
				}
			}

			if len(got) != len(want) {
				t.Fatalf("federation public allowlist has %d rules, want %d: %+v", len(got), len(want), got)
			}
			for key := range want {
				if _, ok := got[key]; !ok {
					t.Fatalf("federation public allowlist missing %s", key)
				}
			}
		})
	}
}

func TestProductionOIDCRoutesExposeOnlyProtocolEndpoints(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	wantPaths := map[string]struct{}{
		http.MethodGet + " /oauth2/authorize":                 {},
		http.MethodGet + " /oauth2/authorize/context":         {},
		http.MethodPost + " /oauth2/authorize":                {},
		http.MethodPost + " /oauth2/token":                    {},
		http.MethodGet + " /.well-known/openid-configuration": {},
		http.MethodGet + " /.well-known/jwks.json":            {},
	}
	for _, env := range []string{"sgprod", "shprod"} {
		t.Run(env, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, "argocd/services/service-gateway", env, "config.yaml"))
			if err != nil {
				t.Fatalf("load %s config: %v", env, err)
			}

			gotPaths := map[string]struct{}{}
			for _, route := range cfg.Routes {
				if route.Name != "oidc" && route.Name != "oidc-discovery" {
					continue
				}
				if route.Access != AccessPublic {
					t.Fatalf("OIDC protocol routes must be public and defer session checks to UserAuth: %+v", route)
				}
				if route.PathPolicy != PathPolicyAllowlist {
					t.Fatalf("OIDC route must use an exact path allowlist: %+v", route)
				}
				for _, rule := range route.PathAllow {
					gotPaths[rule.Method+" "+rule.Path] = struct{}{}
				}
			}

			if len(gotPaths) != len(wantPaths) {
				t.Fatalf("OIDC path allowlist = %+v, want %+v", gotPaths, wantPaths)
			}
			for key := range wantPaths {
				if _, ok := gotPaths[key]; !ok {
					t.Fatalf("OIDC path allowlist missing %s", key)
				}
			}
		})
	}
}

func TestKoreaPaymentMethodRoutesAreAuthenticatedAndAllowlisted(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	cfg, err := LoadConfigFile(filepath.Join(repoRoot, "argocd/services/service-gateway/sandbox-kr-1/config.yaml"))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	want := map[string]struct{}{
		http.MethodGet + " /auth/payment-methods":                         {},
		http.MethodPost + " /auth/payment-methods/sign-orders":            {},
		http.MethodPut + " /auth/payment-methods/{contract_code}/default": {},
		http.MethodDelete + " /auth/payment-methods/{contract_code}":      {},
	}
	wantOrigins := map[string]struct{}{
		"https://sandbox-kr-1.lightclaw.tech":              {},
		"https://intl-sandbox-kr-1.preview.lightclaw.tech": {},
		"https://lightvela-intl.pages.dev":                 {},
		"http://localhost:4173":                            {},
		"http://127.0.0.1:4173":                            {},
		"http://localhost:5173":                            {},
		"http://127.0.0.1:5173":                            {},
	}
	for _, route := range cfg.Routes {
		if route.Name != "auth-payment-methods" {
			continue
		}
		if route.Prefix != "/auth/payment-methods" || route.Access != AccessAuthenticated {
			t.Fatalf("payment method route must be authenticated and narrowly prefixed: %+v", route)
		}
		if route.RequireRealname {
			t.Fatal("international payment method route must not require realname")
		}
		if route.PathPolicy != PathPolicyAllowlist {
			t.Fatalf("path_policy = %q, want allowlist", route.PathPolicy)
		}
		if len(route.AllowedOrigins) != len(wantOrigins) {
			t.Fatalf("payment method allowed_origins has %d entries, want %d: %+v", len(route.AllowedOrigins), len(wantOrigins), route.AllowedOrigins)
		}
		for _, origin := range route.AllowedOrigins {
			if _, ok := wantOrigins[origin]; !ok {
				t.Fatalf("payment method route has unexpected allowed origin %q", origin)
			}
		}
		got := make(map[string]struct{}, len(route.PathAllow))
		for _, rule := range route.PathAllow {
			got[rule.Method+" "+rule.Path] = struct{}{}
		}
		if len(got) != len(want) {
			t.Fatalf("payment method path allowlist has %d rules, want %d: %+v", len(got), len(want), got)
		}
		for key := range want {
			if _, ok := got[key]; !ok {
				t.Fatalf("payment method path allowlist missing %s", key)
			}
		}
		return
	}
	t.Fatal("auth-payment-methods route not found")
}

func TestDeployConfigsScopePhoneAuthPublicRoutes(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))

	configPaths := []string{
		"argocd/services/service-gateway/beijing-sandbox/config.yaml",
		"argocd/services/service-gateway/beijing-sandbox-2/config.yaml",
		"argocd/services/service-gateway/sandbox-bj-7/config.yaml",
		"argocd/services/service-gateway/sgprod/config.yaml",
		"argocd/services/service-gateway/shprod/config.yaml",
	}
	phoneAuthPublicPaths := map[string]struct{}{
		"/auth/sms/send":   {},
		"/auth/sms/verify": {},
	}
	phoneAuthEnabled := map[string]bool{
		"argocd/services/service-gateway/beijing-sandbox/config.yaml": true,
		"argocd/services/service-gateway/sandbox-bj-7/config.yaml":    true,
		"argocd/services/service-gateway/shprod/config.yaml":          true,
	}

	for _, configPath := range configPaths {
		t.Run(configPath, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, configPath))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}

			publicPhoneAuthPaths := make(map[string]bool, len(phoneAuthPublicPaths))
			for _, route := range cfg.Routes {
				for _, rule := range route.PublicAllow {
					if rule.Method != http.MethodPost {
						continue
					}
					if _, phoneAuthPath := phoneAuthPublicPaths[rule.Path]; phoneAuthPath {
						if !phoneAuthEnabled[configPath] {
							t.Fatalf("phone auth endpoint must not be public while disabled: %s %s", rule.Method, rule.Path)
						}
						publicPhoneAuthPaths[rule.Path] = true
					}
				}
			}
			if phoneAuthEnabled[configPath] {
				for path := range phoneAuthPublicPaths {
					if !publicPhoneAuthPaths[path] {
						t.Fatalf("enabled phone auth endpoint must be public: POST %s", path)
					}
				}
			}
		})
	}
}

func TestDeployConfigsAllowOnlyFrontendInstanceRoutes(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))

	configPaths := []string{
		"argocd/services/service-gateway/beijing-sandbox/config.yaml",
		"argocd/services/service-gateway/beijing-sandbox-2/config.yaml",
		"argocd/services/service-gateway/sandbox-bj-7/config.yaml",
		"argocd/services/service-gateway/sgprod/config.yaml",
		"argocd/services/service-gateway/shprod/config.yaml",
	}
	want := map[string]struct{}{
		http.MethodGet + " /v1/instances":                                                                   {},
		http.MethodPost + " /v1/instances":                                                                  {},
		http.MethodGet + " /v1/instances/{instance_id}":                                                     {},
		http.MethodDelete + " /v1/instances/{instance_id}":                                                  {},
		http.MethodPost + " /v1/instances/{instance_id}/debug/exec":                                         {},
		http.MethodPost + " /v1/instances/{instance_id}/tat/session":                                        {},
		http.MethodPost + " /v1/instances/{instance_id}/config/reset":                                       {},
		http.MethodPost + " /v1/instances/{instance_id}/agentchat/launch-token":                             {},
		http.MethodPost + " /v1/instances/{instance_id}/channels/config":                                    {},
		http.MethodPost + " /v1/instances/{instance_id}/channels/weixin/login-sessions":                     {},
		http.MethodGet + " /v1/instances/{instance_id}/channels/weixin/login-sessions/{session_id}":         {},
		http.MethodGet + " /v1/instances/{instance_id}/channels/weixin/login-sessions/{session_id}/events":  {},
		http.MethodPost + " /v1/instances/{instance_id}/channels/weixin/login-sessions/{session_id}/cancel": {},
	}

	for _, configPath := range configPaths {
		t.Run(configPath, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, configPath))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			for _, route := range cfg.Routes {
				if route.Prefix != "/v1/instances" {
					continue
				}
				if route.PathPolicy != "allowlist" {
					t.Fatalf("instance route path_policy = %q, want allowlist", route.PathPolicy)
				}
				got := make(map[string]struct{}, len(route.PathAllow))
				for _, rule := range route.PathAllow {
					got[rule.Method+" "+rule.Path] = struct{}{}
				}
				if _, exposed := got[http.MethodGet+" /v1/instances/{instance_id}/borncard"]; exposed {
					t.Fatal("borncard must not be exposed by the gateway")
				}
				if len(got) != len(want) {
					t.Fatalf("instance path allowlist has %d rules, want %d: %+v", len(got), len(want), got)
				}
				for key := range want {
					if _, ok := got[key]; !ok {
						t.Fatalf("instance path allowlist missing %s", key)
					}
				}
				if _, exposed := got[http.MethodPost+" /v1/instances/{instance_id}/resume"]; exposed {
					t.Fatal("resume must not be exposed by the gateway")
				}
				return
			}
			t.Fatal("instance route not found")
		})
	}
}

func TestProductionChatOriginsAreScopedToBotListAndTATSession(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	tests := []struct {
		name        string
		configPath  string
		wantOrigins map[string]struct{}
	}{
		{
			name:       "Shanghai",
			configPath: "argocd/services/service-gateway/shprod/config.yaml",
			wantOrigins: map[string]struct{}{
				"https://chat.lightvela.com":      {},
				"https://localhost.lightvela.com": {},
				"https://chat.lightvela.ai":       {},
				"https://localhost.lightvela.ai":  {},
			},
		},
		{
			name:       "Singapore",
			configPath: "argocd/services/service-gateway/sgprod/config.yaml",
			wantOrigins: map[string]struct{}{
				"https://chat.lightvela.com":      {},
				"https://localhost.lightvela.com": {},
				"https://chat.lightvela.ai":       {},
				"https://localhost.lightvela.ai":  {},
			},
		},
	}
	wantRules := map[string]struct{}{
		http.MethodGet + " /v1/instances":                            {},
		http.MethodPost + " /v1/instances/{instance_id}/tat/session": {},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, tt.configPath))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			for _, origin := range cfg.AllowedOrigins {
				if _, scoped := tt.wantOrigins[origin]; scoped {
					t.Fatalf("scoped chat origin %q must not be added to the global CORS allowlist", origin)
				}
			}
			for _, route := range cfg.Routes {
				if route.Name != "ctl" {
					continue
				}
				if len(route.CORSAllow) != len(wantRules) {
					t.Fatalf("ctl cors_allow has %d rules, want %d: %+v", len(route.CORSAllow), len(wantRules), route.CORSAllow)
				}
				gotRules := make(map[string]struct{}, len(route.CORSAllow))
				for _, rule := range route.CORSAllow {
					key := rule.Method + " " + rule.Path
					if _, wanted := wantRules[key]; !wanted {
						t.Fatalf("unexpected scoped CORS rule: %+v", rule)
					}
					if len(rule.AllowedOrigins) != len(tt.wantOrigins) {
						t.Fatalf("unexpected scoped CORS origins for %s: %+v", key, rule.AllowedOrigins)
					}
					for _, origin := range rule.AllowedOrigins {
						if _, wanted := tt.wantOrigins[origin]; !wanted {
							t.Fatalf("unexpected scoped CORS origin %q for %s", origin, key)
						}
					}
					gotRules[key] = struct{}{}
				}
				for key := range wantRules {
					if _, ok := gotRules[key]; !ok {
						t.Fatalf("missing scoped CORS rule %s", key)
					}
				}
				return
			}
			t.Fatal("ctl route not found")
		})
	}
}

func TestDeployConfigsScopeWebsiteInstanceCredentials(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	configPaths := []string{
		"argocd/services/service-gateway/beijing-sandbox/config.yaml",
		"argocd/services/service-gateway/shprod/config.yaml",
		"argocd/services/service-gateway/sgprod/config.yaml",
	}
	wantInstancePaths := map[string]struct{}{
		http.MethodGet + " /v1/websites/capability":                          {},
		http.MethodGet + " /v1/websites":                                     {},
		http.MethodPost + " /v1/websites":                                    {},
		http.MethodGet + " /v1/websites/{site_id}":                           {},
		http.MethodDelete + " /v1/websites/{site_id}":                        {},
		http.MethodGet + " /v1/websites/{site_id}/releases":                  {},
		http.MethodPost + " /v1/websites/{site_id}/releases":                 {},
		http.MethodGet + " /v1/websites/{site_id}/operations/{operation_id}": {},
	}

	for _, configPath := range configPaths {
		t.Run(configPath, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, configPath))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			var websiteRoute *Route
			for i := range cfg.Routes {
				route := &cfg.Routes[i]
				if route.Prefix == "/v1/instance/websites" {
					t.Fatal("legacy /v1/instance/websites route must not be exposed")
				}
				if route.Prefix == "/v1/websites" {
					websiteRoute = route
				}
			}
			if websiteRoute == nil || websiteRoute.Access != AccessAuthenticated {
				t.Fatalf("authenticated website route is required: %+v", websiteRoute)
			}
			if len(websiteRoute.PublicAllow) != 0 {
				t.Fatalf("website route must not contain public exceptions: %+v", websiteRoute.PublicAllow)
			}
			if !websiteRoute.AllowVelaInstanceKey {
				t.Fatal("website route must enable scoped Vela instance credentials")
			}
			got := make(map[string]struct{}, len(websiteRoute.VelaInstanceKeyAllow))
			for _, rule := range websiteRoute.VelaInstanceKeyAllow {
				got[rule.Method+" "+rule.Path] = struct{}{}
			}
			if len(got) != len(wantInstancePaths) {
				t.Fatalf("instance website allowlist has %d rules, want %d: %+v", len(got), len(wantInstancePaths), got)
			}
			for key := range wantInstancePaths {
				if _, ok := got[key]; !ok {
					t.Fatalf("instance website allowlist missing %s", key)
				}
			}
		})
	}
}

func TestLegacySandboxProxyRoutesStayRestricted(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))

	for _, configFile := range deployConfigPaths(t, repoRoot) {
		configFile := configFile
		t.Run(filepath.Base(filepath.Dir(configFile)), func(t *testing.T) {
			cfg, err := LoadConfigFile(configFile)
			if err != nil {
				t.Fatalf("load config: %v", err)
			}

			for _, route := range cfg.Routes {
				if route.Prefix != "/sandboxes" {
					continue
				}
				if route.Access != AccessAuthenticated {
					t.Fatalf("legacy sandbox proxy route must stay authenticated: %+v", route)
				}
				if len(route.Methods) != 2 || !containsString(route.Methods, http.MethodPost) || !containsString(route.Methods, http.MethodOptions) {
					t.Fatalf("legacy sandbox proxy route must stay limited to POST/OPTIONS: %+v", route)
				}
				if route.PathPolicy != PathPolicyAllowlist {
					t.Fatalf("legacy sandbox proxy path_policy = %q, want allowlist", route.PathPolicy)
				}
				if len(route.PathAllow) != 1 || route.PathAllow[0].Method != http.MethodPost || route.PathAllow[0].Path != "/sandboxes" {
					t.Fatalf("legacy sandbox proxy must allow only POST /sandboxes: %+v", route.PathAllow)
				}
				for _, rule := range route.PathAllow {
					if rule.Path == "/sandboxes/{id}/tat/session" || rule.Path == "/sandboxes/{sandbox_id}/tat/session" {
						t.Fatalf("legacy sandbox proxy must not expose TAT session creation: %+v", rule)
					}
				}
				return
			}
		})
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func TestFaceIDCallbackIsPublicInDomesticEnvironments(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))

	for _, env := range []string{"beijing-sandbox", "shprod"} {
		t.Run(env, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, "argocd", "services", "service-gateway", env, "config.yaml"))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			for _, route := range cfg.Routes {
				if route.Name != "auth" {
					continue
				}
				for _, rule := range route.PublicAllow {
					if rule.Method == http.MethodGet && rule.Path == "/auth/realname/faceid/callback" {
						return
					}
				}
			}
			t.Fatal("FaceID callback must bypass session authentication")
		})
	}
}

func TestTencentCloudAccountCallbackIsPublicInRequiredEnvironments(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))

	for _, env := range []string{"beijing-sandbox", "sandbox-kr-1", "sgprod", "shprod"} {
		t.Run(env, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, "argocd", "services", "service-gateway", env, "config.yaml"))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			for _, route := range cfg.Routes {
				if route.Name != "auth" {
					continue
				}
				for _, rule := range route.PublicAllow {
					if rule.Method == http.MethodPost && rule.Path == "/auth/internal/tencentcloud/account" {
						return
					}
				}
			}
			t.Fatal("TencentCloud account callback must bypass session authentication")
		})
	}
}

func TestSingaporeBillingEntryRoutesArePublic(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	cfg, err := LoadConfigFile(filepath.Join(repoRoot, "argocd/services/service-gateway/sgprod/config.yaml"))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	want := map[string]struct {
		prefix   string
		upstream string
	}{
		"trade-jifei-callback": {
			prefix:   "/trade/jifei/callback",
			upstream: "http://trade.trade.svc.cluster.local",
		},
		"ctl-cloudapi": {
			prefix:   "/cloudapi",
			upstream: "http://ctl-api.ctl.svc.cluster.local",
		},
	}

	for _, route := range cfg.Routes {
		expected, required := want[route.Name]
		if !required {
			continue
		}
		if route.Prefix != expected.prefix || route.Upstream != expected.upstream || route.Access != AccessPublic {
			t.Fatalf("route %s must use the public SG billing target: %+v", route.Name, route)
		}
		if len(route.Methods) != 2 || !containsString(route.Methods, http.MethodPost) || !containsString(route.Methods, http.MethodOptions) {
			t.Fatalf("route %s must be limited to POST/OPTIONS: %+v", route.Name, route)
		}
		delete(want, route.Name)
	}
	for routeName := range want {
		t.Fatalf("required SG billing route %s not found", routeName)
	}
}

func TestProdWorkerActionConfigsDeclareRequiredRuntimeSecretKeys(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))

	envs := []string{"sgprod", "shprod"}
	requiredSecretKeys := []string{
		"TEMPORAL_BEARER_TOKEN",
		"TENCENTCLOUD_SECRET_ID",
		"TENCENTCLOUD_SECRET_KEY",
	}

	for _, env := range envs {
		t.Run(env, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, "argocd", "services", "service-gateway", env, "config.yaml"))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			if !cfg.WorkerActions.Enabled {
				t.Skip("worker actions disabled")
			}

			keys, err := loadSOPSStringDataKeys(filepath.Join(repoRoot, "argocd", "secrets", env, "service-gateway-runtime-secrets.sops.yaml"))
			if err != nil {
				t.Fatalf("load runtime secret keys: %v", err)
			}
			for _, key := range requiredSecretKeys {
				if _, ok := keys[key]; !ok {
					t.Fatalf("worker actions enabled but runtime secret is missing %s", key)
				}
			}
		})
	}
}

func loadSOPSStringDataKeys(path string) (map[string]struct{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var secret struct {
		StringData map[string]string `yaml:"stringData"`
	}
	if err := yaml.Unmarshal(data, &secret); err != nil {
		return nil, err
	}
	keys := make(map[string]struct{}, len(secret.StringData))
	for key := range secret.StringData {
		keys[key] = struct{}{}
	}
	return keys, nil
}

// websiteAccessPUTExpectations 声明每个环境的 ctl-websites 路由是否应放行 PUT。
//
// PUT /v1/websites/{site_id}/access 是「开启/关闭分享码」的唯一写入口，只有在
// site-gateway 以 SITE_GATEWAY_AUTH_MODE=required 运行的环境才有意义：
//
//   - shprod（国内站）：required 模式，站点访问要校验分享 Cookie，必须放行。
//   - sgprod（国际站）：public 模式，site-gateway 直接回源、不读分享状态也不展示
//     分享页。ctl 侧的 SetAccessPolicy 并不按地域拦截，一旦网关放行，请求会真的
//     写入 Redis 并返回分享码，却对实际访问毫无约束 —— 那是一个「返回成功但安全
//     承诺是假的」接口。所以这里保持关闭，是刻意的 fail-closed，不是遗漏。
//   - beijing-sandbox：国内测试环境，供前端联调分享码，放行。
//
// 新环境必须在这里显式表态，否则测试会失败，避免再次出现「接口上线但网关方法白
// 名单没跟上」的静默缺口（参见 MR !3416 只改业务代码、没改网关配置）。
var websiteAccessPUTExpectations = map[string]bool{
	"shprod":          true,
	"beijing-sandbox": true,
	"sgprod":          false,
}

// TestWebsiteRoutesShareAccessPUTMatchesSiteAuthMode 锁定建站路由 PUT 方法的开关状态。
//
// 网关的 methods 同时决定两件事：CORS 预检是否放行（allowsPreflight 直接查这个
// 列表），以及真实请求是否被 methodAllowed 拒绝。少了 PUT，浏览器在 OPTIONS 阶段
// 就拿到不含 PUT 的 Access-Control-Allow-Methods，前端只会看到一个没有响应体的
// CORS 错误，业务代码完全不会被执行。
func TestWebsiteRoutesShareAccessPUTMatchesSiteAuthMode(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))

	for _, configFile := range deployConfigPaths(t, repoRoot) {
		configFile := configFile
		env := filepath.Base(filepath.Dir(configFile))
		t.Run(env, func(t *testing.T) {
			cfg, err := LoadConfigFile(configFile)
			if err != nil {
				t.Fatalf("load config: %v", err)
			}

			for _, route := range cfg.Routes {
				if route.Name != "ctl-websites" {
					continue
				}
				want, declared := websiteAccessPUTExpectations[env]
				if !declared {
					t.Fatalf("env %q routes ctl-websites but has no entry in websiteAccessPUTExpectations; "+
						"decide explicitly whether PUT /v1/websites/{site_id}/access should be reachable there", env)
				}
				got := methodAllowed(route.Methods, http.MethodPut)
				if got != want {
					if want {
						t.Fatalf("ctl-websites must allow PUT for /v1/websites/{site_id}/access, got methods %v", route.Methods)
					}
					t.Fatalf("ctl-websites must NOT allow PUT in %s (site-gateway runs in public mode, share codes are inert there), got methods %v", env, route.Methods)
				}
			}
		})
	}
}
