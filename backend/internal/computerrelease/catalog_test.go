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

func TestLoadReleaseSetReadsTwoStrictTargetLocalBindingsAndLegacyMac(t *testing.T) {
	hash := strings.Repeat("a", 64)
	path := filepath.Join(t.TempDir(), "release.catalog.json")
	content := `{
  "schema":"agent-network-computer-release-set/v1",
  "version":"0.2.0",
  "targets":[
    {"target":"darwin-arm64","osType":"macos","architecture":"arm64","signingKeyId":"key-1",
     "manifest":{"objectKey":"computer/releases/0.2.0/darwin-arm64/manifest.json","sha256":"` + hash + `","size":101},
     "signature":{"objectKey":"computer/releases/0.2.0/darwin-arm64/manifest.sig","sha256":"` + hash + `","size":64},
     "installer":{"objectKey":"computer/releases/0.2.0/darwin-arm64/install.sh","sha256":"` + hash + `","size":202},
     "program":{"objectKey":"computer/releases/0.2.0/darwin-arm64/vela-computer","sha256":"` + hash + `","size":303}},
    {"target":"linux-amd64","osType":"linux","architecture":"amd64","signingKeyId":"key-1",
     "manifest":{"objectKey":"computer/releases/0.2.0/linux-amd64/manifest.json","sha256":"` + hash + `","size":102},
     "signature":{"objectKey":"computer/releases/0.2.0/linux-amd64/manifest.sig","sha256":"` + hash + `","size":64},
     "installer":{"objectKey":"computer/releases/0.2.0/linux-amd64/install.sh","sha256":"` + hash + `","size":203},
     "program":{"objectKey":"computer/releases/0.2.0/linux-amd64/vela-computer","sha256":"` + hash + `","size":304}}
  ]
}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	releaseSet, err := LoadReleaseSet(path)
	if err != nil || releaseSet.Version != "0.2.0" || len(releaseSet.Releases) != 2 ||
		releaseSet.Releases[1].Target != "linux-amd64" || releaseSet.Releases[1].Program.Size != 304 {
		t.Fatalf("LoadReleaseSet() = (%#v, %v)", releaseSet, err)
	}

	legacyPath := filepath.Join(t.TempDir(), "legacy.catalog.json")
	legacyContent := `{"version":"0.1.0","target":"darwin-arm64","osType":"macos","architecture":"arm64","signingKeyId":"key-1","manifest":{"objectKey":"computer/releases/0.1.0/manifest.json","sha256":"` + hash + `","size":1},"signature":{"objectKey":"computer/releases/0.1.0/manifest.sig","sha256":"` + hash + `","size":1},"installer":{"objectKey":"computer/releases/0.1.0/darwin-arm64/install.sh","sha256":"` + hash + `","size":1},"program":{"objectKey":"computer/releases/0.1.0/darwin-arm64/vela-computer","sha256":"` + hash + `","size":1}}`
	if err := os.WriteFile(legacyPath, []byte(legacyContent), 0o600); err != nil {
		t.Fatal(err)
	}
	legacySet, err := LoadReleaseSet(legacyPath)
	if err != nil || len(legacySet.Releases) != 1 || legacySet.Releases[0].Target != "darwin-arm64" {
		t.Fatalf("legacy LoadReleaseSet() = (%#v, %v)", legacySet, err)
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
