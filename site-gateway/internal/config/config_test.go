package config

import (
	"encoding/base64"
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
	t.Setenv("TENCENT_SECRET_ID", "AKIDPLATFORM")
	t.Setenv("TENCENT_SECRET_KEY", "platform-key")
}

func TestFromEnvAuthDefaultsToPublic(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_AUTH_MODE", "")
	t.Setenv("SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED", "")
	t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "")

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.AuthMode != AuthModePublic || cfg.AuthSessionTTL != 5*time.Minute || cfg.AuthEndpointsEnabled {
		t.Fatalf("auth config = %+v", cfg)
	}
}

func TestFromEnvRequiredAuthParsesOIDCAndAEADConfig(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_AUTH_MODE", "required")
	t.Setenv("SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED", "true")
	t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.tech")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	t.Setenv("SITE_GATEWAY_AUTH_SESSION_TTL", "5m")

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.AuthMode != AuthModeRequired || !cfg.AuthEndpointsEnabled || cfg.AuthFixedHost != "sites-auth.lightvela.tech" || cfg.AuthOIDCIssuer != "https://userauth.lightvela.tech" || cfg.AuthOIDCClientID != "site-gateway" || cfg.AuthAEADActiveKeyID != "key-1" || cfg.AuthSessionTTL != 5*time.Minute {
		t.Fatalf("auth config = %+v", cfg)
	}
	if len(cfg.AuthAEADKeys) != 1 || len(cfg.AuthAEADKeys["key-1"]) != 32 {
		t.Fatalf("aead keys = %+v", cfg.AuthAEADKeys)
	}
}

func TestFromEnvRequiredAuthAcceptsSiteFixedHost(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_AUTH_MODE", "required")
	t.Setenv("SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED", "true")
	t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.site")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.site")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.site/oauth2/authorize")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.site/oauth2/token")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.site/.well-known/jwks.json")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.AuthFixedHost != "sites-auth.lightvela.site" {
		t.Fatalf("fixed host = %q", cfg.AuthFixedHost)
	}
}

func TestFromEnvPublicModeCanEnableOIDCEndpoints(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_AUTH_MODE", "public")
	t.Setenv("SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED", "true")
	t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.site")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.site")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.site/oauth2/authorize")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.site/oauth2/token")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.site/.well-known/jwks.json")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.AuthMode != AuthModePublic || !cfg.AuthEndpointsEnabled || cfg.AuthFixedHost != "sites-auth.lightvela.site" {
		t.Fatalf("auth config = %+v", cfg)
	}
}

func TestFromEnvRejectsAuthSessionTTLOverFiveMinutes(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_AUTH_SESSION_TTL", "5m1s")
	if _, err := FromEnv(); err == nil {
		t.Fatal("auth session TTL over five minutes unexpectedly succeeded")
	}
}

func TestFromEnvRequiredAuthRejectsIncompleteConfig(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_AUTH_MODE", "required")
	t.Setenv("SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED", "true")
	for _, tc := range []struct {
		name string
		set  func()
	}{
		{name: "fixed host", set: func() {
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
		}},
		{name: "issuer", set: func() {
			t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
		}},
		{name: "authorize url", set: func() {
			t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
		}},
		{name: "token url", set: func() {
			t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
		}},
		{name: "jwks url", set: func() {
			t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
		}},
		{name: "client id", set: func() {
			t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
		}},
		{name: "active key id", set: func() {
			t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
		}},
		{name: "aead keys", set: func() {
			t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "")
			t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "")
			t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "")
			tc.set()
			if _, err := FromEnv(); err == nil {
				t.Fatal("incomplete required auth config unexpectedly succeeded")
			}
		})
	}
}

func TestFromEnvRequiredAuthRejectsInsecureOIDCConfig(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_AUTH_MODE", "required")
	t.Setenv("SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED", "true")
	t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "https://sites-auth.lightvela.tech")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "http://userauth.lightvela.tech/oauth2/authorize")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))

	if _, err := FromEnv(); err == nil {
		t.Fatal("insecure auth config unexpectedly succeeded")
	}
}

func TestFromEnvRequiredAuthRejectsUnexpectedFixedHost(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_AUTH_MODE", "required")
	t.Setenv("SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED", "true")
	t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.example.com")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))

	if _, err := FromEnv(); err == nil {
		t.Fatal("unexpected fixed host unexpectedly succeeded")
	}
}

func TestFromEnvRequiredAuthRejectsUnexpectedClientID(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_AUTH_MODE", "required")
	t.Setenv("SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED", "true")
	t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.tech")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "another-client")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))

	if _, err := FromEnv(); err == nil {
		t.Fatal("unexpected client id unexpectedly succeeded")
	}
}

func TestFromEnvRejectsRequiredModeWhenAuthEndpointsAreDisabled(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_AUTH_MODE", "required")
	t.Setenv("SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED", "false")
	t.Setenv("SITE_GATEWAY_AUTH_FIXED_HOST", "sites-auth.lightvela.tech")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_ISSUER", "https://userauth.lightvela.tech")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL", "https://userauth.lightvela.tech/oauth2/authorize")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_TOKEN_URL", "https://userauth.lightvela.tech/oauth2/token")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_JWKS_URL", "https://userauth.lightvela.tech/.well-known/jwks.json")
	t.Setenv("SITE_GATEWAY_AUTH_OIDC_CLIENT_ID", "site-gateway")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID", "key-1")
	t.Setenv("SITE_GATEWAY_AUTH_AEAD_KEYS", "key-1="+base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))

	if _, err := FromEnv(); err == nil {
		t.Fatal("required mode without auth endpoints unexpectedly succeeded")
	}
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

// 上报间隔和内存上界的默认值必须是可预期的：默认一分钟上报，
// 它同时决定了超额拦截的收敛延迟下限。
func TestFromEnvUsageDefaultsAndOverrides(t *testing.T) {
	setRequired(t)
	t.Setenv("TENCENT_SECRET_ID", "AKIDPLATFORM")
	t.Setenv("TENCENT_SECRET_KEY", "platform-key")

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.UsageReportInterval != time.Minute {
		t.Fatalf("上报间隔默认值 = %v, want 1m", cfg.UsageReportInterval)
	}
	if cfg.UsageMaxSites != 20000 || cfg.SiteCacheMaxEntries != 20000 {
		t.Fatalf("内存上界默认值 = %d/%d, want 20000/20000", cfg.UsageMaxSites, cfg.SiteCacheMaxEntries)
	}

	t.Setenv("SITE_GATEWAY_USAGE_REPORT_INTERVAL", "10s")
	t.Setenv("SITE_GATEWAY_USAGE_MAX_SITES", "500")
	t.Setenv("SITE_GATEWAY_SITE_CACHE_MAX_ENTRIES", "600")
	cfg, err = FromEnv()
	if err != nil {
		t.Fatalf("FromEnv() error = %v", err)
	}
	if cfg.UsageReportInterval != 10*time.Second || cfg.UsageMaxSites != 500 || cfg.SiteCacheMaxEntries != 600 {
		t.Fatalf("覆盖未生效: %v/%d/%d", cfg.UsageReportInterval, cfg.UsageMaxSites, cfg.SiteCacheMaxEntries)
	}
}

// 内存上界配成非法值必须启动失败：静默回落到默认值比启动失败难查得多。
func TestFromEnvRejectsInvalidUsageBounds(t *testing.T) {
	for _, raw := range []string{"0", "-1", "many"} {
		setRequired(t)
		t.Setenv("TENCENT_SECRET_ID", "AKIDPLATFORM")
		t.Setenv("TENCENT_SECRET_KEY", "platform-key")
		t.Setenv("SITE_GATEWAY_USAGE_MAX_SITES", raw)

		if _, err := FromEnv(); err == nil {
			t.Fatalf("SITE_GATEWAY_USAGE_MAX_SITES=%q 应当报错", raw)
		}
	}
}

func TestFromEnvDSHDefaultsDisabled(t *testing.T) {
	setRequired(t)
	cfg, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.DSHDomains) != 0 || cfg.DSHTargetURL != "" {
		t.Fatalf("DSH unexpectedly enabled: %+v", cfg.DSHDomains)
	}
}

func TestFromEnvDSHRequiresCompleteConfiguration(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_DSH_DOMAINS", "dsh.lightvela.site,dsh.lightvela.tech")
	t.Setenv("SITE_GATEWAY_DSH_TARGET_URL", "http://getport.ctl.svc.cluster.local/v1/dsh/target")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.DSHDomains) != 2 || cfg.DSHMaxTargets != 16 || cfg.DSHMaxConnectionsPerTarget != 64 || cfg.DSHQueueDepth != 64 ||
		cfg.DSHMaxFrameBytes != 256<<10 || cfg.DSHMaxBufferedBytesPerConn != 2<<20 ||
		cfg.DSHMaxBufferedBytesPerTarget != 16<<20 || cfg.DSHMaxBufferedBytesTotal != 64<<20 {
		t.Fatalf("DSH config = %+v", cfg)
	}

	t.Setenv("TENCENT_SECRET_ID", "")
	t.Setenv("TENCENT_SECRET_KEY", "")
	t.Setenv("WEBSITE_COS_SECRET_ID", "cos-only-id")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "cos-only-key")
	if _, err := FromEnv(); err == nil {
		t.Fatal("DSH enabled without Tencent credentials unexpectedly succeeded")
	}
}

func TestFromEnvDSHRejectsInconsistentByteLimits(t *testing.T) {
	setRequired(t)
	t.Setenv("SITE_GATEWAY_DSH_DOMAINS", "dsh.lightvela.site")
	t.Setenv("SITE_GATEWAY_DSH_TARGET_URL", "http://getport.ctl.svc.cluster.local/v1/dsh/target")
	t.Setenv("SITE_GATEWAY_DSH_MAX_FRAME_BYTES", "4096")
	t.Setenv("SITE_GATEWAY_DSH_MAX_BUFFERED_BYTES_PER_CONNECTION", "2048")
	if _, err := FromEnv(); err == nil {
		t.Fatal("frame limit larger than connection budget unexpectedly succeeded")
	}
}
