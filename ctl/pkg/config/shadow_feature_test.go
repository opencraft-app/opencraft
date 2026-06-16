package config

import (
	"os"
	"testing"
)

func TestShadowBindingRequiredFallbacksToLegacyShadowAccountEnabled(t *testing.T) {
	withShadowFeatureEnv(t, map[string]string{
		"SHADOW_ACCOUNT_ENABLED": "true",
	})

	if !ShadowBindingRequired() {
		t.Fatalf("expected SHADOW_ACCOUNT_ENABLED=true to require binding when SHADOW_BINDING_REQUIRED is unset")
	}
}

func TestShadowBindingRequiredCanDisableGateWhileFeatureEnabled(t *testing.T) {
	withShadowFeatureEnv(t, map[string]string{
		"SHADOW_ACCOUNT_ENABLED":  "true",
		"SHADOW_BINDING_REQUIRED": "false",
	})

	if ShadowBindingRequired() {
		t.Fatalf("expected SHADOW_BINDING_REQUIRED=false to disable the hard binding gate")
	}
}

func TestShadowBindingRequiredCanEnableGateWhenFeatureDisabled(t *testing.T) {
	withShadowFeatureEnv(t, map[string]string{
		"SHADOW_ACCOUNT_ENABLED":  "false",
		"SHADOW_BINDING_REQUIRED": "true",
	})

	if !ShadowBindingRequired() {
		t.Fatalf("expected SHADOW_BINDING_REQUIRED=true to require binding")
	}
}

func TestShadowBindingRequiredFallbacksToConfig(t *testing.T) {
	withShadowFeatureEnv(t, nil)
	original := ServerConf
	t.Cleanup(func() {
		ServerConf = original
	})
	ServerConf = &GlobalConfig{
		AdapterConfig: &AdapterConfig{
			Shadow: &ShadowConfig{
				Enabled: true,
			},
		},
	}

	if !ShadowBindingRequired() {
		t.Fatalf("expected adapter.shadow.enabled=true to require binding when env vars are unset")
	}
}

func withShadowFeatureEnv(t *testing.T, values map[string]string) {
	t.Helper()
	keys := []string{"SHADOW_ACCOUNT_ENABLED", "SHADOW_BINDING_REQUIRED"}
	previous := make(map[string]*string, len(keys))
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok {
			copy := value
			previous[key] = &copy
		}
		_ = os.Unsetenv(key)
	}
	t.Cleanup(func() {
		for _, key := range keys {
			if value := previous[key]; value != nil {
				_ = os.Setenv(key, *value)
			} else {
				_ = os.Unsetenv(key)
			}
		}
	})
	for key, value := range values {
		_ = os.Setenv(key, value)
	}
}
