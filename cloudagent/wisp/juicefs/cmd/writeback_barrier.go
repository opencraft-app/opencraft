package cmd

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"syscall"
	"time"

	"github.com/dustin/go-humanize"
	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/juicedata/juicefs/pkg/utils"
	"github.com/juicedata/juicefs/pkg/vfs"
	"github.com/pkg/errors"
	"github.com/urfave/cli/v2"
)

func cmdWritebackBarrier() *cli.Command {
	return &cli.Command{
		Name:      "writeback-barrier",
		Action:    writebackBarrier,
		Category:  "TOOL",
		Hidden:    true,
		Usage:     "Wait until writeback staging chunks are uploaded",
		ArgsUsage: "MOUNTPOINT",
		Description: `
This hidden command is intended for Wisp checkpoint and shutdown paths.

It waits for the JuiceFS writeback staging directory to drain without
unmounting the filesystem. It complements file-barrier and meta-barrier:
file-barrier fences the mounted VFS writer, meta-barrier fences metadata, and
writeback-barrier fences delayed local writeback chunks.

Examples:
$ juicefs writeback-barrier /mnt/jfs
`,
		Flags: []cli.Flag{
			&cli.DurationFlag{
				Name:  "timeout",
				Value: 10 * time.Minute,
				Usage: "maximum time to wait for writeback staging chunks",
			},
			&cli.BoolFlag{
				Name:  "verbose",
				Usage: "print per-second writeback drain progress",
			},
			&cli.DurationFlag{
				Name:  "poll-interval",
				Value: 30 * time.Millisecond,
				Usage: "interval for polling writeback staging drain progress",
			},
		},
	}
}

func cmdWritebackCutBarrier() *cli.Command {
	return &cli.Command{
		Name:      "writeback-cut-barrier",
		Action:    writebackCutBarrier,
		Category:  "TOOL",
		Hidden:    true,
		Usage:     "Wait until writeback staging chunks captured at the cut are uploaded",
		ArgsUsage: "MOUNTPOINT",
		Description: `
This hidden command is intended for Wisp checkpoint paths.

It captures the currently pending writeback staging set, forces upload for that
set, and waits only for that captured set to drain. New writes after the cut do
not keep the command from completing.
`,
		Flags: []cli.Flag{
			&cli.DurationFlag{
				Name:  "timeout",
				Value: 120 * time.Second,
				Usage: "maximum time to wait for captured writeback staging chunks",
			},
			&cli.DurationFlag{
				Name:  "poll-interval",
				Value: 30 * time.Millisecond,
				Usage: "interval for polling captured writeback staging drain progress",
			},
		},
	}
}

func writebackBarrier(ctx *cli.Context) error {
	setup0(ctx, 1, 1)
	mp := ctx.Args().First()
	raw, err := readConfig(mp)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("not a JuiceFS mount point")
		}
		return errors.Wrap(err, "failed to read config")
	}

	var conf vfs.Config
	if err = json.Unmarshal(raw, &conf); err != nil {
		return errors.Wrap(err, "failed to parse config")
	}
	if conf.Chunk == nil || !conf.Chunk.Writeback {
		return nil
	}
	if err := triggerWritebackBarrier(mp); err != nil {
		return err
	}
	stagingDir := path.Join(conf.Chunk.CacheDir, "rawstaging")
	timeout := ctx.Duration("timeout")
	if err := waitWritebackStagingComplete(stagingDir, timeout, ctx.Duration("poll-interval"), ctx.Bool("verbose")); err != nil {
		return err
	}
	size, _ := dirSizeBytes(stagingDir)
	clearWritebackBarrierLine()
	if size == 0 {
		fmt.Println("\rAll staging chunks are flushed")
	}
	return nil
}

func writebackCutBarrier(ctx *cli.Context) error {
	setup0(ctx, 1, 1)
	mp := ctx.Args().First()
	raw, err := readConfig(mp)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("not a JuiceFS mount point")
		}
		return errors.Wrap(err, "failed to read config")
	}

	var conf vfs.Config
	if err = json.Unmarshal(raw, &conf); err != nil {
		return errors.Wrap(err, "failed to parse config")
	}
	if conf.Chunk == nil || !conf.Chunk.Writeback {
		return nil
	}
	if err := triggerWritebackCutBarrier(mp, ctx.Duration("timeout"), ctx.Duration("poll-interval")); err != nil {
		return err
	}
	fmt.Println("Captured staging chunks are flushed")
	return nil
}

func triggerWritebackBarrier(mp string) error {
	controller, err := openController(mp)
	if err != nil {
		return fmt.Errorf("open control file for %q: %w", mp, err)
	}
	defer controller.Close()

	wb := utils.NewBuffer(8)
	wb.Put32(meta.WritebackBarrier)
	wb.Put32(0)
	if _, err := controller.Write(wb.Bytes()); err != nil {
		return fmt.Errorf("write writeback barrier message: %w", err)
	}

	var out [256]byte
	n := readControl(controller, out[:])
	if n <= 0 {
		return fmt.Errorf("read writeback barrier response: empty reply")
	}
	if errno := syscall.Errno(out[n-1]); errno != 0 {
		return fmt.Errorf("writeback barrier failed: %w", errno)
	}
	return nil
}

func triggerWritebackCutBarrier(mp string, timeout, pollInterval time.Duration) error {
	controller, err := openController(mp)
	if err != nil {
		return fmt.Errorf("open control file for %q: %w", mp, err)
	}
	defer controller.Close()

	if _, err := controller.Write(writebackCutBarrierMessage(timeout, pollInterval)); err != nil {
		return fmt.Errorf("write writeback cut barrier message: %w", err)
	}

	var out [256]byte
	n := readControl(controller, out[:])
	if n <= 0 {
		return fmt.Errorf("read writeback cut barrier response: empty reply")
	}
	if errno := syscall.Errno(out[n-1]); errno != 0 {
		return fmt.Errorf("writeback cut barrier failed: %w", errno)
	}
	return nil
}

func writebackCutBarrierMessage(timeout, pollInterval time.Duration) []byte {
	wb := utils.NewBuffer(24)
	wb.Put32(meta.WritebackCutBarrier)
	wb.Put32(16)
	wb.Put64(uint64(timeout))
	wb.Put64(uint64(pollInterval))
	return wb.Bytes()
}

func waitWritebackStagingComplete(stagingDir string, timeout, pollInterval time.Duration, verbose bool) error {
	if pollInterval <= 0 {
		pollInterval = 30 * time.Millisecond
	}
	deadline := time.Time{}
	if timeout > 0 {
		deadline = time.Now().Add(timeout)
	}
	lastLeft := uint64(0)
	lastFiles := 0
	for {
		if !deadline.IsZero() && time.Now().After(deadline) {
			size, files, _ := dirSizeAndFiles(stagingDir)
			return fmt.Errorf("timed out waiting for writeback staging chunks to flush: %s/%d files left in %s", humanize.IBytes(size), files, stagingDir)
		}
		if _, err := os.Stat(stagingDir); err != nil {
			if os.IsNotExist(err) {
				if verbose {
					fmt.Fprintf(os.Stderr, "writeback_barrier drained bytes=0 files=0 staging=%s reason=missing\n", stagingDir)
				}
				return nil
			}
			return errors.Wrap(err, "failed to read staging directory")
		}
		start := time.Now()
		size, files, err := dirSizeAndFiles(stagingDir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return errors.Wrap(err, "failed to read staging directory")
		}
		if lastLeft == 0 {
			lastLeft = size
			lastFiles = files
		}
		if size == 0 && lastLeft == 0 {
			if verbose {
				fmt.Fprintf(os.Stderr, "writeback_barrier drained bytes=0 files=0 staging=%s reason=empty\n", stagingDir)
			}
			return nil
		}

		speed := uint64(0)
		if lastLeft > size {
			speed = lastLeft - size
		}
		fileDelta := 0
		if lastFiles > files {
			fileDelta = lastFiles - files
		}
		leftTime := 720 * time.Hour
		if speed != 0 {
			leftTime = time.Duration(size/speed) * time.Second
		}
		if verbose {
			fmt.Fprintf(os.Stderr, "writeback_barrier progress bytes=%d files=%d speed_bps=%d files_done=%d eta=%s staging=%s\n", size, files, speed, fileDelta, leftTime, stagingDir)
		}
		clearWritebackBarrierLine()
		fmt.Printf("\r%s staging chunks are being flushed... %s/s, left %s", humanize.IBytes(size), humanize.IBytes(speed), leftTime)
		lastLeft = size
		lastFiles = files
		sleep := pollInterval - time.Since(start)
		if sleep > 0 {
			time.Sleep(sleep)
		}
	}
}

func dirSizeBytes(dir string) (uint64, error) {
	size, _, err := dirSizeAndFiles(dir)
	return size, err
}

func dirSizeAndFiles(dir string) (uint64, int, error) {
	var size uint64
	var files int
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d != nil && !d.IsDir() {
			files++
			fi, _ := d.Info()
			if fi != nil {
				size += uint64(fi.Size())
			}
		}
		return nil
	})
	return size, files, err
}

func clearWritebackBarrierLine() {
	fmt.Printf("\r                                                                             ")
}
