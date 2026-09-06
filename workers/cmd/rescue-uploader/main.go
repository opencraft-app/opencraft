//go:build linux

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/lightclaw/tencent-rescue-exporter/internal/rescuearchive"
	"github.com/lightclaw/tencent-rescue-exporter/internal/rescuemultipart"
	cos "github.com/tencentyun/cos-go-sdk-v5"
)

type Config struct {
	UploadURL      string   `json:"upload_url"`
	BucketURL      string   `json:"bucket_url"`
	ObjectURL      string   `json:"object_url"`
	ObjectKey      string   `json:"object_key"`
	UploadID       string   `json:"upload_id"`
	TmpSecretID    string   `json:"tmp_secret_id"`
	TmpSecretKey   string   `json:"tmp_secret_key"`
	SessionToken   string   `json:"session_token"`
	MountRoot      string   `json:"mount_root"`
	DeviceGlobs    []string `json:"device_globs"`
	RemotePaths    []string `json:"remote_paths"`
	ArchiveMode    string   `json:"archive_mode"`
	PartSizeBytes  int      `json:"part_size_bytes"`
	MaxPartRetries int      `json:"max_part_retries"`
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
	var (
		bytes           int64
		sha             string
		parts           int
		multipartResult rescuemultipart.Result
	)
	if cfg.UploadID != "" {
		multipartResult, err = streamArchiveMultipart(cfg)
		bytes, sha, parts = multipartResult.Bytes, multipartResult.SHA256, multipartResult.PartCount
	} else {
		bytes, sha, err = streamArchiveToCOS(cfg)
	}
	if err != nil {
		if cfg.UploadID != "" {
			stage := rescuemultipart.StageArchive
			partNumber := 0
			var uploadErr *rescuemultipart.UploadError
			if errors.As(err, &uploadErr) {
				stage = uploadErr.Stage
				partNumber = uploadErr.PartNumber
			}
			fail(fmt.Sprintf(
				"multipart export failed stage=%s part_number=%d generated_bytes=%d uploaded_bytes=%d uploaded_parts=%d error=%v",
				stage,
				partNumber,
				multipartResult.Bytes,
				multipartResult.UploadedBytes,
				multipartResult.PartCount,
				err,
			))
		}
		fail(err.Error())
	}
	fmt.Printf("RESCUE_UPLOAD_RESULT={\"object_url\":\"%s\",\"device\":\"%s\",\"bytes\":%d,\"sha256\":\"%s\",\"parts\":%d}\n", cfg.ObjectURL, device, bytes, sha, parts)
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
	if cfg.ObjectURL == "" || cfg.MountRoot == "" || len(cfg.DeviceGlobs) == 0 || len(cfg.RemotePaths) == 0 {
		return Config{}, errors.New("missing required config fields")
	}
	multipartConfigured := cfg.BucketURL != "" && cfg.ObjectKey != "" && cfg.UploadID != "" &&
		cfg.TmpSecretID != "" && cfg.TmpSecretKey != "" && cfg.SessionToken != ""
	if cfg.UploadURL == "" && !multipartConfigured {
		return Config{}, errors.New("legacy upload URL or complete multipart configuration is required")
	}
	cfg.ArchiveMode = rescuearchive.NormalizeMode(cfg.ArchiveMode)
	if cfg.ArchiveMode != rescuearchive.ModeHermes && cfg.ArchiveMode != rescuearchive.ModeGeneric {
		return Config{}, fmt.Errorf("unknown archive mode %q", cfg.ArchiveMode)
	}
	if cfg.ArchiveMode == rescuearchive.ModeHermes && len(cfg.RemotePaths) != 1 {
		return Config{}, errors.New("hermes archive mode requires exactly one remote path")
	}
	return cfg, nil
}

func streamArchiveMultipart(cfg Config) (rescuemultipart.Result, error) {
	bucketURL, err := url.Parse(cfg.BucketURL)
	if err != nil {
		return rescuemultipart.Result{}, err
	}
	transport := &cos.AuthorizationTransport{
		SecretID:     cfg.TmpSecretID,
		SecretKey:    cfg.TmpSecretKey,
		SessionToken: cfg.SessionToken,
	}
	sdk := cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, &http.Client{Transport: transport})
	client, err := rescuemultipart.NewCOSClient(sdk, cfg.ObjectKey, cfg.UploadID)
	if err != nil {
		return rescuemultipart.Result{}, err
	}
	partSize := cfg.PartSizeBytes
	if partSize <= 0 {
		partSize = 32 * 1024 * 1024
	}
	maxAttempts := cfg.MaxPartRetries + 1
	if maxAttempts <= 1 {
		maxAttempts = 3
	}
	return rescuemultipart.Upload(context.Background(), client, func(out io.Writer) error {
		return rescuearchive.Write(rescuearchive.Config{
			MountRoot:   cfg.MountRoot,
			RemotePaths: cfg.RemotePaths,
			ArchiveMode: cfg.ArchiveMode,
		}, out)
	}, rescuemultipart.Options{
		PartSize:    partSize,
		MaxParts:    10_000,
		MaxAttempts: maxAttempts,
	})
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
		err := rescuearchive.Write(rescuearchive.Config{
			MountRoot:   cfg.MountRoot,
			RemotePaths: cfg.RemotePaths,
			ArchiveMode: cfg.ArchiveMode,
		}, counting)
		_ = pw.CloseWithError(err)
		errCh <- err
	}()

	req, err := http.NewRequest(http.MethodPut, cfg.UploadURL, pr)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", rescuearchive.ContentType(cfg.ArchiveMode))
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

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
