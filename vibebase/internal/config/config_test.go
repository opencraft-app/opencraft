package config

import "testing"

func TestFromEnvUsesSharedRedisPasswordFallback(t *testing.T) {
	t.Setenv("VIBEBASE_REDIS_ADDR", "redis:6379")
	t.Setenv("VIBEBASE_INTERNAL_SERVICE_TOKEN", "token")
	t.Setenv("REDIS_PASSWORD", "shared")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if cfg.RedisPassword != "shared" {
		t.Fatalf("expected shared Redis password fallback, got %q", cfg.RedisPassword)
	}
}

func TestFromEnvPrefersVibebaseRedisPassword(t *testing.T) {
	t.Setenv("VIBEBASE_REDIS_ADDR", "redis:6379")
	t.Setenv("VIBEBASE_INTERNAL_SERVICE_TOKEN", "token")
	t.Setenv("REDIS_PASSWORD", "shared")
	t.Setenv("VIBEBASE_REDIS_PASSWORD", "vibebase")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if cfg.RedisPassword != "vibebase" {
		t.Fatalf("expected Vibebase Redis password override, got %q", cfg.RedisPassword)
	}
}

func TestFromEnvUsesMaxNameBytesForNamespaceAndKeyLimit(t *testing.T) {
	t.Setenv("VIBEBASE_REDIS_ADDR", "redis:6379")
	t.Setenv("VIBEBASE_INTERNAL_SERVICE_TOKEN", "token")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if cfg.MaxNameBytes != 128 {
		t.Fatalf("expected default max name bytes 128, got %d", cfg.MaxNameBytes)
	}
}

func TestFromEnvPrefersMaxNameBytesOverLegacyMaxKeyBytes(t *testing.T) {
	t.Setenv("VIBEBASE_REDIS_ADDR", "redis:6379")
	t.Setenv("VIBEBASE_INTERNAL_SERVICE_TOKEN", "token")
	t.Setenv("VIBEBASE_MAX_KEY_BYTES", "256")
	t.Setenv("VIBEBASE_MAX_NAME_BYTES", "64")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if cfg.MaxNameBytes != 64 {
		t.Fatalf("expected max name bytes override 64, got %d", cfg.MaxNameBytes)
	}
}
