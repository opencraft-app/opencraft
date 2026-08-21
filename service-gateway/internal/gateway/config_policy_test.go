package gateway

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"gopkg.in/yaml.v3"
)

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
		http.MethodGet + " /v1/instances/{instance_id}/borncard":                                            {},
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

	configPaths := []string{
		"argocd/services/service-gateway/beijing-sandbox/config.yaml",
		"argocd/services/service-gateway/beijing-sandbox-2/config.yaml",
		"argocd/services/service-gateway/sgprod/config.yaml",
		"argocd/services/service-gateway/shprod/config.yaml",
	}

	for _, configPath := range configPaths {
		t.Run(configPath, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, configPath))
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
				return
			}
			t.Fatal("legacy sandbox proxy route is required until old frontend is fully rolled out")
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
