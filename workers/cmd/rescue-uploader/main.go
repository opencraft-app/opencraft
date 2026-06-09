//go:build linux

package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type Config struct {
	UploadURL   string   `json:"upload_url"`
	ObjectURL   string   `json:"object_url"`
	MountRoot   string   `json:"mount_root"`
	DeviceGlobs []string `json:"device_globs"`
	RemotePaths []string `json:"remote_paths"`
}

type countingHashWriter struct {
	out  io.Writer
	hash hashWriter
	n    int64
}

type hashWriter interface {
	io.Writer
	Sum([]byte) []byte
}

func (w *countingHashWriter) Write(data []byte) (int, error) {
	if _, err := w.hash.Write(data); err != nil {
		return 0, err
	}
	n, err := w.out.Write(data)
	w.n += int64(n)
	return n, err
}

func main() {
	if len(os.Args) != 2 {
		fail("usage: rescue-uploader <config.json>")
	}
	cfg, err := readConfig(os.Args[1])
	if err != nil {
		fail(err.Error())
	}
	device, err := mountRescuedRoot(cfg)
	if err != nil {
		fail(err.Error())
	}
	defer syscall.Unmount(cfg.MountRoot, 0)
	bytes, sha, err := streamArchiveToCOS(cfg)
	if err != nil {
		fail(err.Error())
	}
	fmt.Printf("RESCUE_UPLOAD_RESULT={\"object_url\":\"%s\",\"device\":\"%s\",\"bytes\":%d,\"sha256\":\"%s\"}\n", cfg.ObjectURL, device, bytes, sha)
}

func readConfig(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.UploadURL == "" || cfg.ObjectURL == "" || cfg.MountRoot == "" || len(cfg.DeviceGlobs) == 0 || len(cfg.RemotePaths) == 0 {
		return Config{}, errors.New("missing required config fields")
	}
	return cfg, nil
}

func mountRescuedRoot(cfg Config) (string, error) {
	if err := os.MkdirAll(cfg.MountRoot, 0o755); err != nil {
		return "", err
	}
	rootSource := currentRootSource()
	var last error
	for _, pattern := range cfg.DeviceGlobs {
		devices, _ := filepath.Glob(pattern)
		for _, dev := range devices {
			if dev == rootSource {
				continue
			}
			if err := tryMount(dev, cfg.MountRoot); err != nil {
				last = err
				continue
			}
			return dev, nil
		}
	}
	if last != nil {
		return "", fmt.Errorf("no mountable device found: %w", last)
	}
	return "", errors.New("no candidate block device found")
}

func tryMount(device, target string) error {
	fsTypes := []string{"ext4", "xfs", "ext3", "ext2", "btrfs"}
	var last error
	for _, fsType := range fsTypes {
		dataOptions := []string{""}
		if strings.HasPrefix(fsType, "ext") {
			dataOptions = []string{"noload", ""}
		}
		for _, data := range dataOptions {
			if err := syscall.Mount(device, target, fsType, syscall.MS_RDONLY, data); err == nil {
				return nil
			} else {
				last = err
			}
		}
	}
	return last
}

func currentRootSource() string {
	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == "/" {
			return fields[0]
		}
	}
	return ""
}

func streamArchiveToCOS(cfg Config) (int64, string, error) {
	pr, pw := io.Pipe()
	hash := sha256.New()
	counting := &countingHashWriter{out: pw, hash: hash}
	errCh := make(chan error, 1)
	go func() {
		err := writeTarGzip(cfg, counting)
		_ = pw.CloseWithError(err)
		errCh <- err
	}()

	req, err := http.NewRequest(http.MethodPut, cfg.UploadURL, pr)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/gzip")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return counting.n, "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return counting.n, "", fmt.Errorf("cos upload failed status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := <-errCh; err != nil {
		return counting.n, "", err
	}
	return counting.n, hex.EncodeToString(hash.Sum(nil)), nil
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

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
