package workspaces

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type volumeRunner struct {
	filesystem string
	probeErr   error
	calls      []string
}

func (r *volumeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, name+" "+strings.Join(args, " "))
	switch name {
	case "blkid":
		return []byte(r.filesystem), r.probeErr
	case "findmnt":
		return nil, errors.New("not mounted")
	default:
		return nil, nil
	}
}

func (r *volumeRunner) called(name string) bool {
	for _, call := range r.calls {
		if strings.HasPrefix(call, name+" ") {
			return true
		}
	}
	return false
}

func TestPrepareVolumeFormatsOnlyANewEmptyImage(t *testing.T) {
	runner := &volumeRunner{probeErr: errors.New("no filesystem")}
	root := t.TempDir()
	image := filepath.Join(root, "workspace.img")
	err := PrepareVolume(context.Background(), VolumeConfig{
		ImagePath: image,
		SizeBytes: 1024 * 1024 * 1024,
		MountPath: filepath.Join(root, "mount"),
		Runner:    runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !runner.called("mkfs.btrfs") || !runner.called("mount") {
		t.Fatalf("new image was not formatted and mounted: %#v", runner.calls)
	}
}

func TestPrepareVolumeRefusesToFormatAnExistingUnrecognizedImage(t *testing.T) {
	runner := &volumeRunner{probeErr: errors.New("corrupt or unknown filesystem")}
	root := t.TempDir()
	image := filepath.Join(root, "workspace.img")
	if err := os.WriteFile(image, []byte("existing-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := PrepareVolume(context.Background(), VolumeConfig{
		ImagePath: image,
		SizeBytes: 1024 * 1024 * 1024,
		MountPath: filepath.Join(root, "mount"),
		Runner:    runner,
	})
	if err == nil || !strings.Contains(err.Error(), "refusing to format existing workspace image") {
		t.Fatalf("existing unrecognized image was not rejected: %v", err)
	}
	if runner.called("mkfs.btrfs") {
		t.Fatalf("existing image was formatted: %#v", runner.calls)
	}
}

func TestPrepareVolumeRejectsANonBtrfsFilesystem(t *testing.T) {
	runner := &volumeRunner{filesystem: "ext4\n"}
	root := t.TempDir()
	image := filepath.Join(root, "workspace.img")
	if err := os.WriteFile(image, []byte("existing-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := PrepareVolume(context.Background(), VolumeConfig{
		ImagePath: image,
		SizeBytes: 1024 * 1024 * 1024,
		MountPath: filepath.Join(root, "mount"),
		Runner:    runner,
	})
	if err == nil || !strings.Contains(err.Error(), "filesystem type \"ext4\"") {
		t.Fatalf("non-Btrfs image was not rejected: %v", err)
	}
	if runner.called("mount") {
		t.Fatalf("non-Btrfs image was mounted: %#v", runner.calls)
	}
}
