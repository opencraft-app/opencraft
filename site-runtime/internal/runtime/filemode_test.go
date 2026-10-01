//go:build linux || darwin

package runtime

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestRuntimeFileReadableUnderPrivateManagerUmask(t *testing.T) {
	// Match the systemd unit's UMask=0077. Do not run this test in parallel.
	previous := syscall.Umask(0077)
	defer syscall.Umask(previous)
	path := filepath.Join(t.TempDir(), "app.mjs")
	if err := writeRuntimeFile(path, []byte("export default {};")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0444 {
		t.Fatalf("isolated UID cannot read runtime file: mode=%04o", info.Mode().Perm())
	}
}
