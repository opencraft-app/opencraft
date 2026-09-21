package workspaces

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const DefaultImageSizeBytes int64 = 16_000_000_000_000

type VolumeConfig struct {
	ImagePath string
	SizeBytes int64
	MountPath string
	Runner    CommandRunner
}

type VolumeStatus struct {
	ImagePath string
	SizeBytes int64
	MountPath string
	Mounted   bool
	Source    string
}

func validateVolumeConfig(config VolumeConfig) (VolumeConfig, error) {
	if config.SizeBytes == 0 {
		config.SizeBytes = DefaultImageSizeBytes
	}
	if config.SizeBytes < 1024*1024*1024 {
		return config, fmt.Errorf("workspace image must be at least 1 GiB")
	}
	for label, value := range map[string]string{"image path": config.ImagePath, "mount path": config.MountPath} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return config, fmt.Errorf("%s must be an absolute clean path: %q", label, value)
		}
	}
	if config.Runner == nil {
		config.Runner = ExecCommandRunner{}
	}
	return config, nil
}

func volumeMountSource(ctx context.Context, runner CommandRunner, target string) (string, bool) {
	output, err := runner.Run(ctx, "findmnt", "-n", "-o", "SOURCE", "--mountpoint", target)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(output)), true
}

// PrepareVolume is an explicit administrative operation. Server startup only
// validates storage; it never formats or mounts an image implicitly.
func PrepareVolume(ctx context.Context, input VolumeConfig) error {
	config, err := validateVolumeConfig(input)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(config.ImagePath), 0o755); err != nil {
		return fmt.Errorf("create workspace image parent: %w", err)
	}
	image, err := os.OpenFile(config.ImagePath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open workspace image: %w", err)
	}
	info, statErr := image.Stat()
	newImage := statErr == nil && info.Size() == 0
	if newImage {
		statErr = image.Truncate(config.SizeBytes)
	}
	closeErr := image.Close()
	if statErr != nil {
		return fmt.Errorf("create sparse workspace image: %w", statErr)
	}
	if closeErr != nil {
		return closeErr
	}
	filesystem, probeErr := config.Runner.Run(ctx, "blkid", "-p", "-s", "TYPE", "-o", "value", config.ImagePath)
	if probeErr != nil {
		if !newImage {
			return fmt.Errorf("refusing to format existing workspace image after filesystem probe failed: %w", probeErr)
		}
		if _, formatErr := config.Runner.Run(ctx, "mkfs.btrfs", "-f", "-L", "hypernode-workspaces-v2", config.ImagePath); formatErr != nil {
			return fmt.Errorf("format workspace image: %w", formatErr)
		}
	} else if kind := strings.TrimSpace(string(filesystem)); kind != "btrfs" {
		return fmt.Errorf("refusing workspace image with filesystem type %q; expected btrfs", kind)
	}
	if err := os.MkdirAll(config.MountPath, 0o755); err != nil {
		return fmt.Errorf("create workspace mountpoint: %w", err)
	}
	if source, mounted := volumeMountSource(ctx, config.Runner, config.MountPath); mounted {
		if !strings.Contains(source, filepath.Base(config.ImagePath)) && !strings.HasPrefix(source, "/dev/loop") {
			return fmt.Errorf("refusing workspace mountpoint already backed by %s", source)
		}
		return nil
	}
	if _, err := config.Runner.Run(ctx, "mount", "-o", "loop,discard,compress=zstd:3,noatime", config.ImagePath, config.MountPath); err != nil {
		return fmt.Errorf("mount workspace image: %w", err)
	}
	return nil
}

func InspectVolume(ctx context.Context, input VolumeConfig) (VolumeStatus, error) {
	config, err := validateVolumeConfig(input)
	if err != nil {
		return VolumeStatus{}, err
	}
	status := VolumeStatus{ImagePath: config.ImagePath, SizeBytes: config.SizeBytes, MountPath: config.MountPath}
	if info, err := os.Stat(config.ImagePath); err == nil {
		status.SizeBytes = info.Size()
	} else if !errors.Is(err, os.ErrNotExist) {
		return VolumeStatus{}, err
	}
	status.Source, status.Mounted = volumeMountSource(ctx, config.Runner, config.MountPath)
	return status, nil
}

func RequirePreparedVolume(ctx context.Context, input VolumeConfig) error {
	status, err := InspectVolume(ctx, input)
	if err != nil {
		return err
	}
	if !status.Mounted {
		return fmt.Errorf("workspace volume is not mounted at %s; run workspace prepare-v2", status.MountPath)
	}
	return nil
}
