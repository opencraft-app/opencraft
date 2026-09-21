package workspaces

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestShiftRootfsOwnershipVisitsHardlinkedInodeOnce(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("ownership shifting requires root")
	}
	root := t.TempDir()
	first := filepath.Join(root, "perl")
	second := filepath.Join(root, "perl5")
	if err := os.WriteFile(first, []byte("runtime"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(first, second); err != nil {
		t.Fatal(err)
	}
	if err := shiftRootfsOwnership(root, 100000); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{first, second} {
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		stat := info.Sys().(*syscall.Stat_t)
		if stat.Uid != 100000 || stat.Gid != 100000 {
			t.Fatalf("unexpected shifted ownership for %s: %d:%d", path, stat.Uid, stat.Gid)
		}
	}
}
