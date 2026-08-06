package config

import (
	"testing"
	"time"
)

// setRequired 填齐 FromEnv 的必填项，让用例只关注自己要验证的那一项。
func setRequired(t *testing.T) {
	t.Helper()
	t.Setenv("SITE_GATEWAY_ROOT_DOMAINS", "sites.lightclaw.tech")
	t.Setenv("SITE_GATEWAY_COS_BUCKET", "test-vela-user-sites-1388575217")
	t.Setenv("SITE_GATEWAY_COS_REGION", "ap-beijing")
	t.Setenv("SITE_GATEWAY_CTL_BASE_URL", "http://ctl-api-cloudbase.ctl.svc.cluster.local")
}

// 站点专用凭据一旦配上，网关就不能再用共享平台凭据回源：三个组件的优先级必须一致，
// 否则会出现「换了 deployer 的凭据、网关还在用大权限」的半吊子状态。
func TestFromEnvPrefersWebsiteScopedCredentials(t *testing.T) {
	setRequired(t)
	t.Setenv("TENCENT_SECRET_ID", "AKIDPLATFORM")
	t.Setenv("TENCENT_SECRET_KEY", "platform-key")
	t.Setenv("WEBSITE_COS_SECRET_ID", "AKIDSITESCOPED")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "site-key")

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.COSSecretID != "AKIDSITESCOPED" || cfg.COSSecretKey != "site-key" {
		t.Fatalf("凭据 = %q/%q, want AKIDSITESCOPED/site-key", cfg.COSSecretID, cfg.COSSecretKey)
	}
}

// 集群里 site-gateway-secrets 目前只有 TENCENT_*，回落必须真的能生效，
// 否则这次改动会让网关起不来。
func TestFromEnvFallsBackToPlatformCredentials(t *testing.T) {
	setRequired(t)
	t.Setenv("WEBSITE_COS_SECRET_ID", "")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "")
	t.Setenv("TENCENT_SECRET_ID", "AKIDPLATFORM")
	t.Setenv("TENCENT_SECRET_KEY", "platform-key")

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.COSSecretID != "AKIDPLATFORM" || cfg.COSSecretKey != "platform-key" {
		t.Fatalf("凭据 = %q/%q, want AKIDPLATFORM/platform-key", cfg.COSSecretID, cfg.COSSecretKey)
	}
}

// 只配了一半的专用凭据不能用半套回源，必须整体回落。
func TestFromEnvIgnoresPartialWebsiteCredentials(t *testing.T) {
	setRequired(t)
	t.Setenv("WEBSITE_COS_SECRET_ID", "AKIDSITESCOPED")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "")
	t.Setenv("TENCENT_SECRET_ID", "AKIDPLATFORM")
	t.Setenv("TENCENT_SECRET_KEY", "platform-key")

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.COSSecretID != "AKIDPLATFORM" || cfg.COSSecretKey != "platform-key" {
		t.Fatalf("凭据 = %q/%q, want AKIDPLATFORM/platform-key", cfg.COSSecretID, cfg.COSSecretKey)
	}
}

func TestFromEnvRequiresSomeCredentials(t *testing.T) {
	setRequired(t)
	t.Setenv("WEBSITE_COS_SECRET_ID", "")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "")
	t.Setenv("TENCENT_SECRET_ID", "")
	t.Setenv("TENCENT_SECRET_KEY", "")

	if _, err := FromEnv(); err == nil {
		t.Fatal("两套凭据都缺失时应当报错")
	}
}

// 站点缓存 TTL 是唯一还需要按环境调的可选项，默认值和覆盖都要守住：
// env 名字写错时只会静默回落，不会报错。
func TestFromEnvSiteCacheTTLDefaultsAndOverrides(t *testing.T) {
	setRequired(t)
	t.Setenv("TENCENT_SECRET_ID", "AKIDPLATFORM")
	t.Setenv("TENCENT_SECRET_KEY", "platform-key")

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.SitePositiveTTL != 30*time.Second || cfg.SiteNegativeTTL != 5*time.Second {
		t.Fatalf("缓存 TTL 默认值 = %v/%v, want 30s/5s", cfg.SitePositiveTTL, cfg.SiteNegativeTTL)
	}

	t.Setenv("SITE_GATEWAY_SITE_CACHE_TTL", "2m")
	t.Setenv("SITE_GATEWAY_SITE_MISS_CACHE_TTL", "15s")
	cfg, err = FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.SitePositiveTTL != 2*time.Minute || cfg.SiteNegativeTTL != 15*time.Second {
		t.Fatalf("覆盖未生效: %v/%v", cfg.SitePositiveTTL, cfg.SiteNegativeTTL)
	}
}
