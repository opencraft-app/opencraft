package gateway

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"gopkg.in/yaml.v3"
)

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

func TestTencentCloudAccountCallbackIsPublicInDomesticEnvironments(t *testing.T) {
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
					if rule.Method == http.MethodPost && rule.Path == "/auth/internal/tencentcloud/account" {
						return
					}
				}
			}
			t.Fatal("TencentCloud account callback must bypass session authentication")
		})
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
