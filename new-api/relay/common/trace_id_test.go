package common

import "testing"

func TestSafeVelaGWTraceID(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  string
	}{
		{"abcdefghijklmnop", "abcdefghijklmnop"},
		{"abCD0123_-gh5678", "abCD0123_-gh5678"},
		{"short", "none"},
		{"123456789012345\nsecret", "none"},
		{"123456789012345=", "none"},
	} {
		if got := SafeVelaGWTraceID(tc.value); got != tc.want {
			t.Errorf("SafeVelaGWTraceID(%q) = %q, want %q", tc.value, got, tc.want)
		}
	}
}
