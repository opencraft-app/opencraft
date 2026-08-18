// Package config 从环境变量加载站点网关配置。
package config

import (
	"crypto/ed25519"
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

	AuthMode       AuthMode
	AuthIssuer     string
	AuthAudience   string
	AuthStartURL   string
	AuthPublicKeys map[string]ed25519.PublicKey
	AuthSessionTTL time.Duration

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
		Addr:             getEnv("SITE_GATEWAY_ADDR", ":8080"),
		AdminAddr:        getEnv("SITE_GATEWAY_ADMIN_ADDR", ":8081"),
		RootDomains:      splitList(os.Getenv("SITE_GATEWAY_ROOT_DOMAINS")),
		COSBucket:        strings.TrimSpace(os.Getenv("SITE_GATEWAY_COS_BUCKET")),
		COSRegion:        strings.TrimSpace(os.Getenv("SITE_GATEWAY_COS_REGION")),
		CTLBaseURL:       strings.TrimSpace(os.Getenv("SITE_GATEWAY_CTL_BASE_URL")),
		CTLInternalToken: strings.TrimSpace(os.Getenv("WEBSITE_INTERNAL_API_TOKEN")),
		AuthIssuer:       strings.TrimSpace(os.Getenv("SITE_GATEWAY_AUTH_ISSUER")),
		AuthAudience:     strings.TrimSpace(os.Getenv("SITE_GATEWAY_AUTH_AUDIENCE")),
		AuthStartURL:     strings.TrimSpace(os.Getenv("SITE_GATEWAY_AUTH_START_URL")),
	}
	switch AuthMode(getEnv("SITE_GATEWAY_AUTH_MODE", string(AuthModePublic))) {
	case AuthModePublic:
		cfg.AuthMode = AuthModePublic
	case AuthModeRequired:
		cfg.AuthMode = AuthModeRequired
	default:
		return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_MODE must be public or required")
	}
	var err error
	if cfg.AuthPublicKeys, err = parseAuthPublicKeys(os.Getenv("SITE_GATEWAY_AUTH_PUBLIC_KEYS")); err != nil {
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
	if cfg.AuthMode == AuthModeRequired {
		if cfg.AuthIssuer == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_ISSUER is required when auth mode is required")
		}
		if cfg.AuthAudience == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_AUDIENCE is required when auth mode is required")
		}
		if cfg.AuthStartURL == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_START_URL is required when auth mode is required")
		}
		startURL, err := url.Parse(cfg.AuthStartURL)
		if err != nil || startURL.Scheme != "https" || startURL.Host == "" {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_START_URL must be an https URL when auth mode is required")
		}
		if len(cfg.AuthPublicKeys) == 0 {
			return Config{}, fmt.Errorf("SITE_GATEWAY_AUTH_PUBLIC_KEYS is required when auth mode is required")
		}
	}
	return cfg, nil
}

func parseAuthPublicKeys(raw string) (map[string]ed25519.PublicKey, error) {
	keys := make(map[string]ed25519.PublicKey)
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
			return nil, fmt.Errorf("SITE_GATEWAY_AUTH_PUBLIC_KEYS entry must be kid=base64url-public-key")
		}
		kid := strings.TrimSpace(parts[0])
		if _, exists := keys[kid]; exists {
			return nil, fmt.Errorf("SITE_GATEWAY_AUTH_PUBLIC_KEYS contains duplicate kid %q", kid)
		}
		decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(parts[1]))
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("SITE_GATEWAY_AUTH_PUBLIC_KEYS key %q must be a base64url Ed25519 public key", kid)
		}
		keys[kid] = ed25519.PublicKey(decoded)
	}
	return keys, nil
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
