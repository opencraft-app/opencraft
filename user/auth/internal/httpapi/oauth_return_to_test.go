package httpapi

import "testing"

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

func TestAppendSessionTokenToReturnTo(t *testing.T) {
	t.Parallel()

	got := appendSessionTokenToReturnTo("https://preview.foo.lightclaw.cn/dashboard/settings?tab=1#wechat", "session-123")
	want := "https://preview.foo.lightclaw.cn/dashboard/settings?tab=1#wechat&session_token=session-123"
	if got != want {
		t.Fatalf("appendSessionTokenToReturnTo() = %q, want %q", got, want)
	}
}
