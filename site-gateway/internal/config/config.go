// Package config 从环境变量加载站点网关配置。
package config

import (
	"fmt"
	"os"
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

	SitePositiveTTL time.Duration
	SiteNegativeTTL time.Duration
}

func FromEnv() (Config, error) {
	cfg := Config{
		Addr:             getEnv("SITE_GATEWAY_ADDR", ":8080"),
		AdminAddr:        getEnv("SITE_GATEWAY_ADMIN_ADDR", ":8081"),
		RootDomains:      splitList(os.Getenv("SITE_GATEWAY_ROOT_DOMAINS")),
		COSBucket:        strings.TrimSpace(os.Getenv("SITE_GATEWAY_COS_BUCKET")),
		COSRegion:        strings.TrimSpace(os.Getenv("SITE_GATEWAY_COS_REGION")),
		CTLBaseURL:       strings.TrimSpace(os.Getenv("SITE_GATEWAY_CTL_BASE_URL")),
		CTLInternalToken: strings.TrimSpace(os.Getenv("WEBSITE_INTERNAL_API_TOKEN")),
	}
	cfg.COSSecretID, cfg.COSSecretKey = cosSecrets()

	var err error
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
	return cfg, nil
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
