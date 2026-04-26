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

func TestAppendSessionTokenToReturnTo(t *testing.T) {
	t.Parallel()

	got := appendSessionTokenToReturnTo("https://preview.foo.lightclaw.cn/dashboard/settings?tab=1#wechat", "session-123")
	want := "https://preview.foo.lightclaw.cn/dashboard/settings?tab=1#wechat&session_token=session-123"
	if got != want {
		t.Fatalf("appendSessionTokenToReturnTo() = %q, want %q", got, want)
	}
}
