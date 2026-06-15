package main

import (
	"net/http"
	"testing"
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
