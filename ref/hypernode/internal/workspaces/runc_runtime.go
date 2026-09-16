package workspaces

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

type AttachmentSourceResolver func(Principal) (string, error)

type RuncRuntimeConfig struct {
	RuntimeRoot              string
	RuncBinary               string
	AgentBinary              string
	AgentPolicy              string
	HostResolvConf           string
	HostHostsFile            string
	UIDBase                  int
	AttachmentSourceResolver AttachmentSourceResolver
	PrincipalHomeResolver    AttachmentSourceResolver
	Runner                   CommandRunner
}

type runcAttachment struct {
	attachment Attachment
	container  string
	bundle     string
	workspace  Ref
	paused     bool
}

type runcBundlePaths struct {
	bundle        string
	rootfs        string
	workspace     string
	attachments   string
	principalHome string
	principalUID  int
	principalGID  int
}

func (p runcBundlePaths) principalRuntimeHome() string {
	if p.principalHome == "" {
		return ""
	}
	return filepath.Join(p.bundle, "principal-home")
}

type runcListEntry struct {
	ID     string `json:"id"`
	Bundle string `json:"bundle"`
}

// RuncRuntime composes one persistent SystemView and one persistent DataView
// at attach time. Principal state is mounted only at deterministic private and
// Codex aliases; the users-root directory itself is never exposed or listable.
type RuncRuntime struct {
	config      RuncRuntimeConfig
	mu          sync.Mutex
	principalMu sync.Mutex
	attachments map[string]*runcAttachment
	instanceID  string
	ownerLock   *os.File
	closed      bool
}

func NewRuncRuntime(config RuncRuntimeConfig) (*RuncRuntime, error) {
	for label, value := range map[string]string{
		"runtime root": config.RuntimeRoot,
		"agent binary": config.AgentBinary,
		"agent policy": config.AgentPolicy,
	} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return nil, fmt.Errorf("runc %s must be absolute and clean: %q", label, value)
		}
	}
	if config.RuncBinary == "" {
		config.RuncBinary = "runc"
	}
	if config.UIDBase == 0 {
		config.UIDBase = 100000
	}
	if config.HostResolvConf == "" {
		config.HostResolvConf = "/etc/resolv.conf"
	}
	if config.HostHostsFile == "" {
		config.HostHostsFile = "/etc/hosts"
	}
	for label, value := range map[string]string{
		"host resolv.conf": config.HostResolvConf,
		"host hosts file":  config.HostHostsFile,
	} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return nil, fmt.Errorf("runc %s must be absolute and clean: %q", label, value)
		}
	}
	if config.Runner == nil {
		config.Runner = ExecCommandRunner{}
	}
	if err := os.MkdirAll(config.RuntimeRoot, 0o711); err != nil {
		return nil, fmt.Errorf("create runc runtime root: %w", err)
	}
	ownerLock, err := os.OpenFile(filepath.Join(config.RuntimeRoot, ".owner.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open runc runtime owner lock: %w", err)
	}
	if err := syscall.Flock(int(ownerLock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = ownerLock.Close()
		return nil, fmt.Errorf("runc runtime root is already owned by another HyperNode instance: %w", err)
	}
	instanceID, err := randomID()
	if err != nil {
		_ = syscall.Flock(int(ownerLock.Fd()), syscall.LOCK_UN)
		_ = ownerLock.Close()
		return nil, err
	}
	return &RuncRuntime{
		config: config, attachments: map[string]*runcAttachment{},
		instanceID: instanceID, ownerLock: ownerLock,
	}, nil
}

// ReconcileRuntimeRoot fences containers left by an earlier HyperNode process.
// Runtime attachment ownership is intentionally in-memory, so after a process
// restart every container under this exclusive runtime root is stale. Leaving
// one alive can retain a Codex rollout writer lease even though the new policy
// runtime has no registry record for it.
func (r *RuncRuntime) ReconcileRuntimeRoot(ctx context.Context) error {
	output, err := r.config.Runner.Run(ctx, r.config.RuncBinary, "list", "--format", "json")
	if err != nil {
		return fmt.Errorf("list stale workspace runtimes: %w", err)
	}
	var entries []runcListEntry
	if err := json.Unmarshal(output, &entries); err != nil {
		return fmt.Errorf("decode stale workspace runtimes: %w", err)
	}
	var result error
	removed := 0
	for _, entry := range entries {
		bundle := filepath.Clean(entry.Bundle)
		id := strings.TrimPrefix(entry.ID, "hypernode-")
		if id == entry.ID || !localWorkspaceID.MatchString(id) ||
			filepath.Dir(bundle) != r.config.RuntimeRoot || filepath.Base(bundle) != id {
			continue
		}
		if r.bundleInstanceID(bundle) == r.instanceID {
			continue
		}
		_, _ = r.config.Runner.Run(ctx, r.config.RuncBinary, "kill", entry.ID, "KILL")
		if _, err := r.config.Runner.Run(ctx, r.config.RuncBinary, "delete", "--force", entry.ID); err != nil {
			result = errors.Join(result, fmt.Errorf("delete stale workspace runtime %s: %w", entry.ID, err))
			continue
		}
		if err := r.cleanupBundle(ctx, runcBundlePaths{
			bundle: bundle, attachments: filepath.Join(bundle, "attachments"),
		}); err != nil {
			result = errors.Join(result, fmt.Errorf("clean stale workspace bundle %s: %w", bundle, err))
			continue
		}
		removed++
	}
	if removed > 0 {
		log.Printf("workspace runtime cleanup removed_orphans=%d runtime_root=%s", removed, r.config.RuntimeRoot)
	}
	return result
}

func (r *RuncRuntime) bundleInstanceID(bundle string) string {
	encoded, err := os.ReadFile(filepath.Join(bundle, "config.json"))
	if err != nil {
		return ""
	}
	var configuration struct {
		Annotations map[string]string `json:"annotations"`
	}
	if json.Unmarshal(encoded, &configuration) != nil {
		return ""
	}
	return configuration.Annotations["io.hypernode.runtime.instance"]
}

// Close terminates every attachment owned by this process before releasing the
// runtime-root lease. Process crashes still skip this path, which is why the
// next owner must also reconcile before serving traffic.
func (r *RuncRuntime) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	records := make([]*runcAttachment, 0, len(r.attachments))
	for _, record := range r.attachments {
		records = append(records, record)
	}
	r.attachments = map[string]*runcAttachment{}
	ownerLock := r.ownerLock
	r.ownerLock = nil
	r.mu.Unlock()

	var result error
	for _, record := range records {
		_, _ = r.config.Runner.Run(context.Background(), r.config.RuncBinary, "kill", record.container, "TERM")
		if _, err := r.config.Runner.Run(context.Background(), r.config.RuncBinary, "delete", "--force", record.container); err != nil {
			result = errors.Join(result, err)
		}
		result = errors.Join(result, r.cleanupBundle(context.Background(), runcBundlePaths{
			bundle: record.bundle, attachments: filepath.Join(record.bundle, "attachments"),
		}))
	}
	if ownerLock != nil {
		result = errors.Join(result, syscall.Flock(int(ownerLock.Fd()), syscall.LOCK_UN))
		result = errors.Join(result, ownerLock.Close())
	}
	return result
}

func (r *RuncRuntime) Attach(ctx context.Context, ref Ref, paths LocalPaths, spec AttachSpec) (Attachment, error) {
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return Attachment{}, errors.New("runc runtime is closed")
	}
	if spec.Principal.ID == "" {
		return Attachment{}, errors.New("workspace attachment principal is required")
	}
	if spec.Mode == "" {
		spec.Mode = ModeReadWrite
	}
	if spec.Mode != ModeReadOnly && spec.Mode != ModeReadWrite {
		return Attachment{}, fmt.Errorf("unsupported workspace attachment mode %q", spec.Mode)
	}
	id, err := randomID()
	if err != nil {
		return Attachment{}, err
	}
	container := "hypernode-" + id
	bundle := filepath.Join(r.config.RuntimeRoot, id)
	bundlePaths := runcBundlePaths{
		bundle: bundle, rootfs: paths.System, workspace: paths.Data,
		attachments: filepath.Join(bundle, "attachments"),
	}
	if r.config.PrincipalHomeResolver != nil {
		home, resolveErr := r.config.PrincipalHomeResolver(spec.Principal)
		if resolveErr != nil {
			return Attachment{}, fmt.Errorf("resolve principal home: %w", resolveErr)
		}
		if info, statErr := os.Stat(home); statErr == nil {
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok {
				return Attachment{}, fmt.Errorf("principal home has no unix ownership: %s", home)
			}
			bundlePaths.principalHome = home
			bundlePaths.principalUID = int(stat.Uid)
			bundlePaths.principalGID = int(stat.Gid)
		} else if !os.IsNotExist(statErr) {
			return Attachment{}, fmt.Errorf("inspect principal home: %w", statErr)
		}
	}
	if err := r.normalizePrincipalHomeOwnership(bundlePaths); err != nil {
		return Attachment{}, err
	}
	if err := r.prepareBundle(bundlePaths); err != nil {
		return Attachment{}, fmt.Errorf("create runc attachment bundle: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = r.cleanupBundle(context.Background(), bundlePaths)
		}
	}()
	if r.config.AttachmentSourceResolver != nil {
		source, err := r.config.AttachmentSourceResolver(spec.Principal)
		if err != nil {
			return Attachment{}, fmt.Errorf("resolve principal attachment source: %w", err)
		}
		if source != "" {
			if err := copyAttachmentTree(source, bundlePaths.attachments, r.config.UIDBase); err != nil {
				return Attachment{}, fmt.Errorf("stage principal attachments: %w", err)
			}
		}
	}
	if err := r.bindPrincipalHome(ctx, bundlePaths); err != nil {
		return Attachment{}, err
	}
	if err := r.bindWorkspacePaths(ctx, paths, bundlePaths); err != nil {
		return Attachment{}, err
	}
	port, err := reservePort()
	if err != nil {
		return Attachment{}, err
	}
	configuration := r.ociConfiguration(bundlePaths, port, spec.Mode)
	encoded, err := json.MarshalIndent(configuration, "", "  ")
	if err != nil {
		return Attachment{}, err
	}
	if err := os.WriteFile(filepath.Join(bundle, "config.json"), append(encoded, '\n'), 0o600); err != nil {
		return Attachment{}, fmt.Errorf("write runc config: %w", err)
	}
	if _, err := r.runDetached(ctx, filepath.Join(bundle, "runtime.log"), r.config.RuncBinary, "run", "--detach", "--bundle", bundle,
		"--pid-file", filepath.Join(bundle, "pid"), container); err != nil {
		return Attachment{}, fmt.Errorf("start attached workspace runtime: %w", err)
	}
	if err := waitForTCP(ctx, fmt.Sprintf("127.0.0.1:%d", port)); err != nil {
		_, _ = r.config.Runner.Run(context.Background(), r.config.RuncBinary, "delete", "--force", container)
		return Attachment{}, fmt.Errorf("wait for workspace agent: %w", err)
	}
	attachment := Attachment{
		ID: id, Workspace: ref,
		Endpoint: Endpoint{Transport: "ssh", Host: "127.0.0.1", Port: port, Username: "root", Subsystem: "hypernode-fs@v1"},
	}
	r.mu.Lock()
	r.attachments[id] = &runcAttachment{attachment: attachment, container: container, bundle: bundle, workspace: ref}
	r.mu.Unlock()
	cleanup = false
	return attachment, nil
}

const principalHomeIDMapMarker = ".hypernode-idmap-owner-v1"

// normalizePrincipalHomeOwnership migrates files created by the legacy direct
// bind. In that layout, container root was mapped to UIDBase and could leave a
// mixed principal/UIDBase tree behind. An idmapped mount cannot map both host
// owners to the same container root, so convert only IDs from the old runtime
// range back to the durable principal before creating the idmapped mount.
func (r *RuncRuntime) normalizePrincipalHomeOwnership(paths runcBundlePaths) error {
	if paths.principalHome == "" {
		return nil
	}
	r.principalMu.Lock()
	defer r.principalMu.Unlock()

	marker := filepath.Join(paths.principalHome, principalHomeIDMapMarker)
	markerValue := fmt.Sprintf(
		"v1 uidbase=%d principal=%d:%d\n",
		r.config.UIDBase, paths.principalUID, paths.principalGID,
	)
	if encoded, err := os.ReadFile(marker); err == nil && string(encoded) == markerValue {
		if info, statErr := os.Lstat(marker); statErr == nil {
			if stat, ok := info.Sys().(*syscall.Stat_t); ok &&
				int(stat.Uid) == paths.principalUID && int(stat.Gid) == paths.principalGID {
				return nil
			}
		}
	}

	upper := r.config.UIDBase + 65536
	if err := filepath.Walk(paths.principalHome, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return fmt.Errorf("principal home entry has no unix ownership: %s", path)
		}
		uid, gid := -1, -1
		if int(stat.Uid) >= r.config.UIDBase && int(stat.Uid) < upper {
			uid = paths.principalUID
		}
		if int(stat.Gid) >= r.config.UIDBase && int(stat.Gid) < upper {
			gid = paths.principalGID
		}
		if uid == -1 && gid == -1 {
			return nil
		}
		return os.Lchown(path, uid, gid)
	}); err != nil {
		return fmt.Errorf("normalize principal home ownership %s: %w", paths.principalHome, err)
	}

	temporaryMarker := marker + ".tmp"
	if err := os.WriteFile(temporaryMarker, []byte(markerValue), 0o600); err != nil {
		return fmt.Errorf("write principal home ownership marker: %w", err)
	}
	if err := os.Chown(temporaryMarker, paths.principalUID, paths.principalGID); err != nil {
		_ = os.Remove(temporaryMarker)
		return fmt.Errorf("assign principal home ownership marker: %w", err)
	}
	if err := os.Rename(temporaryMarker, marker); err != nil {
		_ = os.Remove(temporaryMarker)
		return fmt.Errorf("commit principal home ownership marker: %w", err)
	}
	return nil
}

func (r *RuncRuntime) runDetached(ctx context.Context, logPath, name string, args ...string) ([]byte, error) {
	if runner, ok := r.config.Runner.(DetachedCommandRunner); ok {
		return runner.RunDetached(ctx, logPath, name, args...)
	}
	// Deterministic test runners complete synchronously and do not leave a child
	// process holding their output stream.
	return r.config.Runner.Run(ctx, name, args...)
}

func (r *RuncRuntime) Detach(ctx context.Context, attachment Attachment) error {
	r.mu.Lock()
	record := r.attachments[attachment.ID]
	if record != nil {
		delete(r.attachments, attachment.ID)
	}
	r.mu.Unlock()
	if record == nil {
		return nil
	}
	_, _ = r.config.Runner.Run(ctx, r.config.RuncBinary, "kill", record.container, "TERM")
	_, deleteErr := r.config.Runner.Run(ctx, r.config.RuncBinary, "delete", "--force", record.container)
	cleanupErr := r.cleanupBundle(ctx, runcBundlePaths{
		bundle: record.bundle, attachments: filepath.Join(record.bundle, "attachments"),
	})
	return errors.Join(deleteErr, cleanupErr)
}

func (r *RuncRuntime) Quiesce(ctx context.Context, ref Ref) (func() error, error) {
	records := r.recordsForWorkspace(ref)
	paused := make([]*runcAttachment, 0, len(records))
	for _, record := range records {
		if _, err := r.config.Runner.Run(ctx, r.config.RuncBinary, "pause", record.container); err != nil {
			for _, previous := range paused {
				_, _ = r.config.Runner.Run(context.Background(), r.config.RuncBinary, "resume", previous.container)
			}
			return nil, err
		}
		record.paused = true
		paused = append(paused, record)
	}
	var once sync.Once
	var resumeErr error
	return func() error {
		once.Do(func() {
			for _, record := range paused {
				if _, err := r.config.Runner.Run(context.Background(), r.config.RuncBinary, "resume", record.container); err != nil && resumeErr == nil {
					resumeErr = err
				}
				record.paused = false
			}
		})
		return resumeErr
	}, nil
}

func (r *RuncRuntime) StopWorkspace(ctx context.Context, ref Ref) error {
	var first error
	for _, record := range r.recordsForWorkspace(ref) {
		if err := r.Detach(ctx, record.attachment); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (r *RuncRuntime) recordsForWorkspace(ref Ref) []*runcAttachment {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]*runcAttachment, 0)
	for _, record := range r.attachments {
		if record.workspace == ref {
			result = append(result, record)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].attachment.ID < result[j].attachment.ID })
	return result
}

func (r *RuncRuntime) ociConfiguration(paths runcBundlePaths, port int, mode Mode) map[string]any {
	capabilities := []string{
		"CAP_AUDIT_WRITE", "CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL",
		"CAP_MKNOD", "CAP_NET_BIND_SERVICE", "CAP_NET_RAW", "CAP_SETFCAP", "CAP_SETGID", "CAP_SETPCAP",
		"CAP_SETUID", "CAP_SYS_CHROOT",
	}
	dataOptions := []string{"rbind", "rw", "nosuid", "nodev"}
	if mode == ModeReadOnly {
		dataOptions[1] = "ro"
	}
	mounts := []map[string]any{
		{"destination": "/proc", "type": "proc", "source": "proc"},
		{"destination": "/etc/resolv.conf", "type": "none", "source": r.config.HostResolvConf, "options": []string{"bind", "ro", "nosuid", "nodev", "noexec"}},
		{"destination": "/etc/hosts", "type": "none", "source": r.config.HostHostsFile, "options": []string{"bind", "ro", "nosuid", "nodev", "noexec"}},
		{"destination": "/run", "type": "tmpfs", "source": "tmpfs", "options": []string{"nosuid", "nodev", "mode=755", "size=65536k"}},
		{"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": []string{"nosuid", "strictatime", "mode=755", "size=65536k"}},
		{"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": []string{"nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"}},
		{"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": []string{"nosuid", "noexec", "nodev", "mode=1777", "size=65536k"}},
		{"destination": "/workspace", "type": "none", "source": paths.workspace, "options": dataOptions},
		{"destination": "/opt/hypernode/bin/hypernode", "type": "none", "source": r.config.AgentBinary, "options": []string{"bind", "ro", "nosuid", "nodev"}},
		{"destination": "/opt/hypernode/policy/workspace-agent.js", "type": "none", "source": r.config.AgentPolicy, "options": []string{"bind", "ro", "nosuid", "nodev", "noexec"}},
	}
	uidMappings := []map[string]int{{"containerID": 0, "hostID": r.config.UIDBase, "size": 65536}}
	gidMappings := []map[string]int{{"containerID": 0, "hostID": r.config.UIDBase, "size": 65536}}
	if paths.principalHome != "" {
		principalRuntimeHome := paths.principalRuntimeHome()
		mounts = append(mounts,
			map[string]any{
				"destination": "/run/hypernode-users/" + filepath.Base(paths.principalHome),
				"type":        "none", "source": principalRuntimeHome,
				"options": []string{"rbind", "rw", "nosuid", "nodev"},
			},
			map[string]any{
				"destination": "/workspace/.codex",
				"type":        "none", "source": filepath.Join(principalRuntimeHome, ".codex"),
				"options": []string{"rbind", "rw", "nosuid", "nodev"},
			},
		)
	}
	// Keep the staged attachment capability read-only even when its parent
	// Codex directory is the principal's writable account mount. Parent mounts
	// must precede nested mounts in the OCI list.
	mounts = append(mounts, map[string]any{
		"destination": "/workspace/.codex/attachments", "type": "none", "source": paths.attachments,
		"options": []string{"rbind", "ro", "nosuid", "nodev", "noexec"},
	})
	return map[string]any{
		"ociVersion": "1.1.0",
		"annotations": map[string]string{
			"io.hypernode.runtime.instance": r.instanceID,
		},
		"root":     map[string]any{"path": paths.rootfs, "readonly": false},
		"hostname": "hypernode-workspace",
		"process": map[string]any{
			"terminal": false,
			"user":     map[string]any{"uid": 0, "gid": 0},
			"args": []string{"/opt/hypernode/bin/hypernode", "workspace-agent", "--listen", fmt.Sprintf("127.0.0.1:%d", port),
				"--root", "/workspace", "--policy", "/opt/hypernode/policy/workspace-agent.js", "--db", "/run/hypernode-workspace-agent.sqlite"},
			"env":             []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "USER=root", "LOGNAME=root", "HYPERNODE_FS_SUBSYSTEM=hypernode-fs@v1"},
			"cwd":             "/workspace/projects",
			"capabilities":    map[string]any{"bounding": capabilities, "effective": capabilities, "permitted": capabilities, "ambient": capabilities},
			"noNewPrivileges": false,
		},
		"mounts": mounts,
		"linux": map[string]any{
			"namespaces":    []map[string]string{{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}, {"type": "user"}},
			"uidMappings":   uidMappings,
			"gidMappings":   gidMappings,
			"maskedPaths":   []string{"/proc/acpi", "/proc/asound", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug", "/sys/firmware", "/sys/devices/virtual/powercap"},
			"readonlyPaths": []string{"/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"},
		},
	}
}

func (r *RuncRuntime) prepareBundle(paths runcBundlePaths) error {
	if err := os.MkdirAll(r.config.RuntimeRoot, 0o711); err != nil {
		return err
	}
	if err := os.Chmod(r.config.RuntimeRoot, 0o711); err != nil {
		return err
	}
	if err := os.MkdirAll(paths.bundle, 0o711); err != nil {
		return err
	}
	if err := os.Chmod(paths.bundle, 0o711); err != nil {
		return err
	}
	directories := []string{paths.attachments}
	if principalRuntimeHome := paths.principalRuntimeHome(); principalRuntimeHome != "" {
		directories = append(directories, principalRuntimeHome)
	}
	for _, directory := range directories {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
	}
	return os.Chown(paths.attachments, r.config.UIDBase, r.config.UIDBase)
}

// bindPrincipalHome presents the selected principal's durable home to runc
// through an idmapped bind mount. The files keep their principal UID/GID on
// the host, while the outer workspace user namespace sees them as its root
// UID/GID. Codex can therefore create a nested bwrap user namespace without
// losing traversal access to /workspace/.codex. Mounting only the selected
// principal home preserves the existing cross-principal isolation boundary.
func (r *RuncRuntime) bindPrincipalHome(ctx context.Context, paths runcBundlePaths) error {
	target := paths.principalRuntimeHome()
	if target == "" {
		return nil
	}
	if paths.principalUID <= 0 || paths.principalGID <= 0 {
		return fmt.Errorf("principal home requires positive UID/GID: %s", paths.principalHome)
	}
	idmap := fmt.Sprintf(
		"X-mount.idmap=u:%d:%d:1 g:%d:%d:1",
		paths.principalUID, r.config.UIDBase,
		paths.principalGID, r.config.UIDBase,
	)
	if _, err := r.config.Runner.Run(ctx, "mount", "--bind", "-o", idmap, paths.principalHome, target); err != nil {
		return fmt.Errorf("idmap principal home %s: %w", paths.principalHome, err)
	}
	if _, directRunner := r.config.Runner.(ExecCommandRunner); directRunner {
		info, err := os.Stat(target)
		if err != nil {
			return fmt.Errorf("inspect idmapped principal home %s: %w", target, err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return fmt.Errorf("idmapped principal home has no unix ownership: %s", target)
		}
		if int(stat.Uid) != r.config.UIDBase || int(stat.Gid) != r.config.UIDBase {
			return fmt.Errorf(
				"idmapped principal home has ownership %d:%d, expected %d:%d",
				stat.Uid, stat.Gid, r.config.UIDBase, r.config.UIDBase,
			)
		}
	}
	return nil
}

// bindWorkspacePaths grants the mapped container root the minimum host-side
// capability needed by runc: traverse-only access through private catalog
// ancestors. It cannot list those directories, and after pivot_root the catalog
// namespace is not present inside the container. Pre-bind mounting rootfs into
// /run is intentionally avoided: an inherited bind mount is locked to the
// parent user namespace and cannot be rebound by runc's child user namespace.
func (r *RuncRuntime) bindWorkspacePaths(ctx context.Context, source LocalPaths, target runcBundlePaths) error {
	for _, directory := range []string{
		filepath.Join(source.Data, ".codex"),
		filepath.Join(source.Data, ".codex", "attachments"),
	} {
		if err := os.MkdirAll(directory, 0o770); err != nil {
			return fmt.Errorf("prepare workspace metadata directory %s: %w", directory, err)
		}
		if err := os.Chown(directory, r.config.UIDBase, r.config.UIDBase); err != nil {
			return fmt.Errorf("assign workspace metadata ownership %s: %w", directory, err)
		}
	}
	acl := fmt.Sprintf("u:%d:--x", r.config.UIDBase)
	seen := map[string]struct{}{}
	for _, selected := range []string{source.System, source.Data} {
		for directory := filepath.Dir(selected); directory != string(filepath.Separator); directory = filepath.Dir(directory) {
			if _, exists := seen[directory]; exists {
				continue
			}
			seen[directory] = struct{}{}
			info, err := os.Stat(directory)
			if err != nil {
				return fmt.Errorf("inspect workspace catalog ancestor %s: %w", directory, err)
			}
			if info.Mode().Perm()&0o001 != 0 {
				continue
			}
			if _, err := r.config.Runner.Run(ctx, "setfacl", "-m", acl, directory); err != nil {
				return fmt.Errorf("grant mapped root traversal for %s: %w", directory, err)
			}
		}
	}
	return nil
}

func (r *RuncRuntime) cleanupBundle(ctx context.Context, paths runcBundlePaths) error {
	var result error
	principalRuntimeHome := filepath.Join(paths.bundle, "principal-home")
	if err := syscall.Unmount(principalRuntimeHome, syscall.MNT_DETACH); err != nil &&
		!errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOENT) {
		result = errors.Join(result, fmt.Errorf("unmount principal home %s: %w", principalRuntimeHome, err))
	}
	if err := os.RemoveAll(paths.bundle); err != nil {
		result = errors.Join(result, err)
	}
	return result
}

func reservePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("reserve workspace agent port: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		return 0, err
	}
	return port, nil
}

func waitForTCP(ctx context.Context, address string) error {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		connection, err := (&net.Dialer{Timeout: 100 * time.Millisecond}).DialContext(ctx, "tcp", address)
		if err == nil {
			_ = connection.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func copyAttachmentTree(source, destination string, owner int) error {
	clean, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	info, err := os.Stat(clean)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("attachment source is not a directory: %s", clean)
	}
	return filepath.WalkDir(clean, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(clean, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("attachment symlinks are not permitted: %s", path)
		}
		if entry.IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			return os.Chown(target, owner, owner)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			_ = input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
		inputCloseErr := input.Close()
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		if inputCloseErr != nil {
			return inputCloseErr
		}
		if closeErr != nil {
			return closeErr
		}
		return os.Chown(target, owner, owner)
	})
}

func (r *RuncRuntime) Snapshot() []Attachment {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]Attachment, 0, len(r.attachments))
	for _, record := range r.attachments {
		result = append(result, record.attachment)
	}
	sort.Slice(result, func(i, j int) bool { return strings.Compare(result[i].ID, result[j].ID) < 0 })
	return result
}
