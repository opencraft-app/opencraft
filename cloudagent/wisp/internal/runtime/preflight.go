package runtime

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

func (r *Runtime) preflightBootstrap() error {
	var failures []string

	r.log("preflight check=start require_commands commands=mke2fs,e2fsck")
	if err := requireCommands("mke2fs", "e2fsck"); err != nil {
		failures = append(failures, err.Error())
	}
	r.log("preflight check=done require_commands failures=%d", len(failures))

	r.log("preflight check=start overlayfs")
	if ok, err := kernelFilesystemAvailable("overlay"); err != nil {
		failures = append(failures, fmt.Sprintf("check overlayfs support: %v", err))
	} else if !ok {
		failures = append(failures, "overlayfs is unavailable")
	}
	r.log("preflight check=done overlayfs failures=%d", len(failures))

	r.log("preflight check=start cgroup_v2")
	if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err != nil {
		failures = append(failures, "cgroup v2 is unavailable")
	}
	r.log("preflight check=done cgroup_v2 failures=%d", len(failures))

	r.log("preflight check=start loop_device")
	if ok, err := kernelDeviceAvailable("loop"); err != nil {
		failures = append(failures, fmt.Sprintf("check loop device support: %v", err))
	} else if !ok {
		failures = append(failures, "loop device support is unavailable")
	}
	r.log("preflight check=done loop_device failures=%d", len(failures))

	for _, dir := range bootstrapWritableDirs(r.cfg) {
		r.log("preflight check=start writable_dir path=%s", dir)
		if err := ensureWritableDir(dir); err != nil {
			failures = append(failures, fmt.Sprintf("writable dir %s: %v", dir, err))
		}
		r.log("preflight check=done writable_dir path=%s failures=%d", dir, len(failures))
	}

	if len(failures) == 0 {
		r.log("preflight result=ok")
		return nil
	}
	r.log("preflight result=fail count=%d", len(failures))
	return fmt.Errorf("bootstrap preflight failed: %s", strings.Join(failures, "; "))
}

func bootstrapWritableDirs(cfg interface{ GetTempRoot() string; GetRuntimeRoot() string; GetAdminRoot() string }) []string {
	dirs := []string{
		filepath.Dir(cfg.GetTempRoot()),
		filepath.Dir(cfg.GetRuntimeRoot()),
		filepath.Dir(cfg.GetAdminRoot()),
	}
	seen := make(map[string]struct{}, len(dirs))
	out := make([]string, 0, len(dirs))
	for _, dir := range dirs {
		dir = filepath.Clean(strings.TrimSpace(dir))
		if dir == "" || dir == "." || dir == "/" {
			continue
		}
		if _, ok := seen[dir]; ok {
			continue
		}
		seen[dir] = struct{}{}
		out = append(out, dir)
	}
	slices.Sort(out)
	return out
}

func ensureWritableDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".wisp-preflight-*")
	if err != nil {
		return err
	}
	name := f.Name()
	if err := f.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	return os.Remove(name)
}

func kernelFilesystemAvailable(name string) (bool, error) {
	data, err := os.ReadFile("/proc/filesystems")
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if fields[len(fields)-1] == name {
			return true, nil
		}
	}
	return false, nil
}

func kernelDeviceAvailable(name string) (bool, error) {
	data, err := os.ReadFile("/proc/devices")
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == name {
			return true, nil
		}
	}
	return false, nil
}
