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

func cmdMetaBarrier() *cli.Command {
	return &cli.Command{
		Name:      "meta-barrier",
		Action:    metaBarrier,
		Category:  "TOOL",
		Hidden:    true,
		Usage:     "Force a durable metadata cut for testing",
		ArgsUsage: "MOUNTPOINT|META-URL",
		Description: `
This hidden command is intended for durability and recovery harnesses.

Examples:
$ juicefs meta-barrier /mnt/jfs
$ juicefs meta-barrier 'sqlite3:///tmp/meta.db?litestream_write=true&litestream_path=foo/bar'
`,
	}
}

func metaBarrier(ctx *cli.Context) error {
	setup0(ctx, 1, 0)
	target := strings.TrimSpace(ctx.Args().First())
	if target == "" {
		return cli.ShowCommandHelp(ctx, "meta-barrier")
	}

	if strings.Contains(target, "://") {
		return metaBarrierDirect(target)
	}

	abs, err := filepath.Abs(target)
	if err != nil {
		return fmt.Errorf("abs %q: %w", target, err)
	}
	return metaBarrierViaController(abs)
}

func metaBarrierDirect(uri string) error {
	m := meta.NewClient(uri, meta.DefaultConf())
	defer func() { _ = m.Shutdown() }()
	if _, err := m.Load(true); err != nil {
		return err
	}
	barrier, ok := m.(meta.CheckpointBarrier)
	if !ok {
		return fmt.Errorf("metadata backend %T does not implement checkpoint barrier", m)
	}
	lease, err := barrier.BeginCheckpoint(meta.Background())
	if err != nil {
		return err
	}
	return lease.Release()
}

func metaBarrierViaController(path string) error {
	controller, err := openController(path)
	if err != nil {
		return fmt.Errorf("open control file for %q: %w", path, err)
	}
	defer controller.Close()

	wb := utils.NewBuffer(8)
	wb.Put32(meta.CheckpointCut)
	wb.Put32(0)
	if _, err := controller.Write(wb.Bytes()); err != nil {
		return fmt.Errorf("write checkpoint cut message: %w", err)
	}

	var out [256]byte
	n := readControl(controller, out[:])
	if n <= 0 {
		return fmt.Errorf("read checkpoint cut response: empty reply")
	}
	if errno := syscall.Errno(out[n-1]); errno != 0 {
		return fmt.Errorf("checkpoint cut failed: %w", errno)
	}
	return nil
}
