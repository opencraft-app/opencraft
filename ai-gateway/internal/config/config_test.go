package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTestConfig(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write test config: %v", err)
	}
	return path
}

func TestLoadConfig_ValidYAML(t *testing.T) {
	yaml := `
server:
  port: 9090
  admin_token: "test-token"
  max_request_body_size: 5242880
database:
  dsn: "root:pass@tcp(localhost:3306)/testdb?charset=utf8mb4&parseTime=True&loc=Local"
redis:
  addr: "localhost:6380"
portkey:
  base_url: "http://localhost:9787"
billing:
  async_log: true
  low_balance_threshold: 5000
  default_reservation_tokens: 2048
rate_limit:
  defaults:
    - window: "1m"
      max_requests: 30
      label: "每分钟"
    - window: "1d"
      max_requests: 500
      label: "每日"
gateway:
  max_inflight_budget: 128
  stream_request_weight: 4
  non_stream_request_weight: 1
  overload_status_code: 503
provider_cooldown:
  default_429_ttl_s: 12
  max_429_ttl_s: 45
`
	path := writeTestConfig(t, yaml)
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}

	if cfg.Server.Port != 9090 {
		t.Errorf("expected port 9090, got %d", cfg.Server.Port)
	}
	if cfg.Server.AdminToken != "test-token" {
		t.Errorf("expected admin_token 'test-token', got %q", cfg.Server.AdminToken)
	}
	if cfg.Server.MaxRequestBodySize != 5242880 {
		t.Errorf("expected max_request_body_size 5242880, got %d", cfg.Server.MaxRequestBodySize)
	}
	if strings.Contains(cfg.Database.DSN, "loc=Local") || !strings.Contains(cfg.Database.DSN, "parseTime=true") || !strings.Contains(cfg.Database.DSN, "time_zone=") {
		t.Errorf("unexpected normalized DSN: %q", cfg.Database.DSN)
	}
	if cfg.Redis.Addr != "localhost:6380" {
		t.Errorf("expected redis addr 'localhost:6380', got %q", cfg.Redis.Addr)
	}
	if cfg.Portkey.BaseURL != "http://localhost:9787" {
		t.Errorf("expected portkey base_url 'http://localhost:9787', got %q", cfg.Portkey.BaseURL)
	}
	if cfg.Billing.LowBalanceThreshold != 5000 {
		t.Errorf("expected low_balance_threshold 5000, got %d", cfg.Billing.LowBalanceThreshold)
	}
	if cfg.Billing.DefaultReservationTokens != 2048 {
		t.Errorf("expected default_reservation_tokens 2048, got %d", cfg.Billing.DefaultReservationTokens)
	}
	if len(cfg.RateLimit.Defaults) != 2 {
		t.Errorf("expected 2 rate limit defaults, got %d", len(cfg.RateLimit.Defaults))
	}
	if cfg.RateLimit.Defaults[0].Window != "1m" || cfg.RateLimit.Defaults[0].MaxRequests != 30 {
		t.Errorf("expected first default 1m/30, got %s/%d", cfg.RateLimit.Defaults[0].Window, cfg.RateLimit.Defaults[0].MaxRequests)
	}
	if cfg.RateLimit.Defaults[1].Window != "1d" || cfg.RateLimit.Defaults[1].MaxRequests != 500 {
		t.Errorf("expected second default 1d/500, got %s/%d", cfg.RateLimit.Defaults[1].Window, cfg.RateLimit.Defaults[1].MaxRequests)
	}
	if cfg.Gateway.MaxInflightBudget != 128 {
		t.Errorf("expected gateway max_inflight_budget 128, got %d", cfg.Gateway.MaxInflightBudget)
	}
	if cfg.Gateway.StreamRequestWeight != 4 {
		t.Errorf("expected gateway stream_request_weight 4, got %d", cfg.Gateway.StreamRequestWeight)
	}
	if cfg.ProviderCooldown.Default429TTLS != 12 {
		t.Errorf("expected provider cooldown default ttl 12, got %d", cfg.ProviderCooldown.Default429TTLS)
	}
}

func TestLoadConfig_EnvVarOverrides(t *testing.T) {
	yaml := `
server:
  port: 18080
  admin_token: "yaml-token"
database:
  dsn: "root:pass@tcp(localhost:3306)/testdb?charset=utf8mb4&parseTime=True&loc=Local"
`
	path := writeTestConfig(t, yaml)

	t.Setenv("ADMIN_TOKEN", "env-token")
	t.Setenv("DATABASE_URL", "root:override@tcp(db:3306)/prod?charset=utf8mb4&parseTime=True&loc=Local")
	t.Setenv("ENCRYPTION_KEY", "super-secret-key")

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}

	if cfg.Server.AdminToken != "env-token" {
		t.Errorf("expected ADMIN_TOKEN env override 'env-token', got %q", cfg.Server.AdminToken)
	}
	if !strings.Contains(cfg.Database.DSN, "root:override@tcp(db:3306)/prod") || strings.Contains(cfg.Database.DSN, "loc=Local") || !strings.Contains(cfg.Database.DSN, "parseTime=true") || !strings.Contains(cfg.Database.DSN, "time_zone=") {
		t.Errorf("expected normalized DATABASE_URL env override, got %q", cfg.Database.DSN)
	}
	if cfg.EncryptionKey != "super-secret-key" {
		t.Errorf("expected ENCRYPTION_KEY 'super-secret-key', got %q", cfg.EncryptionKey)
	}
}

func TestLoadConfig_DefaultsApplied(t *testing.T) {
	// Minimal YAML with no optional fields
	yaml := `
database:
  dsn: "root:pass@tcp(localhost:3306)/testdb?charset=utf8mb4&parseTime=True&loc=Local"
`
	path := writeTestConfig(t, yaml)

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}

	if cfg.Server.Port != 18080 {
		t.Errorf("expected default port 18080, got %d", cfg.Server.Port)
	}
	if cfg.Server.MaxRequestBodySize != 10*1024*1024 {
		t.Errorf("expected default max_request_body_size 10MB, got %d", cfg.Server.MaxRequestBodySize)
	}
	if cfg.Billing.DefaultReservationTokens != 4096 {
		t.Errorf("expected default_reservation_tokens 4096, got %d", cfg.Billing.DefaultReservationTokens)
	}
	if len(cfg.RateLimit.Defaults) != 3 {
		t.Errorf("expected 3 rate limit defaults, got %d", len(cfg.RateLimit.Defaults))
	}
	if cfg.RateLimit.Defaults[0].Window != "5h" || cfg.RateLimit.Defaults[0].MaxRequests != 1200 {
		t.Errorf("expected first default 5h/1200, got %s/%d", cfg.RateLimit.Defaults[0].Window, cfg.RateLimit.Defaults[0].MaxRequests)
	}
	if cfg.RateLimit.Defaults[1].Window != "1w" || cfg.RateLimit.Defaults[1].MaxRequests != 9000 {
		t.Errorf("expected second default 1w/9000, got %s/%d", cfg.RateLimit.Defaults[1].Window, cfg.RateLimit.Defaults[1].MaxRequests)
	}
	if cfg.Redis.Addr != "localhost:6379" {
		t.Errorf("expected default redis addr 'localhost:6379', got %q", cfg.Redis.Addr)
	}
	if cfg.Portkey.BaseURL != "http://localhost:8787" {
		t.Errorf("expected default portkey base_url, got %q", cfg.Portkey.BaseURL)
	}
	if cfg.Gateway.StreamRequestWeight != 3 {
		t.Errorf("expected default stream_request_weight 3, got %d", cfg.Gateway.StreamRequestWeight)
	}
	if cfg.Gateway.NonStreamRequestWeight != 1 {
		t.Errorf("expected default non_stream_request_weight 1, got %d", cfg.Gateway.NonStreamRequestWeight)
	}
	if cfg.Gateway.OverloadStatusCode != 503 {
		t.Errorf("expected default overload_status_code 503, got %d", cfg.Gateway.OverloadStatusCode)
	}
	if cfg.ProviderCooldown.Default429TTLS != 15 {
		t.Errorf("expected default provider cooldown ttl 15, got %d", cfg.ProviderCooldown.Default429TTLS)
	}
}

func TestLoadConfig_FileNotFound(t *testing.T) {
	_, err := LoadConfig("/nonexistent/path/config.yaml")
	if err == nil {
		t.Fatal("expected error for nonexistent file, got nil")
	}
}

func TestLoadConfig_InvalidYAML(t *testing.T) {
	path := writeTestConfig(t, "{{invalid yaml")
	_, err := LoadConfig(path)
	if err == nil {
		t.Fatal("expected error for invalid YAML, got nil")
	}
}
