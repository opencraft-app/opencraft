package gateway

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
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

func TestDesktopDeploymentUpstreamCoverage(t *testing.T) {
	for _, file := range deployConfigPaths(t, "../../..") {
		cfg, err := LoadConfigFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, route := range cfg.Routes {
			if route.Prefix != "/v1/instances" {
				if route.DesktopUpstream != "" {
					t.Fatalf("non-desktop route changed in %s", file)
				}
				continue
			}
			want := strings.Replace(route.Upstream, "//ctl-api.", "//ctl-desktop.", 1)
			if filepath.Base(filepath.Dir(file)) == "sandbox-jp-1" {
				want = "" // No CTL deployment root is maintained here for JP yet.
			}
			if route.DesktopUpstream != want {
				t.Errorf("%s desktop upstream=%q, want %q", file, route.DesktopUpstream, want)
			}
		}
	}
}

func TestDesktopWorkloadRenderedIsolation(t *testing.T) {
	binary := os.Getenv("KUSTOMIZE")
	if binary == "" {
		var err error
		binary, err = exec.LookPath("kustomize")
		if err != nil {
			t.Skip("set KUSTOMIZE to render desktop deployment contracts")
		}
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	tree := t.TempDir()
	// Use real public manifests and replacements. Omit only the secret generator:
	// validating PodSpecs must not require decrypting production credentials.
	for _, source := range []string{"ctl/k8s", "argocd/services/ctl"} {
		err := filepath.WalkDir(filepath.Join(root, source), func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			target := filepath.Join(tree, relative)
			if entry.IsDir() {
				return os.MkdirAll(target, 0700)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if entry.Name() == "kustomization.yaml" {
				var document map[string]interface{}
				if err := yaml.Unmarshal(data, &document); err != nil {
					return err
				}
				var assets bytes.Buffer
				generators, _ := document["generators"].([]interface{})
				for _, generator := range generators {
					generatorPath := filepath.Join(filepath.Dir(path), generator.(string))
					generatorData, err := os.ReadFile(generatorPath)
					if err != nil {
						return err
					}
					var generatorSpec struct {
						Files []string `yaml:"files"`
					}
					if err := yaml.Unmarshal(generatorData, &generatorSpec); err != nil {
						return err
					}
					for _, input := range generatorSpec.Files {
						// Names follow the existing assets convention. Some SOPS files
						// encrypt even metadata; this test never reads encrypted payloads.
						name := strings.TrimSuffix(filepath.Base(input), ".sops.yaml")
						kind := "Secret"
						if strings.HasPrefix(name, "ctl-conf-") {
							kind = "ConfigMap"
						}
						stub, err := yaml.Marshal(map[string]interface{}{
							"apiVersion": "v1", "kind": kind,
							"metadata": map[string]interface{}{"name": name, "namespace": "ctl"},
						})
						if err != nil {
							return err
						}
						assets.WriteString("---\n")
						assets.Write(stub)
					}
				}
				if assets.Len() > 0 {
					if err := os.WriteFile(filepath.Join(filepath.Dir(target), "test-asset-metadata.yaml"), assets.Bytes(), 0600); err != nil {
						return err
					}
					resources, _ := document["resources"].([]interface{})
					document["resources"] = append(resources, "test-asset-metadata.yaml")
				}
				delete(document, "generators")
				data, err = yaml.Marshal(document)
				if err != nil {
					return err
				}
			}
			return os.WriteFile(target, data, 0600)
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, env := range []string{"beijing-sandbox", "beijing-sandbox-2", "sandbox-bj-7", "sandbox-kr-1", "sgprod", "shprod"} {
		t.Run(env, func(t *testing.T) {
			command := exec.Command(binary, "build", filepath.Join(tree, "argocd/services/ctl", env))
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("render failed: %v: %s", err, output)
			}
			decoder := yaml.NewDecoder(bytes.NewReader(output))
			documents := map[string]map[string]interface{}{}
			for {
				var document map[string]interface{}
				if err := decoder.Decode(&document); err == io.EOF {
					break
				} else if err != nil {
					t.Fatal(err)
				}
				if document == nil {
					continue
				}
				metadata := document["metadata"].(map[string]interface{})
				documents[document["kind"].(string)+"/"+metadata["name"].(string)] = document
			}
			api := documents["Deployment/ctl-api"]["spec"].(map[string]interface{})
			desktop := documents["Deployment/ctl-desktop"]["spec"].(map[string]interface{})
			if desktop["replicas"] != 1 || !reflect.DeepEqual(desktop["strategy"], map[string]interface{}{"type": "Recreate"}) {
				t.Fatal("desktop must remain singleton with Recreate updates")
			}
			apiTemplate := api["template"].(map[string]interface{})
			desktopTemplate := desktop["template"].(map[string]interface{})
			if !reflect.DeepEqual(apiTemplate["spec"], desktopTemplate["spec"]) {
				t.Fatal("desktop lost final image, environment, volumes or other PodSpec configuration")
			}
			for name, template := range map[string]map[string]interface{}{"api": apiTemplate, "desktop": desktopTemplate} {
				metadata := template["metadata"].(map[string]interface{})
				labels := metadata["labels"].(map[string]interface{})
				if labels["app"] != "ctl-"+name || labels["ctl.clawhub.dev/role"] != name {
					t.Fatalf("incorrect role or overlapping workload labels: %v", labels)
				}
			}
			for name, document := range documents {
				if strings.HasPrefix(name, "HorizontalPodAutoscaler/") {
					spec := document["spec"].(map[string]interface{})
					if spec["scaleTargetRef"].(map[string]interface{})["name"] == "ctl-desktop" {
						t.Fatal("desktop cannot be independently scaled while state is process-local")
					}
				}
			}
			for _, name := range []string{"ctl-api", "ctl-api-internal", "ctl-desktop"} {
				service := documents["Service/"+name]["spec"].(map[string]interface{})
				want := "ctl-api"
				if name == "ctl-desktop" {
					want = name
				}
				if service["selector"].(map[string]interface{})["app"] != want {
					t.Fatalf("service %s may select the wrong workload", name)
				}
			}
		})
	}
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

func testCreditRouteIsAuthenticatedAndAllowlisted(t *testing.T, configPath, wantUpstream string, wantRealname bool) {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	cfg, err := LoadConfigFile(filepath.Join(repoRoot, configPath))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	wantPaths := map[string]struct{}{
		http.MethodGet + " /v1/credit/products":                      {},
		http.MethodPost + " /v1/credit/inquiry":                      {},
		http.MethodPost + " /v1/credit/packages/order":               {},
		http.MethodPost + " /v1/credit/packages/order-url":           {},
		http.MethodPost + " /v1/credit/packages/order-and-pay":       {},
		http.MethodGet + " /v1/credit/packages":                      {},
		http.MethodPost + " /v1/credit/packages/{package_id}/refund": {},
	}
	for _, route := range cfg.Routes {
		if route.Name != "credit" {
			continue
		}
		if route.Prefix != "/v1/credit" || route.Access != AccessAuthenticated {
			t.Fatalf("credit route must use authenticated session access: %+v", route)
		}
		if route.Upstream != wantUpstream {
			t.Fatalf("credit upstream=%q", route.Upstream)
		}
		if route.RequireRealname != wantRealname {
			t.Fatalf("credit require_realname=%v, want %v", route.RequireRealname, wantRealname)
		}
		if route.PathPolicy != PathPolicyAllowlist {
			t.Fatalf("credit path_policy=%q, want allowlist", route.PathPolicy)
		}
		gotPaths := make(map[string]struct{}, len(route.PathAllow))
		for _, rule := range route.PathAllow {
			gotPaths[rule.Method+" "+rule.Path] = struct{}{}
		}
		if len(gotPaths) != len(wantPaths) {
			t.Fatalf("credit allowlist=%+v, want=%+v", gotPaths, wantPaths)
		}
		for path := range wantPaths {
			if _, exists := gotPaths[path]; !exists {
				t.Fatalf("credit allowlist missing %s", path)
			}
		}
		wantOptionalAuth := map[string]struct{}{
			http.MethodPost + " /v1/credit/inquiry":            {},
			http.MethodPost + " /v1/credit/packages/order-url": {},
		}
		if len(route.OptionalAuthAllow) != len(wantOptionalAuth) {
			t.Fatalf("credit optional auth allowlist=%+v, want=%+v", route.OptionalAuthAllow, wantOptionalAuth)
		}
		for _, rule := range route.OptionalAuthAllow {
			key := rule.Method + " " + rule.Path
			if _, ok := wantOptionalAuth[key]; !ok {
				t.Fatalf("unexpected credit optional auth route=%s", key)
			}
		}
		return
	}
	t.Fatal("credit route not found")
}

func TestBeijing7CreditRouteIsAuthenticatedAndAllowlisted(t *testing.T) {
	testCreditRouteIsAuthenticatedAndAllowlisted(
		t,
		"argocd/services/service-gateway/sandbox-bj-7/config.yaml",
		"http://credit.lightvela-playground-sandbox-bj-7.svc.cluster.local",
		true,
	)
}

func TestBeijingCreditRouteIsAuthenticatedAndAllowlisted(t *testing.T) {
	testCreditRouteIsAuthenticatedAndAllowlisted(
		t,
		"argocd/services/service-gateway/beijing-sandbox/config.yaml",
		"http://credit.credit.svc.cluster.local",
		true,
	)
}

func TestShanghaiCreditRouteIsAuthenticatedAndAllowlisted(t *testing.T) {
	testCreditRouteIsAuthenticatedAndAllowlisted(
		t,
		"argocd/services/service-gateway/shprod/config.yaml",
		"http://credit.credit.svc.cluster.local",
		true,
	)
}

func TestSingaporeCreditRouteIsAuthenticatedAndAllowlisted(t *testing.T) {
	testCreditRouteIsAuthenticatedAndAllowlisted(
		t,
		"argocd/services/service-gateway/sgprod/config.yaml",
		"http://credit.credit.svc.cluster.local",
		false,
	)
}

func TestTokyoCreditRouteIsAuthenticatedAndAllowlisted(t *testing.T) {
	testCreditRouteIsAuthenticatedAndAllowlisted(
		t,
		"argocd/services/service-gateway/sandbox-jp-1/config.yaml",
		"http://credit.lightvela-playground-sandbox-jp-1.svc.cluster.local",
		true,
	)
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

	domesticConfigPaths := []string{
		"argocd/services/service-gateway/beijing-sandbox/config.yaml",
		"argocd/services/service-gateway/beijing-sandbox-2/config.yaml",
		"argocd/services/service-gateway/sandbox-bj-7/config.yaml",
		"argocd/services/service-gateway/shprod/config.yaml",
	}
	globalConfigPath := "argocd/services/service-gateway/sgprod/config.yaml"
	baseWant := map[string]struct{}{
		http.MethodGet + " /v1/instances":                                                                   {},
		http.MethodPost + " /v1/instances":                                                                  {},
		http.MethodGet + " /v1/instances/{instance_id}":                                                     {},
		http.MethodDelete + " /v1/instances/{instance_id}":                                                  {},
		http.MethodPost + " /v1/instances/{instance_id}/debug/exec":                                         {},
		http.MethodGet + " /v1/instances/{instance_id}/desktop/session":                                     {},
		http.MethodPost + " /v1/instances/{instance_id}/desktop/session":                                    {},
		http.MethodGet + " /v1/instances/{instance_id}/desktop/resource":                                    {},
		http.MethodPost + " /v1/instances/{instance_id}/desktop/resource":                                   {},
		http.MethodPost + " /v1/instances/{instance_id}/desktop/viewer":                                     {},
		http.MethodDelete + " /v1/instances/{instance_id}/desktop/viewer/{attachment_id}":                   {},
		http.MethodPost + " /v1/instances/{instance_id}/desktop/viewer/{attachment_id}/claim":               {},
		http.MethodPost + " /v1/instances/{instance_id}/tat/session":                                        {},
		http.MethodPost + " /v1/instances/{instance_id}/config/reset":                                       {},
		http.MethodPost + " /v1/instances/{instance_id}/agentchat/launch-token":                             {},
		http.MethodPost + " /v1/instances/{instance_id}/channels/config":                                    {},
		http.MethodPost + " /v1/instances/{instance_id}/channels/weixin/login-sessions":                     {},
		http.MethodGet + " /v1/instances/{instance_id}/channels/weixin/login-sessions/{session_id}":         {},
		http.MethodGet + " /v1/instances/{instance_id}/channels/weixin/login-sessions/{session_id}/events":  {},
		http.MethodPost + " /v1/instances/{instance_id}/channels/weixin/login-sessions/{session_id}/cancel": {},
	}
	domesticWant := make(map[string]struct{}, len(baseWant)+8)
	globalWant := make(map[string]struct{}, len(baseWant)+8)
	for key := range baseWant {
		domesticWant[key] = struct{}{}
		globalWant[key] = struct{}{}
	}
	for _, key := range []string{
		http.MethodGet + " /v1/instances/{instance_id}/bots",
		http.MethodPost + " /v1/instances/{instance_id}/bots",
		http.MethodPut + " /v1/instances/{instance_id}/bots/{bot_id}",
		http.MethodDelete + " /v1/instances/{instance_id}/bots/{bot_id}",
		http.MethodPost + " /v1/instances/{instance_id}/bots/{bot_id}/retry",
		http.MethodPut + " /v1/instances/{instance_id}/bots/{bot_id}/channel-bindings/{channel}",
		http.MethodPost + " /v1/instances/{instance_id}/bots/{bot_id}/channel-bindings/{channel}",
		http.MethodDelete + " /v1/instances/{instance_id}/bots/{bot_id}/channel-bindings/{channel}",
	} {
		domesticWant[key] = struct{}{}
		globalWant[key] = struct{}{}
	}

	assertAllowlist := func(t *testing.T, configPath string, want map[string]struct{}) {
		t.Helper()
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
	}

	for _, configPath := range domesticConfigPaths {
		t.Run(configPath, func(t *testing.T) {
			assertAllowlist(t, configPath, domesticWant)
		})
	}
	t.Run(globalConfigPath, func(t *testing.T) {
		assertAllowlist(t, globalConfigPath, globalWant)
	})
}

func TestProductionChatOriginsAreGloballyAllowed(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	wantGlobalOrigins := map[string]struct{}{
		"https://chat.lightvela.com": {},
		"https://chat.lightvela.ai":  {},
		"https://*.devcloud.woa.com": {},
	}
	wantScopedRules := map[string]map[string]struct{}{
		http.MethodGet + " /v1/instances": {
			"https://localhost.lightvela.com": {},
			"https://localhost.lightvela.ai":  {},
		},
		http.MethodPost + " /v1/instances/{instance_id}/tat/session": {
			"https://localhost.lightvela.com": {},
			"https://localhost.lightvela.ai":  {},
		},
	}

	for _, env := range []string{"shprod", "sgprod"} {
		t.Run(env, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, "argocd", "services", "service-gateway", env, "config.yaml"))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			gotGlobalOrigins := make(map[string]struct{}, len(cfg.AllowedOrigins))
			for _, origin := range cfg.AllowedOrigins {
				gotGlobalOrigins[origin] = struct{}{}
			}
			for origin := range wantGlobalOrigins {
				if _, ok := gotGlobalOrigins[origin]; !ok {
					t.Fatalf("missing global chat origin %q", origin)
				}
			}
			for _, route := range cfg.Routes {
				if route.Name != "ctl" {
					continue
				}
				if len(route.CORSAllow) != len(wantScopedRules) {
					t.Fatalf("ctl cors_allow has %d rules, want %d: %+v", len(route.CORSAllow), len(wantScopedRules), route.CORSAllow)
				}
				gotRules := make(map[string]struct{}, len(route.CORSAllow))
				for _, rule := range route.CORSAllow {
					key := rule.Method + " " + rule.Path
					wantOriginsForRule, wanted := wantScopedRules[key]
					if !wanted {
						t.Fatalf("unexpected scoped CORS rule: %+v", rule)
					}
					if len(rule.AllowedOrigins) != len(wantOriginsForRule) {
						t.Fatalf("unexpected scoped CORS origins for %s: %+v", key, rule.AllowedOrigins)
					}
					for _, origin := range rule.AllowedOrigins {
						if _, wanted := wantOriginsForRule[origin]; !wanted {
							t.Fatalf("unexpected scoped CORS origin %q for %s", origin, key)
						}
					}
					gotRules[key] = struct{}{}
				}
				for key := range wantScopedRules {
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
		http.MethodPost + " /v1/websites/{site_id}/rollback":                 {},
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

func TestPersonalDevBillingProxyIsPublicOnlyInTestingSandboxes(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	want := map[string]struct{}{
		http.MethodPost + " /auth/dev-environments/billing-proxy/jifei/resource-center/interface": {},
		http.MethodPost + " /auth/dev-environments/billing-proxy/cloudapi/":                       {},
	}

	for _, env := range []string{"sandbox-bj-7", "sandbox-kr-1"} {
		t.Run(env, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, "argocd", "services", "service-gateway", env, "config.yaml"))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			got := make(map[string]struct{})
			for _, route := range cfg.Routes {
				if route.Name != "auth" {
					continue
				}
				for _, rule := range route.PublicAllow {
					key := strings.ToUpper(strings.TrimSpace(rule.Method)) + " " + strings.TrimSpace(rule.Path)
					if _, required := want[key]; required {
						got[key] = struct{}{}
					}
				}
			}
			for key := range want {
				if _, ok := got[key]; !ok {
					t.Fatalf("testing sandbox auth route is missing public rule %s", key)
				}
			}
		})
	}

	for _, env := range []string{"shprod", "sgprod"} {
		t.Run(env+"-production", func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, "argocd", "services", "service-gateway", env, "config.yaml"))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			for _, route := range cfg.Routes {
				for _, rule := range route.PublicAllow {
					key := strings.ToUpper(strings.TrimSpace(rule.Method)) + " " + strings.TrimSpace(rule.Path)
					if _, forbidden := want[key]; forbidden {
						t.Fatalf("production config %s must not expose personal DevCloud billing proxy", env)
					}
				}
			}
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
