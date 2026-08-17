package scripts

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPlatformBuildsPinBothUpdateTrustDomains(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve scripts directory")
	}
	root := filepath.Dir(sourceFile)
	paths := []string{
		filepath.Join(root, "build-vela-macos-arm64.sh"),
		filepath.Join(root, "build-vela-linux-amd64-buildx.sh"),
		filepath.Join(filepath.Dir(root), "deploy", "linux-amd64.Dockerfile"),
	}
	combined := ""
	for _, path := range paths {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		combined += string(content)
	}
	for _, required := range []string{
		"--update-channel-url", "--channel-key-id", "--channel-public-key",
		"--release-key-id", "--release-public-key",
		"main.updateChannelURL", "main.updateChannelKeyID", "main.updateChannelPublicKey",
		"main.updateReleaseKeyID", "main.updateReleasePublicKey",
	} {
		if !strings.Contains(combined, required) {
			t.Errorf("Computer build trust pinning missing %q", required)
		}
	}
}
