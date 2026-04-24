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
