package computerrelease

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadCatalog读取严格不可变ReleaseBinding(t *testing.T) {
	path := filepath.Join(t.TempDir(), "release.json")
	content := `{
  "version":"0.1.0",
  "target":"darwin-arm64",
  "osType":"macos",
  "architecture":"arm64",
  "signingKeyId":"computer-release-2026-01",
  "manifest":{"objectKey":"computer/releases/0.1.0/manifest.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":101},
  "signature":{"objectKey":"computer/releases/0.1.0/manifest.sig","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":64},
  "installer":{"objectKey":"computer/releases/0.1.0/darwin-arm64/install.sh","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","size":202},
  "program":{"objectKey":"computer/releases/0.1.0/darwin-arm64/vela-computer","sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","size":303}
}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	release, err := LoadCatalog(path)
	if err != nil {
		t.Fatal(err)
	}
	if release.Version != "0.1.0" || release.Target != "darwin-arm64" ||
		release.Program.Size != 303 || release.Manifest.SHA256[0] != 0xaa {
		t.Fatalf("release = %#v", release)
	}
}

func TestLoadCatalog拒绝未知字段路径逃逸和非匹配目录(t *testing.T) {
	base := `{"version":"0.1.0","target":"darwin-arm64","osType":"macos","architecture":"arm64","signingKeyId":"key-1","manifest":{"objectKey":"computer/releases/0.1.0/manifest.json","sha256":"%s","size":1},"signature":{"objectKey":"computer/releases/0.1.0/manifest.sig","sha256":"%s","size":1},"installer":{"objectKey":"computer/releases/0.1.0/darwin-arm64/install.sh","sha256":"%s","size":1},"program":{"objectKey":"computer/releases/0.1.0/darwin-arm64/vela-computer","sha256":"%s","size":1}%s}`
	hash := strings.Repeat("1", 64)
	for index, content := range []string{
		fmtCatalog(base, hash, hash, hash, hash, `,"unexpected":true`),
		strings.Replace(fmtCatalog(base, hash, hash, hash, hash, ""), "computer/releases/0.1.0/manifest.json", "../manifest.json", 1),
		strings.Replace(fmtCatalog(base, hash, hash, hash, hash, ""), "computer/releases/0.1.0/darwin-arm64/install.sh", "computer/releases/other/darwin-arm64/install.sh", 1),
	} {
		path := filepath.Join(t.TempDir(), "release.json")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadCatalog(path); err == nil {
			t.Fatalf("case %d unexpectedly succeeded", index)
		}
	}
}

func fmtCatalog(format string, values ...any) string {
	return fmt.Sprintf(format, values...)
}
