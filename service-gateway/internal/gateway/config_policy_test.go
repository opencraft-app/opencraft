package gateway

import (
	"net/http"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDeployConfigsDoNotExposeRetiredPublicRoutes(t *testing.T) {
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
	retiredPublicAuthPaths := map[string]struct{}{
		"/auth/sms/send":   {},
		"/auth/sms/verify": {},
	}

	for _, configPath := range configPaths {
		t.Run(configPath, func(t *testing.T) {
			cfg, err := LoadConfigFile(filepath.Join(repoRoot, configPath))
			if err != nil {
				t.Fatalf("load config: %v", err)
			}

			legacySandboxRouteFound := false
			for _, route := range cfg.Routes {
				if route.Prefix == "/sandboxes" {
					legacySandboxRouteFound = true
					if route.Access != AccessAuthenticated {
						t.Fatalf("legacy sandbox proxy route must stay authenticated: %+v", route)
					}
					if len(route.Methods) != 2 || !containsString(route.Methods, http.MethodPost) || !containsString(route.Methods, http.MethodOptions) {
						t.Fatalf("legacy sandbox proxy route must stay limited to POST/OPTIONS: %+v", route)
					}
				}
				for _, rule := range route.PublicAllow {
					if rule.Method != http.MethodPost {
						continue
					}
					if _, retired := retiredPublicAuthPaths[rule.Path]; retired {
						t.Fatalf("retired auth endpoint is still public: %s %s", rule.Method, rule.Path)
					}
				}
			}
			if !legacySandboxRouteFound {
				t.Fatalf("legacy sandbox proxy route is required until old frontend is fully rolled out")
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
