package rescuearchive

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const (
	ModeHermes  = "hermes"
	ModeGeneric = "generic"
)

type Config struct {
	MountRoot   string
	RemotePaths []string
	ArchiveMode string
}

func NormalizeMode(mode string) string {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		return ModeHermes
	}
	return mode
}

func ContentType(mode string) string {
	if NormalizeMode(mode) == ModeHermes {
		return "application/zip"
	}
	return "application/gzip"
}

func Write(cfg Config, out io.Writer) error {
	cfg.ArchiveMode = NormalizeMode(cfg.ArchiveMode)
	switch cfg.ArchiveMode {
	case ModeHermes:
		return writeHermesZip(cfg, out)
	case ModeGeneric:
		return writeTarGzip(cfg, out)
	default:
		return fmt.Errorf("unknown archive mode %q", cfg.ArchiveMode)
	}
}

func writeTarGzip(cfg Config, out io.Writer) error {
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	for _, requested := range cfg.RemotePaths {
		rel := strings.TrimPrefix(requested, "/")
		if rel == "" {
			rel = "."
		}
		full := filepath.Join(cfg.MountRoot, rel)
		if _, err := os.Lstat(full); err != nil {
			fmt.Fprintf(os.Stderr, "Skipping missing path: %s\n", requested)
			continue
		}
		if err := addPathToTar(tw, cfg.MountRoot, rel); err != nil {
			tw.Close()
			gz.Close()
			return err
		}
	}
	if err := tw.Close(); err != nil {
		gz.Close()
		return err
	}
	return gz.Close()
}

func writeHermesZip(cfg Config, out io.Writer) error {
	if len(cfg.RemotePaths) != 1 {
		return errors.New("hermes archive mode requires exactly one remote path")
	}
	sourceRel := strings.TrimPrefix(cfg.RemotePaths[0], "/")
	if sourceRel == "" || sourceRel == "." {
		return errors.New("hermes archive source must not be /")
	}
	sourceRoot := filepath.Join(cfg.MountRoot, sourceRel)
	info, err := os.Lstat(sourceRoot)
	if err != nil {
		return fmt.Errorf("hermes home not found: %s: %w", cfg.RemotePaths[0], err)
	}
	if !info.IsDir() {
		return fmt.Errorf("hermes home is not a directory: %s", cfg.RemotePaths[0])
	}
	if !hasHermesMarker(sourceRoot) {
		return fmt.Errorf("hermes home marker not found under %s (need config.yaml, .env, or state.db)", cfg.RemotePaths[0])
	}

	zw := zip.NewWriter(out)
	added := 0
	err = filepath.WalkDir(sourceRoot, func(pathOnDisk string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if pathOnDisk == sourceRoot {
			return nil
		}
		rel, err := filepath.Rel(sourceRoot, pathOnDisk)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if shouldExcludeHermesZipEntry(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = rel
		header.Method = zip.Deflate
		writer, err := zw.CreateHeader(header)
		if err != nil {
			return err
		}
		file, err := os.Open(pathOnDisk)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, file)
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		added++
		return nil
	})
	if err != nil {
		_ = zw.Close()
		return err
	}
	if added == 0 {
		_ = zw.Close()
		return fmt.Errorf("no Hermes files to archive under %s", cfg.RemotePaths[0])
	}
	return zw.Close()
}

func addPathToTar(tw *tar.Writer, root string, rel string) error {
	full := filepath.Join(root, rel)
	return filepath.WalkDir(full, func(pathOnDisk string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, _ = os.Readlink(pathOnDisk)
		}
		header, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		name, err := filepath.Rel(root, pathOnDisk)
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(name)
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			header.Uid = int(stat.Uid)
			header.Gid = int(stat.Gid)
		}
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		file, err := os.Open(pathOnDisk)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = io.Copy(tw, file)
		return err
	})
}

func hasHermesMarker(root string) bool {
	for _, name := range []string{"config.yaml", ".env", "state.db"} {
		if _, err := os.Lstat(filepath.Join(root, name)); err == nil {
			return true
		}
	}
	return false
}

func shouldExcludeHermesZipEntry(rel string) bool {
	name := filepath.Base(rel)
	if name == "gateway.pid" || name == "cron.pid" || strings.HasSuffix(name, ".pyc") || strings.HasSuffix(name, ".pyo") {
		return true
	}
	for _, part := range strings.Split(rel, "/") {
		switch part {
		case "hermes-agent", "__pycache__", ".git", "node_modules":
			return true
		}
	}
	return false
}
