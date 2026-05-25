package wrapper

import (
	"net/http"
	"os"
	"regexp"
	"strings"
)

var scopeValueRE = regexp.MustCompile(`^[A-Za-z0-9_.:-]+$`)

func scopeFromRequest(r *http.Request) (Scope, *APIError) {
	scope := Scope{
		TenantID:     r.Header.Get("X-Tenant-ID"),
		ProjectID:    r.Header.Get("X-Project-ID"),
		SandboxScope: r.Header.Get("X-Sandbox-Scope"),
	}
	if scope.TenantID == "" && scope.ProjectID == "" {
		if _, ok := bearerToken(r); !ok {
			return Scope{}, apiErr("identity_missing", "X-Tenant-ID/X-Project-ID or Authorization: Bearer is required")
		}
		scope.TenantID = envDefault("GATEWAY_DEFAULT_TENANT_ID", "default")
		scope.ProjectID = envDefault("GATEWAY_DEFAULT_PROJECT_ID", "default")
		scope.SandboxScope = envDefault("GATEWAY_DEFAULT_SANDBOX_SCOPE", scope.SandboxScope)
	}
	if scope.TenantID == "" || scope.ProjectID == "" {
		return Scope{}, apiErr("identity_missing", "X-Tenant-ID and X-Project-ID are required")
	}
	if !validScopeValue(scope.TenantID) || !validScopeValue(scope.ProjectID) || (scope.SandboxScope != "" && !validScopeValue(scope.SandboxScope)) {
		return Scope{}, apiErr("identity_invalid", "identity scope values contain unsupported characters")
	}
	return scope, nil
}

func bearerToken(r *http.Request) (string, bool) {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if auth == "" {
		return "", false
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(strings.ToLower(auth), strings.ToLower(prefix)) {
		return "", false
	}
	token := strings.TrimSpace(auth[len(prefix):])
	if token == "" {
		return "", false
	}
	if expected := firstEnv("GATEWAY_API_KEY", "CLOUDAGENT_API_KEY"); expected != "" && token != expected {
		return "", false
	}
	return token, true
}

func envDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func validScopeValue(value string) bool {
	return scopeValueRE.MatchString(value)
}

func sameScope(a, b Scope) bool {
	return a.TenantID == b.TenantID && a.ProjectID == b.ProjectID && a.SandboxScope == b.SandboxScope
}
