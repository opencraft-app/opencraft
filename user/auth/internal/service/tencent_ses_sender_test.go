package service

import (
	"strings"
	"testing"
)

func TestBuildEmailBindMagicLinkContentIncludesConfirmURL(t *testing.T) {
	confirmURL := "https://api.lightvela.com/auth/email/bind/confirm?token=abc"
	subject, html, text := buildEmailBindMagicLinkContent(confirmURL)
	if subject == "" {
		t.Fatal("expected subject")
	}
	for _, part := range []string{confirmURL, "验证邮箱"} {
		if !strings.Contains(html, part) {
			t.Fatalf("html missing %q: %s", part, html)
		}
	}
	for _, part := range []string{confirmURL, "30 分钟"} {
		if !strings.Contains(text, part) {
			t.Fatalf("text missing %q: %s", part, text)
		}
	}
}
