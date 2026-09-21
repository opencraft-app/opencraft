package workspaces

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// PrepareTemplate materializes a clean OCI image as a read-only Btrfs
// subvolume. Docker is only an image builder/exporter; it is not the runtime.
func (d *LocalBtrfsDriver) PrepareTemplate(ctx context.Context, buildImage bool) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.prepareParents(); err != nil {
		return err
	}
	template := d.templatePath()
	if d.isSubvolume(ctx, template) {
		return nil
	}
	if buildImage {
		if d.config.DockerfilePath == "" {
			return errors.New("workspace Dockerfile is required when building the template image")
		}
		dockerfile, err := filepath.Abs(d.config.DockerfilePath)
		if err != nil {
			return fmt.Errorf("resolve workspace Dockerfile: %w", err)
		}
		if _, err := d.config.Runner.Run(ctx, d.config.DockerBinary, "build", "-t", d.config.ContainerImage,
			"-f", dockerfile, filepath.Dir(dockerfile)); err != nil {
			return fmt.Errorf("build workspace template image: %w", err)
		}
	}
	partial := filepath.Join(filepath.Dir(template), fmt.Sprintf(".%s.partial-%d", d.config.TemplateName, os.Getpid()))
	if d.isSubvolume(ctx, partial) {
		if err := d.deleteSubvolume(ctx, partial); err != nil {
			return fmt.Errorf("remove stale workspace template: %w", err)
		}
	}
	if _, err := d.config.Runner.Run(ctx, "btrfs", "subvolume", "create", partial); err != nil {
		return fmt.Errorf("create workspace template subvolume: %w", err)
	}
	keepPartial := false
	defer func() {
		if !keepPartial {
			_ = d.deleteSubvolume(context.Background(), partial)
		}
	}()
	containerName := fmt.Sprintf("hypernode-template-%d-%d", os.Getpid(), time.Now().UnixNano())
	createOutput, err := d.config.Runner.Run(ctx, d.config.DockerBinary, "create", "--name", containerName,
		d.config.ContainerImage, "/bin/true")
	if err != nil {
		return fmt.Errorf("create workspace template export container: %w", err)
	}
	containerID := strings.TrimSpace(string(createOutput))
	if containerID == "" {
		containerID = containerName
	}
	defer func() {
		_, _ = d.config.Runner.Run(context.Background(), d.config.DockerBinary, "rm", "-f", containerID)
	}()
	if err := exportContainerRootfs(ctx, d.config.DockerBinary, containerID, partial); err != nil {
		return err
	}
	for _, directory := range []string{
		filepath.Join(partial, "workspace"),
		filepath.Join(partial, "root"),
		filepath.Join(partial, "run"),
		filepath.Join(partial, "tmp"),
		filepath.Join(partial, "opt", "hypernode", "bin"),
		filepath.Join(partial, "opt", "hypernode", "policy"),
	} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return fmt.Errorf("initialize workspace template rootfs: %w", err)
		}
	}
	if err := shiftRootfsOwnership(partial, d.config.OwnerUIDBase); err != nil {
		return fmt.Errorf("shift workspace template ownership: %w", err)
	}
	if _, err := d.config.Runner.Run(ctx, "btrfs", "property", "set", "-ts", partial, "ro", "true"); err != nil {
		return fmt.Errorf("seal workspace template: %w", err)
	}
	if err := os.Rename(partial, template); err != nil {
		return fmt.Errorf("publish workspace template: %w", err)
	}
	keepPartial = true
	return nil
}

func shiftRootfsOwnership(root string, base int) error {
	type inodeKey struct {
		device uint64
		inode  uint64
	}
	shifted := make(map[inodeKey]struct{})
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		uid, gid := 0, 0
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			key := inodeKey{device: uint64(stat.Dev), inode: stat.Ino}
			if _, found := shifted[key]; found {
				// Docker exports hard-linked files as multiple directory entries.
				// Chowning the first name changes the shared inode, so treating a
				// later name as an unshifted UID would reject a valid rootfs.
				return nil
			}
			shifted[key] = struct{}{}
			uid = int(stat.Uid)
			gid = int(stat.Gid)
		}
		if uid < 0 || uid >= 65536 || gid < 0 || gid >= 65536 {
			return fmt.Errorf("rootfs ownership exceeds configured user namespace: %s uid=%d gid=%d", path, uid, gid)
		}
		return os.Lchown(path, base+uid, base+gid)
	})
}

func exportContainerRootfs(ctx context.Context, dockerBinary, containerID, destination string) error {
	exporter := exec.CommandContext(ctx, dockerBinary, "export", containerID)
	extractor := exec.CommandContext(ctx, "tar", "--numeric-owner", "-xpf", "-", "-C", destination)
	pipe, err := exporter.StdoutPipe()
	if err != nil {
		return fmt.Errorf("open Docker export stream: %w", err)
	}
	var exporterError bytes.Buffer
	var extractorError bytes.Buffer
	exporter.Stderr = &exporterError
	extractor.Stdin = pipe
	extractor.Stderr = &extractorError
	if err := extractor.Start(); err != nil {
		return fmt.Errorf("start rootfs extractor: %w", err)
	}
	if err := exporter.Start(); err != nil {
		_ = extractor.Process.Kill()
		_ = extractor.Wait()
		return fmt.Errorf("start Docker export: %w", err)
	}
	exportErr := exporter.Wait()
	extractErr := extractor.Wait()
	if exportErr != nil {
		return fmt.Errorf("export workspace rootfs: %w: %s", exportErr, strings.TrimSpace(exporterError.String()))
	}
	if extractErr != nil {
		return fmt.Errorf("extract workspace rootfs: %w: %s", extractErr, strings.TrimSpace(extractorError.String()))
	}
	return nil
}
