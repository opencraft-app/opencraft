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
			"EdDSA",
			"kid",
			"site_host",
			"state",
			"lv_site_session",
			"__Host-lv_site_state",
			"lightvela.tech",
			"lightvela.site",
		} {
			if !strings.Contains(doc, required) {
				t.Fatalf("%s missing %q", name, required)
			}
		}
	}
}
