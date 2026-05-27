package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/juicedata/juicefs/pkg/meta"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "direct_meta_op: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 4 {
		return fmt.Errorf("usage: direct_meta_op <meta-url> <create|rename|unlink> <name> [new-name]")
	}
	uri := strings.TrimSpace(os.Args[1])
	op := strings.TrimSpace(os.Args[2])
	name := strings.TrimSpace(os.Args[3])
	if uri == "" || op == "" || name == "" {
		return fmt.Errorf("meta-url, op, and name are required")
	}

	m := meta.NewClient(uri, meta.DefaultConf())
	defer func() { _ = m.Shutdown() }()
	if _, err := m.Load(true); err != nil {
		return err
	}

	ctx := meta.Background()
	switch op {
	case "create":
		var inode meta.Ino
		var attr meta.Attr
		if st := m.Create(ctx, meta.RootInode, name, 0644, 0, 0, &inode, &attr); st != 0 {
			return fmt.Errorf("create %q: %s", name, st)
		}
	case "rename":
		if len(os.Args) != 5 {
			return fmt.Errorf("usage: direct_meta_op <meta-url> rename <old> <new>")
		}
		newName := strings.TrimSpace(os.Args[4])
		if newName == "" {
			return fmt.Errorf("new name is required")
		}
		if st := m.Rename(ctx, meta.RootInode, name, meta.RootInode, newName, 0, nil, nil); st != 0 {
			return fmt.Errorf("rename %q -> %q: %s", name, newName, st)
		}
	case "unlink":
		if st := m.Unlink(ctx, meta.RootInode, name); st != 0 {
			return fmt.Errorf("unlink %q: %s", name, st)
		}
	default:
		return fmt.Errorf("unsupported op %q", op)
	}
	return nil
}
