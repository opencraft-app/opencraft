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
