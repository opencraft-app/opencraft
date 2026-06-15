package httpapi

import (
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

func TestValidatedReturnToURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "allowed company subdomain",
			raw:  "https://preview.foo.lightclaw.cn/dashboard/settings?tab=1#wechat",
			want: "https://preview.foo.lightclaw.cn/dashboard/settings?tab=1#wechat",
		},
		{
			name: "allowed edgeone subdomain",
			raw:  "https://lightvela-preview.edgeone.cool/dashboard/settings?tab=1#wechat",
			want: "https://lightvela-preview.edgeone.cool/dashboard/settings?tab=1#wechat",
		},
		{
			name: "allowed edgeone run subdomain",
			raw:  "https://lightvela-preview.edgeone.run/dashboard/settings?tab=1#wechat",
			want: "https://lightvela-preview.edgeone.run/dashboard/settings?tab=1#wechat",
		},
		{
			name: "allowed exact lightvela root",
			raw:  "https://lightvela.com/dashboard",
			want: "https://lightvela.com/dashboard",
		},
		{
			name: "reject non https",
			raw:  "http://preview.foo.lightclaw.cn/dashboard",
			want: "",
		},
		{
			name: "reject external host",
			raw:  "https://evil.example.com/dashboard",
			want: "",
		},
		{
			name: "reject user info",
			raw:  "https://foo:bar@preview.foo.lightclaw.cn/dashboard",
			want: "",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := validatedReturnToURL(tc.raw); got != tc.want {
				t.Fatalf("validatedReturnToURL(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestValidatedReturnToURLWithConfiguredPagesWildcard(t *testing.T) {
	t.Parallel()

	allowlist := buildOAuthReturnToAllowlist([]string{"*.pages.dev"})

	if got := validatedReturnToURLWithAllowlist("https://lightclaw.pages.dev/dashboard", allowlist); got == "" {
		t.Fatal("expected pages.dev subdomain to be allowed")
	}
	if got := validatedReturnToURLWithAllowlist("https://bj82.lightclaw.pages.dev/dashboard", allowlist); got == "" {
		t.Fatal("expected nested pages.dev subdomain to be allowed")
	}
	if got := validatedReturnToURLWithAllowlist("https://pages.dev/dashboard", allowlist); got != "" {
		t.Fatalf("expected bare pages.dev root to stay blocked, got %q", got)
	}
}

func TestValidatedReturnToURLWithConfiguredLocalhostHTTP(t *testing.T) {
	t.Parallel()

	allowlist := buildOAuthReturnToAllowlist([]string{"localhost", "127.0.0.1", "::1"})

	cases := []string{
		"http://localhost:5173/auth/sign-in",
		"http://127.0.0.1:5173/auth/sign-in",
		"http://[::1]:5173/auth/sign-in",
	}
	for _, raw := range cases {
		if got := validatedReturnToURLWithAllowlist(raw, allowlist); got == "" {
			t.Fatalf("expected localhost-style http return_to to be allowed for %q", raw)
		}
	}
}

func TestValidatedReturnToURLWithConfiguredHTTPOrigin(t *testing.T) {
	t.Parallel()

	allowlist := buildOAuthReturnToAllowlist([]string{"http://30.184.61.101:5173"})

	allowed := "http://30.184.61.101:5173/auth/sign-in"
	if got := validatedReturnToURLWithAllowlist(allowed, allowlist); got != allowed {
		t.Fatalf("expected configured http origin to be allowed, got %q", got)
	}
	allowedArbitraryPath := "http://30.184.61.101:5173/any/deep/path?next=/dashboard#panel"
	if got := validatedReturnToURLWithAllowlist(allowedArbitraryPath, allowlist); got != allowedArbitraryPath {
		t.Fatalf("expected configured http origin to allow arbitrary path, got %q", got)
	}
	if got := validatedReturnToURLWithAllowlist("http://30.184.61.101:3000/auth/sign-in", allowlist); got != "" {
		t.Fatalf("expected different port to stay blocked, got %q", got)
	}
	if got := validatedReturnToURLWithAllowlist("http://30.184.61.102:5173/auth/sign-in", allowlist); got != "" {
		t.Fatalf("expected different host to stay blocked, got %q", got)
	}
}

func TestValidatedReturnToURLAllowsBrowserExtensionCallback(t *testing.T) {
	t.Parallel()

	allowed := "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/lightvela?provider_type=browser_extension&extension_id=abcdefghijklmnopabcdefghijklmnop"
	if got := validatedReturnToURL(allowed); got != allowed {
		t.Fatalf("expected chromium extension return_to to be allowed, got %q", got)
	}

	rejected := []string{
		"https://chromiumapp.org/lightvela",
		"https://foo.bar.chromiumapp.org/lightvela",
		"https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/other",
		"http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/lightvela",
		"https://abc123.chromiumapp.org/lightvela",
	}
	for _, raw := range rejected {
		raw := raw
		t.Run(raw, func(t *testing.T) {
			t.Parallel()
			if got := validatedReturnToURL(raw); got != "" {
				t.Fatalf("expected chromium extension return_to to be rejected, got %q", got)
			}
		})
	}
}

func TestAppendSessionTokenToReturnTo(t *testing.T) {
	t.Parallel()

	got := appendSessionTokenToReturnTo("https://preview.foo.lightclaw.cn/dashboard/settings?tab=1#wechat", "session-123")
	want := "https://preview.foo.lightclaw.cn/dashboard/settings?tab=1#wechat&session_token=session-123"
	if got != want {
		t.Fatalf("appendSessionTokenToReturnTo() = %q, want %q", got, want)
	}
}

func TestOAuthSuccessRedirectForDeviceBindUsesShortToken(t *testing.T) {
	t.Parallel()

	for _, returnTo := range []string{
		"http://127.0.0.1:17631/lightvela/callback?device_nonce=nonce-123",
		"http://127.0.0.1:17631/lightvela/auth-callback?device_nonce=nonce-123",
	} {
		returnTo := returnTo
		t.Run(returnTo, func(t *testing.T) {
			t.Parallel()

			assertOAuthDeviceBindRedirectUsesShortToken(t, returnTo, "nonce-123")
		})
	}
}

func TestOAuthSuccessRedirectForBrowserExtensionUsesShortToken(t *testing.T) {
	t.Parallel()

	returnTo := "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/lightvela?provider_type=browser_extension&extension_id=abcdefghijklmnopabcdefghijklmnop"
	assertOAuthDeviceBindRedirectUsesShortToken(t, returnTo, "")
}

func assertOAuthDeviceBindRedirectUsesShortToken(t *testing.T, returnTo string, expectedNonce string) {
	t.Helper()

	codec := newDeviceBindTokenCodec("device-bind-secret", 10*time.Minute)
	codec.now = func() time.Time { return time.Unix(1000, 0).UTC() }
	handler := &Handler{
		returnToAllow:    buildOAuthReturnToAllowlist([]string{"127.0.0.1"}),
		deviceBindTokens: codec,
	}

	redirectURL := handler.oauthSuccessRedirectURL(nil, returnTo, "https://lightclaw.pages.dev/#session_token=session-123", &service.AuthSession{
		Token: "session-123",
		User:  service.User{ID: "user-123"},
	})

	parsed, err := url.Parse(redirectURL)
	if err != nil {
		t.Fatalf("parse redirect: %v", err)
	}
	token := parsed.Query().Get("device_bind_token")
	if token == "" {
		t.Fatalf("expected device_bind_token in redirect, got %q", redirectURL)
	}
	if strings.Contains(redirectURL, "session_token") {
		t.Fatalf("device bind redirect must not expose session_token: %q", redirectURL)
	}
	claims, err := codec.Verify(token)
	if err != nil {
		t.Fatalf("verify device token: %v", err)
	}
	if claims.UserID != "user-123" || claims.DeviceNonce != expectedNonce || claims.Scope != deviceBindTokenScope {
		t.Fatalf("claims = %+v", claims)
	}
}
