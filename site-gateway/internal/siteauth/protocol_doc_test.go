package siteauth

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestProtocolDocumentContainsRequiredContract(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	docsDir := filepath.Join(filepath.Dir(currentFile), "..", "..", "docs")
	for _, name := range []string{"site-access-protocol.md", "site-access-integration.md"} {
		data, err := os.ReadFile(filepath.Join(docsDir, name))
		if err != nil {
			t.Fatalf("read protocol document %q: %v", name, err)
		}
		doc := string(data)
		for _, required := range []string{
			"/auth/lightvela/start",
			"/auth/lightvela/callback",
			"/__lightvela/auth/start",
			"/__lightvela/auth/callback",
			"PKCE",
			"nonce",
			"openid",
			"__Host-lv_oidc_state",
			"lv_site_session",
			"handoff",
			"launch",
			"SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED",
			"lightvela.tech",
			"lightvela.site",
			"Domain=",
			"site-gateway-secrets",
		} {
			if !strings.Contains(doc, required) {
				t.Fatalf("%s missing %q", name, required)
			}
		}
	}
}
