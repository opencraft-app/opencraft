package config

import (
	"testing"
)

func setRequiredLoadEnv(t *testing.T) {
	t.Helper()
	t.Setenv("TRADE_MYSQL_DSN", "trade:pass@tcp(127.0.0.1:3306)/trade")
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-token")
	t.Setenv("CTL_INTERNAL_BASE_URL", "http://ctl.local")
}

func TestLoadUsesAccountBindingInternalBaseURL(t *testing.T) {
	setRequiredLoadEnv(t)
	t.Setenv("ACCOUNT_BINDING_INTERNAL_BASE_URL", "http://auth.local")
	t.Setenv("SHADOW_INTERNAL_BASE_URL", "http://legacy-shadow.local")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.AccountBindingInternalBaseURL != "http://auth.local" {
		t.Fatalf("AccountBindingInternalBaseURL = %q", cfg.AccountBindingInternalBaseURL)
	}
}

func TestLoadFallsBackToLegacyShadowInternalBaseURL(t *testing.T) {
	setRequiredLoadEnv(t)
	t.Setenv("SHADOW_INTERNAL_BASE_URL", "http://legacy-shadow.local")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.AccountBindingInternalBaseURL != "http://legacy-shadow.local" {
		t.Fatalf("AccountBindingInternalBaseURL = %q", cfg.AccountBindingInternalBaseURL)
	}
}

// TestNormalizeSiteKind 验证 LIGHTVELA_SITE_KIND env 字面量到 trade 内部规范化字面量
// 的映射（v1.7.x 国际站接入新增）。
//
// 不变量（B-COMPAT-1）：非法值兜底为 "cn"，与 ctl / shadow / sandbox 缺省一致。
func TestNormalizeSiteKind(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"empty falls back to cn", "", "cn"},
		{"explicit cn lowercase", "cn", "cn"},
		{"explicit cn uppercase normalized", "CN", "cn"},
		{"explicit intl lowercase", "intl", "intl"},
		{"explicit intl uppercase normalized", "INTL", "intl"},
		{"explicit intl mixed case", "Intl", "intl"},
		{"with surrounding whitespace", "  intl  ", "intl"},
		{"bogus value falls back to cn", "bogus", "cn"},
		{"sg cluster name is not site kind, falls back to cn", "sg", "cn"},
		{"kr cluster name falls back to cn", "kr", "cn"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeSiteKind(tc.raw); got != tc.want {
				t.Errorf("normalizeSiteKind(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestLoad_SiteKindFromEnv 验证 Load() 端到端从 LIGHTVELA_SITE_KIND env 读取并写入
// Config.SiteKind 字段。仅校验 SiteKind 字段，其它必填项用 t.Setenv 准备最小集合
// 让 Load() 能跑通必填项校验。
func TestLoad_SiteKindFromEnv(t *testing.T) {
	cases := []struct {
		name    string
		envVal  string
		wantVal string
	}{
		{"unset env defaults to cn", "", "cn"},
		{"intl env value", "intl", "intl"},
		{"uppercase INTL normalized to intl", "INTL", "intl"},
		{"bogus value falls back to cn", "kr", "cn"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 准备 Load() 必填项最小集合（避免 require 校验失败）
			t.Setenv("TRADE_MYSQL_DSN", "user:pass@tcp(127.0.0.1:3306)/trade")
			t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "tk-test")
			t.Setenv("CTL_INTERNAL_BASE_URL", "http://ctl.test")
			t.Setenv("SHADOW_INTERNAL_BASE_URL", "http://shadow.test")
			t.Setenv("LIGHTVELA_SITE_KIND", tc.envVal)

			cfg, err := Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if cfg.SiteKind != tc.wantVal {
				t.Errorf("cfg.SiteKind = %q, want %q", cfg.SiteKind, tc.wantVal)
			}
		})
	}
}

func TestLoad_ShadowMockBindingFromEnv(t *testing.T) {
	setRequiredLoadEnv(t)
	t.Setenv("SHADOW_INTERNAL_BASE_URL", "http://shadow.test")
	t.Setenv("TRADE_SHADOW_MOCK_ENABLED", "true")
	t.Setenv("TRADE_SHADOW_MOCK_UIN", " 800000294207 ")
	t.Setenv("TRADE_SHADOW_MOCK_APP_ID", " 251221987 ")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.ShadowMockEnabled {
		t.Fatalf("ShadowMockEnabled = false, want true")
	}
	if cfg.ShadowMockUin != "800000294207" {
		t.Fatalf("ShadowMockUin = %q", cfg.ShadowMockUin)
	}
	if cfg.ShadowMockAppID != "251221987" {
		t.Fatalf("ShadowMockAppID = %q", cfg.ShadowMockAppID)
	}
}

// TestLoad_RegionOverrideFromEnv 验证 Load() 端到端从 LIGHTVELA_TRADE_REGION env 读取
// 并写入 Config.RegionOverride 字段（北京 2 预发布接入 2026-06-12 新增）。
//
// 关键不变量：
//   - 未设 env / 空字符串 → cfg.RegionOverride = ""，trade 出向走 SiteKind 兜底
//   - 已注册的 region 字面量（ap-guangzhou / ap-beijing / ap-shanghai / ap-singapore）→ 写入字面量原值
//   - 大小写 / 前后空白由 Load 直接 trim 但不 lower（lower 由 region.LookupByRegion 内部做）
//   - 未注册的 region 字面量 → Load 返回 error（fail-fast）
func TestLoad_RegionOverrideFromEnv(t *testing.T) {
	cases := []struct {
		name    string
		envVal  string
		wantVal string
		wantErr bool
	}{
		{"unset env keeps RegionOverride empty", "", "", false},
		{"ap-beijing override accepted", "ap-beijing", "ap-beijing", false},
		{"ap-shanghai override accepted", "ap-shanghai", "ap-shanghai", false},
		{"ap-guangzhou override accepted", "ap-guangzhou", "ap-guangzhou", false},
		{"ap-singapore override accepted", "ap-singapore", "ap-singapore", false},
		{"surrounding whitespace trimmed", "  ap-beijing  ", "ap-beijing", false},
		{"unknown region fails fast", "ap-tokyo", "", true},
		{"typo fails fast", "bj", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TRADE_MYSQL_DSN", "user:pass@tcp(127.0.0.1:3306)/trade")
			t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "tk-test")
			t.Setenv("CTL_INTERNAL_BASE_URL", "http://ctl.test")
			t.Setenv("SHADOW_INTERNAL_BASE_URL", "http://shadow.test")
			t.Setenv("LIGHTVELA_TRADE_REGION", tc.envVal)

			cfg, err := Load()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Load() expected error for envVal=%q, got nil (cfg.RegionOverride=%q)",
						tc.envVal, cfg.RegionOverride)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() unexpected error = %v", err)
			}
			if cfg.RegionOverride != tc.wantVal {
				t.Errorf("cfg.RegionOverride = %q, want %q", cfg.RegionOverride, tc.wantVal)
			}
		})
	}
}

func TestLoad_InquiryFallbackIdentityFromEnv(t *testing.T) {
	cases := []struct {
		name      string
		uin       string
		appID     string
		wantUin   string
		wantAppID string
		wantErr   bool
	}{
		{"unset disables fallback", "", "", "", "", false},
		{"both configured", "330500000004", "1447552654", "330500000004", "1447552654", false},
		{"surrounding whitespace trimmed", "  330500000004  ", "  1447552654  ", "330500000004", "1447552654", false},
		{"uin only fails fast", "330500000004", "", "", "", true},
		{"app id only fails fast", "", "1447552654", "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TRADE_MYSQL_DSN", "user:pass@tcp(127.0.0.1:3306)/trade")
			t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "tk-test")
			t.Setenv("CTL_INTERNAL_BASE_URL", "http://ctl.test")
			t.Setenv("SHADOW_INTERNAL_BASE_URL", "http://shadow.test")
			t.Setenv("TRADE_INQUIRY_FALLBACK_UIN", tc.uin)
			t.Setenv("TRADE_INQUIRY_FALLBACK_APP_ID", tc.appID)

			cfg, err := Load()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Load() expected error, got nil (uin=%q appID=%q)",
						cfg.InquiryFallbackUin, cfg.InquiryFallbackAppID)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() unexpected error = %v", err)
			}
			if cfg.InquiryFallbackUin != tc.wantUin || cfg.InquiryFallbackAppID != tc.wantAppID {
				t.Errorf("fallback identity = %q/%q, want %q/%q",
					cfg.InquiryFallbackUin, cfg.InquiryFallbackAppID, tc.wantUin, tc.wantAppID)
			}
		})
	}
}

func TestLoad_BillingCloudAPIIgnoresShadowCredentialFallback(t *testing.T) {
	setRequiredLoadEnv(t)
	t.Setenv("SHADOW_INTERNAL_BASE_URL", "http://shadow.test")
	t.Setenv("SHADOW_SECRET_ID", "shadow-opening-secret-id")
	t.Setenv("SHADOW_SECRET_KEY", "shadow-opening-secret-key")
	t.Setenv("SHADOW_BILLING_SECRET_ID", "shadow-billing-secret-id")
	t.Setenv("SHADOW_BILLING_SECRET_KEY", "shadow-billing-secret-key")
	t.Setenv("SHADOW_CLOUDLADDER_ENABLED", "true")
	t.Setenv("SHADOW_CLOUDLADDER_GATEWAY_BASE_URL", "http://clgateway.test")
	t.Setenv("SHADOW_CLOUDLADDER_HMAC_SECRET", "shadow-hmac")
	t.Setenv("SHADOW_BILLING_CLOUDLADDER_ROUTE_ID", "tcapi-billing-intl-test")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.BillingCloudAPISecretID != "" {
		t.Fatalf("BillingCloudAPISecretID = %q", cfg.BillingCloudAPISecretID)
	}
	if cfg.BillingCloudAPISecretKey != "" {
		t.Fatalf("BillingCloudAPISecretKey = %q", cfg.BillingCloudAPISecretKey)
	}
	if cfg.BillingCloudAPICloudLadderEnabled {
		t.Fatalf("BillingCloudAPICloudLadderEnabled = true, want false")
	}
	if cfg.BillingCloudAPICloudLadderGatewayURL != "" {
		t.Fatalf("BillingCloudAPICloudLadderGatewayURL = %q", cfg.BillingCloudAPICloudLadderGatewayURL)
	}
	if cfg.BillingCloudAPICloudLadderRouteID != "tcapi-billing-trade-intl-test" {
		t.Fatalf("BillingCloudAPICloudLadderRouteID default = %q", cfg.BillingCloudAPICloudLadderRouteID)
	}
	if cfg.BillingCloudAPICloudLadderCaller != "lightvela-trade" {
		t.Fatalf("BillingCloudAPICloudLadderCaller default = %q", cfg.BillingCloudAPICloudLadderCaller)
	}
	if cfg.BillingCloudAPICloudLadderHMACSecret != "" {
		t.Fatalf("BillingCloudAPICloudLadderHMACSecret = %q", cfg.BillingCloudAPICloudLadderHMACSecret)
	}
}

func TestLoad_BillingCloudAPIUsesTradeBillingCredential(t *testing.T) {
	setRequiredLoadEnv(t)
	t.Setenv("SHADOW_INTERNAL_BASE_URL", "http://shadow.test")
	t.Setenv("SHADOW_SECRET_ID", "shadow-opening-secret-id")
	t.Setenv("SHADOW_SECRET_KEY", "shadow-opening-secret-key")
	t.Setenv("TRADE_BILLING_SECRET_ID", "trade-billing-secret-id")
	t.Setenv("TRADE_BILLING_SECRET_KEY", "trade-billing-secret-key")
	t.Setenv("TRADE_BILLING_ENDPOINT", "billing.dev.tencentcloudapi.com")
	t.Setenv("TRADE_BILLING_REGION", "ap-singapore")
	t.Setenv("TRADE_BILLING_REQUEST_TIMEOUT", "3s")
	t.Setenv("TRADE_BILLING_CLOUDLADDER_ENABLED", "true")
	t.Setenv("TRADE_BILLING_CLOUDLADDER_GATEWAY_BASE_URL", "http://trade-clgateway.test")
	t.Setenv("TRADE_BILLING_CLOUDLADDER_ROUTE_ID", "tcapi-billing-intl-dev")
	t.Setenv("TRADE_BILLING_CLOUDLADDER_CALLER", "lightvela-trade")
	t.Setenv("TRADE_BILLING_CLOUDLADDER_HMAC_SECRET", "trade-hmac")
	t.Setenv("TRADE_BILLING_X_QCLOUD_USER_ID", "")
	t.Setenv("JIFEI_CGW_X_QCLOUD_USER_ID", "800000294207")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.BillingCloudAPISecretID != "trade-billing-secret-id" {
		t.Fatalf("BillingCloudAPISecretID = %q", cfg.BillingCloudAPISecretID)
	}
	if cfg.BillingCloudAPISecretKey != "trade-billing-secret-key" {
		t.Fatalf("BillingCloudAPISecretKey = %q", cfg.BillingCloudAPISecretKey)
	}
	if cfg.BillingCloudAPIEndpoint != "billing.dev.tencentcloudapi.com" {
		t.Fatalf("BillingCloudAPIEndpoint = %q", cfg.BillingCloudAPIEndpoint)
	}
	if cfg.BillingCloudAPIRegion != "ap-singapore" {
		t.Fatalf("BillingCloudAPIRegion = %q", cfg.BillingCloudAPIRegion)
	}
	if cfg.BillingCloudAPIRequestTimeout.String() != "3s" {
		t.Fatalf("BillingCloudAPIRequestTimeout = %s", cfg.BillingCloudAPIRequestTimeout)
	}
	if cfg.BillingCloudAPICloudLadderGatewayURL != "http://trade-clgateway.test" {
		t.Fatalf("BillingCloudAPICloudLadderGatewayURL = %q", cfg.BillingCloudAPICloudLadderGatewayURL)
	}
	if cfg.BillingCloudAPICloudLadderRouteID != "tcapi-billing-intl-dev" {
		t.Fatalf("BillingCloudAPICloudLadderRouteID = %q", cfg.BillingCloudAPICloudLadderRouteID)
	}
	if cfg.BillingCloudAPICloudLadderCaller != "lightvela-trade" {
		t.Fatalf("BillingCloudAPICloudLadderCaller = %q", cfg.BillingCloudAPICloudLadderCaller)
	}
	if cfg.BillingCloudAPICloudLadderHMACSecret != "trade-hmac" {
		t.Fatalf("BillingCloudAPICloudLadderHMACSecret = %q", cfg.BillingCloudAPICloudLadderHMACSecret)
	}
	if cfg.BillingCloudAPIXQCloudUserID != "800000294207" {
		t.Fatalf("BillingCloudAPIXQCloudUserID = %q", cfg.BillingCloudAPIXQCloudUserID)
	}
}
