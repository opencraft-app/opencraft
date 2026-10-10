package platformcontract

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

const velaComputerFixtureSHA256 = "3d9fef884bf624b35d096e54abe5c2991d3cf77fc55533311d722dcfcbe5d3a9"

func TestVelaComputerFixtureIsFrozen(t *testing.T) {
	t.Parallel()

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current test file")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(currentFile),
		"..",
		"..",
		"..",
		"testdata",
		"vela-platform-v1",
		"vela-computer-protocol.v1.json",
	))
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read Vela Computer fixture: %v", err)
	}
	sum := sha256.Sum256(content)
	if got := hex.EncodeToString(sum[:]); got != velaComputerFixtureSHA256 {
		t.Fatalf(
			"Vela Computer fixture SHA-256 = %s, want %s",
			got,
			velaComputerFixtureSHA256,
		)
	}
}
