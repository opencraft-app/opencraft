package config

import (
	"fmt"
	"os"
	"time"

	"github.com/go-sql-driver/mysql"
	"gopkg.in/yaml.v3"
)

// EncryptionKey is loaded from the ENCRYPTION_KEY env var.
type Config struct {
	Server           ServerConfig           `yaml:"server"`
	Database         DatabaseConfig         `yaml:"database"`
	Redis            RedisConfig            `yaml:"redis"`
	Portkey          PortkeyConfig          `yaml:"portkey"`
	Billing          BillingConfig          `yaml:"billing"`
	RateLimit        RateLimitConfig        `yaml:"rate_limit"`
	CircuitBreaker   CircuitBreakerConfig   `yaml:"circuit_breaker"`
	Gateway          GatewayConfig          `yaml:"gateway"`
	ProviderCooldown ProviderCooldownConfig `yaml:"provider_cooldown"`
	Registry         RegistryConfig         `yaml:"registry"`
	EncryptionKey    string                 `yaml:"-"`
}

// ServerConfig holds HTTP server settings.
type ServerConfig struct {
	Port                 int      `yaml:"port"`
	AdminToken           string   `yaml:"admin_token"`
	InternalServiceToken string   `yaml:"internal_service_token"`
	AdminIPWhitelist     []string `yaml:"admin_ip_whitelist"`
	MaxRequestBodySize   int64    `yaml:"max_request_body_size"`
}

// DatabaseConfig holds MySQL connection settings.
type DatabaseConfig struct {
	DSN string `yaml:"dsn"`
}

// RedisConfig holds Redis connection settings.
type RedisConfig struct {
	Addr     string `yaml:"addr"`
	Password string `yaml:"password"`
}

// PortkeyStrategyYAML 定义 路由策略的 YAML 配置。
type PortkeyStrategyYAML struct {
	Mode             string `yaml:"mode"`               // "loadbalance" | "fallback"
	OnStatusCodes    []int  `yaml:"on_status_codes"`    // 策略触发状态码
	RetryAttempts    int    `yaml:"retry_attempts"`     // 重试次数 0-5
	RetryStatusCodes []int  `yaml:"retry_status_codes"` // 重试触发状态码
}

// PortkeyConfig holds Portkey Gateway connection settings.
type PortkeyConfig struct {
	BaseURL  string              `yaml:"base_url"`
	Strategy PortkeyStrategyYAML `yaml:"strategy"`
}

// BillingConfig holds billing and token reservation settings.
type BillingConfig struct {
	AsyncLog                 bool  `yaml:"async_log"`
	LowBalanceThreshold      int64 `yaml:"low_balance_threshold"`
	DefaultReservationTokens int64 `yaml:"default_reservation_tokens"`
}

// RateLimitDefault 定义单条默认限流规则。
type RateLimitDefault struct {
	Window      string `yaml:"window"`
	MaxRequests int    `yaml:"max_requests"`
	Label       string `yaml:"label"`
}

// RateLimitConfig holds default rate limiting settings.
type RateLimitConfig struct {
	Defaults []RateLimitDefault `yaml:"defaults"`
}

// CircuitBreakerConfig 控制熔断器行为。
type CircuitBreakerConfig struct {
	FailureThreshold  int `yaml:"failure_threshold"`   // 连续失败多少次后打开，默认 5
	CooldownDurationS int `yaml:"cooldown_duration_s"` // 冷却时长(s)，默认 30
}

type GatewayConfig struct {
	MaxInflightBudget      int   `yaml:"max_inflight_budget"`
	StreamRequestWeight    int64 `yaml:"stream_request_weight"`
	NonStreamRequestWeight int64 `yaml:"non_stream_request_weight"`
	OverloadStatusCode     int   `yaml:"overload_status_code"`
}

type ProviderCooldownConfig struct {
	Default429TTLS int `yaml:"default_429_ttl_s"`
	Max429TTLS     int `yaml:"max_429_ttl_s"`
}

// RegistryConfig 控制服务注册中心行为。
type RegistryConfig struct {
	Token                string `yaml:"token"`                   // 注册认证 token，为空则不启用
	HeartbeatIntervalS   int    `yaml:"heartbeat_interval_s"`    // 心跳间隔(s)，默认 30
	StaleTimeoutS        int    `yaml:"stale_timeout_s"`         // 超时标记 unhealthy(s)，默认 90
	HealthCheckIntervalS int    `yaml:"health_check_interval_s"` // 健康检查间隔(s)，默认 60
}

// LoadConfig reads configuration from a YAML file at the given path,
// applies defaults, and overrides select fields from environment variables.
func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config file: %w", err)
	}

	cfg := &Config{}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parsing config file: %w", err)
	}

	applyDefaults(cfg)
	applyEnvOverrides(cfg)

	return cfg, nil
}

// applyDefaults sets sensible defaults for fields not specified in YAML.
func applyDefaults(cfg *Config) {
	if cfg.Server.Port == 0 {
		cfg.Server.Port = 18080
	}
	if cfg.Server.MaxRequestBodySize == 0 {
		cfg.Server.MaxRequestBodySize = 10 * 1024 * 1024 // 10 MB
	}
	if cfg.Redis.Addr == "" {
		cfg.Redis.Addr = "localhost:6379"
	}
	if cfg.Portkey.BaseURL == "" {
		cfg.Portkey.BaseURL = "http://localhost:8787"
	}
	if cfg.Portkey.Strategy.Mode == "" {
		cfg.Portkey.Strategy.Mode = "fallback"
	}
	if len(cfg.Portkey.Strategy.OnStatusCodes) == 0 {
		cfg.Portkey.Strategy.OnStatusCodes = []int{429, 500, 502, 503, 504}
	}
	if cfg.Portkey.Strategy.RetryAttempts == 0 {
		cfg.Portkey.Strategy.RetryAttempts = 3
	}
	if len(cfg.Portkey.Strategy.RetryStatusCodes) == 0 {
		cfg.Portkey.Strategy.RetryStatusCodes = []int{429, 503}
	}
	if cfg.Billing.DefaultReservationTokens == 0 {
		cfg.Billing.DefaultReservationTokens = 4096
	}
	if len(cfg.RateLimit.Defaults) == 0 {
		cfg.RateLimit.Defaults = []RateLimitDefault{
			{Window: "5h", MaxRequests: 1200, Label: "5小时"},
			{Window: "1w", MaxRequests: 9000, Label: "每周"},
			{Window: "1M", MaxRequests: 18000, Label: "每月"},
		}
	}
	if cfg.CircuitBreaker.FailureThreshold == 0 {
		cfg.CircuitBreaker.FailureThreshold = 5
	}
	if cfg.CircuitBreaker.CooldownDurationS == 0 {
		cfg.CircuitBreaker.CooldownDurationS = 30
	}
	if cfg.Gateway.StreamRequestWeight == 0 {
		cfg.Gateway.StreamRequestWeight = 3
	}
	if cfg.Gateway.NonStreamRequestWeight == 0 {
		cfg.Gateway.NonStreamRequestWeight = 1
	}
	if cfg.Gateway.OverloadStatusCode == 0 {
		cfg.Gateway.OverloadStatusCode = 503
	}
	if cfg.ProviderCooldown.Default429TTLS == 0 {
		cfg.ProviderCooldown.Default429TTLS = 15
	}
	if cfg.ProviderCooldown.Max429TTLS == 0 {
		cfg.ProviderCooldown.Max429TTLS = 60
	}
	if cfg.Registry.HeartbeatIntervalS == 0 {
		cfg.Registry.HeartbeatIntervalS = 30
	}
	if cfg.Registry.StaleTimeoutS == 0 {
		cfg.Registry.StaleTimeoutS = 90
	}
	if cfg.Registry.HealthCheckIntervalS == 0 {
		cfg.Registry.HealthCheckIntervalS = 60
	}
}

// applyEnvOverrides overrides config fields with environment variables where applicable.
func applyEnvOverrides(cfg *Config) {
	if v := os.Getenv("ENCRYPTION_KEY"); v != "" {
		cfg.EncryptionKey = v
	}
	if v := os.Getenv("ADMIN_TOKEN"); v != "" {
		cfg.Server.AdminToken = v
	}
	if v := os.Getenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN"); v != "" {
		cfg.Server.InternalServiceToken = v
	}
	if v := os.Getenv("DATABASE_URL"); v != "" {
		cfg.Database.DSN = v
	}
	if normalizedDSN, err := normalizeMySQLDSN(cfg.Database.DSN); err == nil {
		cfg.Database.DSN = normalizedDSN
	}
	if v := os.Getenv("REDIS_ADDR"); v != "" {
		cfg.Redis.Addr = v
	}
	if v := os.Getenv("REDIS_PASSWORD"); v != "" {
		cfg.Redis.Password = v
	}
	if v := os.Getenv("REGISTRY_TOKEN"); v != "" {
		cfg.Registry.Token = v
	}
	if v := os.Getenv("PORTKEY_BASE_URL"); v != "" {
		cfg.Portkey.BaseURL = v
	}
}

func normalizeMySQLDSN(dsn string) (string, error) {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		return "", fmt.Errorf("parse mysql dsn: %w", err)
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	return cfg.FormatDSN(), nil
}
