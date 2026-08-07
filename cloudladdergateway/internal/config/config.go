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

const RouteModeSignedHTTPTunnel = "signed_http_tunnel"

type Config struct {
	Addr         string          `yaml:"addr"`
	MaxBodyBytes int64           `yaml:"max_body_bytes"`
	Transport    TransportConfig `yaml:"transport"`
	Discovery    DiscoveryConfig `yaml:"discovery"`
	Backends     []BackendConfig `yaml:"backends"`
	Auth         AuthConfig      `yaml:"auth"`
	Audit        AuditConfig     `yaml:"audit"`
	External     []ExternalRoute `yaml:"external_routes"`
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

type BackendConfig struct {
	Alias     string         `yaml:"alias"`
	EnvPrefix string         `yaml:"env_prefix"`
	Upstream  UpstreamConfig `yaml:"upstream"`
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
	Mode        string          `yaml:"mode"`
	Condition   string          `yaml:"condition"`
	Callers     []string        `yaml:"callers"`
	Upstream    UpstreamConfig  `yaml:"upstream"`
	Webhooks    []WebhookConfig `yaml:"webhooks"`

	// UinRoutes 按请求体里的影子账号 uin 把请求改派到另一条 route。
	//
	// 用途：jifei 侧只能配置一个固定的回调地址，但测试期有多个开发者环境需要各自收到
	// 自己订单的回调。计费把回调统一打到本 route，本表按 `interface.para.uin` 把请求
	// 分发到对应开发者环境的 route；表里没有的 uin 走本 route 自身的 upstream 兜底。
	//
	// 前提：每个开发者环境必须持有**不同的**影子账号 uin。共用同一个测试账号时无法区分。
	//
	// 可用 CLOUDLADDERGATEWAY_ROUTE_<ID>_UIN_ROUTES 覆盖，格式 `uin=route_id` 逗号分隔，
	// 这样新增开发者不需要重新构建镜像。
	UinRoutes []UinRoute `yaml:"uin_routes"`
}

// UinRoute 是一条 uin → route 的改派规则。
type UinRoute struct {
	Uin     string `yaml:"uin"`
	RouteID string `yaml:"route_id"`
}

type UpstreamConfig struct {
	Backend        string                `yaml:"backend"`
	BaseURL        string                `yaml:"base_url"`
	Scheme         string                `yaml:"scheme"`
	Polaris        PolarisUpstreamConfig `yaml:"polaris"`
	Timeout        string                `yaml:"timeout"`
	AllowedMethods []string              `yaml:"allowed_methods"`
	Headers        map[string]string     `yaml:"headers"`
	HeadersFromEnv map[string]string     `yaml:"headers_from_env"`
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

type ExternalRoute struct {
	Path               string                      `yaml:"path"`
	Methods            []string                    `yaml:"methods"`
	RouteID            string                      `yaml:"route_id"`
	UpstreamPath       string                      `yaml:"upstream_path"`
	HeaderRoutes       []ExternalHeaderRoute       `yaml:"header_routes"`
	AuthCodeRoutes     []ExternalAuthCodeRoute     `yaml:"auth_code_routes"`
	UserIDRoutes       []ExternalUserIDRoute       `yaml:"user_id_routes"`
	UserIDPrefixRoutes []ExternalUserIDPrefixRoute `yaml:"user_id_prefix_routes"`
}

type ExternalHeaderRoute struct {
	Name    string `yaml:"name"`
	Value   string `yaml:"value"`
	RouteID string `yaml:"route_id"`
}

type ExternalAuthCodeRoute struct {
	Prefix  string `yaml:"prefix"`
	RouteID string `yaml:"route_id"`
}

type ExternalUserIDRoute struct {
	UserID  string `yaml:"user_id"`
	RouteID string `yaml:"route_id"`
}

type ExternalUserIDPrefixRoute struct {
	Prefix  string `yaml:"prefix"`
	RouteID string `yaml:"route_id"`
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
	applyBackendEnvOverrides(&cfg)
	applyRouteEnvOverrides(&cfg)
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
	seenBackends := map[string]struct{}{}
	for i, backend := range c.Backends {
		if strings.TrimSpace(backend.Alias) == "" {
			return fmt.Errorf("backends[%d].alias is required", i)
		}
		if _, ok := seenBackends[backend.Alias]; ok {
			return fmt.Errorf("duplicate backend alias %q", backend.Alias)
		}
		seenBackends[backend.Alias] = struct{}{}
		if strings.TrimSpace(backend.Upstream.Backend) != "" {
			return fmt.Errorf("backend %q upstream.backend is not allowed", backend.Alias)
		}
		if err := validateConcreteUpstream("backend "+backend.Alias, backend.Upstream); err != nil {
			return err
		}
		if _, err := ParseDuration(backend.Upstream.Timeout, 30*time.Second); err != nil {
			return fmt.Errorf("backend %q upstream.timeout: %w", backend.Alias, err)
		}
	}
	seen := map[string]struct{}{}
	for i, route := range c.Routes {
		if strings.TrimSpace(route.ID) == "" {
			return fmt.Errorf("routes[%d].id is required", i)
		}
		mode := normalizeRouteMode(route.Mode)
		switch mode {
		case "", RouteModeSignedHTTPTunnel:
		default:
			return fmt.Errorf("route %q mode %q is not supported", route.ID, route.Mode)
		}
		if _, ok := seen[route.ID]; ok {
			return fmt.Errorf("duplicate route id %q", route.ID)
		}
		seen[route.ID] = struct{}{}
		upstream, err := c.ResolveUpstream(route.ID, route.Upstream)
		if err != nil {
			return err
		}
		if err := validateConcreteUpstream("route "+route.ID, upstream); err != nil {
			return err
		}
		if _, err := ParseDuration(upstream.Timeout, 30*time.Second); err != nil {
			return fmt.Errorf("route %q upstream.timeout: %w", route.ID, err)
		}
		if mode == RouteModeSignedHTTPTunnel {
			if _, ok := trustedHost(upstream); !ok {
				return fmt.Errorf("route %q signed_http_tunnel requires upstream base_url host or upstream.headers.Host", route.ID)
			}
			if len(route.Webhooks) > 0 {
				return fmt.Errorf("route %q signed_http_tunnel does not support webhooks", route.ID)
			}
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
	for i, route := range c.External {
		if strings.TrimSpace(route.Path) == "" {
			return fmt.Errorf("external_routes[%d].path is required", i)
		}
		if !strings.HasPrefix(route.Path, "/") {
			return fmt.Errorf("external_routes[%d].path must start with /", i)
		}
		if strings.Contains(route.Path, ":") || strings.Contains(route.Path, "*") {
			return fmt.Errorf("external_routes[%d].path must be exact", i)
		}
		if strings.TrimSpace(route.RouteID) == "" {
			return fmt.Errorf("external_routes[%d].route_id is required", i)
		}
		if _, ok := seen[route.RouteID]; !ok {
			return fmt.Errorf("external_routes[%d] references unknown route %q", i, route.RouteID)
		}
		if strings.TrimSpace(route.UpstreamPath) != "" && !strings.HasPrefix(route.UpstreamPath, "/") {
			return fmt.Errorf("external_routes[%d].upstream_path must start with /", i)
		}
		headerRouteKeys := make(map[string]struct{}, len(route.HeaderRoutes))
		for j, headerRoute := range route.HeaderRoutes {
			name := strings.TrimSpace(headerRoute.Name)
			value := strings.TrimSpace(headerRoute.Value)
			if name == "" {
				return fmt.Errorf("external_routes[%d].header_routes[%d].name is required", i, j)
			}
			if value == "" {
				return fmt.Errorf("external_routes[%d].header_routes[%d].value is required", i, j)
			}
			key := strings.ToLower(name) + "\x00" + value
			if _, exists := headerRouteKeys[key]; exists {
				return fmt.Errorf("external_routes[%d].header_routes[%d] %q=%q is duplicated", i, j, name, value)
			}
			headerRouteKeys[key] = struct{}{}
			if strings.TrimSpace(headerRoute.RouteID) == "" {
				return fmt.Errorf("external_routes[%d].header_routes[%d].route_id is required", i, j)
			}
			if _, ok := seen[headerRoute.RouteID]; !ok {
				return fmt.Errorf("external_routes[%d].header_routes[%d] references unknown route %q", i, j, headerRoute.RouteID)
			}
		}
		prefixes := make(map[string]struct{}, len(route.AuthCodeRoutes))
		for j, authCodeRoute := range route.AuthCodeRoutes {
			prefix := strings.TrimSpace(authCodeRoute.Prefix)
			if prefix == "" || !strings.HasSuffix(prefix, ".") {
				return fmt.Errorf("external_routes[%d].auth_code_routes[%d].prefix must be non-empty and end with .", i, j)
			}
			if _, exists := prefixes[prefix]; exists {
				return fmt.Errorf("external_routes[%d].auth_code_routes[%d].prefix %q is duplicated", i, j, prefix)
			}
			prefixes[prefix] = struct{}{}
			if strings.TrimSpace(authCodeRoute.RouteID) == "" {
				return fmt.Errorf("external_routes[%d].auth_code_routes[%d].route_id is required", i, j)
			}
			if _, ok := seen[authCodeRoute.RouteID]; !ok {
				return fmt.Errorf("external_routes[%d].auth_code_routes[%d] references unknown route %q", i, j, authCodeRoute.RouteID)
			}
		}
		userIDs := make(map[string]struct{}, len(route.UserIDRoutes))
		for j, userIDRoute := range route.UserIDRoutes {
			userID := strings.TrimSpace(userIDRoute.UserID)
			if userID == "" {
				return fmt.Errorf("external_routes[%d].user_id_routes[%d].user_id is required", i, j)
			}
			if _, exists := userIDs[userID]; exists {
				return fmt.Errorf("external_routes[%d].user_id_routes[%d].user_id %q is duplicated", i, j, userID)
			}
			userIDs[userID] = struct{}{}
			if strings.TrimSpace(userIDRoute.RouteID) == "" {
				return fmt.Errorf("external_routes[%d].user_id_routes[%d].route_id is required", i, j)
			}
			if _, ok := seen[userIDRoute.RouteID]; !ok {
				return fmt.Errorf("external_routes[%d].user_id_routes[%d] references unknown route %q", i, j, userIDRoute.RouteID)
			}
		}
		userIDPrefixes := make(map[string]struct{}, len(route.UserIDPrefixRoutes))
		for j, userIDPrefixRoute := range route.UserIDPrefixRoutes {
			prefix := strings.TrimSpace(userIDPrefixRoute.Prefix)
			if prefix == "" || !strings.HasSuffix(prefix, "_") {
				return fmt.Errorf("external_routes[%d].user_id_prefix_routes[%d].prefix must be non-empty and end with _", i, j)
			}
			if _, exists := userIDPrefixes[prefix]; exists {
				return fmt.Errorf("external_routes[%d].user_id_prefix_routes[%d].prefix %q is duplicated", i, j, prefix)
			}
			userIDPrefixes[prefix] = struct{}{}
			if strings.TrimSpace(userIDPrefixRoute.RouteID) == "" {
				return fmt.Errorf("external_routes[%d].user_id_prefix_routes[%d].route_id is required", i, j)
			}
			if _, ok := seen[userIDPrefixRoute.RouteID]; !ok {
				return fmt.Errorf("external_routes[%d].user_id_prefix_routes[%d] references unknown route %q", i, j, userIDPrefixRoute.RouteID)
			}
		}
	}
	return nil
}

func normalizeRouteMode(mode string) string {
	return strings.ToLower(strings.TrimSpace(mode))
}

func applyBackendEnvOverrides(cfg *Config) {
	for i := range cfg.Backends {
		alias := strings.TrimSpace(cfg.Backends[i].Alias)
		if alias == "" {
			continue
		}
		envPrefix := strings.TrimSpace(cfg.Backends[i].EnvPrefix)
		if envPrefix == "" {
			envPrefix = "CLOUDLADDERGATEWAY_BACKEND_" + envToken(alias)
		}
		if value := strings.TrimSpace(os.Getenv(envPrefix + "_BASE_URL")); value != "" {
			cfg.Backends[i].Upstream.BaseURL = value
		}
		if value := strings.TrimSpace(os.Getenv(envPrefix + "_HOST_HEADER")); value != "" {
			if cfg.Backends[i].Upstream.Headers == nil {
				cfg.Backends[i].Upstream.Headers = map[string]string{}
			}
			cfg.Backends[i].Upstream.Headers["Host"] = value
		}
	}
}

func applyRouteEnvOverrides(cfg *Config) {
	for i := range cfg.Routes {
		routeID := strings.TrimSpace(cfg.Routes[i].ID)
		if routeID == "" {
			continue
		}
		envPrefix := "CLOUDLADDERGATEWAY_ROUTE_" + envToken(routeID)
		if value := strings.TrimSpace(os.Getenv(envPrefix + "_BASE_URL")); value != "" {
			cfg.Routes[i].Upstream.BaseURL = value
		}
		if value := strings.TrimSpace(os.Getenv(envPrefix + "_HOST_HEADER")); value != "" {
			if cfg.Routes[i].Upstream.Headers == nil {
				cfg.Routes[i].Upstream.Headers = map[string]string{}
			}
			cfg.Routes[i].Upstream.Headers["Host"] = value
		}
		if value := strings.TrimSpace(os.Getenv(envPrefix + "_UIN_ROUTES")); value != "" {
			if parsed := parseUinRoutes(value); len(parsed) > 0 {
				cfg.Routes[i].UinRoutes = parsed
			}
		}
	}
}

// parseUinRoutes 解析 `uin=route_id` 逗号分隔的 uin 改派表。
//
// 这个 env 覆盖存在的意义是「新增一个开发者环境不需要重新构建镜像」——路由表是烤进镜像的，
// 但 env 可以只改 gitops 的工作负载清单。格式不合法的条目直接跳过，不让一处笔误把整张表废掉
// （回调链路宁可退化到兜底环境，也不要整体失效）。
func parseUinRoutes(raw string) []UinRoute {
	var routes []UinRoute
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		uin, routeID, ok := strings.Cut(item, "=")
		uin = strings.TrimSpace(uin)
		routeID = strings.TrimSpace(routeID)
		if !ok || uin == "" || routeID == "" {
			continue
		}
		routes = append(routes, UinRoute{Uin: uin, RouteID: routeID})
	}
	return routes
}

func envToken(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r - 'a' + 'A')
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

func trustedHost(upstream UpstreamConfig) (string, bool) {
	for key, value := range upstream.Headers {
		if strings.EqualFold(key, "Host") && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value), true
		}
	}
	if strings.TrimSpace(upstream.BaseURL) == "" {
		return "", false
	}
	parsed, err := url.Parse(upstream.BaseURL)
	if err != nil || parsed.Host == "" {
		return "", false
	}
	return parsed.Host, true
}

func (c Config) ResolveUpstream(routeID string, upstream UpstreamConfig) (UpstreamConfig, error) {
	backendAlias := strings.TrimSpace(upstream.Backend)
	if backendAlias == "" {
		return upstream, nil
	}
	if strings.TrimSpace(upstream.BaseURL) != "" ||
		strings.TrimSpace(upstream.Polaris.Service) != "" ||
		strings.TrimSpace(upstream.Polaris.Namespace) != "" {
		return UpstreamConfig{}, fmt.Errorf("route %q upstream must not mix backend with base_url or polaris", routeID)
	}
	var backend *BackendConfig
	for i := range c.Backends {
		if c.Backends[i].Alias == backendAlias {
			backend = &c.Backends[i]
			break
		}
	}
	if backend == nil {
		return UpstreamConfig{}, fmt.Errorf("route %q references unknown backend %q", routeID, backendAlias)
	}
	resolved := backend.Upstream
	if upstream.Scheme != "" {
		resolved.Scheme = upstream.Scheme
	}
	if upstream.Timeout != "" {
		resolved.Timeout = upstream.Timeout
	}
	if len(upstream.AllowedMethods) > 0 {
		resolved.AllowedMethods = append([]string(nil), upstream.AllowedMethods...)
	}
	if len(upstream.Headers) > 0 {
		headers := map[string]string{}
		for key, value := range resolved.Headers {
			headers[key] = value
		}
		for key, value := range upstream.Headers {
			headers[key] = value
		}
		resolved.Headers = headers
	}
	if len(upstream.HeadersFromEnv) > 0 {
		headersFromEnv := map[string]string{}
		for key, value := range resolved.HeadersFromEnv {
			headersFromEnv[key] = value
		}
		for key, value := range upstream.HeadersFromEnv {
			headersFromEnv[key] = value
		}
		resolved.HeadersFromEnv = headersFromEnv
	}
	resolved.Backend = ""
	return resolved, nil
}

func validateConcreteUpstream(label string, upstream UpstreamConfig) error {
	hasStatic := strings.TrimSpace(upstream.BaseURL) != ""
	hasPolaris := strings.TrimSpace(upstream.Polaris.Service) != "" || strings.TrimSpace(upstream.Polaris.Namespace) != ""
	switch {
	case hasStatic && hasPolaris:
		return fmt.Errorf("%s upstream must use either base_url or polaris, not both", label)
	case hasStatic:
		if _, err := url.ParseRequestURI(upstream.BaseURL); err != nil {
			return fmt.Errorf("%s upstream.base_url: %w", label, err)
		}
	case hasPolaris:
		if strings.TrimSpace(upstream.Polaris.Service) == "" {
			return fmt.Errorf("%s upstream.polaris.service is required", label)
		}
		if strings.TrimSpace(upstream.Polaris.Namespace) == "" {
			return fmt.Errorf("%s upstream.polaris.namespace is required", label)
		}
		switch strings.TrimSpace(upstream.Scheme) {
		case "", "http", "https":
		default:
			return fmt.Errorf("%s upstream.scheme must be http or https", label)
		}
	default:
		return fmt.Errorf("%s upstream requires base_url or polaris", label)
	}
	for header, envName := range upstream.HeadersFromEnv {
		if strings.TrimSpace(header) == "" {
			return fmt.Errorf("%s upstream.headers_from_env contains empty header name", label)
		}
		if strings.TrimSpace(envName) == "" {
			return fmt.Errorf("%s upstream.headers_from_env.%s is required", label, header)
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
