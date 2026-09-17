package config

import "testing"

func TestSandboxNetworkScopeDoesNotRequirePlatformSecrets(t *testing.T) {
	if requiresPlatformSecrets("sandbox-network") {
		t.Fatal("sandbox-network scope must not require node, DB, or Redis secrets")
	}
	if !requiresPlatformSecrets("") {
		t.Fatal("full stack must continue requiring platform secrets")
	}
}

func TestEffectiveComponentScopePrefersEnvironmentOverride(t *testing.T) {
	previous := lookupEnv
	lookupEnv = func(key string) (string, bool) {
		if key == "INFRA_COMPONENT_SCOPE" {
			return "notify", true
		}
		return "", false
	}
	t.Cleanup(func() { lookupEnv = previous })

	if got := effectiveComponentScope("sandbox-network"); got != "notify" {
		t.Fatalf("effective scope = %q, want env override notify", got)
	}
}
