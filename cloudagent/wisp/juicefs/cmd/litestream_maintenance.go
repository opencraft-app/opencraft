package cmd

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/juicedata/juicefs/pkg/utils"
	"github.com/urfave/cli/v2"
)

func cmdLitestreamMaintenance() *cli.Command {
	return &cli.Command{
		Name:      "litestream-maintenance",
		Action:    litestreamMaintenance,
		Category:  "TOOL",
		Hidden:    true,
		Usage:     "Trigger one-shot Litestream metadata maintenance",
		ArgsUsage: "MOUNTPOINT|META-URL",
		Description: `
This hidden command is intended for Wisp shutdown paths. It runs while the
mount is still alive, before unmount, so short-lived workers do not wait for
background Litestream compaction and snapshot tickers.

Examples:
$ juicefs litestream-maintenance /mnt/jfs
$ juicefs litestream-maintenance --l0-retention-age 0s /mnt/jfs
`,
		Flags: []cli.Flag{
			&cli.BoolFlag{
				Name:  "snapshot",
				Value: true,
				Usage: "create a full Litestream snapshot from remote LTX files",
			},
			&cli.IntFlag{
				Name:  "compact-level",
				Value: 0,
				Usage: "compact into the specified level before snapshot; 0 disables explicit compaction",
			},
			&cli.BoolFlag{
				Name:  "snapshot-retention",
				Value: true,
				Usage: "enforce snapshot retention after creating a snapshot",
			},
			&cli.DurationFlag{
				Name:  "snapshot-retention-age",
				Value: 5 * time.Minute,
				Usage: "snapshot retention age",
			},
			&cli.BoolFlag{
				Name:  "l0-retention",
				Value: true,
				Usage: "enforce L0 retention after snapshot/compaction",
			},
			&cli.DurationFlag{
				Name:  "l0-retention-age",
				Value: 0,
				Usage: "L0 retention age; 0 deletes eligible compacted L0 files immediately",
			},
		},
	}
}

func litestreamMaintenance(ctx *cli.Context) error {
	setup0(ctx, 1, 0)
	target := strings.TrimSpace(ctx.Args().First())
	if target == "" {
		return cli.ShowCommandHelp(ctx, "litestream-maintenance")
	}
	opts := meta.LitestreamMaintenanceOptions{
		Snapshot:                 ctx.Bool("snapshot"),
		CompactLevel:             ctx.Int("compact-level"),
		EnforceSnapshotRetention: ctx.Bool("snapshot-retention"),
		SnapshotRetention:        ctx.Duration("snapshot-retention-age"),
		EnforceL0Retention:       ctx.Bool("l0-retention"),
		L0Retention:              ctx.Duration("l0-retention-age"),
	}
	if strings.Contains(target, "://") {
		return litestreamMaintenanceDirect(target, opts)
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		return fmt.Errorf("abs %q: %w", target, err)
	}
	return litestreamMaintenanceViaController(abs, opts)
}

func litestreamMaintenanceDirect(uri string, opts meta.LitestreamMaintenanceOptions) error {
	m := meta.NewClient(uri, meta.DefaultConf())
	defer func() { _ = m.Shutdown() }()
	if _, err := m.Load(true); err != nil {
		return err
	}
	maintainer, ok := m.(meta.LitestreamMaintainer)
	if !ok {
		return fmt.Errorf("metadata backend %T does not implement litestream maintenance", m)
	}
	_, err := maintainer.RunLitestreamMaintenance(meta.Background(), opts)
	return err
}

func litestreamMaintenanceViaController(path string, opts meta.LitestreamMaintenanceOptions) error {
	controller, err := openController(path)
	if err != nil {
		return fmt.Errorf("open control file for %q: %w", path, err)
	}
	defer controller.Close()

	msg, err := litestreamMaintenanceMessage(opts)
	if err != nil {
		return err
	}
	if _, err := controller.Write(msg); err != nil {
		return fmt.Errorf("write litestream maintenance message: %w", err)
	}

	var out [256]byte
	n := readControl(controller, out[:])
	if n <= 0 {
		return fmt.Errorf("read litestream maintenance response: empty reply")
	}
	if errno := syscall.Errno(out[n-1]); errno != 0 {
		return fmt.Errorf("litestream maintenance failed: %w", errno)
	}
	return nil
}

func litestreamMaintenanceMessage(opts meta.LitestreamMaintenanceOptions) ([]byte, error) {
	payload, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal litestream maintenance options: %w", err)
	}
	wb := utils.NewBuffer(uint32(8 + len(payload)))
	wb.Put32(meta.LitestreamMaintenance)
	wb.Put32(uint32(len(payload)))
	wb.Put(payload)
	return wb.Bytes(), nil
}
