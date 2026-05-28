package cmd

import (
	"fmt"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/juicedata/juicefs/pkg/utils"
	"github.com/urfave/cli/v2"
)

func cmdFileBarrier() *cli.Command {
	return &cli.Command{
		Name:      "file-barrier",
		Action:    fileBarrier,
		Category:  "TOOL",
		Hidden:    true,
		Usage:     "Force a single file into clone-visible state",
		ArgsUsage: "FILE",
		Description: `
This hidden command is intended for checkpoint and recovery harnesses.

It is intentionally narrower than meta-barrier: file-barrier only fences a
single file path into JuiceFS clone-visible state. It is not a global metadata
durability cut.

Examples:
$ juicefs file-barrier /mnt/jfs/path/to/file
`,
	}
}

func fileBarrier(ctx *cli.Context) error {
	setup0(ctx, 1, 0)
	target := strings.TrimSpace(ctx.Args().First())
	if target == "" {
		return cli.ShowCommandHelp(ctx, "file-barrier")
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		return fmt.Errorf("abs %q: %w", target, err)
	}
	inode, err := utils.GetFileInode(abs)
	if err != nil {
		return fmt.Errorf("lookup inode for %q: %w", abs, err)
	}
	mp, err := findMountpoint(abs)
	if err != nil {
		return err
	}
	controller, err := openController(mp)
	if err != nil {
		return fmt.Errorf("open control file for %q: %w", abs, err)
	}
	defer controller.Close()

	wb := utils.NewBuffer(8 + 8)
	wb.Put32(meta.FileBarrier)
	wb.Put32(8)
	wb.Put64(inode)
	if _, err := controller.Write(wb.Bytes()); err != nil {
		return fmt.Errorf("write file barrier message: %w", err)
	}

	var out [256]byte
	n := readControl(controller, out[:])
	if n <= 0 {
		return fmt.Errorf("read file barrier response: empty reply")
	}
	if errno := syscall.Errno(out[n-1]); errno != 0 {
		return fmt.Errorf("file barrier failed: %w", errno)
	}
	return nil
}
