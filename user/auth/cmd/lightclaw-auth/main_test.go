package main

import (
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/devroute"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

func TestParseSameSite(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  http.SameSite
	}{
		{name: "default empty", input: "", want: http.SameSiteLaxMode},
		{name: "lax", input: "lax", want: http.SameSiteLaxMode},
		{name: "none", input: "none", want: http.SameSiteNoneMode},
		{name: "strict", input: "strict", want: http.SameSiteStrictMode},
		{name: "invalid", input: "weird", want: http.SameSiteLaxMode},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := parseSameSite(tt.input); got != tt.want {
				t.Fatalf("parseSameSite(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestBuildGitHubOAuthConfigDerivesRedirectFromPublicBaseURL(t *testing.T) {
	t.Setenv("LIGHTCLAW_GITHUB_CLIENT_ID", "github-client-id")
	t.Setenv("LIGHTCLAW_GITHUB_CLIENT_SECRET", "github-client-secret")
	t.Setenv("LIGHTCLAW_PUBLIC_BASE_URL", "https://api-sandbox-bj-7.lightclaw.tech/")
	t.Setenv("LIGHTCLAW_GITHUB_REDIRECT_URI", "")

	config := buildGitHubOAuthConfig()
	if config == nil {
		t.Fatal("buildGitHubOAuthConfig() = nil, want config")
	}
	const want = "https://api-sandbox-bj-7.lightclaw.tech/auth/oauth/github/callback"
	if config.RedirectURI != want {
		t.Fatalf("RedirectURI = %q, want %q", config.RedirectURI, want)
	}
}

func TestBuildGitHubOAuthConfigKeepsExplicitRedirectURI(t *testing.T) {
	t.Setenv("LIGHTCLAW_GITHUB_CLIENT_ID", "github-client-id")
	t.Setenv("LIGHTCLAW_GITHUB_CLIENT_SECRET", "github-client-secret")
	t.Setenv("LIGHTCLAW_PUBLIC_BASE_URL", "https://api-sandbox-bj-7.lightclaw.tech")
	t.Setenv("LIGHTCLAW_GITHUB_REDIRECT_URI", "https://example.com/auth/oauth/github/callback")

	config := buildGitHubOAuthConfig()
	if config == nil {
		t.Fatal("buildGitHubOAuthConfig() = nil, want config")
	}
	const want = "https://example.com/auth/oauth/github/callback"
	if config.RedirectURI != want {
		t.Fatalf("RedirectURI = %q, want %q", config.RedirectURI, want)
	}
}

func TestBuildWeChatOAuthConfigUsesLegacySecretForOfficialAccountFallback(t *testing.T) {
	t.Setenv("LIGHTVELA_WECHAT_WEBSITE_APP_ID", "")
	t.Setenv("LIGHTVELA_WECHAT_WEBSITE_APP_SECRET", "")
	t.Setenv("LIGHTCLAW_WECHAT_APP_ID", "website-app-id")
	t.Setenv("LIGHTCLAW_WECHAT_APP_SECRET", "legacy-wechat-secret")
	t.Setenv("LIGHTCLAW_WECHAT_REDIRECT_URI", "https://api.example.com/auth/oauth/wechat/callback")
	t.Setenv("LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_APP_ID", "official-account-app-id")
	t.Setenv("LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_APP_SECRET", "")
	t.Setenv("LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_REDIRECT_URI", "https://api.example.com/auth/oauth/wechat/callback")

	config := buildWeChatOAuthConfig()
	if config == nil {
		t.Fatal("buildWeChatOAuthConfig() = nil, want config")
	}
	if config.OfficialAccount.AppSecret != "legacy-wechat-secret" {
		t.Fatalf("OfficialAccount.AppSecret = %q, want legacy fallback", config.OfficialAccount.AppSecret)
	}
}

func TestBuildRealnameFaceIDConfigUsesDefaults(t *testing.T) {
	t.Setenv("LIGHTCLAW_REALNAME_ASSURANCE_MODE", "")
	t.Setenv("TENCENT_REALNAME_FACEID_RULE_ID", "")
	t.Setenv("TENCENT_REALNAME_FACEID_REDIRECT_URL", "")
	t.Setenv("REALNAME_ENCRYPTION_KEY", "")
	t.Setenv("TENCENT_REALNAME_ACCOUNT_ID", "")
	t.Setenv("LIGHTCLAW_REALNAME_FACEID_DAILY_QUOTA", "")
	t.Setenv("LIGHTCLAW_REALNAME_FACEID_ATTEMPT_TTL", "")
	t.Setenv("LIGHTCLAW_REALNAME_FACEID_LEASE_TTL", "")

	cfg := buildRealnameFaceIDConfig()
	if cfg.Mode != service.RealnameAssuranceModeLegacy {
		t.Fatalf("Mode = %q, want legacy", cfg.Mode)
	}
	if cfg.DailyQuota != 5 || cfg.AttemptTTL != 2*time.Hour || cfg.LeaseTTL != 30*time.Second {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestBuildRealnameFaceIDConfigReadsEnvironment(t *testing.T) {
	t.Setenv("LIGHTCLAW_REALNAME_ASSURANCE_MODE", "face_required")
	t.Setenv("TENCENT_REALNAME_FACEID_RULE_ID", "rule-1")
	t.Setenv("TENCENT_REALNAME_FACEID_REDIRECT_URL", "https://api.example.com/auth/realname/faceid/callback")
	t.Setenv("REALNAME_ENCRYPTION_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
	t.Setenv("TENCENT_REALNAME_ACCOUNT_ID", "acct-1")
	t.Setenv("LIGHTCLAW_REALNAME_FACEID_DAILY_QUOTA", "7")
	t.Setenv("LIGHTCLAW_REALNAME_FACEID_ATTEMPT_TTL", "45m")
	t.Setenv("LIGHTCLAW_REALNAME_FACEID_LEASE_TTL", "15s")

	cfg := buildRealnameFaceIDConfig()
	if cfg.Mode != service.RealnameAssuranceModeFaceRequired || cfg.RuleID != "rule-1" || cfg.AccountID != "acct-1" || len(cfg.DigestKey) != 32 {
		t.Fatalf("unexpected faceid config identity fields: %+v", cfg)
	}
	if cfg.DailyQuota != 7 || cfg.AttemptTTL != 45*time.Minute || cfg.LeaseTTL != 15*time.Second {
		t.Fatalf("unexpected faceid timing fields: %+v", cfg)
	}
}

func TestBuildPhoneAuthSMSSenderUsesConfiguredEnvNames(t *testing.T) {
	t.Setenv("LIGHTCLAW_PHONE_AUTH_ENABLED", "true")
	t.Setenv("LIGHTCLAW_SMS_SECRET_ID", "secret-id")
	t.Setenv("LIGHTCLAW_SMS_SECRET_KEY", "secret-key")
	t.Setenv("LIGHTCLAW_SMS_REGION", "ap-guangzhou")
	t.Setenv("LIGHTCLAW_SMS_ENDPOINT", "sms.tencentcloudapi.com")
	t.Setenv("LIGHTCLAW_SMS_SDK_APP_ID", "1401097405")
	t.Setenv("LIGHTCLAW_SMS_SIGN_NAME", "腾讯云")
	t.Setenv("LIGHTCLAW_SMS_TEMPLATE_ID", "2683912")

	if sender := buildPhoneAuthSMSSender(loggingDiscardLogger()); sender == nil {
		t.Fatal("expected configured phone auth sms sender")
	}
}

func TestBuildPaymentMethodClientRequiresExplicitEnable(t *testing.T) {
	t.Setenv("LIGHTCLAW_PAYMENT_METHODS_ENABLED", "false")
	if client := buildPaymentMethodClient(loggingDiscardLogger(), shadowbinding.SiteKindIntl); client != nil {
		t.Fatal("expected payment method client to remain disabled")
	}
}

func TestBuildPaymentMethodClientRejectsCNSite(t *testing.T) {
	t.Setenv("LIGHTCLAW_PAYMENT_METHODS_ENABLED", "true")
	t.Setenv("SHADOW_BILLING_ENDPOINT", "billing.test.tencentcloudapi.com")
	t.Setenv("SHADOW_PLATFORM", "intlSaaSLightvela")
	if client := buildPaymentMethodClient(loggingDiscardLogger(), shadowbinding.SiteKindCN); client != nil {
		t.Fatal("expected payment method client to remain disabled on CN site")
	}
}

func TestBuildPaymentMethodClientRejectsIncompleteConfig(t *testing.T) {
	t.Setenv("LIGHTCLAW_PAYMENT_METHODS_ENABLED", "true")
	t.Setenv("SHADOW_BILLING_ENDPOINT", "")
	t.Setenv("SHADOW_PLATFORM", "intlSaaSLightvela")
	if client := buildPaymentMethodClient(loggingDiscardLogger(), shadowbinding.SiteKindIntl); client != nil {
		t.Fatal("expected incomplete payment method config to remain unavailable")
	}
}

func TestBuildPaymentMethodClientUsesBillingConfig(t *testing.T) {
	t.Setenv("LIGHTCLAW_PAYMENT_METHODS_ENABLED", "true")
	t.Setenv("SHADOW_BILLING_ENDPOINT", "billing.test.tencentcloudapi.com")
	t.Setenv("SHADOW_BILLING_REGION", "ap-guangzhou")
	t.Setenv("SHADOW_PLATFORM", "intlSaaSLightvela")
	t.Setenv("SHADOW_CLOUDLADDER_ENABLED", "false")
	if client := buildPaymentMethodClient(loggingDiscardLogger(), shadowbinding.SiteKindIntl); client == nil {
		t.Fatal("expected configured payment method client")
	}
}

func TestBuildDeveloperRouteClientDisabledByDefault(t *testing.T) {
	t.Setenv("PERSONAL_DEV_ROUTE_CONTROL_ENABLED", "false")
	client, err := buildDeveloperRouteClient("https://api-sandbox-bj-7.lightclaw.tech")
	if err != nil || client != nil {
		t.Fatalf("disabled client=%v err=%v", client, err)
	}
}

func TestBuildDeveloperTestAccountLeaseConfigDisabledByDefault(t *testing.T) {
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_ENABLED", "false")
	userIDs, namespace, sourceCIDRs, err := buildDeveloperTestAccountLeaseConfig("https://api.lightvela.com")
	if err != nil || userIDs != nil || namespace != "" || sourceCIDRs != nil {
		t.Fatalf("disabled account lease config user_ids=%v namespace=%q source_cidrs=%v err=%v", userIDs, namespace, sourceCIDRs, err)
	}
}

func TestBuildDeveloperTestAccountLeaseConfigRequiresMatchingSandbox(t *testing.T) {
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_ENABLED", "true")
	t.Setenv("PERSONAL_DEV_ACCOUNT_POOL_USER_IDS", "usr_pool_a")
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_SOURCE_CIDRS", "14.22.11.160/29")

	tests := []struct {
		name        string
		environment string
		publicURL   string
	}{
		{name: "production environment", environment: "shprod", publicURL: "https://api-shprod.lightclaw.tech"},
		{name: "unsupported sandbox", environment: "sandbox-bj-8", publicURL: "https://api-sandbox-bj-8.lightclaw.tech"},
		{name: "production host", environment: "sandbox-bj-7", publicURL: "https://api.lightvela.com"},
		{name: "wrong sandbox host", environment: "sandbox-bj-7", publicURL: "https://api-sandbox-kr-1.lightclaw.tech"},
		{name: "plaintext sandbox host", environment: "sandbox-bj-7", publicURL: "http://api-sandbox-bj-7.lightclaw.tech"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_ENVIRONMENT", test.environment)
			if userIDs, namespace, sourceCIDRs, err := buildDeveloperTestAccountLeaseConfig(test.publicURL); err == nil || userIDs != nil || namespace != "" || sourceCIDRs != nil {
				t.Fatalf("unsafe config accepted: user_ids=%v namespace=%q source_cidrs=%v err=%v", userIDs, namespace, sourceCIDRs, err)
			}
		})
	}
}

func TestBuildDeveloperTestAccountLeaseConfigRequiresValidPool(t *testing.T) {
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_ENABLED", "true")
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_ENVIRONMENT", "sandbox-bj-7")
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_SOURCE_CIDRS", "14.22.11.160/29")

	for _, pool := range []string{"", "pool-a", "usr_valid,pool-invalid"} {
		t.Setenv("PERSONAL_DEV_ACCOUNT_POOL_USER_IDS", pool)
		if userIDs, namespace, sourceCIDRs, err := buildDeveloperTestAccountLeaseConfig("https://api-sandbox-bj-7.lightclaw.tech"); err == nil || userIDs != nil || namespace != "" || sourceCIDRs != nil {
			t.Fatalf("invalid pool %q accepted: user_ids=%v namespace=%q source_cidrs=%v err=%v", pool, userIDs, namespace, sourceCIDRs, err)
		}
	}
}

func TestBuildDeveloperTestAccountLeaseConfigRequiresNarrowIPv4SourceCIDRs(t *testing.T) {
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_ENABLED", "true")
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_ENVIRONMENT", "sandbox-bj-7")
	t.Setenv("PERSONAL_DEV_ACCOUNT_POOL_USER_IDS", "usr_pool_a")

	for _, sourceCIDRs := range []string{"", "not-a-prefix", "0.0.0.0/0", "2001:db8::/32"} {
		t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_SOURCE_CIDRS", sourceCIDRs)
		userIDs, namespace, prefixes, err := buildDeveloperTestAccountLeaseConfig("https://api-sandbox-bj-7.lightclaw.tech")
		if err == nil || userIDs != nil || namespace != "" || prefixes != nil {
			t.Fatalf("unsafe source CIDRs %q accepted: user_ids=%v namespace=%q prefixes=%v err=%v", sourceCIDRs, userIDs, namespace, prefixes, err)
		}
	}
}

func TestBuildDeveloperTestAccountLeaseConfigAcceptsSandboxPool(t *testing.T) {
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_ENABLED", "true")
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_ENVIRONMENT", "sandbox-kr-1")
	t.Setenv("PERSONAL_DEV_ACCOUNT_POOL_USER_IDS", "usr_pool_b, usr_pool_a,usr_pool_b")
	t.Setenv("PERSONAL_DEV_ACCOUNT_LEASE_SOURCE_CIDRS", "21.0.0.0/8,14.116.239.32/29")

	userIDs, namespace, sourceCIDRs, err := buildDeveloperTestAccountLeaseConfig("https://api-sandbox-kr-1.lightclaw.tech")
	if err != nil {
		t.Fatalf("valid account lease config rejected: %v", err)
	}
	if namespace != "sandbox-kr-1" || len(userIDs) != 3 || userIDs[0] != "usr_pool_b" || userIDs[1] != "usr_pool_a" || userIDs[2] != "usr_pool_b" || len(sourceCIDRs) != 2 {
		t.Fatalf("unexpected account lease config: user_ids=%v namespace=%q source_cidrs=%v", userIDs, namespace, sourceCIDRs)
	}
}

func TestDeveloperRouteExplicitTargetIPRequiresSandboxControlClient(t *testing.T) {
	t.Setenv("PERSONAL_DEV_ROUTE_EXPLICIT_TARGET_IP_ENABLED", "true")
	if developerRouteExplicitTargetIPEnabled(nil) {
		t.Fatal("explicit targetIp enabled without sandbox route control")
	}

	t.Setenv("PERSONAL_DEV_ROUTE_EXPLICIT_TARGET_IP_ENABLED", "false")
	if developerRouteExplicitTargetIPEnabled(&devroute.Client{}) {
		t.Fatal("explicit targetIp enabled by default")
	}

	t.Setenv("PERSONAL_DEV_ROUTE_EXPLICIT_TARGET_IP_ENABLED", "true")
	if !developerRouteExplicitTargetIPEnabled(&devroute.Client{}) {
		t.Fatal("explicit targetIp remained disabled for an explicitly enabled sandbox route control client")
	}
}

func TestBuildDeveloperRouteClientRequiresMatchingSandboxHTTPSHost(t *testing.T) {
	t.Setenv("PERSONAL_DEV_ROUTE_CONTROL_ENABLED", "true")
	t.Setenv("PERSONAL_DEV_ROUTE_CONTROL_ENVIRONMENT", "sandbox-bj-7")
	t.Setenv("PERSONAL_DEV_ROUTE_CLOUDLADDER_GATEWAY_BASE_URL", "http://gateway.testing")
	t.Setenv("CLOUDLADDER_SHADOW_HMAC_SECRET", "test-secret")

	for _, publicBaseURL := range []string{
		"https://api.lightvela.com",
		"http://api-sandbox-bj-7.lightclaw.tech",
		"https://api-sandbox-kr-1.lightclaw.tech",
	} {
		if client, err := buildDeveloperRouteClient(publicBaseURL); err == nil || client != nil {
			t.Fatalf("unsafe public base URL %q accepted, client=%v err=%v", publicBaseURL, client, err)
		}
	}
	client, err := buildDeveloperRouteClient("https://api-sandbox-bj-7.lightclaw.tech")
	if err != nil || client == nil {
		t.Fatalf("matching sandbox config rejected, client=%v err=%v", client, err)
	}
}

func TestBuildDeveloperRouteRegistryDisabledByDefault(t *testing.T) {
	t.Setenv("PERSONAL_DEV_ROUTE_CONTROL_ENABLED", "false")
	registry, secret, err := buildDeveloperRouteRegistry(
		"https://api-sandbox-bj-7.lightclaw.tech",
		service.NewMemoryStore(service.StoreOptions{}),
	)
	if err != nil || registry != nil || secret != "" {
		t.Fatalf("registry=%v secret_present=%v err=%v", registry, secret != "", err)
	}
}

func TestBuildDeveloperRouteRegistryRequiresSandboxAndHMAC(t *testing.T) {
	t.Setenv("PERSONAL_DEV_ROUTE_CONTROL_ENABLED", "true")
	t.Setenv("PERSONAL_DEV_ROUTE_CONTROL_ENVIRONMENT", "sandbox-bj-7")
	t.Setenv("PERSONAL_DEV_ROUTE_CLOUDLADDER_HMAC_SECRET", "")
	t.Setenv("CLOUDLADDER_SHADOW_HMAC_SECRET", "")
	authStore := service.NewMemoryStore(service.StoreOptions{})
	if registry, secret, err := buildDeveloperRouteRegistry("https://api-sandbox-bj-7.lightclaw.tech", authStore); err == nil || registry != nil || secret != "" {
		t.Fatalf("missing secret accepted registry=%v secret_present=%v err=%v", registry, secret != "", err)
	}
	t.Setenv("CLOUDLADDER_SHADOW_HMAC_SECRET", "test-secret")
	registry, secret, err := buildDeveloperRouteRegistry("https://api-sandbox-bj-7.lightclaw.tech", authStore)
	if err != nil || registry == nil || secret != "test-secret" {
		t.Fatalf("registry=%v secret_present=%v err=%v", registry, secret != "", err)
	}
	if registry, _, err := buildDeveloperRouteRegistry("https://api.lightvela.com", authStore); err == nil || registry != nil {
		t.Fatalf("production-like host accepted registry=%v err=%v", registry, err)
	}
}

func TestBuildShadowBindingServiceWiresTestingAdminFlag(t *testing.T) {
	t.Setenv("SHADOW_BINDING_ENABLED", "true")
	t.Setenv("SHADOW_BINDING_ADMIN_ENABLED", "true")
	t.Setenv("SHADOW_BINDING_ADMIN_ENVIRONMENT", "sandbox-bj-7")
	t.Setenv("LIGHTCLAW_PUBLIC_BASE_URL", "https://api-sandbox-bj-7.lightclaw.tech")
	t.Setenv("SHADOW_SECRET_ID", "")
	t.Setenv("SHADOW_SECRET_KEY", "")

	svc := buildShadowBindingService(shadowbinding.NewMemoryStore(), loggingDiscardLogger(), shadowbinding.SiteKindCN)
	if svc == nil {
		t.Fatal("expected shadow binding service")
	}
	if !svc.AdminEnabled() {
		t.Fatal("expected testing admin flag to be enabled")
	}
}

func TestBuildShadowBindingServiceRejectsTestingAdminOnProductionHost(t *testing.T) {
	t.Setenv("SHADOW_BINDING_ENABLED", "true")
	t.Setenv("SHADOW_BINDING_ADMIN_ENABLED", "true")
	t.Setenv("SHADOW_BINDING_ADMIN_ENVIRONMENT", "sandbox-bj-7")
	t.Setenv("LIGHTCLAW_PUBLIC_BASE_URL", "https://api.lightvela.com")
	t.Setenv("SHADOW_SECRET_ID", "")
	t.Setenv("SHADOW_SECRET_KEY", "")

	svc := buildShadowBindingService(shadowbinding.NewMemoryStore(), loggingDiscardLogger(), shadowbinding.SiteKindCN)
	if svc == nil {
		t.Fatal("expected shadow binding service")
	}
	if svc.AdminEnabled() {
		t.Fatal("testing shadow binding admin must remain disabled on a production host")
	}
}

func TestShadowBindingAdminEnabledRejectsMalformedPublicBaseURL(t *testing.T) {
	t.Setenv("SHADOW_BINDING_ADMIN_ENABLED", "true")
	t.Setenv("SHADOW_BINDING_ADMIN_ENVIRONMENT", "sandbox-bj-7")
	t.Setenv("LIGHTCLAW_PUBLIC_BASE_URL", "https://%")

	if shadowBindingAdminEnabled(loggingDiscardLogger()) {
		t.Fatal("testing shadow binding admin must remain disabled for a malformed public base URL")
	}
}

func loggingDiscardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
