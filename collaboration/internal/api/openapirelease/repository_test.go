package openapirelease

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRepositoryReleaseDigestsAreImmutable(t *testing.T) {
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位 OpenAPI release 源码")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(current), "..", "..", ".."))
	if err := VerifyRoot(root); err != nil {
		t.Fatal(err)
	}
}

func TestOASDiffToolVersionIsPinnedForGo125(t *testing.T) {
	_, current, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(current), "..", "..", ".."))
	data, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "github.com/tufin/oasdiff v1.10.29") ||
		!strings.Contains(text, "github.com/tufin/oasdiff\n") {
		t.Fatal("oasdiff CLI 未以 v1.10.29 固定在 Go tool directive")
	}
}
