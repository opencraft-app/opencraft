//go:build wispcli

package cmd

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/juicedata/juicefs/pkg/utils"
	"github.com/urfave/cli/v2"
)

func cmdClone() *cli.Command {
	return &cli.Command{
		Name:      "clone",
		Action:    clone,
		Usage:     "clone a file or directory without copying the underlying data",
		ArgsUsage: "SRC DST",
		Category:  "TOOL",
		Flags: []cli.Flag{
			&cli.BoolFlag{
				Name:    "preserve",
				Aliases: []string{"p"},
				Usage:   "preserve the uid, gid, and mode of the file",
			},
			&cli.IntFlag{
				Name:  "threads",
				Value: meta.CLONE_DEFAULT_CONCURRENCY,
				Usage: "number of concurrent workers for cloning directories",
			},
		},
	}
}

func clone(ctx *cli.Context) error {
	setup(ctx, 2)
	srcPath := ctx.Args().Get(0)
	srcAbsPath, err := filepath.Abs(srcPath)
	if err != nil {
		return fmt.Errorf("abs of %s: %s", srcPath, err)
	}
	srcIno, err := utils.GetFileInode(srcPath)
	if err != nil {
		return fmt.Errorf("lookup inode for %s: %s", srcPath, err)
	}
	srcParentIno, err := utils.GetFileInode(filepath.Dir(srcAbsPath))
	if err != nil {
		return fmt.Errorf("lookup inode for %s: %s", filepath.Dir(srcAbsPath), err)
	}

	dst := ctx.Args().Get(1)
	if strings.HasSuffix(dst, string(filepath.Separator)) {
		dst = filepath.Join(dst, filepath.Base(srcPath))
	}
	if _, err := os.Stat(dst); err == nil {
		return fmt.Errorf("%s already exists", dst)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("stat %s: %s", dst, err)
	}
	dstAbsPath, err := filepath.Abs(dst)
	if err != nil {
		return fmt.Errorf("abs of %s: %s", dst, err)
	}

	srcMp, err := findMountpoint(srcAbsPath)
	if err != nil {
		return err
	}
	dstMp, err := findMountpoint(filepath.Dir(dstAbsPath))
	if err != nil {
		return err
	}
	if srcMp != dstMp {
		return fmt.Errorf("the clone DST path should be at the same mount point as the SRC path")
	}
	if strings.HasPrefix(dstAbsPath, path.Clean(srcAbsPath)+"/") {
		return fmt.Errorf("the clone DST path should not be under the SRC path")
	}

	dstParent := filepath.Dir(dstAbsPath)
	dstName := filepath.Base(dstAbsPath)
	dstParentIno, err := utils.GetFileInode(dstParent)
	if err != nil {
		return fmt.Errorf("lookup inode for %s: %s", dstParent, err)
	}

	var cmode uint8
	if ctx.Bool("preserve") || runtime.GOOS == "windows" {
		cmode |= meta.CLONE_MODE_PRESERVE_ATTR
	}
	threads := ctx.Int("threads")
	if threads < 1 {
		threads = 1
	} else if threads > 255 {
		threads = 255
	}

	contentSize := 8 + 8 + 8 + 1 + uint32(len(dstName)) + 2 + 1 + 1
	wb := utils.NewBuffer(8 + contentSize)
	wb.Put32(meta.Clone)
	wb.Put32(contentSize)
	wb.Put64(srcIno)
	wb.Put64(srcParentIno)
	wb.Put64(dstParentIno)
	wb.Put8(uint8(len(dstName)))
	wb.Put([]byte(dstName))
	wb.Put16(uint16(utils.GetUmask()))
	wb.Put8(cmode)
	wb.Put8(uint8(threads))

	f, err := openController(srcMp)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(wb.Bytes()); err != nil {
		return fmt.Errorf("write message: %s", err)
	}
	if errno := readCloneResult(f); errno != 0 {
		return fmt.Errorf("clone failed: %v", errno)
	}
	return nil
}

func readCloneResult(cf *os.File) syscall.Errno {
	var resp = make([]byte, 2<<16)
	for {
		n := readControl(cf, resp)
		for off := 0; off < n; {
			if off+1 == n {
				errno := syscall.Errno(resp[off])
				if errno != 0 && runtime.GOOS == "windows" {
					errno += 0x20000000
				}
				return errno
			}
			if off+17 <= n && resp[off] == meta.CPROGRESS {
				off += 17
				continue
			}
			if off+5 < n && resp[off] == meta.CDATA {
				size := binary.BigEndian.Uint32(resp[off+1 : off+5])
				if size > uint32(len(resp[off+5:])) {
					_, _ = io.CopyN(io.Discard, cf, int64(size)-int64(len(resp[off+5:])))
				}
				return 0
			}
			logger.Errorf("Bad clone response off %d n %d: %v", off, n, resp[:n])
			return syscall.EPROTO
		}
	}
}
