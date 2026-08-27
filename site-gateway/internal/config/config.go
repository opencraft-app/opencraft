// Package config 从环境变量加载站点网关配置。
package config

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// Addr 是对外的站点入口，承载用户站点的全部路径。
	Addr string
	// AdminAddr 是健康检查入口。必须与站点入口分开监听：站点的路径空间完全属于
	// 用户，把 /healthz 挂在同一个端口会占用用户可能用到的路径。
	AdminAddr string

	RootDomains []string

	COSBucket    string
	COSRegion    string
	COSSecretID  string
	COSSecretKey string
	COSTimeout   time.Duration

	CTLBaseURL       string
	CTLInternalToken string
	CTLTimeout       time.Duration

	AuthMode             AuthMode
	AuthEndpointsEnabled bool
	AuthFixedHost        string
	AuthOIDCIssuer       string
	AuthOIDCAuthorizeURL string
	AuthOIDCTokenURL     string
	AuthOIDCJWKSURL      string
	AuthOIDCClientID     string
	AuthAEADActiveKeyID  string
	AuthAEADKeys         map[string][]byte
	AuthSessionTTL       time.Duration
	TrustProxyHeaders    bool

	DSHDomains                   []string
	DSHFederationAuthorizeURL    string
	DSHFederationBaseURL         string
	DSHFederationClientID        string
	DSHFederationKeyID           string
	DSHFederationHMACKey         []byte
	DSHTATStartTimeout           time.Duration
	DSHTATOpenTimeout            time.Duration
	DSHResponseHeaderTimeout     time.Duration
	DSHTATIdleTimeout            time.Duration
	DSHMaxTargets                int
	DSHMaxConnectionsPerTarget   int
	DSHQueueDepth                int
	DSHMaxFrameBytes             int64
	DSHMaxBufferedBytesPerConn   int64
	DSHMaxBufferedBytesPerTarget int64
	DSHMaxBufferedBytesTotal     int64

	SitePositiveTTL time.Duration
	SiteNegativeTTL time.Duration
	// SiteCacheMaxEntries 是站点元信息缓存的条目上界。
	SiteCacheMaxEntries int

	// UsageReportInterval 是流量上报的窗口长度。
	//
	// 做成配置项是为了让测试环境能把它调短、快速验证链路，正式环境保持一分钟。
	// 它同时决定了超额拦截的收敛延迟下限：拦住之前最多还能跑一个窗口的流量。
	UsageReportInterval time.Duration
	// UsageMaxSites 是内存里同时保留的站点计数条目上界。
	UsageMaxSites int
}

type AuthMode string

const (
	AuthModePublic   AuthMode = "public"
	AuthModeRequired AuthMode = "required"
)

func FromEnv() (Config, error) {
	cfg := Config{
		Addr:                      getEnv("SITE_GATEWAY_ADDR", ":8080"),
		AdminAddr:                 getEnv("SITE_GATEWAY_ADMIN_ADDR", ":8081"),
		RootDomains:               splitList(os.Getenv("SITE_GATEWAY_ROOT_DOMAINS")),
		COSBucket:                 strings.TrimSpace(os.Getenv("SITE_GATEWAY_COS_BUCKET")),
		COSRegion:                 strings.TrimSpace(os.Getenv("SITE_GATEWAY_COS_REGION")),
		CTLBaseURL:                strings.TrimSpace(os.Getenv("SITE_GATEWAY_CTL_BASE_URL")),
		CTLInternalToken:          strings.TrimSpace(os.Getenv("WEBSITE_INTERNAL_API_TOKEN")),
		AuthEndpointsEnabled:      false,
		AuthFixedHost:             strings.TrimSpace(os.Getenv("SITE_GATEWAY_AUTH_FIXED_HOST")),
		AuthOIDCIssuer:            strings.TrimSpace(os.Getenv("SITE_GATEWAY_AUTH_OIDC_ISSUER")),
		AuthOIDCAuthorizeURL:      strings.TrimSpace(os.Getenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL")),
		AuthOIDCTokenURL:          strings.TrimSpace(os.Getenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL")),
		AuthOIDCJWKSURL:           strings.TrimSpace(os.Getenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL")),
		AuthOIDCClientID:          strings.TrimSpace(os.Getenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID")),
		AuthAEADActiveKeyID:       strings.TrimSpace(os.Getenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID")),
		DSHDomains:                splitList(os.Getenv("SITE_GATEWAY_DSH_DOMAINS")),
		DSHFederationAuthorizeURL: strings.TrimSpace(os.Getenv("SITE_GATEWAY_DSH_FEDERATION_AUTHORIZE_URL")),
		DSHFederationBaseURL:      strings.TrimSpace(os.Getenv("SITE_GATEWAY_DSH_FEDERATION_BASE_URL")),
		DSHFederationClientID:     strings.TrimSpace(os.Getenv("SITE_GATEWAY_DSH_FEDERATION_CLIENT_ID")),
		DSHFederationKeyID:        strings.TrimSpace(os.Getenv("SITE_GATEWAY_DSH_FEDERATION_KEY_ID")),
	}
	var err error
	if cfg.AuthEndpointsEnabled, err = getBool("SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED", false); err != nil {
		return Config{}, err
	}
	switch AuthMode(getEnv("SITE_GATEWAY_AUTH_MODE", string(AuthModePublic))) {
	case AuthModePublic:
		cfg.AuthMode = AuthModePublic
	case AuthModeRequired:
		cfg.AuthMode = AuthModeRequired
	default:
		return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_MODE must be public or required")
	}
	if cfg.AuthAEADKeys, err = parseAuthAEADKeys(os.Getenv("SITE_GATEWAY_AUTH_AEAD_KEYS")); err != nil {
		return Config{}, err
	}
	if cfg.DSHFederationHMACKey, err = parseDSHHMACKey(os.Getenv("SITE_GATEWAY_DSH_FEDERATION_HMAC_KEY")); err != nil {
		return Config{}, err
	}
	cfg.COSSecretID, cfg.COSSecretKey = cosSecrets()

	if cfg.COSTimeout, err = getDuration("SITE_GATEWAY_COS_TIMEOUT", 10*time.Second); err != nil {
		return Config{}, err
	}
	if cfg.CTLTimeout, err = getDuration("SITE_GATEWAY_CTL_TIMEOUT", 3*time.Second); err != nil {
		return Config{}, err
	}
	if cfg.SitePositiveTTL, err = getDuration("SITE_GATEWAY_SITE_CACHE_TTL", 30*time.Second); err != nil {
		return Config{}, err
	}
	if cfg.SiteNegativeTTL, err = getDuration("SITE_GATEWAY_SITE_MISS_CACHE_TTL", 5*time.Second); err != nil {
		return Config{}, err
	}
	if cfg.SiteCacheMaxEntries, err = getPositiveInt("SITE_GATEWAY_SITE_CACHE_MAX_ENTRIES", 20000); err != nil {
		return Config{}, err
	}
	if cfg.UsageReportInterval, err = getDuration("SITE_GATEWAY_USAGE_REPORT_INTERVAL", time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.UsageMaxSites, err = getPositiveInt("SITE_GATEWAY_USAGE_MAX_SITES", 20000); err != nil {
		return Config{}, err
	}
	if cfg.AuthSessionTTL, err = getDuration("SITE_GATEWAY_AUTH_SESSION_TTL", 5*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.AuthSessionTTL > 5*time.Minute {
		return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_SESSION_TTL must not exceed 5m")
	}
	if cfg.TrustProxyHeaders, err = getBool("SITE_GATEWAY_TRUST_PROXY_HEADERS", false); err != nil {
		return Config{}, err
	}
	if cfg.DSHTATStartTimeout, err = getDuration("SITE_GATEWAY_DSH_TAT_START_TIMEOUT", 10*time.Second); err != nil {
		return Config{}, err
	}
	if cfg.DSHTATOpenTimeout, err = getDuration("SITE_GATEWAY_DSH_TAT_OPEN_TIMEOUT", 15*time.Second); err != nil {
		return Config{}, err
	}
	if cfg.DSHResponseHeaderTimeout, err = getDuration("SITE_GATEWAY_DSH_RESPONSE_HEADER_TIMEOUT", 20*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.DSHTATIdleTimeout, err = getDuration("SITE_GATEWAY_DSH_TAT_IDLE_TIMEOUT", time.Hour); err != nil {
		return Config{}, err
	}
	if cfg.DSHMaxTargets, err = getPositiveInt("SITE_GATEWAY_DSH_MAX_TARGETS", 16); err != nil {
		return Config{}, err
	}
	if cfg.DSHMaxConnectionsPerTarget, err = getPositiveInt("SITE_GATEWAY_DSH_MAX_CONNECTIONS_PER_TARGET", 64); err != nil {
		return Config{}, err
	}
	if cfg.DSHQueueDepth, err = getPositiveInt("SITE_GATEWAY_DSH_QUEUE_DEPTH", 64); err != nil {
		return Config{}, err
	}
	if cfg.DSHMaxFrameBytes, err = getPositiveInt64("SITE_GATEWAY_DSH_MAX_FRAME_BYTES", 256<<10); err != nil {
		return Config{}, err
	}
	if cfg.DSHMaxBufferedBytesPerConn, err = getPositiveInt64("SITE_GATEWAY_DSH_MAX_BUFFERED_BYTES_PER_CONNECTION", 2<<20); err != nil {
		return Config{}, err
	}
	if cfg.DSHMaxBufferedBytesPerTarget, err = getPositiveInt64("SITE_GATEWAY_DSH_MAX_BUFFERED_BYTES_PER_TARGET", 16<<20); err != nil {
		return Config{}, err
	}
	if cfg.DSHMaxBufferedBytesTotal, err = getPositiveInt64("SITE_GATEWAY_DSH_MAX_BUFFERED_BYTES_TOTAL", 64<<20); err != nil {
		return Config{}, err
	}
	// 根域是配置项而非常量：测试和正式用不同的域，正式根域后续还会更换。
	if len(cfg.RootDomains) == 0 {
		return Config{}, fmt.Errorf("SITE_GATEWAY_ROOT_DOMAINS is required")
	}
	if cfg.COSBucket == "" {
		return Config{}, fmt.Errorf("SITE_GATEWAY_COS_BUCKET is required")
	}
	if cfg.COSRegion == "" {
		return Config{}, fmt.Errorf("SITE_GATEWAY_COS_REGION is required")
	}
	if cfg.COSSecretID == "" || cfg.COSSecretKey == "" {
		return Config{}, fmt.Errorf("WEBSITE_COS_SECRET_ID/KEY (or TENCENT_SECRET_ID/KEY) are required")
	}
	if cfg.CTLBaseURL == "" {
		return Config{}, fmt.Errorf("SITE_GATEWAY_CTL_BASE_URL is required")
	}
	if cfg.AuthMode == AuthModeRequired && !cfg.AuthEndpointsEnabled {
		return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_MODE=required requires SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED=true")
	}
	if cfg.AuthEndpointsEnabled {
		if cfg.AuthFixedHost == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_FIXED_HOST is required when auth endpoints are enabled")
		}
		if !isBareHost(cfg.AuthFixedHost) {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_FIXED_HOST must be a bare host when auth endpoints are enabled")
		}
		if !isAllowedFixedAuthHost(cfg.AuthFixedHost) {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_FIXED_HOST must be one of sites-auth.lightvela.tech or sites-auth.lightvela.site")
		}
		if cfg.AuthOIDCIssuer == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_OIDC_ISSUER is required when auth endpoints are enabled")
		}
		if !isHTTPSURL(cfg.AuthOIDCIssuer) {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_OIDC_ISSUER must be an https URL when auth endpoints are enabled")
		}
		if cfg.AuthOIDCAuthorizeURL == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL is required when auth endpoints are enabled")
		}
		if !isHTTPSURL(cfg.AuthOIDCAuthorizeURL) {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL must be an https URL when auth endpoints are enabled")
		}
		if cfg.AuthOIDCTokenURL == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL is required when auth endpoints are enabled")
		}
		if !isHTTPSURL(cfg.AuthOIDCTokenURL) {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL must be an https URL when auth endpoints are enabled")
		}
		if cfg.AuthOIDCJWKSURL == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_OIDC_JWKS_URL is required when auth endpoints are enabled")
		}
		if !isHTTPSURL(cfg.AuthOIDCJWKSURL) {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_OIDC_JWKS_URL must be an https URL when auth endpoints are enabled")
		}
		if cfg.AuthOIDCClientID == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID is required when auth endpoints are enabled")
		}
		if cfg.AuthOIDCClientID != "site-gateway" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID must equal site-gateway")
		}
		if cfg.AuthAEADActiveKeyID == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID is required when auth endpoints are enabled")
		}
		if len(cfg.AuthAEADKeys) == 0 {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_AEAD_KEYS is required when auth endpoints are enabled")
		}
		if _, ok := cfg.AuthAEADKeys[cfg.AuthAEADActiveKeyID]; !ok {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID %q missing from SITE_GATEWAY_AUTH_AEAD_KEYS", cfg.AuthAEADActiveKeyID)
		}
	}
	dshFederationConfigured := cfg.DSHFederationAuthorizeURL != "" || cfg.DSHFederationBaseURL != "" || cfg.DSHFederationClientID != "" ||
		cfg.DSHFederationKeyID != ""
	if len(cfg.DSHDomains) == 0 && dshFederationConfigured {
		return Config{}, fmt.Errorf("SITE_GATEWAY_DSH_DOMAINS is required when DSH federation is configured")
	}
	if len(cfg.DSHDomains) > 0 {
		if cfg.DSHFederationAuthorizeURL == "" || cfg.DSHFederationBaseURL == "" || cfg.DSHFederationClientID == "" || cfg.DSHFederationKeyID == "" || len(cfg.DSHFederationHMACKey) == 0 {
			return Config{}, fmt.Errorf("DSH federation authorize URL, API base URL, and client credentials are required when DSH domains are configured")
		}
		authorizeURL, err := url.Parse(cfg.DSHFederationAuthorizeURL)
		if err != nil || authorizeURL.Scheme != "https" || authorizeURL.Host == "" || authorizeURL.User != nil || authorizeURL.RawQuery != "" || authorizeURL.Fragment != "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_DSH_FEDERATION_AUTHORIZE_URL must be an https URL without userinfo, query, or fragment")
		}
		federationURL, err := url.Parse(cfg.DSHFederationBaseURL)
		if err != nil || (federationURL.Scheme != "http" && federationURL.Scheme != "https") || federationURL.Host == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_DSH_FEDERATION_BASE_URL must be an http or https URL")
		}
		if federationURL.User != nil || federationURL.RawQuery != "" || federationURL.Fragment != "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_DSH_FEDERATION_BASE_URL must not contain userinfo, query, or fragment")
		}
		if cfg.DSHMaxFrameBytes > cfg.DSHMaxBufferedBytesPerConn ||
			cfg.DSHMaxBufferedBytesPerConn > cfg.DSHMaxBufferedBytesPerTarget ||
			cfg.DSHMaxBufferedBytesPerTarget > cfg.DSHMaxBufferedBytesTotal {
			return Config{}, fmt.Errorf("DSH byte limits must satisfy frame <= connection <= target <= total")
		}
		if int64(cfg.DSHMaxTargets) > (cfg.DSHMaxBufferedBytesTotal/4)/cfg.DSHMaxFrameBytes {
			return Config{}, fmt.Errorf("DSH target and frame limits exceed the transient memory budget")
		}
		for _, domain := range cfg.DSHDomains {
			if strings.ContainsAny(domain, "/:@") || strings.Trim(domain, ". ") != domain || !strings.Contains(domain, ".") {
				return Config{}, fmt.Errorf("SITE_GATEWAY_DSH_DOMAINS contains invalid domain %q", domain)
			}
		}
	}
	return cfg, nil
}

func parseDSHHMACKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(key) < 32 {
		return nil, fmt.Errorf("SITE_GATEWAY_DSH_FEDERATION_HMAC_KEY must be base64 with at least 32 decoded bytes")
	}
	return key, nil
}

func parseAuthAEADKeys(raw string) (map[string][]byte, error) {
	keys := make(map[string][]byte)
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
			return nil, fmt.Errorf("SITE_GATEWAY_AUTH_AEAD_KEYS entry must be kid=base64url-key")
		}
		kid := strings.TrimSpace(parts[0])
		if _, exists := keys[kid]; exists {
			return nil, fmt.Errorf("SITE_GATEWAY_AUTH_AEAD_KEYS contains duplicate kid %q", kid)
		}
		decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(parts[1]))
		if err != nil || len(decoded) < 32 {
			return nil, fmt.Errorf("SITE_GATEWAY_AUTH_AEAD_KEYS key %q must be a base64url key with at least 32 bytes", kid)
		}
		keys[kid] = decoded
	}
	return keys, nil
}

func isHTTPSURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host != ""
}

func isBareHost(raw string) bool {
	if raw == "" || strings.Contains(raw, "/") || strings.Contains(raw, "://") {
		return false
	}
	parsed, err := url.Parse("https://" + raw)
	return err == nil && parsed.Host == raw
}

func isAllowedFixedAuthHost(raw string) bool {
	switch raw {
	case "sites-auth.lightvela.tech", "sites-auth.lightvela.site":
		return true
	default:
		return false
	}
}

// cosSecrets 读取站点桶的访问凭据。
//
// 优先站点专用的 WEBSITE_COS_SECRET_ID/KEY，缺失时回落到共享平台凭据。这个优先级
// 和 ctl、website-deployer 完全一致，三处必须同时切换：ctl 用同一套凭据签发交给
// 用户的预签名 URL，权限越小越好；如果只把 deployer 换成专用凭据而漏掉网关，
// 就会留下一个仍在用大权限、还没人注意到的组件。
//
// 回落是过渡期的兜底——集群里 site-gateway-secrets 目前只有 TENCENT_* 两个键。
func cosSecrets() (secretID string, secretKey string) {
	secretID = strings.TrimSpace(os.Getenv("WEBSITE_COS_SECRET_ID"))
	secretKey = strings.TrimSpace(os.Getenv("WEBSITE_COS_SECRET_KEY"))
	if secretID != "" && secretKey != "" {
		return secretID, secretKey
	}
	return strings.TrimSpace(os.Getenv("TENCENT_SECRET_ID")),
		strings.TrimSpace(os.Getenv("TENCENT_SECRET_KEY"))
}

func getEnv(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func splitList(raw string) []string {
	var items []string
	for _, item := range strings.Split(raw, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}

// getPositiveInt 读取一个必须为正的整数配置。
//
// 非法值直接报错而不是回落到默认值：这些都是内存上界和上报节奏，配错一个字符
// 就静默换掉运行时行为，比启动失败难查得多。
func getPositiveInt(key string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	if value <= 0 {
		return 0, fmt.Errorf("%s must be positive", key)
	}
	return value, nil
}

func getPositiveInt64(key string, fallback int64) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	if value <= 0 {
		return 0, fmt.Errorf("%s must be positive", key)
	}
	return value, nil
}

func getDuration(key string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	if value <= 0 {
		return 0, fmt.Errorf("%s must be positive", key)
	}
	return value, nil
}

func getBool(key string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s: %w", key, err)
	}
	return value, nil
}
