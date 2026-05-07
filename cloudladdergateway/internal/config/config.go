package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const DefaultMaxBodyBytes int64 = 10 << 20

type Config struct {
	Addr         string          `yaml:"addr"`
	MaxBodyBytes int64           `yaml:"max_body_bytes"`
	Transport    TransportConfig `yaml:"transport"`
	Discovery    DiscoveryConfig `yaml:"discovery"`
	Auth         AuthConfig      `yaml:"auth"`
	Audit        AuditConfig     `yaml:"audit"`
	Routes       []RouteConfig   `yaml:"routes"`
}

type TransportConfig struct {
	MaxIdleConns          int    `yaml:"max_idle_conns"`
	MaxIdleConnsPerHost   int    `yaml:"max_idle_conns_per_host"`
	IdleConnTimeout       string `yaml:"idle_conn_timeout"`
	ResponseHeaderTimeout string `yaml:"response_header_timeout"`
	TLSHandshakeTimeout   string `yaml:"tls_handshake_timeout"`
	ExpectContinueTimeout string `yaml:"expect_continue_timeout"`
}

type DiscoveryConfig struct {
	Polaris PolarisDiscoveryConfig `yaml:"polaris"`
}

type PolarisDiscoveryConfig struct {
	SidecarURL   string `yaml:"sidecar_url"`
	CacheTTL     string `yaml:"cache_ttl"`
	StaleOnError *bool  `yaml:"stale_on_error"`
}

type AuthConfig struct {
	Enabled              bool           `yaml:"enabled"`
	TimestampSkew        string         `yaml:"timestamp_skew"`
	Callers              []CallerConfig `yaml:"callers"`
	AllowUnauthenticated []string       `yaml:"allow_unauthenticated"`
}

type CallerConfig struct {
	ID        string   `yaml:"id"`
	SecretEnv string   `yaml:"secret_env"`
	Routes    []string `yaml:"routes"`
}

type AuditConfig struct {
	ServiceName string          `yaml:"service_name"`
	Stdout      bool            `yaml:"stdout"`
	OTLP        AuditOTLPConfig `yaml:"otlp"`
}

type AuditOTLPConfig struct {
	Enabled     bool              `yaml:"enabled"`
	Endpoint    string            `yaml:"endpoint"`
	EndpointURL string            `yaml:"endpoint_url"`
	Insecure    bool              `yaml:"insecure"`
	Headers     map[string]string `yaml:"headers"`
	Timeout     string            `yaml:"timeout"`
}

type RouteConfig struct {
	ID          string          `yaml:"id"`
	Description string          `yaml:"description"`
	Condition   string          `yaml:"condition"`
	Callers     []string        `yaml:"callers"`
	Upstream    UpstreamConfig  `yaml:"upstream"`
	Webhooks    []WebhookConfig `yaml:"webhooks"`
}

type UpstreamConfig struct {
	BaseURL        string                `yaml:"base_url"`
	Scheme         string                `yaml:"scheme"`
	Polaris        PolarisUpstreamConfig `yaml:"polaris"`
	Timeout        string                `yaml:"timeout"`
	AllowedMethods []string              `yaml:"allowed_methods"`
	Headers        map[string]string     `yaml:"headers"`
}

type PolarisUpstreamConfig struct {
	Service   string `yaml:"service"`
	Namespace string `yaml:"namespace"`
}

type WebhookConfig struct {
	ID                  string            `yaml:"id"`
	URL                 string            `yaml:"url"`
	Method              string            `yaml:"method"`
	Mode                string            `yaml:"mode"`
	Condition           string            `yaml:"condition"`
	Timeout             string            `yaml:"timeout"`
	Headers             map[string]string `yaml:"headers"`
	ForwardOriginal     bool              `yaml:"forward_original"`
	SigningSecretEnv    string            `yaml:"signing_secret_env"`
	IncludeRequestBody  bool              `yaml:"include_request_body"`
	IncludeResponseBody bool              `yaml:"include_response_body"`
}

func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("decode config: %w", err)
	}
	if cfg.Addr == "" {
		cfg.Addr = ":8095"
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if cfg.Transport.MaxIdleConns <= 0 {
		cfg.Transport.MaxIdleConns = 100
	}
	if cfg.Transport.MaxIdleConnsPerHost <= 0 {
		cfg.Transport.MaxIdleConnsPerHost = 20
	}
	if cfg.Transport.IdleConnTimeout == "" {
		cfg.Transport.IdleConnTimeout = "90s"
	}
	if cfg.Transport.ResponseHeaderTimeout == "" {
		cfg.Transport.ResponseHeaderTimeout = "30s"
	}
	if cfg.Transport.TLSHandshakeTimeout == "" {
		cfg.Transport.TLSHandshakeTimeout = "10s"
	}
	if cfg.Transport.ExpectContinueTimeout == "" {
		cfg.Transport.ExpectContinueTimeout = "1s"
	}
	if cfg.Discovery.Polaris.SidecarURL == "" {
		cfg.Discovery.Polaris.SidecarURL = "http://127.0.0.1:8080"
	}
	if cfg.Discovery.Polaris.CacheTTL == "" {
		cfg.Discovery.Polaris.CacheTTL = "30s"
	}
	if cfg.Discovery.Polaris.StaleOnError == nil {
		staleOnError := true
		cfg.Discovery.Polaris.StaleOnError = &staleOnError
	}
	if cfg.Auth.TimestampSkew == "" {
		cfg.Auth.TimestampSkew = "5m"
	}
	if cfg.Audit.ServiceName == "" {
		cfg.Audit.ServiceName = "cloudladdergateway"
	}
	if !cfg.Audit.OTLP.Enabled && hasOTLPLogEndpointEnv() {
		cfg.Audit.OTLP.Enabled = true
	}
	if !cfg.Audit.Stdout && !cfg.Audit.OTLP.Enabled {
		cfg.Audit.Stdout = true
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if _, err := ParseDuration(c.Auth.TimestampSkew, 5*time.Minute); err != nil {
		return fmt.Errorf("auth.timestamp_skew: %w", err)
	}
	if _, err := ParseDuration(c.Transport.IdleConnTimeout, 90*time.Second); err != nil {
		return fmt.Errorf("transport.idle_conn_timeout: %w", err)
	}
	if _, err := ParseDuration(c.Transport.ResponseHeaderTimeout, 30*time.Second); err != nil {
		return fmt.Errorf("transport.response_header_timeout: %w", err)
	}
	if _, err := ParseDuration(c.Transport.TLSHandshakeTimeout, 10*time.Second); err != nil {
		return fmt.Errorf("transport.tls_handshake_timeout: %w", err)
	}
	if _, err := ParseDuration(c.Transport.ExpectContinueTimeout, time.Second); err != nil {
		return fmt.Errorf("transport.expect_continue_timeout: %w", err)
	}
	if _, err := ParseDuration(c.Discovery.Polaris.CacheTTL, 30*time.Second); err != nil {
		return fmt.Errorf("discovery.polaris.cache_ttl: %w", err)
	}
	if strings.TrimSpace(c.Discovery.Polaris.SidecarURL) != "" {
		if _, err := url.ParseRequestURI(c.Discovery.Polaris.SidecarURL); err != nil {
			return fmt.Errorf("discovery.polaris.sidecar_url: %w", err)
		}
	}
	seenCallers := map[string]struct{}{}
	for i, caller := range c.Auth.Callers {
		if strings.TrimSpace(caller.ID) == "" {
			return fmt.Errorf("auth.callers[%d].id is required", i)
		}
		if strings.TrimSpace(caller.SecretEnv) == "" {
			return fmt.Errorf("auth.caller %q secret_env is required", caller.ID)
		}
		if _, ok := seenCallers[caller.ID]; ok {
			return fmt.Errorf("duplicate auth caller %q", caller.ID)
		}
		seenCallers[caller.ID] = struct{}{}
	}
	seen := map[string]struct{}{}
	for i, route := range c.Routes {
		if strings.TrimSpace(route.ID) == "" {
			return fmt.Errorf("routes[%d].id is required", i)
		}
		if _, ok := seen[route.ID]; ok {
			return fmt.Errorf("duplicate route id %q", route.ID)
		}
		seen[route.ID] = struct{}{}
		hasStatic := strings.TrimSpace(route.Upstream.BaseURL) != ""
		hasPolaris := strings.TrimSpace(route.Upstream.Polaris.Service) != "" || strings.TrimSpace(route.Upstream.Polaris.Namespace) != ""
		switch {
		case hasStatic && hasPolaris:
			return fmt.Errorf("route %q upstream must use either base_url or polaris, not both", route.ID)
		case hasStatic:
			if _, err := url.ParseRequestURI(route.Upstream.BaseURL); err != nil {
				return fmt.Errorf("route %q upstream.base_url: %w", route.ID, err)
			}
		case hasPolaris:
			if strings.TrimSpace(route.Upstream.Polaris.Service) == "" {
				return fmt.Errorf("route %q upstream.polaris.service is required", route.ID)
			}
			if strings.TrimSpace(route.Upstream.Polaris.Namespace) == "" {
				return fmt.Errorf("route %q upstream.polaris.namespace is required", route.ID)
			}
			switch strings.TrimSpace(route.Upstream.Scheme) {
			case "", "http", "https":
			default:
				return fmt.Errorf("route %q upstream.scheme must be http or https", route.ID)
			}
		default:
			return fmt.Errorf("route %q upstream requires base_url or polaris", route.ID)
		}
		if _, err := ParseDuration(route.Upstream.Timeout, 30*time.Second); err != nil {
			return fmt.Errorf("route %q upstream.timeout: %w", route.ID, err)
		}
		for j, webhook := range route.Webhooks {
			if strings.TrimSpace(webhook.ID) == "" {
				return fmt.Errorf("route %q webhooks[%d].id is required", route.ID, j)
			}
			if _, err := url.ParseRequestURI(webhook.URL); err != nil {
				return fmt.Errorf("route %q webhook %q url: %w", route.ID, webhook.ID, err)
			}
			if _, err := ParseDuration(webhook.Timeout, 10*time.Second); err != nil {
				return fmt.Errorf("route %q webhook %q timeout: %w", route.ID, webhook.ID, err)
			}
		}
	}
	return nil
}

func ParseDuration(raw string, fallback time.Duration) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	return time.ParseDuration(raw)
}

func hasOTLPLogEndpointEnv() bool {
	return strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")) != "" ||
		strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")) != ""
}
