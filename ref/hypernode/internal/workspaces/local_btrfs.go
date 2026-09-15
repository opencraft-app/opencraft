package workspaces

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const LocalBtrfsDriverName = "local-runc-btrfs"

var localWorkspaceID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type CommandRunner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type DetachedCommandRunner interface {
	RunDetached(context.Context, string, string, ...string) ([]byte, error)
}

type ExecCommandRunner struct{}

func (ExecCommandRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	output, err := command.CombinedOutput()
	if err != nil {
		return output, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

func (ExecCommandRunner) RunDetached(ctx context.Context, logPath, name string, args ...string) ([]byte, error) {
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open detached command log: %w", err)
	}
	command := exec.CommandContext(ctx, name, args...)
	command.Stdout = logFile
	command.Stderr = logFile
	runErr := command.Run()
	closeErr := logFile.Close()
	output, readErr := os.ReadFile(logPath)
	if runErr != nil {
		return output, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), runErr, strings.TrimSpace(string(output)))
	}
	if closeErr != nil {
		return output, closeErr
	}
	if readErr != nil {
		return output, readErr
	}
	return output, nil
}

type LocalPaths struct {
	System string
	Data   string
}

// LocalRuntime is the execution half of the local driver. Storage snapshots
// do not need to understand OCI bundles; OCI does not need to understand the
// workspace catalog.
type LocalRuntime interface {
	Attach(context.Context, Ref, LocalPaths, AttachSpec) (Attachment, error)
	Detach(context.Context, Attachment) error
	Quiesce(context.Context, Ref) (resume func() error, err error)
	StopWorkspace(context.Context, Ref) error
}

type LocalBtrfsConfig struct {
	MountPath      string
	TemplateName   string
	ContainerImage string
	DockerfilePath string
	DockerBinary   string
	OwnerUIDBase   int
	Runner         CommandRunner
	Runtime        LocalRuntime
}

type LocalBtrfsDriver struct {
	config         LocalBtrfsConfig
	mu             sync.Mutex
	workspaceMu    sync.Mutex
	workspaceLocks map[string]*sync.Mutex
}

func NewLocalBtrfsDriver(config LocalBtrfsConfig) (*LocalBtrfsDriver, error) {
	if !filepath.IsAbs(config.MountPath) || filepath.Clean(config.MountPath) != config.MountPath {
		return nil, fmt.Errorf("local Btrfs mount path must be absolute and clean: %q", config.MountPath)
	}
	if config.TemplateName == "" {
		config.TemplateName = "ubuntu-24.04"
	}
	if config.ContainerImage == "" {
		config.ContainerImage = "hypernode/workspace:ubuntu-24.04"
	}
	if config.DockerBinary == "" {
		config.DockerBinary = "docker"
	}
	if config.OwnerUIDBase == 0 {
		config.OwnerUIDBase = 100000
	}
	if !localWorkspaceID.MatchString(config.TemplateName) {
		return nil, fmt.Errorf("invalid local workspace template name %q", config.TemplateName)
	}
	if config.Runner == nil {
		config.Runner = ExecCommandRunner{}
	}
	return &LocalBtrfsDriver{config: config, workspaceLocks: map[string]*sync.Mutex{}}, nil
}

func (d *LocalBtrfsDriver) Name() string { return LocalBtrfsDriverName }

func (d *LocalBtrfsDriver) Capabilities() Capabilities {
	return Capabilities{Fork: true, PersistentSystem: true, PersistentWorkspace: true}
}

// lockWorkspaces serializes lifecycle changes only for the workspaces they
// touch. Runtime attach can take seconds while runc starts and waits for its
// agent; a driver-wide lock made that unrelated delay block every fork on the
// node. Sorted acquisition keeps two-workspace fork operations deadlock-free.
func (d *LocalBtrfsDriver) lockWorkspaces(ids ...string) func() {
	unique := make(map[string]struct{}, len(ids))
	keys := make([]string, 0, len(ids))
	for _, id := range ids {
		if _, found := unique[id]; found {
			continue
		}
		unique[id] = struct{}{}
		keys = append(keys, id)
	}
	sort.Strings(keys)
	d.workspaceMu.Lock()
	locks := make([]*sync.Mutex, 0, len(keys))
	for _, key := range keys {
		lock := d.workspaceLocks[key]
		if lock == nil {
			lock = &sync.Mutex{}
			d.workspaceLocks[key] = lock
		}
		locks = append(locks, lock)
	}
	d.workspaceMu.Unlock()
	for _, lock := range locks {
		lock.Lock()
	}
	return func() {
		for index := len(locks) - 1; index >= 0; index-- {
			locks[index].Unlock()
		}
	}
}

func (d *LocalBtrfsDriver) templatePath() string {
	return filepath.Join(d.config.MountPath, ".workspaces", "templates", d.config.TemplateName)
}

func (d *LocalBtrfsDriver) TemplatePrepared(ctx context.Context) bool {
	return d.isSubvolume(ctx, d.templatePath())
}

func (d *LocalBtrfsDriver) paths(id string) (LocalPaths, error) {
	if !localWorkspaceID.MatchString(id) {
		return LocalPaths{}, fmt.Errorf("invalid local workspace id %q", id)
	}
	base := filepath.Join(d.config.MountPath, ".workspaces")
	return LocalPaths{
		System: filepath.Join(base, "systems", id),
		Data:   filepath.Join(base, "data", id),
	}, nil
}

func (d *LocalBtrfsDriver) prepareParents() error {
	for _, directory := range []string{
		filepath.Join(d.config.MountPath, ".workspaces", "templates"),
		filepath.Join(d.config.MountPath, ".workspaces", "systems"),
		filepath.Join(d.config.MountPath, ".workspaces", "data"),
		filepath.Join(d.config.MountPath, ".workspaces", "runtime"),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return fmt.Errorf("create local workspace directory %s: %w", directory, err)
		}
	}
	return nil
}

func (d *LocalBtrfsDriver) Create(ctx context.Context, spec CreateSpec) (Ref, error) {
	if spec.Driver != "" && spec.Driver != d.Name() {
		return Ref{}, fmt.Errorf("local driver cannot create %q", spec.Driver)
	}
	paths, err := d.paths(spec.ID)
	if err != nil {
		return Ref{}, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	unlock := d.lockWorkspaces(spec.ID)
	defer unlock()
	if err := d.prepareParents(); err != nil {
		return Ref{}, err
	}
	if !d.isSubvolume(ctx, d.templatePath()) {
		return Ref{}, fmt.Errorf("local system template is not prepared: %s", d.templatePath())
	}
	if d.isSubvolume(ctx, paths.System) || d.isSubvolume(ctx, paths.Data) {
		return Ref{}, fmt.Errorf("local workspace already exists: %s", spec.ID)
	}
	if _, err := d.config.Runner.Run(ctx, "btrfs", "subvolume", "snapshot", d.templatePath(), paths.System); err != nil {
		return Ref{}, fmt.Errorf("snapshot local system template: %w", err)
	}
	if _, err := d.config.Runner.Run(ctx, "btrfs", "subvolume", "create", paths.Data); err != nil {
		_ = d.deleteSubvolume(ctx, paths.System)
		return Ref{}, fmt.Errorf("create local workspace data: %w", err)
	}
	if err := d.initializeData(paths.Data); err != nil {
		_ = d.deleteSubvolume(ctx, paths.Data)
		_ = d.deleteSubvolume(ctx, paths.System)
		return Ref{}, err
	}
	return Ref{ID: spec.ID, Driver: d.Name()}, nil
}

func (d *LocalBtrfsDriver) Fork(ctx context.Context, source Ref, options ForkOptions) (Ref, error) {
	started := time.Now()
	if source.Driver != d.Name() {
		return Ref{}, fmt.Errorf("local driver cannot fork %s", source.Key())
	}
	sourcePaths, err := d.paths(source.ID)
	if err != nil {
		return Ref{}, err
	}
	destinationPaths, err := d.paths(options.ID)
	if err != nil {
		return Ref{}, err
	}
	unlock := d.lockWorkspaces(source.ID, options.ID)
	defer unlock()
	lockDuration := time.Since(started)
	if !d.isSubvolume(ctx, sourcePaths.System) || !d.isSubvolume(ctx, sourcePaths.Data) {
		return Ref{}, fmt.Errorf("source workspace does not exist: %s", source.Key())
	}
	if d.isSubvolume(ctx, destinationPaths.System) || d.isSubvolume(ctx, destinationPaths.Data) {
		return Ref{}, fmt.Errorf("destination workspace already exists: %s", options.ID)
	}
	resume := func() error { return nil }
	quiesceStarted := time.Now()
	if d.config.Runtime != nil {
		resume, err = d.config.Runtime.Quiesce(ctx, source)
		if err != nil {
			return Ref{}, fmt.Errorf("quiesce source workspace: %w", err)
		}
	}
	quiesceDuration := time.Since(quiesceStarted)
	defer func() { _ = resume() }()
	systemSnapshotStarted := time.Now()
	if _, err := d.config.Runner.Run(ctx, "btrfs", "subvolume", "snapshot", sourcePaths.System, destinationPaths.System); err != nil {
		return Ref{}, fmt.Errorf("snapshot workspace system: %w", err)
	}
	systemSnapshotDuration := time.Since(systemSnapshotStarted)
	dataSnapshotStarted := time.Now()
	if _, err := d.config.Runner.Run(ctx, "btrfs", "subvolume", "snapshot", sourcePaths.Data, destinationPaths.Data); err != nil {
		_ = d.deleteSubvolume(ctx, destinationPaths.System)
		return Ref{}, fmt.Errorf("snapshot workspace data: %w", err)
	}
	dataSnapshotDuration := time.Since(dataSnapshotStarted)
	resumeStarted := time.Now()
	if err := resume(); err != nil {
		_ = d.deleteSubvolume(ctx, destinationPaths.Data)
		_ = d.deleteSubvolume(ctx, destinationPaths.System)
		return Ref{}, fmt.Errorf("resume source workspace: %w", err)
	}
	resume = func() error { return nil }
	log.Printf(
		"btrfs fork timing source=%s destination=%s lock_ms=%d quiesce_ms=%d system_snapshot_ms=%d data_snapshot_ms=%d resume_ms=%d total_ms=%d",
		source.ID, options.ID, lockDuration.Milliseconds(), quiesceDuration.Milliseconds(),
		systemSnapshotDuration.Milliseconds(), dataSnapshotDuration.Milliseconds(),
		time.Since(resumeStarted).Milliseconds(), time.Since(started).Milliseconds(),
	)
	return Ref{ID: options.ID, Driver: d.Name()}, nil
}

func (d *LocalBtrfsDriver) Attach(ctx context.Context, ref Ref, spec AttachSpec) (Attachment, error) {
	if d.config.Runtime == nil {
		return Attachment{}, errors.New("local workspace runtime is not configured")
	}
	paths, err := d.paths(ref.ID)
	if err != nil {
		return Attachment{}, err
	}
	unlock := d.lockWorkspaces(ref.ID)
	defer unlock()
	if !d.isSubvolume(ctx, paths.System) || !d.isSubvolume(ctx, paths.Data) {
		return Attachment{}, fmt.Errorf("local workspace does not exist: %s", ref.Key())
	}
	return d.config.Runtime.Attach(ctx, ref, paths, spec)
}

func (d *LocalBtrfsDriver) Detach(ctx context.Context, attachment Attachment) error {
	if d.config.Runtime == nil {
		return nil
	}
	unlock := d.lockWorkspaces(attachment.Workspace.ID)
	defer unlock()
	return d.config.Runtime.Detach(ctx, attachment)
}

func (d *LocalBtrfsDriver) Delete(ctx context.Context, ref Ref) error {
	paths, err := d.paths(ref.ID)
	if err != nil {
		return err
	}
	unlock := d.lockWorkspaces(ref.ID)
	defer unlock()
	if d.config.Runtime != nil {
		if err := d.config.Runtime.StopWorkspace(ctx, ref); err != nil {
			return fmt.Errorf("stop local workspace: %w", err)
		}
	}
	if d.isSubvolume(ctx, paths.Data) {
		if err := d.deleteSubvolume(ctx, paths.Data); err != nil {
			return fmt.Errorf("delete workspace data: %w", err)
		}
	}
	if d.isSubvolume(ctx, paths.System) {
		if err := d.deleteSubvolume(ctx, paths.System); err != nil {
			return fmt.Errorf("delete workspace system: %w", err)
		}
	}
	return nil
}

func (d *LocalBtrfsDriver) Exists(ctx context.Context, ref Ref) (bool, error) {
	paths, err := d.paths(ref.ID)
	if err != nil {
		return false, err
	}
	unlock := d.lockWorkspaces(ref.ID)
	defer unlock()
	return d.isSubvolume(ctx, paths.System) && d.isSubvolume(ctx, paths.Data), nil
}

func (d *LocalBtrfsDriver) isSubvolume(ctx context.Context, path string) bool {
	_, err := d.config.Runner.Run(ctx, "btrfs", "subvolume", "show", path)
	return err == nil
}

func (d *LocalBtrfsDriver) deleteSubvolume(ctx context.Context, path string) error {
	_, err := d.config.Runner.Run(ctx, "btrfs", "subvolume", "delete", path)
	return err
}

func (d *LocalBtrfsDriver) initializeData(path string) error {
	for _, directory := range []string{
		filepath.Join(path, "projects"),
		filepath.Join(path, ".codex"),
		filepath.Join(path, ".codex", "attachments"),
		filepath.Join(path, ".hypernode"),
	} {
		if err := os.MkdirAll(directory, 0o770); err != nil {
			return fmt.Errorf("initialize workspace data: %w", err)
		}
		if err := os.Chown(directory, d.config.OwnerUIDBase, d.config.OwnerUIDBase); err != nil {
			return fmt.Errorf("assign workspace data ownership: %w", err)
		}
	}
	if err := os.Chown(path, d.config.OwnerUIDBase, d.config.OwnerUIDBase); err != nil {
		return fmt.Errorf("assign workspace root ownership: %w", err)
	}
	return nil
}
