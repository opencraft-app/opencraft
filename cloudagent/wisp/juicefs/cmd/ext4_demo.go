//go:build !wispcli

package cmd

import (
	"fmt"
	"io"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/juicedata/juicefs/pkg/chunk"
	"github.com/juicedata/juicefs/pkg/ext4sdk"
	"github.com/juicedata/juicefs/pkg/fs"
	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/juicedata/juicefs/pkg/object"
	"github.com/juicedata/juicefs/pkg/utils"
	"github.com/juicedata/juicefs/pkg/version"
	"github.com/juicedata/juicefs/pkg/vfs"
	"github.com/urfave/cli/v2"
)

const (
	ext4DemoBlockPath  = "/block.bin"
	ext4DemoBlockSize  = 4096
	ext4DemoBlockGB    = 100
	ext4DemoMountPoint = "/mp/"
	ext4DemoRootDir    = "demo"
	ext4DemoHelloDir   = "hello"
	ext4DemoHelloFile  = "hello/world.txt"
	ext4DemoAppendText = "aaaa"
)

func cmdExt4ReadWriteDemo() *cli.Command {
	return &cli.Command{
		Name:      "ext4readwritedemo",
		Action:    ext4ReadWriteDemo,
		Category:  "TOOL",
		Usage:     "Demonstrate lwext4 running on a JuiceFS-backed block.bin file",
		ArgsUsage: "META-URL",
		Flags: append(
			append(storageFlags(), dataCacheFlags()...),
			&cli.StringFlag{
				Name:  "block-path",
				Value: ext4DemoBlockPath,
				Usage: "JuiceFS path to the ext4 backing file",
			},
			&cli.Uint64Flag{
				Name:  "block-size",
				Value: ext4DemoBlockSize,
				Usage: "block size for the ext4 backing device",
			},
			&cli.Uint64Flag{
				Name:  "size-gb",
				Value: ext4DemoBlockGB,
				Usage: "logical size of the ext4 backing file in GiB",
			},
			&cli.BoolFlag{
				Name:  "reformat",
				Usage: "always format the ext4 volume before running the demo",
			},
			&cli.StringFlag{
				Name:  "scenarios",
				Value: "append,overwrite,rename,crossrename_raw,crossrename,renamechain,truncate,seekwrite,multiseekwrite,multiappend,manyfiles,crossdirmix,largefile,largefilex,reopen,tree,remove,stats",
				Usage: "comma-separated ext4 demo scenarios to execute",
			},
			&cli.StringFlag{
				Name:  "root",
				Value: ext4DemoRootDir,
				Usage: "root directory inside ext4 for demo scenarios",
			},
		),
		Description: `
This demo does not use FUSE. It opens an existing JuiceFS volume internally,
creates /block.bin as a sparse file, mounts lwext4 on top of that file, and
demonstrates mkdir/write/read/readdir through the lwext4 API.

Example:
$ juicefs ext4readwritedemo sqlite3:///tmp/meta.db
`,
	}
}

func ext4ReadWriteDemo(c *cli.Context) error {
	setup(c, 1)
	metaURL := strings.TrimSpace(c.Args().First())
	blockPath := strings.TrimSpace(c.String("block-path"))
	if blockPath == "" {
		blockPath = ext4DemoBlockPath
	}
	if !strings.HasPrefix(blockPath, "/") {
		blockPath = "/" + blockPath
	}
	blockSize := c.Uint64("block-size")
	if blockSize == 0 {
		blockSize = ext4DemoBlockSize
	}
	sizeGB := c.Uint64("size-gb")
	if sizeGB == 0 {
		sizeGB = ext4DemoBlockGB
	}
	blockCount := (sizeGB << 30) / blockSize
	rootDir := cleanExt4Path(c.String("root"))
	scenarios := parseExt4Scenarios(c.String("scenarios"))
	if len(scenarios) == 0 {
		return fmt.Errorf("no scenarios selected")
	}

	_, jfs, shutdown, err := newExt4DemoJFS(c, metaURL)
	if err != nil {
		return err
	}
	defer shutdown()

	jctx := meta.NewContext(1, uint32(utils.GetCurrentUID()), []uint32{uint32(utils.GetCurrentGID())})
	backend, err := ext4sdk.NewJuiceFSFileBackend(jfs, jctx, blockPath, uint32(blockSize), blockCount)
	if err != nil {
		return err
	}
	defer func() { _ = backend.Close() }()

	efs, err := ext4sdk.New(backend, ext4sdk.Options{
		DeviceName: "juicefs-ext4-demo",
		MountPoint: ext4DemoMountPoint,
		CacheItems: 128,
	})
	if err != nil {
		return err
	}
	defer func() { _ = efs.Close() }()

	if c.Bool("reformat") {
		if err := efs.Format(ext4sdk.FormatOptions{
			Type:      ext4sdk.Ext4,
			BlockSize: uint32(blockSize),
			Length:    uint64(blockSize) * blockCount,
			Journal:   true,
			Label:     "juicefs-ext4-demo",
		}); err != nil {
			return fmt.Errorf("format ext4: %w", err)
		}
	} else if err := efs.Mount(false); err != nil {
		if err := efs.Format(ext4sdk.FormatOptions{
			Type:      ext4sdk.Ext4,
			BlockSize: uint32(blockSize),
			Length:    uint64(blockSize) * blockCount,
			Journal:   true,
			Label:     "juicefs-ext4-demo",
		}); err != nil {
			return fmt.Errorf("format ext4: %w", err)
		}
	} else {
		goto mounted
	}

	if err := efs.Mount(false); err != nil {
		return fmt.Errorf("mount ext4: %w", err)
	}

mounted:
	defer func() { _ = efs.Unmount() }()

	fmt.Printf("ext4 demo backend ready: block=%s size=%dGiB blockSize=%d blocks=%d\n", blockPath, sizeGB, blockSize, blockCount)
	fmt.Printf("ext4 demo scenarios: %s root=%s\n", strings.Join(scenarios, ","), rootDir)

	for _, scenario := range scenarios {
		switch scenario {
		case "append":
			if err := runExt4AppendScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario append: %w", err)
			}
		case "overwrite":
			if err := runExt4OverwriteScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario overwrite: %w", err)
			}
		case "rename":
			if err := runExt4RenameScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario rename: %w", err)
			}
		case "truncate":
			if err := runExt4TruncateScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario truncate: %w", err)
			}
		case "crossrename":
			if err := runExt4CrossRenameScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario crossrename: %w", err)
			}
		case "crossrename_raw":
			if err := runExt4CrossRenameRawScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario crossrename_raw: %w", err)
			}
		case "renamechain":
			if err := runExt4RenameChainScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario renamechain: %w", err)
			}
		case "seekwrite":
			if err := runExt4SeekWriteScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario seekwrite: %w", err)
			}
		case "multiseekwrite":
			if err := runExt4MultiSeekWriteScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario multiseekwrite: %w", err)
			}
		case "multiappend":
			if err := runExt4MultiAppendScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario multiappend: %w", err)
			}
		case "manyfiles":
			if err := runExt4ManyFilesScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario manyfiles: %w", err)
			}
		case "crossdirmix":
			if err := runExt4CrossDirMixScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario crossdirmix: %w", err)
			}
		case "largefile":
			if err := runExt4LargeFileScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario largefile: %w", err)
			}
		case "largefilex":
			if err := runExt4LargeFileXScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario largefilex: %w", err)
			}
		case "reopen":
			if err := runExt4ReopenScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario reopen: %w", err)
			}
		case "tree":
			if err := runExt4TreeScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario tree: %w", err)
			}
		case "remove":
			if err := runExt4RemoveScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario remove: %w", err)
			}
		case "stats":
			if err := runExt4StatsScenario(efs, rootDir); err != nil {
				return fmt.Errorf("scenario stats: %w", err)
			}
		default:
			return fmt.Errorf("unknown scenario %q", scenario)
		}
	}
	return nil
}

func newExt4DemoJFS(c *cli.Context, metaURL string) (meta.Meta, *fs.FileSystem, func(), error) {
	metaConf := meta.DefaultConf()
	metaConf.MaxDeletes = c.Int("max-deletes")
	metaConf.NoBGJob = true
	metaCli := meta.NewClient(metaURL, metaConf)
	format, err := metaCli.Load(true)
	if err != nil {
		_ = metaCli.Shutdown()
		return nil, nil, nil, fmt.Errorf("load setting: %w", err)
	}
	blob, err := NewReloadableStorage(format, metaCli, updateFormat(c))
	if err != nil {
		_ = metaCli.Shutdown()
		return nil, nil, nil, fmt.Errorf("object storage: %w", err)
	}
	chunkConf := getChunkConf(c, format)
	store := chunk.NewCachedStore(blob, *chunkConf, nil)
	registerMetaMsg(metaCli, store, chunkConf)
	if err := metaCli.NewSession(false); err != nil {
		object.Shutdown(blob)
		_ = metaCli.Shutdown()
		return nil, nil, nil, fmt.Errorf("new session: %w", err)
	}

	vfsConf := &vfs.Config{
		Meta:            metaConf,
		Format:          *format,
		Version:         version.Version(),
		Chunk:           chunkConf,
		AttrTimeout:     0,
		DirEntryTimeout: 0,
		EntryTimeout:    0,
		Mountpoint:      "/",
	}

	jfs, err := fs.NewFileSystem(vfsConf, metaCli, store, nil)
	if err != nil {
		_ = metaCli.CloseSession()
		object.Shutdown(blob)
		_ = metaCli.Shutdown()
		return nil, nil, nil, fmt.Errorf("initialize fs: %w", err)
	}
	shutdown := func() {
		_ = metaCli.CloseSession()
		object.Shutdown(blob)
		_ = metaCli.Shutdown()
	}
	return metaCli, jfs, shutdown, nil
}

func isExt4AlreadyExists(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "exist") || strings.Contains(msg, "already exists")
}

func isExt4NotExist(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "not found") ||
		strings.Contains(msg, "no such") ||
		strings.Contains(msg, "rc=2")
}

func cleanExt4Path(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == "/" {
		return ext4DemoRootDir
	}
	return strings.Trim(strings.TrimPrefix(path.Clean("/"+name), "/"), "/")
}

func parseExt4Scenarios(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(strings.ToLower(part))
		if part == "" {
			continue
		}
		out = append(out, part)
	}
	return out
}

func ext4Join(elem ...string) string {
	parts := make([]string, 0, len(elem))
	for _, item := range elem {
		item = strings.Trim(item, "/")
		if item == "" {
			continue
		}
		parts = append(parts, item)
	}
	if len(parts) == 0 {
		return "/"
	}
	return strings.Join(parts, "/")
}

func ext4EnsureDir(efs *ext4sdk.FS, name string) error {
	if err := efs.Mkdir(name); err != nil && !isExt4AlreadyExists(err) {
		return err
	}
	return nil
}

func ext4EnsureTree(efs *ext4sdk.FS, name string) error {
	name = cleanExt4Path(name)
	if name == "" {
		return nil
	}
	var current string
	for _, part := range strings.Split(name, "/") {
		current = ext4Join(current, part)
		if err := ext4EnsureDir(efs, current); err != nil {
			return err
		}
	}
	return nil
}

func ext4WriteAll(efs *ext4sdk.FS, name, data string) error {
	parent := path.Dir("/" + name)
	if parent != "/" {
		if err := ext4EnsureTree(efs, strings.TrimPrefix(parent, "/")); err != nil {
			return fmt.Errorf("ensure parent %s: %w", parent, err)
		}
	}
	f, err := efs.OpenFile(name, "wb")
	if err != nil {
		return err
	}
	if _, err := f.Write([]byte(data)); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return nil
}

func ext4ReadFileOrEmpty(efs *ext4sdk.FS, name string) (string, error) {
	data, err := ext4ReadAll(efs, name)
	if isExt4NotExist(err) {
		return "", nil
	}
	return data, err
}

func ext4ReadDirAll(efs *ext4sdk.FS, name string) ([]string, error) {
	dir, err := efs.OpenDir(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = dir.Close() }()
	var entries []string
	for {
		de, err := dir.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if de.Name == "." || de.Name == ".." {
			continue
		}
		entries = append(entries, de.Name)
	}
	sort.Strings(entries)
	return entries, nil
}

func ext4RepeatToken(token string, count int) string {
	var b strings.Builder
	for i := 0; i < count; i++ {
		b.WriteString(token)
	}
	return b.String()
}

func runExt4AppendScenario(efs *ext4sdk.FS, root string) error {
	dir := ext4Join(root, ext4DemoHelloDir)
	file := ext4Join(root, ext4DemoHelloFile)
	if err := ext4EnsureTree(efs, dir); err != nil {
		return err
	}
	before, err := ext4ReadFileOrEmpty(efs, file)
	if err != nil {
		return err
	}
	after := before + ext4DemoAppendText
	if err := ext4WriteAll(efs, file, after); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	got, err := ext4ReadAll(efs, file)
	if err != nil {
		return err
	}
	if got != after {
		return fmt.Errorf("append mismatch: got=%q want=%q", got, after)
	}
	fmt.Printf("ext4 append: %s before=%q after=%q\n", file, before, got)
	return nil
}

func runExt4OverwriteScenario(efs *ext4sdk.FS, root string) error {
	file := ext4Join(root, "overwrite", "sample.txt")
	before, err := ext4ReadFileOrEmpty(efs, file)
	if err != nil {
		return err
	}
	after := "overwrite-" + strconv.Itoa(len(before)+1)
	if err := ext4WriteAll(efs, file, after); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	got, err := ext4ReadAll(efs, file)
	if err != nil {
		return err
	}
	if got != after {
		return fmt.Errorf("overwrite mismatch: got=%q want=%q", got, after)
	}
	fmt.Printf("ext4 overwrite: %s before=%q after=%q\n", file, before, got)
	return nil
}

func runExt4RenameScenario(efs *ext4sdk.FS, root string) error {
	src := ext4Join(root, "rename", "src.txt")
	dst := ext4Join(root, "rename", "dst.txt")
	payload := "rename-payload"
	_ = efs.Remove(dst)
	if err := ext4WriteAll(efs, src, payload); err != nil {
		return err
	}
	if err := efs.Rename(src, dst); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	if _, err := ext4ReadAll(efs, src); err == nil || !isExt4NotExist(err) {
		return fmt.Errorf("rename source still exists or wrong error: %v", err)
	}
	got, err := ext4ReadAll(efs, dst)
	if err != nil {
		return err
	}
	if got != payload {
		return fmt.Errorf("rename payload mismatch: got=%q want=%q", got, payload)
	}
	fmt.Printf("ext4 rename: %s -> %s payload=%q\n", src, dst, got)
	return nil
}

func runExt4CrossRenameScenario(efs *ext4sdk.FS, root string) error {
	src := ext4Join(root, "crossrename", "src", "alpha.txt")
	dst := ext4Join(root, "crossrename", "dst", "beta.txt")
	payload := "cross-rename-payload"
	if err := ext4EnsureTree(efs, ext4Join(root, "crossrename", "src")); err != nil {
		return err
	}
	if err := ext4EnsureTree(efs, ext4Join(root, "crossrename", "dst")); err != nil {
		return err
	}
	_ = efs.Remove(dst)
	if err := ext4WriteAll(efs, src, payload); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	if err := efs.Rename(src, dst); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	if _, err := ext4ReadAll(efs, src); err == nil || !isExt4NotExist(err) {
		return fmt.Errorf("crossrename source still exists or wrong error: %v", err)
	}
	got, err := ext4ReadAll(efs, dst)
	if err != nil {
		return err
	}
	if got != payload {
		return fmt.Errorf("crossrename mismatch: got=%q want=%q", got, payload)
	}
	fmt.Printf("ext4 crossrename: %s -> %s payload=%q\n", src, dst, got)
	return nil
}

func runExt4CrossRenameRawScenario(efs *ext4sdk.FS, root string) error {
	src := ext4Join(root, "crossrename_raw", "src", "alpha.txt")
	dst := ext4Join(root, "crossrename_raw", "dst", "beta.txt")
	payload := "cross-rename-raw-payload"
	if err := ext4EnsureTree(efs, ext4Join(root, "crossrename_raw", "src")); err != nil {
		return err
	}
	if err := ext4EnsureTree(efs, ext4Join(root, "crossrename_raw", "dst")); err != nil {
		return err
	}
	_ = efs.Remove(dst)
	if err := ext4WriteAll(efs, src, payload); err != nil {
		return err
	}
	if err := efs.Rename(src, dst); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	if _, err := ext4ReadAll(efs, src); err == nil || !isExt4NotExist(err) {
		return fmt.Errorf("crossrename_raw source still exists or wrong error: %v", err)
	}
	got, err := ext4ReadAll(efs, dst)
	if err != nil {
		return err
	}
	if got != payload {
		return fmt.Errorf("crossrename_raw mismatch: got=%q want=%q", got, payload)
	}
	fmt.Printf("ext4 crossrename_raw: %s -> %s payload=%q\n", src, dst, got)
	return nil
}

func runExt4RenameChainScenario(efs *ext4sdk.FS, root string) error {
	base := ext4Join(root, "renamechain")
	current := ext4Join(base, "step-00.txt")
	payload := "rename-chain"
	for i := 0; i <= 5; i++ {
		_ = efs.Remove(ext4Join(base, fmt.Sprintf("step-%02d.txt", i)))
	}
	if err := ext4WriteAll(efs, current, payload); err != nil {
		return err
	}
	for i := 1; i <= 5; i++ {
		next := ext4Join(base, fmt.Sprintf("step-%02d.txt", i))
		if err := efs.Rename(current, next); err != nil {
			return err
		}
		current = next
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	got, err := ext4ReadAll(efs, current)
	if err != nil {
		return err
	}
	if got != payload {
		return fmt.Errorf("renamechain mismatch: got=%q want=%q", got, payload)
	}
	fmt.Printf("ext4 renamechain: final=%s payload=%q\n", current, got)
	return nil
}

func runExt4TruncateScenario(efs *ext4sdk.FS, root string) error {
	file := ext4Join(root, "truncate", "file.txt")
	if err := ext4WriteAll(efs, file, "0123456789abcdef"); err != nil {
		return err
	}
	f, err := efs.OpenFile(file, "rb+")
	if err != nil {
		return err
	}
	if err := f.Truncate(8); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	got, err := ext4ReadAll(efs, file)
	if err != nil {
		return err
	}
	if got != "01234567" {
		return fmt.Errorf("truncate mismatch: got=%q", got)
	}
	fmt.Printf("ext4 truncate: %s => %q\n", file, got)
	return nil
}

func runExt4SeekWriteScenario(efs *ext4sdk.FS, root string) error {
	file := ext4Join(root, "seekwrite", "file.txt")
	if err := ext4WriteAll(efs, file, "abcdefghij"); err != nil {
		return err
	}
	f, err := efs.OpenFile(file, "rb+")
	if err != nil {
		return err
	}
	if _, err := f.Seek(3, io.SeekStart); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write([]byte("ZZ")); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	got, err := ext4ReadAll(efs, file)
	if err != nil {
		return err
	}
	if got != "abcZZfghij" {
		return fmt.Errorf("seekwrite mismatch: got=%q", got)
	}
	fmt.Printf("ext4 seekwrite: %s => %q\n", file, got)
	return nil
}

func runExt4MultiSeekWriteScenario(efs *ext4sdk.FS, root string) error {
	file := ext4Join(root, "multiseekwrite", "file.txt")
	if err := ext4WriteAll(efs, file, "abcdefghijklmnop"); err != nil {
		return err
	}
	f, err := efs.OpenFile(file, "rb+")
	if err != nil {
		return err
	}
	ops := []struct {
		off  int64
		data string
	}{
		{1, "XX"},
		{6, "YY"},
		{12, "ZZ"},
	}
	for _, op := range ops {
		if _, err := f.Seek(op.off, io.SeekStart); err != nil {
			_ = f.Close()
			return err
		}
		if _, err := f.Write([]byte(op.data)); err != nil {
			_ = f.Close()
			return err
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	got, err := ext4ReadAll(efs, file)
	if err != nil {
		return err
	}
	if got != "aXXdefYYijklZZop" {
		return fmt.Errorf("multiseekwrite mismatch: got=%q", got)
	}
	fmt.Printf("ext4 multiseekwrite: %s => %q\n", file, got)
	return nil
}

func runExt4MultiAppendScenario(efs *ext4sdk.FS, root string) error {
	file := ext4Join(root, "multiappend", "file.txt")
	before, err := ext4ReadFileOrEmpty(efs, file)
	if err != nil {
		return err
	}
	after := before + ext4RepeatToken(ext4DemoAppendText, 8)
	if err := ext4WriteAll(efs, file, after); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	got, err := ext4ReadAll(efs, file)
	if err != nil {
		return err
	}
	if got != after {
		return fmt.Errorf("multiappend mismatch: got=%q want=%q", got, after)
	}
	fmt.Printf("ext4 multiappend: %s len_before=%d len_after=%d\n", file, len(before), len(got))
	return nil
}

func runExt4ManyFilesScenario(efs *ext4sdk.FS, root string) error {
	base := ext4Join(root, "manyfiles")
	if err := ext4EnsureTree(efs, base); err != nil {
		return err
	}
	for i := 0; i < 16; i++ {
		name := ext4Join(base, fmt.Sprintf("file-%02d.txt", i))
		data := fmt.Sprintf("payload-%02d", i)
		if err := ext4WriteAll(efs, name, data); err != nil {
			return err
		}
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	entries, err := ext4ReadDirAll(efs, base)
	if err != nil {
		return err
	}
	if len(entries) != 16 {
		return fmt.Errorf("manyfiles entry count mismatch: got=%d want=16", len(entries))
	}
	last := ext4Join(base, "file-15.txt")
	got, err := ext4ReadAll(efs, last)
	if err != nil {
		return err
	}
	if got != "payload-15" {
		return fmt.Errorf("manyfiles verify mismatch: got=%q", got)
	}
	fmt.Printf("ext4 manyfiles: %s entries=%d last=%q\n", base, len(entries), got)
	return nil
}

func runExt4CrossDirMixScenario(efs *ext4sdk.FS, root string) error {
	left := ext4Join(root, "crossdirmix", "left")
	right := ext4Join(root, "crossdirmix", "right")
	_ = efs.Remove(ext4Join(right, "moved-03.txt"))
	_ = efs.Remove(ext4Join(left, "overlay.txt"))
	_ = efs.Remove(ext4Join(right, "overlay.txt"))
	for i := 0; i < 6; i++ {
		_ = efs.Remove(ext4Join(left, fmt.Sprintf("l-%02d.txt", i)))
		_ = efs.Remove(ext4Join(right, fmt.Sprintf("r-%02d.txt", i)))
	}
	for i := 0; i < 6; i++ {
		if err := ext4WriteAll(efs, ext4Join(left, fmt.Sprintf("l-%02d.txt", i)), "L"+strconv.Itoa(i)); err != nil {
			return err
		}
		if err := ext4WriteAll(efs, ext4Join(right, fmt.Sprintf("r-%02d.txt", i)), "R"+strconv.Itoa(i)); err != nil {
			return err
		}
	}
	if err := efs.Rename(ext4Join(left, "l-03.txt"), ext4Join(right, "moved-03.txt")); err != nil {
		return err
	}
	if err := ext4WriteAll(efs, ext4Join(left, "overlay.txt"), "overlay-left"); err != nil {
		return err
	}
	if err := ext4WriteAll(efs, ext4Join(right, "overlay.txt"), "overlay-right"); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	leftEntries, err := ext4ReadDirAll(efs, left)
	if err != nil {
		return err
	}
	rightEntries, err := ext4ReadDirAll(efs, right)
	if err != nil {
		return err
	}
	got, err := ext4ReadAll(efs, ext4Join(right, "moved-03.txt"))
	if err != nil {
		return err
	}
	if got != "L3" {
		return fmt.Errorf("crossdirmix moved payload mismatch: got=%q", got)
	}
	fmt.Printf("ext4 crossdirmix: left=%d right=%d moved=%q\n", len(leftEntries), len(rightEntries), got)
	return nil
}

func runExt4LargeFileScenario(efs *ext4sdk.FS, root string) error {
	file := ext4Join(root, "largefile", "blob.txt")
	payload := ext4RepeatToken("0123456789abcdef", 2048)
	if err := ext4WriteAll(efs, file, payload); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	got, err := ext4ReadAll(efs, file)
	if err != nil {
		return err
	}
	if got != payload {
		return fmt.Errorf("largefile mismatch: got_len=%d want_len=%d", len(got), len(payload))
	}
	fmt.Printf("ext4 largefile: %s bytes=%d\n", file, len(got))
	return nil
}

func runExt4LargeFileXScenario(efs *ext4sdk.FS, root string) error {
	file := ext4Join(root, "largefilex", "blob.txt")
	payload := ext4RepeatToken("abcdef0123456789", 8192)
	if err := ext4WriteAll(efs, file, payload); err != nil {
		return err
	}
	f, err := efs.OpenFile(file, "rb+")
	if err != nil {
		return err
	}
	patches := []struct {
		off  int64
		data string
	}{
		{0, "BEGIN"},
		{32768, "MIDPOINT"},
		{int64(len(payload) - 6), "FINISH"},
	}
	for _, p := range patches {
		if _, err := f.Seek(p.off, io.SeekStart); err != nil {
			_ = f.Close()
			return err
		}
		if _, err := f.Write([]byte(p.data)); err != nil {
			_ = f.Close()
			return err
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	got, err := ext4ReadAll(efs, file)
	if err != nil {
		return err
	}
	if len(got) != len(payload) {
		return fmt.Errorf("largefilex size mismatch: got=%d want=%d", len(got), len(payload))
	}
	if !strings.HasPrefix(got, "BEGIN") || !strings.Contains(got[32768:], "MIDPOINT") || !strings.HasSuffix(got, "FINISH") {
		return fmt.Errorf("largefilex patch verification failed")
	}
	fmt.Printf("ext4 largefilex: %s bytes=%d patched=true\n", file, len(got))
	return nil
}

func runExt4ReopenScenario(efs *ext4sdk.FS, root string) error {
	file := ext4Join(root, "reopen", "roundtrip.txt")
	payload := "reopen-check"
	if err := ext4WriteAll(efs, file, payload); err != nil {
		return err
	}
	for i := 0; i < 3; i++ {
		got, err := ext4ReadAll(efs, file)
		if err != nil {
			return err
		}
		if got != payload {
			return fmt.Errorf("reopen mismatch on pass %d: got=%q want=%q", i, got, payload)
		}
	}
	fmt.Printf("ext4 reopen: %s payload=%q passes=%d\n", file, payload, 3)
	return nil
}

func runExt4TreeScenario(efs *ext4sdk.FS, root string) error {
	base := ext4Join(root, "tree", "a", "b")
	if err := ext4EnsureTree(efs, base); err != nil {
		return err
	}
	files := map[string]string{
		ext4Join(base, "one.txt"):   "one",
		ext4Join(base, "two.txt"):   "two",
		ext4Join(base, "three.txt"): "three",
	}
	for name, data := range files {
		if err := ext4WriteAll(efs, name, data); err != nil {
			return err
		}
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	entries, err := ext4ReadDirAll(efs, base)
	if err != nil {
		return err
	}
	want := []string{"one.txt", "three.txt", "two.txt"}
	if strings.Join(entries, ",") != strings.Join(want, ",") {
		return fmt.Errorf("tree entries mismatch: got=%v want=%v", entries, want)
	}
	fmt.Printf("ext4 tree: %s => %v\n", base, entries)
	return nil
}

func runExt4RemoveScenario(efs *ext4sdk.FS, root string) error {
	file := ext4Join(root, "remove", "gone.txt")
	if err := ext4WriteAll(efs, file, "gone"); err != nil {
		return err
	}
	if err := efs.Remove(file); err != nil {
		return err
	}
	if err := efs.Flush(); err != nil {
		return err
	}
	if _, err := ext4ReadAll(efs, file); err == nil || !isExt4NotExist(err) {
		return fmt.Errorf("remove expected not-exist, got %v", err)
	}
	fmt.Printf("ext4 remove: %s removed\n", file)
	return nil
}

func runExt4StatsScenario(efs *ext4sdk.FS, root string) error {
	stats, err := efs.Stats()
	if err != nil {
		return err
	}
	fmt.Printf("ext4 stats: root=%s volume=%q blockSize=%d freeBlocks=%d freeInodes=%d\n",
		root, stats.VolumeName, stats.BlockSize, stats.FreeBlocksCount, stats.FreeInodesCount)
	return nil
}

func ext4ReadAll(efs *ext4sdk.FS, name string) (string, error) {
	f, err := efs.OpenFile(name, "rb")
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, 4096)
	var out strings.Builder
	for {
		n, rerr := f.Read(buf)
		if n > 0 {
			out.Write(buf[:n])
		}
		if rerr == nil {
			continue
		}
		if rerr == io.EOF {
			break
		}
		return "", rerr
	}
	return out.String(), nil
}
