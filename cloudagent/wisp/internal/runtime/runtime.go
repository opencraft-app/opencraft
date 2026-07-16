package runtime

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"golang.org/x/sys/unix"
	"wisp/internal/config"
	"wisp/internal/smh"
)

type Runtime struct {
	cfg config.Config
}

type ExecCommandResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

type CheckpointMetadata struct {
	ID        string `json:"id"`
	CreatedAt string `json:"created_at,omitempty"`
	Source    string `json:"source,omitempty"`
	Format    string `json:"format,omitempty"`
	Backend   string `json:"backend,omitempty"`
	Class     string `json:"class,omitempty"`
	Trigger   string `json:"trigger,omitempty"`
	Sequence  int64  `json:"sequence,omitempty"`
	State     string `json:"state,omitempty"`
	Cut       string `json:"cut,omitempty"`
}

type StopOptions struct {
	Force bool
}

const (
	checkpointClassManual = "manual"
	checkpointClassSystem = "system"

	checkpointTriggerManual       = "manual"
	checkpointTriggerGracefulStop = "graceful_stop"

	checkpointStateCommitted = "committed"

	defaultSystemCheckpointRetention = 3
)

const loopClrFD = 0x4C01
const blkFlsBuf = 0x1261

var runtimeTracer = otel.Tracer("wisp/runtime")

func New(cfg config.Config) *Runtime {
	return &Runtime{cfg: cfg}
}

func (r *Runtime) Bootstrap(ctx context.Context) error {
	ctx, span := r.startSpan(ctx, "runtime.bootstrap")
	defer span.End()
	startedAt := time.Now()
	var ensureCOSDur, ensureDirsDur, ensureLowerDur, ensureImgDur time.Duration
	if err := requireRoot(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("bootstrap step=start preflight")
	if err := r.preflightBootstrap(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("bootstrap step=done preflight")
	stepStarted := time.Now()
	r.log("bootstrap-global step=start ensure_cos_root jfs_root=%s workspace=%s", r.cfg.JFSRoot, strings.TrimSpace(r.cfg.COSWorkspace))
	if err := r.traceStep(ctx, "runtime.ensure_remote_backend", func(ctx context.Context) error {
		return ensureWorkspaceBackendMounted(ctx, r)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureCOSDur = time.Since(stepStarted)
	r.log("bootstrap-global step=done ensure_cos_root duration=%s", humanDuration(ensureCOSDur))
	stepStarted = time.Now()
	r.log("bootstrap-global step=start ensure_dirs")
	if err := r.traceStep(ctx, "runtime.ensure_dirs", func(context.Context) error {
		return r.ensureGlobalDirs()
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureDirsDur = time.Since(stepStarted)
	r.log("bootstrap-global step=done ensure_dirs duration=%s", humanDuration(ensureDirsDur))
	stepStarted = time.Now()
	r.log("bootstrap-global step=start ensure_lower_layers lower_system=%s lower_base=%s", r.cfg.LowerSystem, r.cfg.LowerSystemBase)
	if err := r.traceStep(ctx, "runtime.ensure_lower_layers", func(ctx context.Context) error {
		return r.ensureLowerLayers(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureLowerDur = time.Since(stepStarted)
	r.log("bootstrap-global step=done ensure_lower_layers duration=%s", humanDuration(ensureLowerDur))
	stepStarted = time.Now()
	if err := r.traceStep(ctx, "runtime.pre_start_recovery", func(ctx context.Context) error {
		return r.preStartRecovery(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	stepStarted = time.Now()
	if err := r.traceStep(ctx, "runtime.ensure_active_image", func(ctx context.Context) error {
		return r.ensureActiveImage(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureImgDur = time.Since(stepStarted)

	r.log("Bootstrap complete.")
	r.log("State root: %s", r.cfg.StateRoot)
	r.log("Lower base: %s", r.cfg.LowerSystemBase)
	r.log("Active image: %s", r.cfg.ActiveImg)
	r.log("SUMMARY bootstrap container=%s total=%s ensure_cos=%s ensure_dirs=%s ensure_lower=%s ensure_active_image=%s",
		r.cfg.WispName, humanDuration(time.Since(startedAt)), humanDuration(ensureCOSDur), humanDuration(ensureDirsDur), humanDuration(ensureLowerDur), humanDuration(ensureImgDur))
	r.log("%s", humanOpSummary("bootstrap", r.cfg.WispName, time.Since(startedAt),
		timedStep{name: "ensure_cos", dur: ensureCOSDur},
		timedStep{name: "ensure_dirs", dur: ensureDirsDur},
		timedStep{name: "ensure_lower", dur: ensureLowerDur},
		timedStep{name: "ensure_active_image", dur: ensureImgDur},
	))
	return nil
}

func (r *Runtime) BootstrapGlobal(ctx context.Context) error {
	ctx, span := r.startSpan(ctx, "runtime.bootstrap_global")
	defer span.End()
	startedAt := time.Now()
	var ensureCOSDur, ensureDirsDur, ensureLowerDur time.Duration
	if err := requireRoot(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("bootstrap-global step=start preflight")
	if err := r.preflightBootstrap(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("bootstrap-global step=done preflight")
	stepStarted := time.Now()
	if err := r.traceStep(ctx, "runtime.ensure_remote_backend", func(ctx context.Context) error {
		return ensureWorkspaceBackendMounted(ctx, r)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureCOSDur = time.Since(stepStarted)
	stepStarted = time.Now()
	if err := r.traceStep(ctx, "runtime.ensure_dirs", func(context.Context) error {
		return r.ensureGlobalDirs()
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureDirsDur = time.Since(stepStarted)
	stepStarted = time.Now()
	if err := r.traceStep(ctx, "runtime.ensure_lower_layers", func(ctx context.Context) error {
		return r.ensureLowerLayers(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureLowerDur = time.Since(stepStarted)

	r.log("Global bootstrap complete.")
	r.log("Lower base: %s", r.cfg.LowerSystemBase)
	r.log("Shared crun: %s", r.cfg.CrunBinaryPath)
	r.log("SUMMARY bootstrap-global total=%s ensure_cos=%s ensure_dirs=%s ensure_lower=%s",
		humanDuration(time.Since(startedAt)), humanDuration(ensureCOSDur), humanDuration(ensureDirsDur), humanDuration(ensureLowerDur))
	r.log("%s", humanOpSummary("bootstrap-global", "host", time.Since(startedAt),
		timedStep{name: "ensure_cos", dur: ensureCOSDur},
		timedStep{name: "ensure_dirs", dur: ensureDirsDur},
		timedStep{name: "ensure_lower", dur: ensureLowerDur},
	))
	return nil
}

func (r *Runtime) RebuildBaseRootfs(ctx context.Context) error {
	ctx, span := r.startSpan(ctx, "runtime.rebuild_base_rootfs")
	defer span.End()
	if err := requireRoot(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	if err := r.traceStep(ctx, "runtime.ensure_dirs", func(context.Context) error {
		return r.ensureDirs()
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}

	sentinel := filepath.Join(r.cfg.LowerSystemBase, ".wisp-base-ready")
	if r.isMountpoint(ctx, r.cfg.LowerSystemBase) {
		if err := r.ensureUnmounted(ctx, r.cfg.LowerSystemBase); err != nil {
			return fmt.Errorf("unmount lower system base before rebuild: %w", err)
		}
	}
	if err := os.RemoveAll(r.cfg.LowerSystemBase); err != nil {
		return fmt.Errorf("remove lower system base: %w", err)
	}
	_ = os.Remove(sentinel)

	if err := os.MkdirAll(r.cfg.LowerSystemBase, 0o755); err != nil {
		return err
	}
	mountedBase := false
	if err := r.traceStep(ctx, "runtime.ensure_base_rootfs", func(ctx context.Context) error {
		var err error
		mountedBase, err = r.ensureBaseRootfs(ctx)
		return err
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	if !mountedBase {
		if err := r.traceStep(ctx, "runtime.ensure_wisp_user", func(context.Context) error {
			return r.ensureWispUser()
		}); err != nil {
			recordSpanErr(span, err)
			return err
		}
	}
	if err := r.traceStep(ctx, "runtime.populate_system_overlay", func(ctx context.Context) error {
		return r.populateSystemOverlay(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}

	r.log("Base rootfs rebuilt.")
	r.log("Lower base: %s", r.cfg.LowerSystemBase)
	return nil
}

func (r *Runtime) Start(ctx context.Context) error {
	ctx, span := r.startSpan(ctx, "runtime.start")
	defer span.End()
	startedAt := time.Now()
	var recoveryDur, bootstrapReadyDur, mountDur, startContainerDur, cgroupDur time.Duration
	stepStarted := time.Now()
	r.log("start step=start pre_start_recovery container=%s", r.cfg.WispName)
	if err := r.traceStep(ctx, "runtime.pre_start_recovery", func(ctx context.Context) error {
		return r.preStartRecovery(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	recoveryDur = time.Since(stepStarted)
	r.log("start step=done pre_start_recovery container=%s duration=%s", r.cfg.WispName, humanDuration(recoveryDur))
	stepStarted = time.Now()
	r.log("start step=start require_bootstrap_ready container=%s", r.cfg.WispName)
	if err := r.traceStep(ctx, "runtime.require_bootstrap_ready", func(context.Context) error {
		return r.requireBootstrapReady()
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	bootstrapReadyDur = time.Since(stepStarted)
	r.log("start step=done require_bootstrap_ready container=%s duration=%s", r.cfg.WispName, humanDuration(bootstrapReadyDur))
	stepStarted = time.Now()
	r.log("start step=start mount container=%s active_img=%s rootfs=%s", r.cfg.WispName, r.cfg.ActiveImg, r.cfg.RootFSMount)
	if err := r.traceStep(ctx, "runtime.mount", func(ctx context.Context) error {
		return r.mountRuntime(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	mountDur = time.Since(stepStarted)
	r.log("start step=done mount container=%s duration=%s", r.cfg.WispName, humanDuration(mountDur))
	stepStarted = time.Now()
	r.log("start step=start start_container container=%s container_id=%s crun=%s", r.cfg.WispName, r.cfg.ContainerID, r.cfg.CrunBinaryPath)
	if err := r.traceStep(ctx, "runtime.start_container", func(ctx context.Context) error {
		return r.startContainer(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	startContainerDur = time.Since(stepStarted)
	r.log("start step=done start_container container=%s duration=%s", r.cfg.WispName, humanDuration(startContainerDur))
	stepStarted = time.Now()
	r.log("start step=start apply_outer_cgroup_policy container=%s", r.cfg.WispName)
	if err := r.traceStep(ctx, "runtime.apply_outer_cgroup_policy", func(ctx context.Context) error {
		return r.applyOuterCgroupPolicy(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	cgroupDur = time.Since(stepStarted)
	r.log("start step=done apply_outer_cgroup_policy container=%s duration=%s", r.cfg.WispName, humanDuration(cgroupDur))

	r.log("Mounted rootfs at %s", r.cfg.RootFSMount)
	if dev, _ := os.ReadFile(r.cfg.LoopDeviceFile); len(dev) > 0 {
		r.log("Loop device: %s", strings.TrimSpace(string(dev)))
	}
	r.log("crun binary: %s", r.cfg.CrunBinaryPath)
	r.log("crun root: %s", r.cfg.CrunStateRoot)
	r.log("container id: %s", r.cfg.ContainerID)
	r.log("SUMMARY start container=%s total=%s recovery=%s require_bootstrap_ready=%s mount=%s start_container=%s apply_cgroup=%s",
		r.cfg.WispName, humanDuration(time.Since(startedAt)), humanDuration(recoveryDur), humanDuration(bootstrapReadyDur), humanDuration(mountDur), humanDuration(startContainerDur), humanDuration(cgroupDur))
	r.log("%s", humanOpSummary("start", r.cfg.WispName, time.Since(startedAt),
		timedStep{name: "recovery", dur: recoveryDur},
		timedStep{name: "require_bootstrap_ready", dur: bootstrapReadyDur},
		timedStep{name: "mount", dur: mountDur},
		timedStep{name: "start_container", dur: startContainerDur},
		timedStep{name: "apply_cgroup", dur: cgroupDur},
	))
	return nil
}

func (r *Runtime) Stop(ctx context.Context) error {
	return r.StopWithOptions(ctx, StopOptions{})
}

func (r *Runtime) StopWithOptions(ctx context.Context, opts StopOptions) error {
	ctx, span := r.startSpan(ctx, "runtime.stop")
	defer span.End()
	startedAt := time.Now()
	var stopContainerDur, checkpointDur, maintenanceDur, resetDur, promoteDur time.Duration
	var checkpoint CheckpointMetadata
	checkpointCreated := false
	if err := requireRoot(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.logStopState(ctx, "before_stop_container", "")
	stepStarted := time.Now()
	if err := r.traceStep(ctx, "runtime.stop_container", func(ctx context.Context) error {
		return r.stopContainer(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	stopContainerDur = time.Since(stepStarted)
	r.logStopState(ctx, "after_stop_container", "")
	stepStarted = time.Now()
	if opts.Force {
		r.log("runtime.stop force=true skip_checkpoint=true container=%s", r.cfg.WispName)
	} else {
		if err := r.traceStep(ctx, "runtime.create_stop_checkpoint", func(ctx context.Context) error {
			var err error
			checkpoint, err = r.createSystemCheckpoint(ctx, checkpointTriggerGracefulStop)
			checkpointCreated = err == nil
			return err
		}); err != nil {
			recordSpanErr(span, err)
			return err
		}
	}
	checkpointDur = time.Since(stepStarted)
	r.logStopState(ctx, "after_checkpoint", checkpoint.ID)
	if !opts.Force {
		stepStarted = time.Now()
		if err := r.traceStep(ctx, "runtime.litestream_maintenance", func(ctx context.Context) error {
			return r.runStopLitestreamMaintenance(ctx)
		}); err != nil {
			recordSpanErr(span, err)
			return err
		}
		maintenanceDur = time.Since(stepStarted)
	}
	stepStarted = time.Now()
	if err := r.traceStep(ctx, "runtime.reset_runtime", func(ctx context.Context) error {
		return r.resetRuntime(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	resetDur = time.Since(stepStarted)
	r.logStopState(ctx, "after_reset_runtime", checkpoint.ID)
	if checkpointCreated {
		stepStarted = time.Now()
		if err := r.traceStep(ctx, "runtime.promote_stop_checkpoint", func(ctx context.Context) error {
			return r.promoteCheckpointToActive(ctx, checkpoint.ID)
		}); err != nil {
			recordSpanErr(span, err)
			return err
		}
		promoteDur = time.Since(stepStarted)
		r.logStopState(ctx, "after_promote_checkpoint", checkpoint.ID)
	}
	r.log("Runtime stopped.")
	r.log("SUMMARY stop container=%s total=%s force=%t stop_container=%s checkpoint=%s litestream_maintenance=%s reset_runtime=%s promote_checkpoint=%s checkpoint_id=%s",
		r.cfg.WispName, humanDuration(time.Since(startedAt)), opts.Force, humanDuration(stopContainerDur), humanDuration(checkpointDur), humanDuration(maintenanceDur), humanDuration(resetDur), humanDuration(promoteDur), checkpoint.ID)
	r.log("%s", humanOpSummary("stop", r.cfg.WispName, time.Since(startedAt),
		timedStep{name: "stop_container", dur: stopContainerDur},
		timedStep{name: "checkpoint", dur: checkpointDur},
		timedStep{name: "litestream_maintenance", dur: maintenanceDur},
		timedStep{name: "reset_runtime", dur: resetDur},
		timedStep{name: "promote_checkpoint", dur: promoteDur},
	))
	return nil
}

func (r *Runtime) logStopState(ctx context.Context, phase, checkpointID string) {
	loopDev := strings.TrimSpace(string(readFileBestEffort(r.cfg.LoopDeviceFile)))
	loopAttached := false
	if loopDev != "" {
		loopAttached = r.loopDeviceAttached(loopDev)
	}
	containerState := "unknown"
	if strings.TrimSpace(r.cfg.CrunBinaryPath) == "" || strings.TrimSpace(r.cfg.CrunStateRoot) == "" || strings.TrimSpace(r.cfg.ContainerID) == "" {
		containerState = "skipped"
	} else if exists, err := r.containerExists(ctx); err != nil {
		containerState = "error:" + err.Error()
	} else if exists {
		containerState = "exists"
	} else {
		containerState = "absent"
	}
	checkpointStat := "not_requested"
	if checkpointID != "" {
		if _, checkpointImg, err := r.checkpointImagePath(checkpointID); err == nil {
			checkpointStat = r.imageFingerprintForLog(checkpointImg)
		}
	}
	r.log("runtime.stop_state phase=%s container=%s container_state=%s active_img=%s active_fingerprint=%s checkpoint=%s checkpoint_fingerprint=%s loop_dev=%s loop_attached=%t mounts=%s",
		phase,
		r.cfg.WispName,
		containerState,
		r.cfg.ActiveImg,
		r.imageFingerprintForLog(r.cfg.ActiveImg),
		checkpointID,
		checkpointStat,
		loopDev,
		loopAttached,
		r.runtimeMountStateForLog(ctx),
	)
}

func (r *Runtime) runtimeMountStateForLog(ctx context.Context) string {
	paths := []struct {
		name string
		path string
	}{
		{name: "jfs_root", path: r.cfg.JFSRoot},
		{name: "runtime_root", path: r.cfg.RuntimeRoot},
		{name: "upper_mount", path: r.cfg.UpperImageMount},
	}
	if strings.TrimSpace(r.cfg.RuntimeRoot) != "" {
		paths = append(paths,
			struct {
				name string
				path string
			}{name: "rootfs", path: filepath.Join(r.cfg.RuntimeRoot, "rootfs")},
			struct {
				name string
				path string
			}{name: "bundle_rootfs", path: filepath.Join(r.cfg.RuntimeRoot, "bundle", "rootfs")},
			struct {
				name string
				path string
			}{name: "upper_active_mount", path: filepath.Join(r.cfg.RuntimeRoot, "rootfs", ".wisp", "checkpoints", "active")},
		)
	}
	var parts []string
	for _, item := range paths {
		if strings.TrimSpace(item.path) == "" {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s:%t", item.name, r.isMountpoint(ctx, item.path)))
	}
	return strings.Join(parts, ",")
}

func (r *Runtime) Destroy(ctx context.Context) error {
	ctx, span := r.startSpan(ctx, "runtime.destroy")
	defer span.End()
	startedAt := time.Now()
	var ensureCOSDur, cleanupDur time.Duration
	if err := requireRoot(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	_ = r.stopContainer(ctx)
	_ = r.resetRuntime(ctx)
	if r.cfg.COSEnabled {
		stepStarted := time.Now()
		if err := r.traceStep(ctx, "runtime.ensure_remote_backend", func(ctx context.Context) error {
			return ensureWorkspaceBackendMounted(ctx, r)
		}); err != nil {
			recordSpanErr(span, err)
			return err
		}
		ensureCOSDur = time.Since(stepStarted)
	}
	stepStarted := time.Now()
	err := r.traceStep(ctx, "runtime.destroy.cleanup_workspace", func(ctx context.Context) error {
		return r.cleanupWorkspaceState(ctx)
	})
	cleanupDur = time.Since(stepStarted)
	if err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("Runtime destroyed.")
	r.log("SUMMARY destroy container=%s total=%s ensure_cos=%s cleanup_workspace=%s",
		r.cfg.WispName, humanDuration(time.Since(startedAt)), humanDuration(ensureCOSDur), humanDuration(cleanupDur))
	r.log("%s", humanOpSummary("destroy", r.cfg.WispName, time.Since(startedAt),
		timedStep{name: "ensure_cos", dur: ensureCOSDur},
		timedStep{name: "cleanup_workspace", dur: cleanupDur},
	))
	return nil
}

func (r *Runtime) Enter(ctx context.Context) error {
	if err := requireRoot(); err != nil {
		return err
	}
	args, err := r.execArgs(ctx, nil)
	if err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, r.cfg.CrunBinaryPath, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func (r *Runtime) execArgs(ctx context.Context, argv []string) ([]string, error) {
	return r.execArgsWithMode(ctx, argv, true)
}

func (r *Runtime) execArgsWithMode(ctx context.Context, argv []string, tty bool) ([]string, error) {
	if !r.isMountpoint(ctx, r.cfg.RootFSMount) {
		return nil, errors.New("runtime is not started; run start first")
	}
	if exists, _ := r.containerExists(ctx); !exists {
		return nil, errors.New("runtime container is not started; run start first")
	}

	if len(argv) == 0 {
		shellPath := r.cfg.ShellPath
		if _, err := os.Stat(r.cfg.RootFSMount + shellPath); err != nil {
			shellPath = "/bin/sh"
		}
		argv = append([]string{shellPath}, shellArgs(shellPath)...)
	}

	args := []string{
		"--root", r.cfg.CrunStateRoot, "exec",
	}
	if tty {
		args = append(args, "-t")
	}
	args = append(args, "--user", fmt.Sprintf("%d:%d", r.cfg.WispUID, r.cfg.WispGID))
	args = append(args,
		r.cfg.ContainerID,
		"/usr/bin/env", "-i",
		"HOME=/home/"+r.cfg.WispUser,
		"USER="+r.cfg.WispUser,
		"LOGNAME="+r.cfg.WispUser,
		"PATH="+r.cfg.WispPath,
		"LANG="+r.cfg.WispLang,
		"BROWSER="+r.cfg.WispBrowser,
		"DEBIAN_FRONTEND="+r.cfg.WispDebianFrontend,
	)
	if tty {
		args = append(args, "TERM="+getenv("TERM", "xterm-256color"))
	}
	args = append(args, argv...)
	return args, nil
}

func (r *Runtime) ExecCommand(ctx context.Context, argv []string, stdin []byte) (ExecCommandResult, error) {
	if err := requireRoot(); err != nil {
		return ExecCommandResult{}, err
	}
	args, err := r.execArgsWithMode(ctx, argv, false)
	if err != nil {
		return ExecCommandResult{}, err
	}

	cmd := exec.CommandContext(ctx, r.cfg.CrunBinaryPath, args...)
	if len(stdin) > 0 {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	result := ExecCommandResult{
		Stdout: strings.TrimSpace(stdout.String()),
		Stderr: strings.TrimSpace(stderr.String()),
	}
	if err == nil {
		return result, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		result.ExitCode = exitErr.ExitCode()
		return result, nil
	}
	return result, err
}

func (r *Runtime) logFilesystemWriteCommitted(source, path string, bytesWritten int, contentSHA256 string) {
	r.log("filesystem_write_committed source=%s container=%s path=%s bytes=%d content_sha256=%s active_img=%s active_fingerprint=%s loop_dev=%s mounts=%s",
		source,
		r.cfg.WispName,
		path,
		bytesWritten,
		strings.ToLower(strings.TrimSpace(contentSHA256)),
		r.cfg.ActiveImg,
		r.imageFingerprintForLog(r.cfg.ActiveImg),
		strings.TrimSpace(string(readFileBestEffort(r.cfg.LoopDeviceFile))),
		r.runtimeMountStateForLog(context.Background()),
	)
}

func (r *Runtime) Status(ctx context.Context, w io.Writer) error {
	loopDev := strings.TrimSpace(string(readFileBestEffort(r.cfg.LoopDeviceFile)))

	fmt.Fprintf(w, "wisp: %s\n", r.cfg.WispName)
	fmt.Fprintf(w, "cos_enabled: %t\n", r.cfg.COSEnabled)
	fmt.Fprintf(w, "jfs_root: %s\n", r.cfg.JFSRoot)
	if mountpoint, fsType, ok := r.mountInfoForPath(r.cfg.JFSRoot); ok {
		fmt.Fprintf(w, "jfs_root_mountpoint: %s\n", mountpoint)
		fmt.Fprintf(w, "jfs_root_fs_type: %s\n", fsType)
		fmt.Fprintf(w, "object_store_backed: %t\n", isJuiceFSFSType(fsType))
	}
	fmt.Fprintf(w, "state_root: %s\n", r.cfg.StateRoot)
	fmt.Fprintf(w, "active_img: %s\n", r.cfg.ActiveImg)
	fmt.Fprintf(w, "loop_device: %s\n", loopDev)
	fmt.Fprintf(w, "crun_binary: %s\n", r.cfg.CrunBinaryPath)
	fmt.Fprintf(w, "crun_root: %s\n", r.cfg.CrunStateRoot)
	fmt.Fprintf(w, "container_id: %s\n", r.cfg.ContainerID)
	fmt.Fprintf(w, "cgroup_parent: %s\n", r.cfg.CgroupUserParent)
	fmt.Fprintf(w, "cgroup_child: %s\n", r.cfg.CgroupUserContainer)
	fmt.Fprintf(w, "rootfs_mount: %s\n", r.cfg.RootFSMount)
	fmt.Fprintf(w, "upper_image_mount: %s\n", r.cfg.UpperImageMount)

	fmt.Fprintln(w)
	fmt.Fprintln(w, "== mounts ==")
	_ = r.runTo(ctx, w, "findmnt", r.cfg.RootFSMount, r.cfg.ActiveViewMount, r.cfg.UpperImageMount, r.cfg.CrunBundleRootFS)

	fmt.Fprintln(w)
	fmt.Fprintln(w, "== crun state ==")
	if _, err := os.Stat(r.cfg.CrunBinaryPath); err == nil {
		_ = r.runTo(ctx, w, r.cfg.CrunBinaryPath, "--root", r.cfg.CrunStateRoot, "state", r.cfg.ContainerID)
	}

	fmt.Fprintln(w)
	fmt.Fprintln(w, "== outer cgroup knobs ==")
	for _, path := range []string{
		filepath.Join(r.cfg.CgroupUserParent, "memory.max"),
		filepath.Join(r.cfg.CgroupUserParent, "memory.high"),
		filepath.Join(r.cfg.CgroupUserParent, "cpu.max"),
		filepath.Join(r.cfg.CgroupUserParent, "pids.max"),
		filepath.Join(r.cfg.CgroupUserContainer, "cgroup.procs"),
	} {
		fmt.Fprintf(w, "--- %s ---\n", path)
		if data, err := os.ReadFile(path); err == nil {
			_, _ = w.Write(data)
		}
	}

	fmt.Fprintln(w)
	fmt.Fprintln(w, "== checkpoints ==")
	matches, _ := filepath.Glob(filepath.Join(r.cfg.CheckpointsRoot, "*", "root-upper.img"))
	for _, match := range matches {
		fmt.Fprintln(w, match)
	}
	return nil
}

func (r *Runtime) ApplyCgroupPolicy(ctx context.Context, w io.Writer) error {
	if err := requireRoot(); err != nil {
		return err
	}
	if err := r.applyOuterCgroupPolicy(ctx); err != nil {
		return err
	}

	r.log("Applied outer cgroup policy.")
	r.log("Parent: %s", r.cfg.CgroupUserParent)
	r.log("Child: %s", r.cfg.CgroupUserContainer)
	return r.StatusCgroup(w)
}

func (r *Runtime) StatusCgroup(w io.Writer) error {
	for _, path := range []string{
		filepath.Join(r.cfg.CgroupUserParent, "memory.max"),
		filepath.Join(r.cfg.CgroupUserParent, "memory.high"),
		filepath.Join(r.cfg.CgroupUserParent, "cpu.max"),
		filepath.Join(r.cfg.CgroupUserParent, "pids.max"),
		filepath.Join(r.cfg.CgroupUserContainer, "cgroup.procs"),
	} {
		fmt.Fprintf(w, "--- %s ---\n", path)
		if data, err := os.ReadFile(path); err == nil {
			_, _ = w.Write(data)
		}
	}
	return nil
}

func (r *Runtime) CreateCheckpoint(ctx context.Context, checkpointID string) error {
	_, err := r.createCheckpoint(ctx, checkpointID, checkpointClassManual, checkpointTriggerManual, false)
	return err
}

func (r *Runtime) createSystemCheckpoint(ctx context.Context, trigger string) (CheckpointMetadata, error) {
	id := fmt.Sprintf("system-%s-%s", strings.ReplaceAll(trigger, "_", "-"), time.Now().UTC().Format("20060102T150405.000000000Z"))
	return r.createCheckpoint(ctx, id, checkpointClassSystem, trigger, true)
}

func (r *Runtime) createCheckpoint(ctx context.Context, checkpointID, class, trigger string, runRetention bool) (CheckpointMetadata, error) {
	if err := requireRoot(); err != nil {
		return CheckpointMetadata{}, err
	}
	if err := r.ensureDirs(); err != nil {
		return CheckpointMetadata{}, err
	}
	checkpointID, checkpointDir, err := r.checkpointDirPath(checkpointID)
	if err != nil {
		return CheckpointMetadata{}, err
	}
	checkpointImg := filepath.Join(checkpointDir, "root-upper.img")
	if _, err := os.Stat(checkpointDir); err == nil {
		return CheckpointMetadata{}, fmt.Errorf("checkpoint already exists: %s", checkpointID)
	}
	if err := os.MkdirAll(checkpointDir, 0o755); err != nil {
		return CheckpointMetadata{}, err
	}
	if err := r.ensureJuiceFSCloneSupported(r.cfg.ActiveImg); err != nil {
		_ = os.RemoveAll(checkpointDir)
		return CheckpointMetadata{}, err
	}
	meta := checkpointMetadataFromID(checkpointID, r.cfg.ActiveImg)
	meta.Class = class
	meta.Trigger = trigger
	r.log("create_checkpoint source_stat checkpoint=%s phase=before_sync active_img=%s active_fingerprint=%s", checkpointID, r.cfg.ActiveImg, r.imageFingerprintForLog(r.cfg.ActiveImg))
	if err := r.syncCheckpointSource(ctx); err != nil {
		_ = os.RemoveAll(checkpointDir)
		return CheckpointMetadata{}, err
	}
	r.log("create_checkpoint source_stat checkpoint=%s phase=after_sync active_img=%s active_fingerprint=%s", checkpointID, r.cfg.ActiveImg, r.imageFingerprintForLog(r.cfg.ActiveImg))
	// file-barrier is the source-data fence: it makes ACTIVE_IMG clone-visible
	// to JuiceFS after the host-side loop/backing flush chain completes.
	if err := r.run(ctx, r.cfg.JFSBin, "file-barrier", r.cfg.ActiveImg); err != nil {
		_ = os.RemoveAll(checkpointDir)
		return CheckpointMetadata{}, fmt.Errorf("juicefs file-barrier %s: %w", r.cfg.ActiveImg, err)
	}
	r.log("create_checkpoint source_stat checkpoint=%s phase=after_file_barrier active_img=%s active_fingerprint=%s", checkpointID, r.cfg.ActiveImg, r.imageFingerprintForLog(r.cfg.ActiveImg))
	r.log("create_checkpoint clone_start checkpoint=%s active_img=%s checkpoint_img=%s active_fingerprint=%s checkpoint_fingerprint=%s",
		checkpointID,
		r.cfg.ActiveImg,
		checkpointImg,
		r.imageFingerprintForLog(r.cfg.ActiveImg),
		r.imageFingerprintForLog(checkpointImg),
	)
	if err := r.run(ctx, r.cfg.JFSBin, "clone", r.cfg.ActiveImg, checkpointImg); err != nil {
		_ = os.RemoveAll(checkpointDir)
		return CheckpointMetadata{}, err
	}
	r.log("create_checkpoint clone_done checkpoint=%s active_img=%s checkpoint_img=%s active_fingerprint=%s checkpoint_fingerprint=%s",
		checkpointID,
		r.cfg.ActiveImg,
		checkpointImg,
		r.imageFingerprintForLog(r.cfg.ActiveImg),
		r.imageFingerprintForLog(checkpointImg),
	)
	if err := r.fenceClonedImage(ctx, "create_checkpoint", checkpointImg); err != nil {
		return CheckpointMetadata{}, err
	}
	meta.State = checkpointStateCommitted
	if runRetention {
		if err := r.retainSystemCheckpoints(ctx, defaultSystemCheckpointRetention); err != nil {
			r.log("checkpoint retention failed checkpoint=%s: %v", checkpointID, err)
		}
	}
	r.log("Checkpoint created: %s", checkpointID)
	r.log(checkpointImg)
	return meta, nil
}

func (r *Runtime) syncCheckpointSource(ctx context.Context) error {
	startedAt := time.Now()
	r.log("sync_checkpoint_source start container=%s", r.cfg.WispName)
	containerCheckStart := time.Now()
	exists, existsErr := r.containerExists(ctx)
	r.log("sync_checkpoint_source container_exists_done container=%s exists=%t duration=%s err=%v", r.cfg.WispName, exists, humanDuration(time.Since(containerCheckStart)), existsErr)
	if existsErr != nil {
		return existsErr
	}
	if exists {
		stepStarted := time.Now()
		r.log("sync_checkpoint_source container_mount_syncfs_start container=%s", r.cfg.WispName)
		if err := r.syncContainerMountNamespace(ctx); err != nil {
			return fmt.Errorf("container mount syncfs before checkpoint: %w", err)
		}
		r.log("sync_checkpoint_source container_mount_syncfs_done container=%s duration=%s", r.cfg.WispName, humanDuration(time.Since(stepStarted)))
	}
	mountCheckStart := time.Now()
	upperMounted := r.isMountpoint(ctx, r.cfg.UpperImageMount)
	r.log("sync_checkpoint_source upper_mount_check_done container=%s target=%s mounted=%t duration=%s", r.cfg.WispName, r.cfg.UpperImageMount, upperMounted, humanDuration(time.Since(mountCheckStart)))
	if upperMounted {
		stepStarted := time.Now()
		r.log("sync_checkpoint_source upper_syncfs_start container=%s target=%s", r.cfg.WispName, r.cfg.UpperImageMount)
		f, err := os.Open(r.cfg.UpperImageMount)
		if err != nil {
			return fmt.Errorf("open upper image mount for syncfs %s: %w", r.cfg.UpperImageMount, err)
		}
		defer f.Close()
		if err := unix.Syncfs(int(f.Fd())); err != nil {
			return fmt.Errorf("syncfs %s: %w", r.cfg.UpperImageMount, err)
		}
		r.log("sync_checkpoint_source upper_syncfs_done container=%s target=%s duration=%s", r.cfg.WispName, r.cfg.UpperImageMount, humanDuration(time.Since(stepStarted)))
	}
	if dev := strings.TrimSpace(string(readFileBestEffort(r.cfg.LoopDeviceFile))); dev != "" {
		stepStarted := time.Now()
		r.log("sync_checkpoint_source loop_flush_start container=%s loop_dev=%s", r.cfg.WispName, dev)
		if err := r.flushLoopDevice(dev); err != nil {
			return fmt.Errorf("flush loop device %s before checkpoint: %w", dev, err)
		}
		r.log("sync_checkpoint_source loop_flush_done container=%s loop_dev=%s duration=%s", r.cfg.WispName, dev, humanDuration(time.Since(stepStarted)))
	}
	if err := r.fsyncActiveImageBackingFile(ctx, "sync_checkpoint_source"); err != nil {
		return err
	}
	r.log("sync_checkpoint_source done container=%s duration=%s", r.cfg.WispName, humanDuration(time.Since(startedAt)))
	return nil
}

func (r *Runtime) fsyncActiveImageBackingFile(ctx context.Context, operation string) error {
	_ = ctx
	startedAt := time.Now()
	r.log("%s active_fsync_start active_img=%s active_fingerprint=%s", operation, r.cfg.ActiveImg, r.imageFingerprintForLog(r.cfg.ActiveImg))
	f, err := os.OpenFile(r.cfg.ActiveImg, os.O_RDONLY, 0)
	if err != nil {
		return fmt.Errorf("%s open active image for fsync %s: %w", operation, r.cfg.ActiveImg, err)
	}
	defer f.Close()
	if err := f.Sync(); err != nil {
		return fmt.Errorf("%s fsync active image %s: %w", operation, r.cfg.ActiveImg, err)
	}
	r.log("%s active_fsync_done active_img=%s duration=%s active_fingerprint=%s", operation, r.cfg.ActiveImg, humanDuration(time.Since(startedAt)), r.imageFingerprintForLog(r.cfg.ActiveImg))
	return nil
}

func (r *Runtime) persistActiveImage(ctx context.Context, operation string) error {
	if _, err := os.Stat(r.cfg.ActiveImg); err != nil {
		if os.IsNotExist(err) {
			r.log("%s persist_active_image skip active_img_missing=%s", operation, r.cfg.ActiveImg)
			return nil
		}
		return fmt.Errorf("stat active image before %s persistence barrier: %w", operation, err)
	}
	if err := r.syncCheckpointSource(ctx); err != nil {
		return fmt.Errorf("%s sync active image before persistence barrier: %w", operation, err)
	}
	if !r.remoteBackendRequiresMount() {
		r.log("%s persist_active_image skip remote_backend_without_mount active_img=%s", operation, r.cfg.ActiveImg)
		return nil
	}
	if strings.TrimSpace(r.cfg.JFSBin) == "" {
		return fmt.Errorf("%s persistence barrier requires JFS_BIN", operation)
	}
	if !r.isMountpoint(ctx, r.cfg.JFSRoot) {
		return fmt.Errorf("%s persistence barrier requires mounted JFS_ROOT: %s", operation, r.cfg.JFSRoot)
	}
	r.log("%s persist_active_image file_barrier_start active_img=%s", operation, r.cfg.ActiveImg)
	fileBarrierStart := time.Now()
	if err := r.run(ctx, r.cfg.JFSBin, "file-barrier", r.cfg.ActiveImg); err != nil {
		return fmt.Errorf("%s juicefs file-barrier %s: %w", operation, r.cfg.ActiveImg, err)
	}
	r.log("%s persist_active_image file_barrier_done active_img=%s duration=%s", operation, r.cfg.ActiveImg, humanDuration(time.Since(fileBarrierStart)))
	r.log("%s persist_active_image meta_barrier_start jfs_root=%s", operation, r.cfg.JFSRoot)
	metaBarrierStart := time.Now()
	if err := r.run(ctx, r.cfg.JFSBin, "meta-barrier", r.cfg.JFSRoot); err != nil {
		return fmt.Errorf("%s juicefs meta-barrier %s: %w", operation, r.cfg.JFSRoot, err)
	}
	r.log("%s persist_active_image meta_barrier_done jfs_root=%s duration=%s", operation, r.cfg.JFSRoot, humanDuration(time.Since(metaBarrierStart)))
	r.log("%s persist_active_image writeback_barrier_start jfs_root=%s", operation, r.cfg.JFSRoot)
	writebackBarrierStart := time.Now()
	writebackArgs := []string{"writeback-barrier", "--verbose"}
	if pollInterval := strings.TrimSpace(os.Getenv("JFS_WRITEBACK_BARRIER_POLL_INTERVAL")); pollInterval != "" {
		writebackArgs = append(writebackArgs, "--poll-interval", pollInterval)
	}
	writebackArgs = append(writebackArgs, r.cfg.JFSRoot)
	if err := r.runLogged(ctx, "writeback_barrier", r.cfg.JFSBin, writebackArgs...); err != nil {
		return fmt.Errorf("%s juicefs writeback-barrier %s: %w", operation, r.cfg.JFSRoot, err)
	}
	r.log("%s persist_active_image writeback_barrier_done jfs_root=%s duration=%s", operation, r.cfg.JFSRoot, humanDuration(time.Since(writebackBarrierStart)))
	return nil
}

func (r *Runtime) flushLoopDevice(dev string) error {
	f, err := os.OpenFile(dev, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), uintptr(blkFlsBuf), 0); errno != 0 {
		return errno
	}
	return nil
}

func (r *Runtime) syncContainerMountNamespace(ctx context.Context) error {
	pid, err := r.containerPID(ctx)
	if err != nil {
		return err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	origNS, err := os.Open("/proc/self/ns/mnt")
	if err != nil {
		return fmt.Errorf("open current mount namespace: %w", err)
	}
	defer origNS.Close()

	targetNS, err := os.Open(filepath.Join("/proc", pid, "ns", "mnt"))
	if err != nil {
		return fmt.Errorf("open container mount namespace: %w", err)
	}
	defer targetNS.Close()

	if err := unix.Unshare(unix.CLONE_FS); err != nil {
		return fmt.Errorf("unshare fs state before setns: %w", err)
	}
	if err := unix.Setns(int(targetNS.Fd()), unix.CLONE_NEWNS); err != nil {
		return fmt.Errorf("enter container mount namespace: %w", err)
	}
	defer func() {
		_ = unix.Setns(int(origNS.Fd()), unix.CLONE_NEWNS)
	}()

	root, err := os.Open("/")
	if err != nil {
		return fmt.Errorf("open container root for syncfs: %w", err)
	}
	defer root.Close()
	if err := unix.Syncfs(int(root.Fd())); err != nil {
		return fmt.Errorf("syncfs container root: %w", err)
	}
	return nil
}

func (r *Runtime) RestoreCheckpoint(ctx context.Context, checkpointID string) error {
	if err := requireRoot(); err != nil {
		return err
	}
	checkpointID, checkpointImg, err := r.checkpointImagePath(checkpointID)
	if err != nil {
		return err
	}
	info, err := os.Stat(checkpointImg)
	if err != nil {
		return fmt.Errorf("checkpoint image not found: %s", checkpointImg)
	}
	if info.Size() <= 0 {
		return fmt.Errorf("checkpoint not found: %s", checkpointID)
	}
	r.log("restore_checkpoint start checkpoint=%s checkpoint_img=%s checkpoint_fingerprint=%s active_img=%s active_before=%s",
		checkpointID,
		checkpointImg,
		r.imageFingerprintForLog(checkpointImg),
		r.cfg.ActiveImg,
		r.imageFingerprintForLog(r.cfg.ActiveImg),
	)
	if err := r.stopContainer(ctx); err != nil {
		return err
	}
	if err := r.resetRuntime(ctx); err != nil {
		return err
	}
	r.log("restore_checkpoint after_reset checkpoint=%s active_img=%s active_fingerprint=%s checkpoint_fingerprint=%s",
		checkpointID,
		r.cfg.ActiveImg,
		r.imageFingerprintForLog(r.cfg.ActiveImg),
		r.imageFingerprintForLog(checkpointImg),
	)
	if err := r.ensureJuiceFSCloneSupported(checkpointImg); err != nil {
		return err
	}
	if err := os.Remove(r.cfg.ActiveImg); err != nil && !os.IsNotExist(err) {
		return err
	}
	r.log("restore_checkpoint clone_start checkpoint=%s checkpoint_img=%s active_img=%s checkpoint_fingerprint=%s active_fingerprint=%s",
		checkpointID,
		checkpointImg,
		r.cfg.ActiveImg,
		r.imageFingerprintForLog(checkpointImg),
		r.imageFingerprintForLog(r.cfg.ActiveImg),
	)
	if err := r.run(ctx, r.cfg.JFSBin, "clone", checkpointImg, r.cfg.ActiveImg); err != nil {
		return err
	}
	r.log("restore_checkpoint clone_done checkpoint=%s checkpoint_img=%s active_img=%s checkpoint_fingerprint=%s active_fingerprint=%s",
		checkpointID,
		checkpointImg,
		r.cfg.ActiveImg,
		r.imageFingerprintForLog(checkpointImg),
		r.imageFingerprintForLog(r.cfg.ActiveImg),
	)
	if err := r.fenceClonedImage(ctx, "restore_checkpoint", r.cfg.ActiveImg); err != nil {
		return err
	}
	r.log("restore_checkpoint fenced checkpoint=%s active_img=%s active_fingerprint=%s", checkpointID, r.cfg.ActiveImg, r.imageFingerprintForLog(r.cfg.ActiveImg))
	if ok, reason := r.activeImageValid(ctx); !ok {
		r.log("restore_checkpoint active_invalid checkpoint=%s active_img=%s active_fingerprint=%s reason=%s", checkpointID, r.cfg.ActiveImg, r.imageFingerprintForLog(r.cfg.ActiveImg), reason)
		return fmt.Errorf("restored active image invalid checkpoint=%s active_img=%s reason=%s", checkpointID, r.cfg.ActiveImg, reason)
	}
	r.log("restore_checkpoint active_valid checkpoint=%s active_img=%s active_fingerprint=%s", checkpointID, r.cfg.ActiveImg, r.imageFingerprintForLog(r.cfg.ActiveImg))
	r.log("Restored active image from checkpoint: %s", checkpointID)
	return nil
}

func (r *Runtime) promoteCheckpointToActive(ctx context.Context, checkpointID string) error {
	checkpointID, checkpointImg, err := r.checkpointImagePath(checkpointID)
	if err != nil {
		return err
	}
	if _, err := os.Stat(checkpointImg); err != nil {
		return fmt.Errorf("checkpoint image not found: %s: %w", checkpointImg, err)
	}
	if err := r.ensureJuiceFSCloneSupported(checkpointImg); err != nil {
		return err
	}
	r.log("stop_checkpoint_promote start checkpoint=%s checkpoint_img=%s active_img=%s active_before=%s checkpoint_fingerprint=%s",
		checkpointID,
		checkpointImg,
		r.cfg.ActiveImg,
		r.imageFingerprintForLog(r.cfg.ActiveImg),
		r.imageFingerprintForLog(checkpointImg),
	)
	if err := os.Remove(r.cfg.ActiveImg); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove active image before checkpoint promote: %w", err)
	}
	if err := r.run(ctx, r.cfg.JFSBin, "clone", checkpointImg, r.cfg.ActiveImg); err != nil {
		return fmt.Errorf("clone checkpoint to active image: %w", err)
	}
	// Stop creates the checkpoint as the durable commit point and already
	// fences the cloned checkpoint image. Promoting it back to active only
	// refreshes the next-boot cache, so avoid a second writeback cut barrier
	// on the same mounted JuiceFS tree.
	if r.remoteBackendRequiresMount() {
		if strings.TrimSpace(r.cfg.JFSBin) == "" {
			return errors.New("stop checkpoint promote fence requires JFS_BIN")
		}
		started := time.Now()
		r.log("stop_checkpoint_promote active_file_barrier_start image=%s", r.cfg.ActiveImg)
		if err := r.run(ctx, r.cfg.JFSBin, "file-barrier", r.cfg.ActiveImg); err != nil {
			return fmt.Errorf("stop checkpoint promote juicefs file-barrier %s: %w", r.cfg.ActiveImg, err)
		}
		r.log("stop_checkpoint_promote active_file_barrier_done image=%s duration=%s", r.cfg.ActiveImg, humanDuration(time.Since(started)))
		started = time.Now()
		r.log("stop_checkpoint_promote meta_barrier_start jfs_root=%s", r.cfg.JFSRoot)
		if err := r.runMetaBarrier(ctx); err != nil {
			return fmt.Errorf("stop checkpoint promote meta barrier: %w", err)
		}
		r.log("stop_checkpoint_promote meta_barrier_done jfs_root=%s duration=%s", r.cfg.JFSRoot, humanDuration(time.Since(started)))
	}
	r.log("stop_checkpoint_promote done checkpoint=%s active_img=%s active_after=%s", checkpointID, r.cfg.ActiveImg, r.imageFingerprintForLog(r.cfg.ActiveImg))
	return nil
}

func (r *Runtime) imageStatForLog(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Sprintf("stat_error=%q", err.Error())
	}
	return fmt.Sprintf("size=%d mode=%s mod=%s", info.Size(), info.Mode().String(), info.ModTime().UTC().Format(time.RFC3339Nano))
}

func (r *Runtime) imageFingerprintForLog(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Sprintf("stat_error=%q", err.Error())
	}
	size := info.Size()
	if size <= 0 {
		return fmt.Sprintf("size=%d mode=%s mod=%s sample_sha256=empty", size, info.Mode().String(), info.ModTime().UTC().Format(time.RFC3339Nano))
	}
	f, err := os.Open(path)
	if err != nil {
		return fmt.Sprintf("size=%d mode=%s mod=%s open_error=%q", size, info.Mode().String(), info.ModTime().UTC().Format(time.RFC3339Nano), err.Error())
	}
	defer f.Close()
	const sampleSize int64 = 1 << 20
	offsets := []int64{0}
	if size > sampleSize*2 {
		mid := size / 2
		if mid > sampleSize/2 {
			mid -= sampleSize / 2
		}
		offsets = append(offsets, mid)
	}
	if size > sampleSize {
		offsets = append(offsets, size-sampleSize)
	}
	h := sha256.New()
	buf := make([]byte, sampleSize)
	var sampled int64
	for _, off := range offsets {
		remaining := size - off
		if remaining <= 0 {
			continue
		}
		n := sampleSize
		if remaining < n {
			n = remaining
		}
		read, err := f.ReadAt(buf[:n], off)
		if read > 0 {
			_, _ = h.Write([]byte(fmt.Sprintf("@%d:%d:", off, read)))
			_, _ = h.Write(buf[:read])
			sampled += int64(read)
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return fmt.Sprintf("size=%d mode=%s mod=%s sample_error=%q sampled=%d", size, info.Mode().String(), info.ModTime().UTC().Format(time.RFC3339Nano), err.Error(), sampled)
		}
	}
	return fmt.Sprintf("size=%d mode=%s mod=%s sampled=%d sample_sha256=%x", size, info.Mode().String(), info.ModTime().UTC().Format(time.RFC3339Nano), sampled, h.Sum(nil))
}

func (r *Runtime) ListCheckpoints(ctx context.Context) ([]CheckpointMetadata, error) {
	return r.listCheckpoints(ctx, false)
}

func (r *Runtime) listCheckpoints(ctx context.Context, includeCandidates bool) ([]CheckpointMetadata, error) {
	if err := requireRoot(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(r.cfg.CheckpointsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []CheckpointMetadata
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		meta, err := r.GetCheckpoint(ctx, entry.Name())
		if err != nil {
			if strings.Contains(err.Error(), "checkpoint not found") {
				continue
			}
			return nil, err
		}
		if !includeCandidates && meta.State != checkpointStateCommitted {
			continue
		}
		out = append(out, meta)
	}
	sort.Slice(out, func(i, j int) bool {
		left := out[i].CreatedAt
		right := out[j].CreatedAt
		if left == right {
			return out[i].ID < out[j].ID
		}
		return left < right
	})
	return out, nil
}

func (r *Runtime) GetCheckpoint(ctx context.Context, checkpointID string) (CheckpointMetadata, error) {
	if err := requireRoot(); err != nil {
		return CheckpointMetadata{}, err
	}
	checkpointID, dir, err := r.checkpointDirPath(checkpointID)
	if err != nil {
		return CheckpointMetadata{}, err
	}
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) {
			return CheckpointMetadata{}, fmt.Errorf("checkpoint not found: %s", checkpointID)
		}
		return CheckpointMetadata{}, err
	}
	checkpointImg := filepath.Join(dir, "root-upper.img")
	info, err := os.Stat(checkpointImg)
	if err != nil {
		if os.IsNotExist(err) {
			return CheckpointMetadata{}, fmt.Errorf("checkpoint not found: %s", checkpointID)
		}
		return CheckpointMetadata{}, err
	}
	if info.Size() <= 0 {
		return CheckpointMetadata{}, fmt.Errorf("checkpoint not found: %s", checkpointID)
	}
	return checkpointMetadataFromID(checkpointID, r.cfg.ActiveImg), nil
}

func (r *Runtime) DeleteCheckpoint(ctx context.Context, checkpointID string) error {
	if err := requireRoot(); err != nil {
		return err
	}
	checkpointID, dir, err := r.checkpointDirPath(checkpointID)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("checkpoint not found: %s", checkpointID)
		}
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	r.log("Checkpoint deleted: %s", checkpointID)
	return nil
}

func (r *Runtime) checkpointDirPath(checkpointID string) (string, string, error) {
	checkpointID, err := validateCheckpointID(checkpointID)
	if err != nil {
		return "", "", err
	}
	return checkpointID, filepath.Join(r.cfg.CheckpointsRoot, checkpointID), nil
}

func (r *Runtime) checkpointImagePath(checkpointID string) (string, string, error) {
	checkpointID, dir, err := r.checkpointDirPath(checkpointID)
	if err != nil {
		return "", "", err
	}
	return checkpointID, filepath.Join(dir, "root-upper.img"), nil
}

func validateCheckpointID(checkpointID string) (string, error) {
	checkpointID = strings.TrimSpace(checkpointID)
	if checkpointID == "" {
		return "", errors.New("checkpoint id is required")
	}
	if strings.Contains(checkpointID, "/") || checkpointID == "." || checkpointID == ".." {
		return "", fmt.Errorf("invalid checkpoint id: %q", checkpointID)
	}
	return checkpointID, nil
}

func (r *Runtime) ensureJuiceFSCloneSupported(target string) error {
	target = strings.TrimSpace(target)
	if target == "" {
		return errors.New("checkpoint path is empty")
	}
	if strings.TrimSpace(r.cfg.JFSBin) == "" {
		return errors.New("JuiceFS clone is unavailable; JFS_BIN is not configured")
	}
	mountpoint, fsType, ok := r.mountInfoForPath(target)
	if !ok || mountpoint != r.cfg.JFSRoot || !isJuiceFSFSType(fsType) {
		r.logCheckpointCloneMountDiagnostics(target, mountpoint, fsType, ok)
		return fmt.Errorf("checkpoint clone requires JuiceFS-backed path under %s: %s observed_mountpoint=%q observed_fs_type=%q mountinfo_ok=%t", r.cfg.JFSRoot, target, mountpoint, fsType, ok)
	}
	return nil
}

func checkpointMetadataFromID(id, source string) CheckpointMetadata {
	meta := CheckpointMetadata{
		ID:      id,
		Source:  source,
		Format:  "juicefs-clone-v1",
		Backend: "juicefs-clone",
		State:   checkpointStateCommitted,
		Cut:     "file-clone-meta-barrier-v1",
	}
	parts := strings.Split(id, "-")
	if len(parts) >= 2 {
		meta.Class = parts[0]
	}
	timestamp := checkpointTimestampFromID(id)
	if timestamp != "" {
		meta.CreatedAt = timestamp
		if parsed, err := time.Parse("20060102T150405.000000000Z", timestamp); err == nil {
			meta.CreatedAt = parsed.UTC().Format(time.RFC3339Nano)
		}
	}
	if meta.Class == checkpointClassSystem && len(parts) >= 3 {
		triggerParts := parts[1 : len(parts)-1]
		if len(triggerParts) > 0 {
			meta.Trigger = strings.ReplaceAll(strings.Join(triggerParts, "-"), "-", "_")
		}
	} else if meta.Class == checkpointClassManual {
		meta.Trigger = checkpointTriggerManual
	}
	return meta
}

func checkpointTimestampFromID(id string) string {
	idx := strings.LastIndex(id, "-")
	if idx < 0 || idx+1 >= len(id) {
		return ""
	}
	candidate := id[idx+1:]
	if _, err := time.Parse("20060102T150405.000000000Z", candidate); err != nil {
		return ""
	}
	return candidate
}

func (r *Runtime) runMetaBarrier(ctx context.Context) error {
	if !r.remoteBackendRequiresMount() {
		return nil
	}
	if strings.TrimSpace(r.cfg.JFSBin) == "" {
		return errors.New("checkpoint meta barrier requires JFS_BIN")
	}
	return r.run(ctx, r.cfg.JFSBin, "meta-barrier", r.cfg.JFSRoot)
}

func (r *Runtime) fenceClonedImage(ctx context.Context, operation, imagePath string) error {
	if !r.remoteBackendRequiresMount() {
		return nil
	}
	if strings.TrimSpace(r.cfg.JFSBin) == "" {
		return fmt.Errorf("%s clone fence requires JFS_BIN", operation)
	}
	if !r.isMountpoint(ctx, r.cfg.JFSRoot) {
		return fmt.Errorf("%s clone fence requires mounted JFS_ROOT: %s", operation, r.cfg.JFSRoot)
	}
	started := time.Now()
	r.log("%s clone_file_barrier_start image=%s", operation, imagePath)
	if err := r.run(ctx, r.cfg.JFSBin, "file-barrier", imagePath); err != nil {
		return fmt.Errorf("%s juicefs file-barrier %s: %w", operation, imagePath, err)
	}
	r.log("%s clone_file_barrier_done image=%s duration=%s", operation, imagePath, humanDuration(time.Since(started)))
	started = time.Now()
	r.log("%s clone_writeback_cut_barrier_start jfs_root=%s", operation, r.cfg.JFSRoot)
	if err := r.runWritebackCutBarrier(ctx); err != nil {
		return fmt.Errorf("%s clone writeback cut barrier: %w", operation, err)
	}
	r.log("%s clone_writeback_cut_barrier_done jfs_root=%s duration=%s", operation, r.cfg.JFSRoot, humanDuration(time.Since(started)))
	started = time.Now()
	r.log("%s clone_meta_barrier_start jfs_root=%s", operation, r.cfg.JFSRoot)
	if err := r.run(ctx, r.cfg.JFSBin, "meta-barrier", r.cfg.JFSRoot); err != nil {
		return fmt.Errorf("%s juicefs meta-barrier %s: %w", operation, r.cfg.JFSRoot, err)
	}
	r.log("%s clone_meta_barrier_done jfs_root=%s duration=%s", operation, r.cfg.JFSRoot, humanDuration(time.Since(started)))
	return nil
}

func (r *Runtime) runStopLitestreamMaintenance(ctx context.Context) error {
	if !r.remoteBackendRequiresMount() {
		r.log("litestream_maintenance skip remote_backend_without_mount")
		return nil
	}
	if !envBoolDefault("WISP_LITESTREAM_MAINTENANCE_ON_STOP", true) {
		r.log("litestream_maintenance skip disabled_by_env")
		return nil
	}
	if strings.TrimSpace(r.cfg.JFSBin) == "" {
		return errors.New("litestream maintenance requires JFS_BIN")
	}
	args := []string{"litestream-maintenance"}
	if !envBoolDefault("WISP_LITESTREAM_MAINTENANCE_SNAPSHOT", false) {
		args = append(args, "--snapshot=false")
	}
	if compactLevel := getenvDefault("WISP_LITESTREAM_MAINTENANCE_COMPACT_LEVEL", "1"); strings.TrimSpace(compactLevel) != "" {
		args = append(args, "--compact-level", compactLevel)
	}
	if !envBoolDefault("WISP_LITESTREAM_MAINTENANCE_SNAPSHOT_RETENTION_ENABLED", true) {
		args = append(args, "--snapshot-retention=false")
	}
	args = append(args, "--snapshot-retention-age", getenvDefault("WISP_LITESTREAM_MAINTENANCE_SNAPSHOT_RETENTION", "5m"))
	if !envBoolDefault("WISP_LITESTREAM_MAINTENANCE_L0_RETENTION_ENABLED", true) {
		args = append(args, "--l0-retention=false")
	}
	args = append(args, "--l0-retention-age", getenvDefault("WISP_LITESTREAM_MAINTENANCE_L0_RETENTION", "0s"), r.cfg.JFSRoot)

	started := time.Now()
	r.log("litestream_maintenance start target=%s args=%s", r.cfg.JFSRoot, strings.Join(args, " "))
	err := r.runLogged(ctx, "litestream_maintenance", r.cfg.JFSBin, args...)
	r.log("litestream_maintenance done target=%s duration=%s err=%v", r.cfg.JFSRoot, humanDuration(time.Since(started)), err)
	if err == nil || envBoolDefault("WISP_LITESTREAM_MAINTENANCE_STRICT", false) {
		return err
	}
	r.log("litestream_maintenance best_effort_failed target=%s: %v", r.cfg.JFSRoot, err)
	return nil
}

func (r *Runtime) runWritebackCutBarrier(ctx context.Context) error {
	if !r.remoteBackendRequiresMount() {
		return nil
	}
	if strings.TrimSpace(r.cfg.JFSBin) == "" {
		return errors.New("checkpoint writeback cut barrier requires JFS_BIN")
	}
	args := []string{"writeback-cut-barrier", "--timeout", getenvDefault("WISP_CHECKPOINT_CUT_DRAIN_TIMEOUT", "120s")}
	if poll := strings.TrimSpace(os.Getenv("WISP_CHECKPOINT_CUT_POLL_INTERVAL")); poll != "" {
		args = append(args, "--poll-interval", poll)
	} else {
		args = append(args, "--poll-interval", "30ms")
	}
	args = append(args, r.cfg.JFSRoot)
	if err := r.runLogged(ctx, "writeback_cut_barrier", r.cfg.JFSBin, args...); err != nil {
		return fmt.Errorf("juicefs writeback-cut-barrier %s: %w", r.cfg.JFSRoot, err)
	}
	return nil
}

func (r *Runtime) checkpointTestCrash(point string) {
	if strings.TrimSpace(os.Getenv("WISP_CHECKPOINT_TEST_CRASH_AT")) != point {
		return
	}
	code := 97
	if raw := strings.TrimSpace(os.Getenv("WISP_CHECKPOINT_TEST_CRASH_EXIT_CODE")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 125 {
			code = parsed
		}
	}
	r.log("checkpoint test crash point=%s exit_code=%d", point, code)
	_ = os.Stderr.Sync()
	os.Exit(code)
}

func getenvDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func (r *Runtime) retainSystemCheckpoints(ctx context.Context, keep int) error {
	if keep < 0 {
		keep = 0
	}
	items, err := r.listCheckpoints(ctx, true)
	if err != nil {
		return err
	}
	var system []CheckpointMetadata
	for _, item := range items {
		if item.Class == checkpointClassSystem && item.State == checkpointStateCommitted {
			system = append(system, item)
		}
	}
	sort.Slice(system, func(i, j int) bool {
		if system[i].CreatedAt == system[j].CreatedAt {
			return system[i].ID > system[j].ID
		}
		return system[i].CreatedAt > system[j].CreatedAt
	})
	for idx, item := range system {
		if idx < keep {
			continue
		}
		if err := r.DeleteCheckpoint(ctx, item.ID); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) preStartRecovery(ctx context.Context) error {
	if r.remoteBackendRequiresMount() {
		if err := ensureWorkspaceBackendMounted(ctx, r); err != nil {
			return err
		}
	}
	if err := r.ensureDirs(); err != nil {
		return err
	}
	activeOK, activeReason := r.activeImageValid(ctx)
	if activeOK {
		r.log("pre_start_recovery skip active_img=%s active_fingerprint=%s reason=active_valid", r.cfg.ActiveImg, r.imageFingerprintForLog(r.cfg.ActiveImg))
		return nil
	}
	checkpoint, ok, err := r.latestCheckpoint(ctx)
	if err != nil {
		return err
	}
	if !ok {
		r.log("pre_start_recovery skip active_img=%s active_fingerprint=%s active_ok=%t active_reason=%s reason=no_checkpoint",
			r.cfg.ActiveImg,
			r.imageFingerprintForLog(r.cfg.ActiveImg),
			activeOK,
			activeReason,
		)
		return nil
	}
	checkpointImg := filepath.Join(r.cfg.CheckpointsRoot, checkpoint.ID, "root-upper.img")
	r.log("pre_start_recovery restore checkpoint=%s checkpoint_img=%s checkpoint_fingerprint=%s active_img=%s active_fingerprint=%s active_ok=%t active_reason=%s",
		checkpoint.ID,
		checkpointImg,
		r.imageFingerprintForLog(checkpointImg),
		r.cfg.ActiveImg,
		r.imageFingerprintForLog(r.cfg.ActiveImg),
		activeOK,
		activeReason,
	)
	return r.RestoreCheckpoint(ctx, checkpoint.ID)
}

func (r *Runtime) latestCheckpoint(ctx context.Context) (CheckpointMetadata, bool, error) {
	items, err := r.ListCheckpoints(ctx)
	if err != nil {
		return CheckpointMetadata{}, false, err
	}
	if len(items) == 0 {
		return CheckpointMetadata{}, false, nil
	}
	return items[len(items)-1], true, nil
}

func (r *Runtime) activeImageValid(ctx context.Context) (bool, string) {
	st, err := os.Stat(r.cfg.ActiveImg)
	if err != nil {
		if os.IsNotExist(err) {
			return false, "missing"
		}
		return false, "stat_error:" + err.Error()
	}
	if st.Size() <= 0 {
		return false, "empty"
	}
	if !hasCommand("e2fsck") {
		return false, "missing_e2fsck"
	}
	startedAt := time.Now()
	cmd := exec.CommandContext(ctx, "e2fsck", "-n", r.cfg.ActiveImg)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		stdoutText := oneLineForLog(stdout.String(), 1200)
		if msg == "" {
			msg = err.Error()
		}
		r.log("active_image_valid e2fsck_done active_img=%s active_fingerprint=%s ok=false duration=%s reason=%s stdout=%q stderr=%q",
			r.cfg.ActiveImg,
			r.imageFingerprintForLog(r.cfg.ActiveImg),
			humanDuration(time.Since(startedAt)),
			oneLineForLog(msg, 1200),
			stdoutText,
			oneLineForLog(stderr.String(), 1200),
		)
		return false, "e2fsck_failed:" + msg
	}
	r.log("active_image_valid e2fsck_done active_img=%s active_fingerprint=%s ok=true duration=%s stdout=%q stderr=%q",
		r.cfg.ActiveImg,
		r.imageFingerprintForLog(r.cfg.ActiveImg),
		humanDuration(time.Since(startedAt)),
		oneLineForLog(stdout.String(), 1200),
		oneLineForLog(stderr.String(), 1200),
	)
	return true, "e2fsck_ok"
}

func (r *Runtime) PrepareMinBase(ctx context.Context, dest string) error {
	if err := requireRoot(); err != nil {
		return err
	}
	if dest == "" {
		dest = "/var/lib/wisp/min-base-rootfs"
	}
	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	for _, dir := range []string{"bin", "sbin", "usr", "lib", "lib64", "etc", "opt", "home", "root"} {
		src := "/" + dir
		if _, err := os.Stat(src); err == nil {
			r.log("Copying %s into %s", src, dest)
			if err := r.run(ctx, "bash", "-lc", fmt.Sprintf("tar -C / -cpf - %s | tar -C %s -xpf -", dir, shellQuote(dest))); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Join(dest, dir), 0o755); err != nil {
			return err
		}
	}
	r.log("Prepared minimal base rootfs at %s", dest)
	return nil
}

func (r *Runtime) ensureDirs() error {
	for _, dir := range []string{
		r.cfg.StateRoot,
		r.cfg.ActiveRoot,
		r.cfg.CheckpointsRoot,
		r.cfg.PolicyRoot,
		r.cfg.LowerLanguages,
		r.cfg.LowerSystem,
		r.cfg.LowerSystemBase,
		r.cfg.RuntimeRoot,
		r.cfg.RootFSMount,
		r.cfg.UpperImageMount,
		r.cfg.CrunStateRoot,
		r.cfg.CrunBundleRoot,
		filepath.Dir(r.cfg.CrunBinaryPath),
		r.cfg.TmpRoot,
		r.cfg.DockerRoot,
		r.cfg.LogRoot,
	} {
		r.log("ensure_dirs mkdir_start path=%s", dir)
		if err := r.ensureDirPath(context.Background(), dir); err != nil {
			return err
		}
		r.log("ensure_dirs mkdir_done path=%s", dir)
	}
	return nil
}

func (r *Runtime) ensureGlobalDirs() error {
	for _, dir := range []string{
		r.cfg.JFSRoot,
		r.cfg.LowerLanguages,
		r.cfg.LowerSystem,
		r.cfg.LowerSystemBase,
		filepath.Dir(r.cfg.CrunBinaryPath),
		r.cfg.TmpRoot,
		r.cfg.DockerRoot,
		r.cfg.LogRoot,
	} {
		if err := r.ensureDirPath(context.Background(), dir); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) ensureDirPath(ctx context.Context, dir string) error {
	dir = filepath.Clean(strings.TrimSpace(dir))
	if dir == "" || dir == "." {
		return nil
	}
	return os.MkdirAll(dir, 0o755)
}

func (r *Runtime) ensureCOSRootMounted(ctx context.Context) error {
	if !r.remoteBackendRequiresMount() {
		mountpoint, fsType, ok := r.mountInfoForPath(r.cfg.JFSRoot)
		r.log("ensure_cos_root skip remote_backend=%s cos_enabled=%t smh_enabled=%t workspace=%s target=%s observed_mountpoint=%s observed_fs_type=%s mountinfo_ok=%t",
			normalizeRemoteBackend(r.cfg.RemoteBackend),
			r.cfg.COSEnabled,
			r.cfg.SMHEnabled,
			strings.TrimSpace(r.cfg.COSWorkspace),
			r.cfg.JFSRoot,
			mountpoint,
			fsType,
			ok,
		)
		return nil
	}
	if mountpoint, fsType, ok := r.mountInfoForPath(r.cfg.JFSRoot); ok && mountpoint == r.cfg.JFSRoot && isJuiceFSFSType(fsType) {
		if r.mountpointUsable(r.cfg.JFSRoot) {
			r.log("ensure_cos_root already_mounted target=%s fs_type=%s", r.cfg.JFSRoot, fsType)
			return nil
		}
		r.log("JuiceFS mount at %s is present but unusable; attempting repair", r.cfg.JFSRoot)
		workspace := strings.TrimSpace(r.cfg.COSWorkspace)
		if workspace == "" {
			workspace = r.cfg.WispName
		}
		_ = r.stopJuiceFSMountProcesses(ctx, workspace)
		if err := r.ensureUnmounted(ctx, r.cfg.JFSRoot); err != nil {
			return fmt.Errorf("repair broken JuiceFS mount at %s: %w", r.cfg.JFSRoot, err)
		}
	}
	if err := os.MkdirAll(r.cfg.JFSRoot, 0o755); err != nil {
		return fmt.Errorf("create JFS_ROOT mountpoint %s: %w", r.cfg.JFSRoot, err)
	}

	workspace := strings.TrimSpace(r.cfg.COSWorkspace)
	if workspace == "" {
		workspace = r.cfg.WispName
	}
	if ok, reason := r.juiceFSAssertMountAvailable(ctx); ok {
		var lastErr error
		for attempt := 1; attempt <= 2; attempt++ {
			attemptStart := time.Now()
			mountStart := time.Now()
			r.log("ensure_cos_root assertmount_start attempt=%d workspace=%s target=%s bin=%s", attempt, workspace, r.cfg.JFSRoot, r.cfg.JFSBin)
			if err := r.runJuiceFSAssertMount(ctx, workspace, r.cfg.JFSRoot); err != nil {
				r.log("ensure_cos_root assertmount_fail attempt=%d workspace=%s duration=%s err=%v", attempt, workspace, humanDuration(time.Since(mountStart)), err)
				return fmt.Errorf("assert JuiceFS mount for workspace %s at %s: %w", workspace, r.cfg.JFSRoot, err)
			}
			r.log("ensure_cos_root assertmount_done attempt=%d workspace=%s duration=%s", attempt, workspace, humanDuration(time.Since(mountStart)))
			waitStart := time.Now()
			r.log("ensure_cos_root wait_mount_start attempt=%d target=%s timeout=30s", attempt, r.cfg.JFSRoot)
			if err := r.waitForJuiceFSMount(ctx, r.cfg.JFSRoot, 30*time.Second); err != nil {
				_ = r.stopJuiceFSMountProcesses(ctx, workspace)
				lastErr = fmt.Errorf("wait for JuiceFS mount at %s: %w", r.cfg.JFSRoot, err)
				r.log("ensure_cos_root wait_mount_fail attempt=%d target=%s duration=%s err=%v", attempt, r.cfg.JFSRoot, humanDuration(time.Since(waitStart)), lastErr)
			} else {
				r.log("ensure_cos_root wait_mount_done attempt=%d target=%s duration=%s", attempt, r.cfg.JFSRoot, humanDuration(time.Since(waitStart)))
				usableStart := time.Now()
				mountpoint, fsType, ok := r.mountInfoForPath(r.cfg.JFSRoot)
				usable := ok && mountpoint == r.cfg.JFSRoot && isJuiceFSFSType(fsType) && r.mountpointUsable(r.cfg.JFSRoot)
				r.log("ensure_cos_root usable_check_done attempt=%d target=%s ok=%t mountpoint=%s fs_type=%s duration=%s", attempt, r.cfg.JFSRoot, usable, mountpoint, fsType, humanDuration(time.Since(usableStart)))
				if usable {
					r.log("ensure_cos_root mounted target=%s fs_type=%s total_attempt_duration=%s", r.cfg.JFSRoot, fsType, humanDuration(time.Since(attemptStart)))
					return nil
				}
				lastErr = fmt.Errorf("JFS_ROOT %s mounted but unusable after assertmount", r.cfg.JFSRoot)
			}
			r.log("ensure_cos_root repair attempt=%d err=%v", attempt, lastErr)
			_ = r.stopJuiceFSMountProcesses(ctx, workspace)
			_ = r.ensureUnmounted(ctx, r.cfg.JFSRoot)
		}
		return lastErr
	} else if strings.TrimSpace(r.cfg.JFSBin) != "" {
		r.log("ensure_cos_root assertmount_unavailable bin=%s reason=%s; falling back to helper scripts", r.cfg.JFSBin, reason)
	}
	smountScript := strings.TrimSpace(r.cfg.JFSSMountScript)
	sformatScript := strings.TrimSpace(r.cfg.JFSSFormatScript)
	if smountScript == "" || sformatScript == "" {
		repoRoot := strings.TrimSpace(r.cfg.JuiceFSRepoRoot)
		if repoRoot == "" {
			return errors.New("COS_ENABLED is set but neither JFS_SMOUNT_SCRIPT/JFS_SFORMAT_SCRIPT nor JUICEFS_REPO_ROOT are configured")
		}
		if smountScript == "" {
			smountScript = filepath.Join(repoRoot, "hack", "smount.sh")
		}
		if sformatScript == "" {
			sformatScript = filepath.Join(repoRoot, "hack", "sformat.sh")
		}
	}

	sformatStart := time.Now()
	r.log("ensure_cos_root sformat_start script=%s workspace=%s", sformatScript, workspace)
	if err := r.runJuiceFSScript(ctx, sformatScript, workspace); err != nil && !isBenignSformatError(err) {
		r.log("ensure_cos_root sformat_fail workspace=%s duration=%s err=%v", workspace, humanDuration(time.Since(sformatStart)), err)
		return fmt.Errorf("prepare JuiceFS workspace %s: %w", workspace, err)
	}
	r.log("ensure_cos_root sformat_done workspace=%s duration=%s", workspace, humanDuration(time.Since(sformatStart)))

	var lastErr error
	for attempt := 1; attempt <= 2; attempt++ {
		attemptStart := time.Now()
		smountStart := time.Now()
		r.log("ensure_cos_root smount_start attempt=%d script=%s workspace=%s target=%s", attempt, smountScript, workspace, r.cfg.JFSRoot)
		smountArgs := append([]string{workspace, r.cfg.JFSRoot, "--"}, r.juiceFSMountOptionArgs()...)
		if err := r.startDetachedJuiceFSScript(ctx, smountScript, smountArgs...); err != nil {
			r.log("ensure_cos_root smount_fail attempt=%d workspace=%s duration=%s err=%v", attempt, workspace, humanDuration(time.Since(smountStart)), err)
			return fmt.Errorf("start JuiceFS mount for workspace %s at %s: %w", workspace, r.cfg.JFSRoot, err)
		}
		r.log("ensure_cos_root smount_done attempt=%d workspace=%s duration=%s", attempt, workspace, humanDuration(time.Since(smountStart)))
		waitStart := time.Now()
		r.log("ensure_cos_root wait_mount_start attempt=%d target=%s timeout=30s", attempt, r.cfg.JFSRoot)
		if err := r.waitForJuiceFSMount(ctx, r.cfg.JFSRoot, 30*time.Second); err != nil {
			_ = r.stopJuiceFSMountProcesses(ctx, workspace)
			lastErr = fmt.Errorf("wait for JuiceFS mount at %s: %w", r.cfg.JFSRoot, err)
			r.log("ensure_cos_root wait_mount_fail attempt=%d target=%s duration=%s err=%v", attempt, r.cfg.JFSRoot, humanDuration(time.Since(waitStart)), lastErr)
		} else {
			r.log("ensure_cos_root wait_mount_done attempt=%d target=%s duration=%s", attempt, r.cfg.JFSRoot, humanDuration(time.Since(waitStart)))
			usableStart := time.Now()
			mountpoint, fsType, ok := r.mountInfoForPath(r.cfg.JFSRoot)
			usable := ok && mountpoint == r.cfg.JFSRoot && isJuiceFSFSType(fsType) && r.mountpointUsable(r.cfg.JFSRoot)
			r.log("ensure_cos_root usable_check_done attempt=%d target=%s ok=%t mountpoint=%s fs_type=%s duration=%s", attempt, r.cfg.JFSRoot, usable, mountpoint, fsType, humanDuration(time.Since(usableStart)))
			if usable {
				r.log("ensure_cos_root mounted target=%s fs_type=%s total_attempt_duration=%s", r.cfg.JFSRoot, fsType, humanDuration(time.Since(attemptStart)))
				return nil
			}
			lastErr = fmt.Errorf("JFS_ROOT %s mounted but unusable after smount", r.cfg.JFSRoot)
		}
		r.log("ensure_cos_root repair attempt=%d err=%v", attempt, lastErr)
		_ = r.stopJuiceFSMountProcesses(ctx, workspace)
		_ = r.ensureUnmounted(ctx, r.cfg.JFSRoot)
	}
	return lastErr
}

func (r *Runtime) juiceFSAssertMountAvailable(ctx context.Context) (bool, string) {
	bin := strings.TrimSpace(r.cfg.JFSBin)
	if bin == "" {
		return false, "JFS_BIN is empty"
	}
	info, err := os.Stat(bin)
	if err != nil {
		return false, err.Error()
	}
	if info.IsDir() {
		return false, "JFS_BIN is a directory"
	}
	if info.Mode().Perm()&0o111 == 0 {
		return false, "JFS_BIN is not executable"
	}

	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, bin, "assertmount", "--help")
	var stderr bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if probeCtx.Err() != nil {
			return false, probeCtx.Err().Error()
		}
		reason := strings.TrimSpace(stderr.String())
		if reason == "" {
			reason = err.Error()
		}
		return false, reason
	}
	return true, ""
}

func (r *Runtime) runJuiceFSAssertMount(ctx context.Context, workspace, mountpoint string) error {
	args := []string{"assertmount", workspace, "--mountpoint", mountpoint, "--managed", "-d"}
	if prefix := firstNonEmptyRuntime(strings.TrimSpace(r.cfg.JFSPrefix), strings.TrimSpace(os.Getenv("JFS_PREFIX"))); prefix != "" {
		args = append(args, "--workspace-prefix", prefix)
	}
	if localRoot := strings.TrimSpace(r.cfg.JFSLocalRoot); localRoot != "" {
		args = append(args, "--local-root", localRoot)
	}
	if syncInterval := strings.TrimSpace(os.Getenv("JFS_ASSERTMOUNT_SYNC_INTERVAL")); syncInterval != "" {
		args = append(args, "--bootstrap-sync-interval", syncInterval)
	}
	if snapshotInterval := strings.TrimSpace(os.Getenv("JFS_ASSERTMOUNT_SNAPSHOT_INTERVAL")); snapshotInterval != "" {
		args = append(args, "--snapshot-interval", snapshotInterval)
	}
	if runtimeMaintenance := strings.TrimSpace(os.Getenv("JFS_ASSERTMOUNT_RUNTIME_MAINTENANCE")); runtimeMaintenance != "" {
		args = append(args, "--runtime-maintenance", runtimeMaintenance)
	}
	args = append(args, r.juiceFSMountOptionArgs()...)
	if trace := strings.TrimSpace(os.Getenv("SMH_HTTP_TRACE")); trace != "" && trace != "0" && !strings.EqualFold(trace, "false") {
		args = append(args, "--log", filepath.Join(os.TempDir(), "juicefs-assertmount.log"))
	}

	cmd := exec.CommandContext(ctx, r.cfg.JFSBin, args...)
	traceOutput := smhHTTPTraceEnabled()
	if traceOutput {
		cmd.Stdout = os.Stdout
	} else {
		cmd.Stdout = io.Discard
	}
	var stderr bytes.Buffer
	if traceOutput {
		cmd.Stderr = io.MultiWriter(os.Stderr, &stderr)
	} else {
		cmd.Stderr = &stderr
	}
	env, err := r.juiceFSScriptEnv(ctx)
	if err != nil {
		return err
	}
	if truthyEnv("JFS_ASSERTMOUNT_SKIP_OBJECT_STORAGE_CHECK") {
		env = append(env, "JFS_NO_CHECK_OBJECT_STORAGE=1")
	}
	cmd.Env = env
	if err := cmd.Run(); err != nil {
		if stderr.Len() == 0 {
			return fmt.Errorf("%s %s: %w", r.cfg.JFSBin, strings.Join(args, " "), err)
		}
		return fmt.Errorf("%s %s: %w: %s", r.cfg.JFSBin, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func firstNonEmptyRuntime(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (r *Runtime) juiceFSMountOptionArgs() []string {
	var args []string
	writeback := truthyEnv("JFS_MOUNT_WRITEBACK")
	if writeback {
		args = append(args, "--writeback")
	}
	if value := strings.TrimSpace(os.Getenv("JFS_MOUNT_WRITEBACK_THRESHOLD_SIZE")); value != "" {
		args = append(args, "--writeback-threshold-size", value)
	}
	if value := strings.TrimSpace(os.Getenv("JFS_MOUNT_UPLOAD_DELAY")); value != "" {
		args = append(args, "--upload-delay", value)
	}
	if value := strings.TrimSpace(os.Getenv("JFS_MOUNT_MAX_UPLOADS")); value != "" {
		args = append(args, "--max-uploads", value)
	}
	if value := strings.TrimSpace(os.Getenv("JFS_MOUNT_CACHE_SIZE")); value != "" {
		args = append(args, "--cache-size", value)
	}
	if value := strings.TrimSpace(os.Getenv("JFS_MOUNT_FREE_SPACE_RATIO")); value != "" {
		args = append(args, "--free-space-ratio", value)
	} else if writeback {
		if ratio, ok := r.adaptiveWritebackFreeSpaceRatio(); ok {
			args = append(args, "--free-space-ratio", ratio)
		}
	}
	if value := strings.TrimSpace(os.Getenv("JFS_MOUNT_BUFFER_SIZE")); value != "" {
		args = append(args, "--buffer-size", value)
	}
	return args
}

const defaultWritebackMinFreeBytes = 200 << 20

func (r *Runtime) adaptiveWritebackFreeSpaceRatio() (string, bool) {
	minFree := int64(defaultWritebackMinFreeBytes)
	if value := strings.TrimSpace(os.Getenv("JFS_MOUNT_MIN_FREE_BYTES")); value != "" {
		parsed, err := parseByteSize(value)
		if err != nil || parsed <= 0 {
			r.log("juicefs adaptive_writeback_free_space_ratio_invalid min_free=%q", value)
			return "", false
		}
		minFree = parsed
	}
	localRoot := strings.TrimSpace(r.cfg.JFSLocalRoot)
	if localRoot == "" {
		localRoot = os.TempDir()
	}
	if err := os.MkdirAll(localRoot, 0o755); err != nil {
		r.log("juicefs adaptive_writeback_free_space_ratio_stat_failed local_root=%s err=%v", localRoot, err)
		return "", false
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(localRoot, &stat); err != nil {
		r.log("juicefs adaptive_writeback_free_space_ratio_stat_failed local_root=%s err=%v", localRoot, err)
		return "", false
	}
	blockSize := int64(stat.Bsize)
	if blockSize <= 0 {
		r.log("juicefs adaptive_writeback_free_space_ratio_stat_failed local_root=%s block_size=%d", localRoot, blockSize)
		return "", false
	}
	totalBytes := int64(stat.Blocks) * blockSize
	ratio, ok := adaptiveWritebackFreeSpaceRatio(totalBytes, minFree)
	if !ok {
		return "", false
	}
	formatted := strconv.FormatFloat(ratio, 'f', 4, 64)
	r.log("juicefs adaptive_writeback_free_space_ratio local_root=%s total_bytes=%d min_free_bytes=%d ratio=%s", localRoot, totalBytes, minFree, formatted)
	return formatted, true
}

func adaptiveWritebackFreeSpaceRatio(totalBytes, minFreeBytes int64) (float64, bool) {
	if totalBytes <= 0 || minFreeBytes <= 0 {
		return 0, false
	}
	ratio := (2 * float64(minFreeBytes)) / float64(totalBytes)
	if ratio < 0.1 {
		ratio = 0.1
	}
	if ratio > 0.95 {
		ratio = 0.95
	}
	return ratio, true
}

func truthyEnv(name string) bool {
	value := strings.TrimSpace(os.Getenv(name))
	return value != "" && value != "0" && !strings.EqualFold(value, "false")
}

func envBoolDefault(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value != "0" && !strings.EqualFold(value, "false")
}

func (r *Runtime) remoteBackendRequiresMount() bool {
	switch normalizeRemoteBackend(r.cfg.RemoteBackend) {
	case remoteBackendSMH:
		return true
	case remoteBackendCOS:
		return r.cfg.COSEnabled
	default:
		return false
	}
}

func (r *Runtime) mountpointUsable(path string) bool {
	result := make(chan error, 1)
	go func() {
		_, err := os.ReadDir(path)
		result <- err
	}()

	select {
	case err := <-result:
		if err != nil {
			if isDisconnectedMountError(err) {
				return false
			}
			r.log("mountpoint usability probe failed: %s: %v", path, err)
			return false
		}
		return true
	case <-time.After(2 * time.Second):
		r.log("mountpoint usability probe timed out: %s", path)
		return false
	}
}

func isDisconnectedMountError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "transport endpoint is not connected")
}

func (r *Runtime) runJuiceFSScript(ctx context.Context, script string, args ...string) error {
	if _, err := os.Stat(script); err != nil {
		return fmt.Errorf("missing JuiceFS helper script %s: %w", script, err)
	}
	cmd := exec.CommandContext(ctx, "bash", append([]string{script}, args...)...)
	traceOutput := smhHTTPTraceEnabled()
	if traceOutput {
		cmd.Stdout = os.Stdout
	} else {
		cmd.Stdout = io.Discard
	}
	var stderr bytes.Buffer
	if traceOutput {
		cmd.Stderr = io.MultiWriter(os.Stderr, &stderr)
	} else {
		cmd.Stderr = &stderr
	}
	env, err := r.juiceFSScriptEnv(ctx)
	if err != nil {
		return err
	}
	cmd.Env = env
	if err := cmd.Run(); err != nil {
		if stderr.Len() == 0 {
			return fmt.Errorf("%s %s: %w", script, strings.Join(args, " "), err)
		}
		return fmt.Errorf("%s %s: %w: %s", script, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func (r *Runtime) startDetachedJuiceFSScript(ctx context.Context, script string, args ...string) error {
	if _, err := os.Stat(script); err != nil {
		return fmt.Errorf("missing JuiceFS helper script %s: %w", script, err)
	}
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open %s: %w", os.DevNull, err)
	}
	defer devNull.Close()

	cmd := exec.CommandContext(ctx, "bash", append([]string{script}, args...)...)
	if smhHTTPTraceEnabled() {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	} else {
		cmd.Stdout = devNull
		cmd.Stderr = devNull
	}
	cmd.Stdin = devNull
	env, err := r.juiceFSScriptEnv(ctx)
	if err != nil {
		return err
	}
	cmd.Env = env
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func (r *Runtime) waitForJuiceFSMount(ctx context.Context, target string, timeout time.Duration) error {
	const pollInterval = 30 * time.Millisecond
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		mountpoint, fsType, ok := r.mountInfoForPath(target)
		if ok && mountpoint == target && isJuiceFSFSType(fsType) {
			if r.mountpointUsable(target) {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
		}
	}
	mountpoint, fsType, _ := r.mountInfoForPath(target)
	return fmt.Errorf("mountpoint=%q fs_type=%q", mountpoint, fsType)
}

func (r *Runtime) stopJuiceFSMountProcesses(ctx context.Context, workspace string) error {
	jfsBin := strings.TrimSpace(r.cfg.JFSBin)
	patterns := []string{
		"smount " + workspace,
		"assertmount " + workspace,
	}
	if jfsBin != "" {
		patterns = append([]string{jfsBin + " smount " + workspace, jfsBin + " assertmount " + workspace}, patterns...)
	}
	seen := make(map[int]struct{})
	for _, pattern := range patterns {
		out, err := r.output(ctx, "pgrep", "-af", pattern)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) == 0 {
				continue
			}
			pid, err := strconv.Atoi(fields[0])
			if err != nil || pid <= 0 {
				continue
			}
			seen[pid] = struct{}{}
		}
	}
	for pid := range seen {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	time.Sleep(500 * time.Millisecond)
	for pid := range seen {
		if err := syscall.Kill(pid, 0); err == nil {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	return nil
}

func (r *Runtime) juiceFSScriptEnv(ctx context.Context) ([]string, error) {
	env := inheritedScriptEnv(
		"PATH",
		"HOME",
		"TMPDIR",
		"TMP",
		"TEMP",
		"USER",
		"LOGNAME",
		"SHELL",
		"GOTOOLCHAIN",
		"GOCACHE",
		"GOMODCACHE",
		"GOFLAGS",
		"GOSUMDB",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
		"SMH_META_REPLICA_URL",
		"LITESTREAM_REPLICA_URL",
		"LITESTREAM_S3_BUCKET",
		"LITESTREAM_S3_REGION",
		"LITESTREAM_S3_ENDPOINT",
		"LITESTREAM_S3_FORCE_PATH_STYLE",
		"LITESTREAM_S3_SIGN_PAYLOAD",
		"LITESTREAM_S3_PATH",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"COS_SECRETID",
		"COS_SECRETKEY",
		"SMH_HTTP_TRACE",
		"COS_HTTP_TRACE",
		"LITESTREAM_S3_HTTP_TRACE",
	)
	if normalizeRemoteBackend(r.cfg.RemoteBackend) != "" {
		env = append(env, "REMOTE_BACKEND="+normalizeRemoteBackend(r.cfg.RemoteBackend))
	}
	if r.cfg.COSBucket != "" {
		env = append(env, "COS_BUCKET="+r.cfg.COSBucket)
	}
	if r.cfg.COSRegion != "" {
		env = append(env, "COS_REGION="+r.cfg.COSRegion)
	}
	if r.cfg.COSEndpoint != "" {
		env = append(env, "COS_ENDPOINT="+r.cfg.COSEndpoint)
	}
	if r.cfg.COSTencentSecretID != "" {
		env = append(env, "TENCENTCLOUD_SECRET_ID="+r.cfg.COSTencentSecretID)
		env = append(env, "COS_SECRETID="+r.cfg.COSTencentSecretID)
		env = append(env, "AWS_ACCESS_KEY_ID="+r.cfg.COSTencentSecretID)
	}
	if r.cfg.COSTencentSecretKey != "" {
		env = append(env, "TENCENTCLOUD_SECRET_KEY="+r.cfg.COSTencentSecretKey)
		env = append(env, "COS_SECRETKEY="+r.cfg.COSTencentSecretKey)
		env = append(env, "AWS_SECRET_ACCESS_KEY="+r.cfg.COSTencentSecretKey)
	}
	if r.cfg.JFSLocalRoot != "" {
		env = append(env, "JFS_LOCAL_ROOT="+r.cfg.JFSLocalRoot)
	}
	if r.cfg.JFSPrefix != "" {
		env = append(env, "JFS_PREFIX="+r.cfg.JFSPrefix)
	}
	if r.cfg.JFSBin != "" {
		env = append(env, "JFS_BIN="+r.cfg.JFSBin)
	}
	if r.cfg.JFSBuild != "" {
		env = append(env, "JFS_BUILD="+r.cfg.JFSBuild)
	}
	if r.cfg.JFSMetaURL != "" {
		env = append(env, "JFS_META_URL="+r.cfg.JFSMetaURL)
	}
	if r.cfg.JFSBucketURL != "" {
		env = append(env, "JFS_BUCKET_URL="+r.cfg.JFSBucketURL)
	}
	if r.cfg.SMHEnabled {
		env = append(env, "SMH_ENABLED=true")
	}
	if r.cfg.SMHLibraryID != "" {
		env = append(env, "SMH_LIBRARY_ID="+r.cfg.SMHLibraryID)
	}
	if r.cfg.SMHAccessDomain != "" {
		env = append(env, "SMH_ACCESS_DOMAIN="+r.cfg.SMHAccessDomain)
	}
	if r.cfg.SMHSpaceID != "" {
		env = append(env, "SMH_SPACE_ID="+r.cfg.SMHSpaceID)
	}
	if normalizeRemoteBackend(r.cfg.RemoteBackend) == remoteBackendSMH {
		token, err := r.issueSMHScriptToken(ctx)
		if err != nil {
			return nil, err
		}
		if token != "" {
			env = append(env, "SMH_ACCESS_TOKEN="+token)
		}
	}
	return env, nil
}

func (r *Runtime) issueSMHScriptToken(ctx context.Context) (string, error) {
	if token := strings.TrimSpace(os.Getenv("SMH_ACCESS_TOKEN")); token != "" {
		return token, nil
	}
	if token := strings.TrimSpace(r.cfg.SMHAccessToken); token != "" {
		return token, nil
	}
	if strings.TrimSpace(r.cfg.SMHLibrarySecret) == "" {
		return "", nil
	}
	if strings.TrimSpace(r.cfg.SMHSpaceID) == "" {
		return "", fmt.Errorf("SMH_SPACE_ID is required to issue a script token")
	}
	client, err := smh.NewClient(r.cfg.SMHAccessDomain, r.cfg.SMHLibraryID, r.cfg.SMHLibrarySecret, &http.Client{Timeout: 30 * time.Second})
	if err != nil {
		return "", err
	}
	token, err := client.IssueToken(ctx, smh.TokenRequest{
		SpaceID:       r.cfg.SMHSpaceID,
		Grant:         []string{"admin"},
		PeriodSeconds: r.cfg.SMHTokenTTLSeconds,
	})
	if err != nil {
		return "", fmt.Errorf("issue SMH script token: %w", err)
	}
	return token.AccessToken, nil
}

func inheritedScriptEnv(keys ...string) []string {
	env := make([]string, 0, len(keys))
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok && strings.TrimSpace(value) != "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func (r *Runtime) ensureLowerLayers(ctx context.Context) error {
	if err := r.ensureCrunBinary(ctx); err != nil {
		return err
	}
	mountedBase, err := r.ensureBaseRootfs(ctx)
	if err != nil {
		return err
	}
	if !mountedBase {
		if err := r.ensureWispUser(); err != nil {
			return err
		}
	}
	return r.populateSystemOverlay(ctx)
}

func (r *Runtime) EnsureWorkspaceReady(ctx context.Context) error {
	ctx, span := r.startSpan(ctx, "runtime.ensure_workspace_ready")
	defer span.End()
	startedAt := time.Now()
	var ensureCOSDur, ensureDirsDur, cleanupDur, recoveryDur, ensureImgDur time.Duration
	if err := requireRoot(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	if err := r.preflightBootstrap(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	stepStarted := time.Now()
	r.log("ensure_workspace_ready step=start ensure_cos_root container=%s jfs_root=%s workspace=%s", r.cfg.WispName, r.cfg.JFSRoot, strings.TrimSpace(r.cfg.COSWorkspace))
	if err := r.traceStep(ctx, "runtime.ensure_remote_backend", func(ctx context.Context) error {
		return ensureWorkspaceBackendMounted(ctx, r)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureCOSDur = time.Since(stepStarted)
	r.log("ensure_workspace_ready step=done ensure_cos_root container=%s duration=%s", r.cfg.WispName, humanDuration(ensureCOSDur))
	stepStarted = time.Now()
	r.log("ensure_workspace_ready step=start ensure_dirs container=%s state_root=%s runtime_root=%s", r.cfg.WispName, r.cfg.StateRoot, r.cfg.RuntimeRoot)
	if err := r.traceStep(ctx, "runtime.ensure_dirs", func(context.Context) error {
		return r.ensureDirs()
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureDirsDur = time.Since(stepStarted)
	r.log("ensure_workspace_ready step=done ensure_dirs container=%s duration=%s", r.cfg.WispName, humanDuration(ensureDirsDur))
	stepStarted = time.Now()
	r.log("ensure_workspace_ready step=start cleanup_inactive_runtime_mounts container=%s runtime_root=%s", r.cfg.WispName, r.cfg.RuntimeRoot)
	if err := r.traceStep(ctx, "runtime.cleanup_inactive_runtime_mounts", func(ctx context.Context) error {
		return r.cleanupInactiveRuntimeMounts(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	cleanupDur = time.Since(stepStarted)
	r.log("ensure_workspace_ready step=done cleanup_inactive_runtime_mounts container=%s duration=%s", r.cfg.WispName, humanDuration(cleanupDur))
	stepStarted = time.Now()
	r.log("ensure_workspace_ready step=start pre_start_recovery container=%s", r.cfg.WispName)
	if err := r.traceStep(ctx, "runtime.pre_start_recovery", func(ctx context.Context) error {
		return r.preStartRecovery(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	recoveryDur = time.Since(stepStarted)
	r.log("ensure_workspace_ready step=done pre_start_recovery container=%s duration=%s", r.cfg.WispName, humanDuration(recoveryDur))
	stepStarted = time.Now()
	r.log("ensure_workspace_ready step=start ensure_active_image container=%s active_img=%s size=%s jfs_root=%s state_root=%s runtime_root=%s active_parent_entries=%s",
		r.cfg.WispName, r.cfg.ActiveImg, r.cfg.RootUpperSize, r.cfg.JFSRoot, r.cfg.StateRoot, r.cfg.RuntimeRoot, diagnosticDirEntries(filepath.Dir(r.cfg.ActiveImg)))
	if err := r.traceStep(ctx, "runtime.ensure_active_image", func(ctx context.Context) error {
		return r.ensureActiveImage(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureImgDur = time.Since(stepStarted)
	r.log("ensure_workspace_ready step=done ensure_active_image container=%s duration=%s", r.cfg.WispName, humanDuration(ensureImgDur))
	r.log("SUMMARY ensure_workspace_ready container=%s total=%s ensure_cos=%s ensure_dirs=%s cleanup_inactive_runtime_mounts=%s pre_start_recovery=%s ensure_active_image=%s",
		r.cfg.WispName, humanDuration(time.Since(startedAt)), humanDuration(ensureCOSDur), humanDuration(ensureDirsDur), humanDuration(cleanupDur), humanDuration(recoveryDur), humanDuration(ensureImgDur))
	r.log("%s", humanOpSummary("ensure_workspace_ready", r.cfg.WispName, time.Since(startedAt),
		timedStep{name: "ensure_cos", dur: ensureCOSDur},
		timedStep{name: "ensure_dirs", dur: ensureDirsDur},
		timedStep{name: "cleanup_inactive_runtime_mounts", dur: cleanupDur},
		timedStep{name: "pre_start_recovery", dur: recoveryDur},
		timedStep{name: "ensure_active_image", dur: ensureImgDur},
	))
	return nil
}

func (r *Runtime) requireBootstrapReady() error {
	var missing []string
	if _, err := os.Stat(filepath.Join(r.cfg.LowerSystemBase, ".wisp-base-ready")); err != nil {
		missing = append(missing, "lower system base")
	}
	if _, err := os.Stat(filepath.Join(r.cfg.LowerSystem, ".wisp/version.txt")); err != nil {
		missing = append(missing, "lower system overlay")
	}
	if _, err := os.Stat(r.cfg.ActiveImg); err != nil {
		missing = append(missing, "active root-upper image")
	}
	if _, err := os.Stat(r.cfg.CrunBinaryPath); err != nil {
		missing = append(missing, "prepared crun binary")
	}
	if len(missing) == 0 {
		return nil
	}
	return fmt.Errorf("runtime is not bootstrapped; run bootstrap first (missing: %s)", strings.Join(missing, ", "))
}

func (r *Runtime) ensureBaseRootfs(ctx context.Context) (bool, error) {
	sentinel := filepath.Join(r.cfg.LowerSystemBase, ".wisp-base-ready")
	if _, err := os.Stat(sentinel); err == nil {
		if samePath(r.cfg.LowerSystemBase, r.cfg.BaseRootFSDir) {
			r.log("Using packaged base rootfs directory directly: %s", r.cfg.LowerSystemBase)
			return true, nil
		}
		return r.isMountpoint(ctx, r.cfg.LowerSystemBase), nil
	}

	switch {
	case r.cfg.BaseRootFSImage != "":
		mounted, err := r.ensureMountedBaseRootfs(ctx, r.cfg.BaseRootFSImage)
		if err != nil {
			return false, err
		}
		if mounted {
			return true, nil
		}
		return false, fmt.Errorf("BASE_ROOTFS_IMG is not a prebaked wisp base image: %s", r.cfg.BaseRootFSImage)
	case r.cfg.BaseRootFSDir != "":
		if err := r.prepareBaseRootfsFromDirectory(ctx, r.cfg.BaseRootFSDir); err != nil {
			return false, err
		}
	default:
		return false, errors.New("could not build a base rootfs; configure BASE_ROOTFS_IMG or BASE_ROOTFS_DIR in config.jsonnet")
	}

	return false, os.WriteFile(sentinel, []byte{}, 0o644)
}

func samePath(a, b string) bool {
	a = strings.TrimSpace(a)
	b = strings.TrimSpace(b)
	if a == "" || b == "" {
		return false
	}
	aa, errA := filepath.Abs(a)
	bb, errB := filepath.Abs(b)
	if errA == nil {
		a = aa
	}
	if errB == nil {
		b = bb
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func (r *Runtime) ensureMountedBaseRootfs(ctx context.Context, imagePath string) (bool, error) {
	sentinel := filepath.Join(r.cfg.LowerSystemBase, ".wisp-base-ready")
	if r.isMountpoint(ctx, r.cfg.LowerSystemBase) {
		if _, err := os.Stat(sentinel); err == nil {
			r.log("Base rootfs image already mounted at %s", r.cfg.LowerSystemBase)
			return true, nil
		}
		return false, fmt.Errorf("LOWER_SYSTEM_BASE is mounted but not a prebaked wisp base: %s", r.cfg.LowerSystemBase)
	}
	if err := os.MkdirAll(r.cfg.LowerSystemBase, 0o755); err != nil {
		return false, err
	}
	loopDev, err := r.attachLoopDevice(imagePath, true)
	if err != nil {
		return false, err
	}
	cleanupLoop := true
	defer func() {
		if cleanupLoop {
			_ = r.ensureLoopDetached(context.Background(), loopDev)
		}
	}()
	if err := r.mountReadOnly(loopDev, r.cfg.LowerSystemBase); err != nil {
		return false, err
	}
	if _, err := os.Stat(sentinel); err == nil {
		cleanupLoop = false
		r.log("Mounted prebaked base rootfs image: %s -> %s", imagePath, r.cfg.LowerSystemBase)
		return true, nil
	}
	if err := r.safeUmount(ctx, r.cfg.LowerSystemBase); err != nil {
		return false, fmt.Errorf("unmount non-prebaked base rootfs %s: %w", r.cfg.LowerSystemBase, err)
	}
	if err := r.ensureLoopDetached(ctx, loopDev); err != nil {
		return false, err
	}
	cleanupLoop = false
	return false, fmt.Errorf("base rootfs image is missing prebaked marker %s: %s", sentinel, imagePath)
}

func (r *Runtime) prepareBaseRootfsFromDirectory(ctx context.Context, src string) error {
	if _, err := os.Stat(src); err != nil {
		return fmt.Errorf("BASE_ROOTFS_DIR does not exist: %s", src)
	}
	r.log("Syncing base rootfs from %s", src)
	if err := os.RemoveAll(r.cfg.LowerSystemBase); err != nil {
		return err
	}
	if err := os.MkdirAll(r.cfg.LowerSystemBase, 0o755); err != nil {
		return err
	}
	cmd := fmt.Sprintf("cd %s && tar --exclude=./proc --exclude=./sys --exclude=./dev --exclude=./run --exclude=./tmp --exclude=./mnt -cpf - . | (cd %s && tar -xpf -)", shellQuote(src), shellQuote(r.cfg.LowerSystemBase))
	if err := r.run(ctx, "bash", "-lc", cmd); err != nil {
		return err
	}
	return r.ensureRequiredRootfsDirs(r.cfg.LowerSystemBase)
}

func (r *Runtime) prepareBaseRootfsFromImage(ctx context.Context, imagePath string) error {
	r.log("Syncing base rootfs from loop image %s", imagePath)

	mountDir, err := os.MkdirTemp("", "wisp-base-rootfs-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(mountDir)

	loopDev, err := r.attachLoopDevice(imagePath, true)
	if err != nil {
		return err
	}
	defer func() { _ = r.ensureLoopDetached(context.Background(), loopDev) }()

	if err := r.mountReadOnly(loopDev, mountDir); err != nil {
		return err
	}
	defer func() { _ = r.safeUmount(context.Background(), mountDir) }()

	return r.prepareBaseRootfsFromDirectory(ctx, mountDir)
}

func (r *Runtime) ensureRequiredRootfsDirs(root string) error {
	for _, dir := range []string{
		"proc",
		"dev",
		"dev/pts",
		"dev/shm",
		"dev/mqueue",
		"sys",
		"sys/fs",
		"sys/fs/cgroup",
		"run",
		"mnt",
		"tmp",
		"var",
		"var/lib",
		"var/lib/docker",
	} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) ensureWispUser() error {
	home := filepath.Join(r.cfg.LowerSystemBase, "home", r.cfg.WispUser)
	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(r.cfg.LowerSystemBase, "etc", "mtab"))
	_ = os.Symlink("/proc/mounts", filepath.Join(r.cfg.LowerSystemBase, "etc", "mtab"))

	passwdPath := filepath.Join(r.cfg.LowerSystemBase, "etc", "passwd")
	groupPath := filepath.Join(r.cfg.LowerSystemBase, "etc", "group")
	shadowPath := filepath.Join(r.cfg.LowerSystemBase, "etc", "shadow")
	if err := appendIfMissing(passwdPath, r.cfg.WispUser+":", fmt.Sprintf("%s:x:%d:%d:Wisp User:/home/%s:%s\n", r.cfg.WispUser, r.cfg.WispUID, r.cfg.WispGID, r.cfg.WispUser, r.cfg.ShellPath)); err != nil {
		return err
	}
	if err := appendIfMissing(groupPath, r.cfg.WispUser+":", fmt.Sprintf("%s:x:%d:\n", r.cfg.WispUser, r.cfg.WispGID)); err != nil {
		return err
	}

	shadowEntry := fmt.Sprintf("%s::%d:0:99999:7:::\n", r.cfg.WispUser, daysSinceUnixEpoch())
	if err := appendIfMissing(shadowPath, r.cfg.WispUser+":", shadowEntry); err != nil {
		return err
	}
	return os.Chmod(shadowPath, 0o640)
}

func (r *Runtime) populateSystemOverlay(ctx context.Context) error {
	for _, dir := range []string{
		filepath.Join(r.cfg.LowerSystem, "proc"),
		filepath.Join(r.cfg.LowerSystem, "dev"),
		filepath.Join(r.cfg.LowerSystem, "dev/pts"),
		filepath.Join(r.cfg.LowerSystem, "dev/shm"),
		filepath.Join(r.cfg.LowerSystem, "dev/mqueue"),
		filepath.Join(r.cfg.LowerSystem, "sys"),
		filepath.Join(r.cfg.LowerSystem, "sys/fs"),
		filepath.Join(r.cfg.LowerSystem, "sys/fs/cgroup"),
		filepath.Join(r.cfg.LowerSystem, "run"),
		filepath.Join(r.cfg.LowerSystem, "mnt"),
		filepath.Join(r.cfg.LowerSystem, "tmp"),
		filepath.Join(r.cfg.LowerSystem, "home", r.cfg.WispUser),
		filepath.Join(r.cfg.LowerSystem, "var"),
		filepath.Join(r.cfg.LowerSystem, "var/lib"),
		filepath.Join(r.cfg.LowerSystem, "var/lib/docker"),
		filepath.Join(r.cfg.LowerSystem, ".pilot"),
		filepath.Join(r.cfg.LowerSystem, ".wisp/bin"),
		filepath.Join(r.cfg.LowerSystem, ".wisp/checkpoints"),
		filepath.Join(r.cfg.LowerSystem, ".wisp/tmp"),
		filepath.Join(r.cfg.LowerSystem, ".wisp/logs"),
		filepath.Join(r.cfg.LowerSystem, ".wisp/policy"),
		filepath.Join(r.cfg.LowerSystem, "etc/sudoers.d"),
		filepath.Join(r.cfg.LowerSystem, "etc/profile.d"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	if err := r.ensureTiniBinary(ctx); err != nil {
		return err
	}
	if err := r.ensureWispFSAgentBinary(ctx); err != nil {
		return err
	}
	type overlayFile struct {
		path    string
		content string
		mode    os.FileMode
	}
	files := []overlayFile{
		{
			path:    filepath.Join(r.cfg.LowerSystem, ".wisp/entrypoint.sh"),
			content: "#!/bin/sh\nset -e\nexec \"$@\"\n",
			mode:    0o755,
		},
		{
			path:    filepath.Join(r.cfg.LowerSystem, ".wisp/bin/wisp-env"),
			content: "#!/bin/sh\nset -eu\ncat <<'TXT'\nwisp-env (MVP shim)\n\nThis is a local prototype, not the real Wisp runtime.\nUse the host-side wisp CLI for checkpoint and lifecycle operations.\nTXT\n",
			mode:    0o755,
		},
		{
			path:    filepath.Join(r.cfg.LowerSystem, ".wisp/bin/wispenv"),
			content: "#!/bin/sh\nset -eu\nexec /.wisp/bin/wisp-env \"$@\"\n",
			mode:    0o755,
		},
		{
			path:    filepath.Join(r.cfg.LowerSystem, "etc/profile.d/wisp.sh"),
			content: fmt.Sprintf("export PATH=\"/.wisp/bin:$PATH\"\nexport BROWSER=\"%s\"\nexport LANG=\"%s\"\nexport DEBIAN_FRONTEND=\"%s\"\nexport USER=\"%s\"\nexport HOME=\"/home/%s\"\n", r.cfg.WispBrowser, r.cfg.WispLang, r.cfg.WispDebianFrontend, r.cfg.WispUser, r.cfg.WispUser),
			mode:    0o755,
		},
		{
			path:    filepath.Join(r.cfg.LowerSystem, "etc/resolv.conf"),
			content: renderResolvConf(r.cfg.ResolvNameservers),
			mode:    0o644,
		},
		{
			path:    filepath.Join(r.cfg.LowerSystem, "etc/sudoers.d/wisp"),
			content: fmt.Sprintf("%s ALL=(ALL) NOPASSWD:ALL\n", r.cfg.WispUser),
			mode:    0o440,
		},
		{
			path:    filepath.Join(r.cfg.LowerSystem, ".wisp/version.txt"),
			content: "dev\n",
			mode:    0o644,
		},
	}
	for _, file := range files {
		if err := os.WriteFile(file.path, []byte(file.content), file.mode); err != nil {
			return err
		}
	}
	if built := strings.TrimSpace(r.cfg.WispEnvBinary); built != "" {
		if err := r.run(ctx, "cp", built, filepath.Join(r.cfg.LowerSystem, ".wisp/bin/wispenv")); err != nil {
			return err
		}
		if err := os.Chmod(filepath.Join(r.cfg.LowerSystem, ".wisp/bin/wispenv"), 0o755); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) ensureActiveImage(ctx context.Context) error {
	if _, err := os.Stat(r.cfg.ActiveImg); err == nil {
		r.log("ensure_active_image existing active_img=%s active_fingerprint=%s", r.cfg.ActiveImg, r.imageFingerprintForLog(r.cfg.ActiveImg))
		return nil
	} else {
		parent := filepath.Dir(r.cfg.ActiveImg)
		r.log("ensure_active_image missing active_img=%s stat_error=%v parent=%s parent_stat=%s parent_entries=%s jfs_root=%s jfs_root_stat=%s state_root=%s state_root_stat=%s runtime_root=%s",
			r.cfg.ActiveImg, err, parent, diagnosticStat(parent), diagnosticDirEntries(parent),
			r.cfg.JFSRoot, diagnosticStat(r.cfg.JFSRoot), r.cfg.StateRoot, diagnosticStat(r.cfg.StateRoot), r.cfg.RuntimeRoot)
	}
	startedAt := time.Now()
	requestedSize := strings.TrimSpace(r.cfg.RootUpperSize)
	r.log("ensure_active_image create_start active_img=%s size=%s blank_template_sparse=%s blank_template=%s blank_template_tar=%s", r.cfg.ActiveImg, requestedSize, r.cfg.BlankRootUpperSparse, r.cfg.BlankRootUpperImage, r.cfg.BlankRootUpperTar)
	if requestedSize == "" {
		copied, err := r.copyBlankActiveImageTemplate(ctx)
		if err != nil {
			return err
		}
		if copied {
			r.log("SUMMARY ensure_active_image active_img=%s total=%s source=blank_template", r.cfg.ActiveImg, humanDuration(time.Since(startedAt)))
			return nil
		}
		requestedSize = strings.TrimSpace(r.cfg.DefaultRootUpperSize)
		r.log("ensure_active_image blank_template_unavailable active_img=%s fallback_size=%s", r.cfg.ActiveImg, requestedSize)
	}
	sizeBytes, err := parseByteSize(requestedSize)
	if err != nil {
		return fmt.Errorf("parse ROOT_UPPER_SIZE %q: %w", requestedSize, err)
	}
	if err := os.MkdirAll(filepath.Dir(r.cfg.ActiveImg), 0o755); err != nil {
		return err
	}
	openStart := time.Now()
	f, err := os.OpenFile(r.cfg.ActiveImg, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	openDur := time.Since(openStart)
	r.log("ensure_active_image open_create_done active_img=%s duration=%s", r.cfg.ActiveImg, humanDuration(openDur))
	truncateStart := time.Now()
	if err := os.Truncate(r.cfg.ActiveImg, sizeBytes); err != nil {
		return err
	}
	truncateDur := time.Since(truncateStart)
	r.log("ensure_active_image truncate_done active_img=%s bytes=%d duration=%s", r.cfg.ActiveImg, sizeBytes, humanDuration(truncateDur))
	args := activeImageMke2fsArgs(sizeBytes, r.cfg.ActiveImg)
	mke2fsStart := time.Now()
	r.log("ensure_active_image mke2fs_start active_img=%s args=%q", r.cfg.ActiveImg, strings.Join(args, " "))
	if err := r.run(ctx, "mke2fs", args...); err != nil {
		r.log("ensure_active_image mke2fs_fail active_img=%s duration=%s err=%v", r.cfg.ActiveImg, humanDuration(time.Since(mke2fsStart)), err)
		return err
	}
	mke2fsDur := time.Since(mke2fsStart)
	r.log("ensure_active_image mke2fs_done active_img=%s duration=%s", r.cfg.ActiveImg, humanDuration(mke2fsDur))
	r.log("SUMMARY ensure_active_image active_img=%s total=%s open_create=%s truncate=%s mke2fs=%s",
		r.cfg.ActiveImg, humanDuration(time.Since(startedAt)), humanDuration(openDur), humanDuration(truncateDur), humanDuration(mke2fsDur))
	return nil
}

func (r *Runtime) copyBlankActiveImageTemplate(ctx context.Context) (bool, error) {
	if strings.TrimSpace(r.cfg.BlankRootUpperSparse) != "" {
		return r.extractBlankActiveImageTemplateSparse(ctx)
	}
	if strings.TrimSpace(r.cfg.BlankRootUpperTar) != "" {
		return r.extractBlankActiveImageTemplateTar(ctx)
	}
	src := strings.TrimSpace(r.cfg.BlankRootUpperImage)
	if src == "" {
		return false, nil
	}
	st, err := os.Stat(src)
	if err != nil {
		if os.IsNotExist(err) {
			r.log("ensure_active_image blank_template_missing path=%s", src)
			return false, nil
		}
		return false, fmt.Errorf("stat BLANK_ROOT_UPPER_IMG %s: %w", src, err)
	}
	if !st.Mode().IsRegular() || st.Size() <= 0 {
		return false, fmt.Errorf("BLANK_ROOT_UPPER_IMG is not a non-empty regular file: %s", src)
	}
	if err := os.MkdirAll(filepath.Dir(r.cfg.ActiveImg), 0o755); err != nil {
		return false, err
	}
	startedAt := time.Now()
	r.log("ensure_active_image blank_template_copy_start src=%s dst=%s bytes=%d", src, r.cfg.ActiveImg, st.Size())
	if err := sparseCopyFile(src, r.cfg.ActiveImg); err != nil {
		_ = os.Remove(r.cfg.ActiveImg)
		return false, fmt.Errorf("copy blank root-upper template %s -> %s: %w", src, r.cfg.ActiveImg, err)
	}
	r.log("ensure_active_image blank_template_copy_done src=%s dst=%s bytes=%d duration=%s", src, r.cfg.ActiveImg, st.Size(), humanDuration(time.Since(startedAt)))
	return true, nil
}

const sparseRootUpperMagic = "WISP_SPARSE_ROOT_UPPER_V1"

type sparseRootUpperManifest struct {
	Size    int64                      `json:"size"`
	Extents []sparseRootUpperExtent    `json:"extents"`
	Meta    map[string]json.RawMessage `json:"meta,omitempty"`
}

type sparseRootUpperExtent struct {
	Offset int64 `json:"offset"`
	Length int64 `json:"length"`
}

func (r *Runtime) extractBlankActiveImageTemplateSparse(ctx context.Context) (bool, error) {
	_ = ctx
	src := strings.TrimSpace(r.cfg.BlankRootUpperSparse)
	st, err := os.Stat(src)
	if err != nil {
		if os.IsNotExist(err) {
			r.log("ensure_active_image blank_template_sparse_missing path=%s", src)
			return false, nil
		}
		return false, fmt.Errorf("stat BLANK_ROOT_UPPER_SPARSE %s: %w", src, err)
	}
	if !st.Mode().IsRegular() || st.Size() <= 0 {
		return false, fmt.Errorf("BLANK_ROOT_UPPER_SPARSE is not a non-empty regular file: %s", src)
	}
	in, err := os.Open(src)
	if err != nil {
		return false, err
	}
	defer in.Close()
	reader := bufio.NewReader(in)
	magic, err := reader.ReadString('\n')
	if err != nil {
		return false, fmt.Errorf("read sparse root-upper magic: %w", err)
	}
	if strings.TrimSpace(magic) != sparseRootUpperMagic {
		return false, fmt.Errorf("invalid sparse root-upper magic in %s", src)
	}
	manifestLine, err := reader.ReadString('\n')
	if err != nil {
		return false, fmt.Errorf("read sparse root-upper manifest: %w", err)
	}
	var manifest sparseRootUpperManifest
	if err := json.Unmarshal([]byte(manifestLine), &manifest); err != nil {
		return false, fmt.Errorf("parse sparse root-upper manifest: %w", err)
	}
	if manifest.Size <= 0 {
		return false, fmt.Errorf("invalid sparse root-upper size %d", manifest.Size)
	}
	if err := os.MkdirAll(filepath.Dir(r.cfg.ActiveImg), 0o755); err != nil {
		return false, err
	}
	out, err := os.OpenFile(r.cfg.ActiveImg, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o644)
	if err != nil {
		return false, err
	}
	defer func() {
		_ = out.Close()
	}()
	startedAt := time.Now()
	r.log("ensure_active_image blank_template_sparse_extract_start src=%s dst=%s bytes=%d logical_size=%d extents=%d", src, r.cfg.ActiveImg, st.Size(), manifest.Size, len(manifest.Extents))
	for _, extent := range manifest.Extents {
		if extent.Offset < 0 || extent.Length < 0 || extent.Offset+extent.Length > manifest.Size {
			_ = os.Remove(r.cfg.ActiveImg)
			return false, fmt.Errorf("invalid sparse root-upper extent offset=%d length=%d size=%d", extent.Offset, extent.Length, manifest.Size)
		}
		if _, err := out.Seek(extent.Offset, io.SeekStart); err != nil {
			_ = os.Remove(r.cfg.ActiveImg)
			return false, err
		}
		if _, err := io.CopyN(out, reader, extent.Length); err != nil {
			_ = os.Remove(r.cfg.ActiveImg)
			return false, err
		}
	}
	if err := out.Truncate(manifest.Size); err != nil {
		_ = os.Remove(r.cfg.ActiveImg)
		return false, err
	}
	r.log("ensure_active_image blank_template_sparse_extract_done src=%s dst=%s logical_size=%d extents=%d duration=%s", src, r.cfg.ActiveImg, manifest.Size, len(manifest.Extents), humanDuration(time.Since(startedAt)))
	return true, nil
}

func (r *Runtime) extractBlankActiveImageTemplateTar(ctx context.Context) (bool, error) {
	src := strings.TrimSpace(r.cfg.BlankRootUpperTar)
	st, err := os.Stat(src)
	if err != nil {
		if os.IsNotExist(err) {
			r.log("ensure_active_image blank_template_tar_missing path=%s", src)
			return false, nil
		}
		return false, fmt.Errorf("stat BLANK_ROOT_UPPER_TAR %s: %w", src, err)
	}
	if !st.Mode().IsRegular() || st.Size() <= 0 {
		return false, fmt.Errorf("BLANK_ROOT_UPPER_TAR is not a non-empty regular file: %s", src)
	}
	if err := os.MkdirAll(filepath.Dir(r.cfg.ActiveImg), 0o755); err != nil {
		return false, err
	}
	tmpDir, err := os.MkdirTemp(filepath.Dir(r.cfg.ActiveImg), ".blank-root-upper-")
	if err != nil {
		return false, err
	}
	defer os.RemoveAll(tmpDir)
	startedAt := time.Now()
	r.log("ensure_active_image blank_template_tar_extract_start src=%s dst=%s bytes=%d", src, r.cfg.ActiveImg, st.Size())
	cmd := exec.CommandContext(ctx, "tar", "--sparse", "-xf", src, "-C", tmpDir)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg != "" {
			return false, fmt.Errorf("extract blank root-upper template %s: %s: %w", src, msg, err)
		}
		return false, fmt.Errorf("extract blank root-upper template %s: %w", src, err)
	}
	extracted := filepath.Join(tmpDir, "root-upper-default.img")
	if _, err := os.Stat(extracted); err != nil {
		return false, fmt.Errorf("extract blank root-upper template %s: missing root-upper-default.img: %w", src, err)
	}
	if err := os.Rename(extracted, r.cfg.ActiveImg); err != nil {
		return false, err
	}
	r.log("ensure_active_image blank_template_tar_extract_done src=%s dst=%s duration=%s", src, r.cfg.ActiveImg, humanDuration(time.Since(startedAt)))
	return true, nil
}

func sparseCopyFile(src, dst string) error {
	dst, err := normalizeLocalFilePath(dst)
	if err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		_ = out.Close()
	}()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	if err := sparseCopyDataRanges(in, out, st.Size()); err == nil {
		return out.Truncate(st.Size())
	} else if !errors.Is(err, errSparseSeekUnsupported) {
		return err
	}
	buf := make([]byte, 1024*1024)
	for {
		n, readErr := in.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if isZeroChunk(chunk) {
				if _, err := out.Seek(int64(n), io.SeekCurrent); err != nil {
					return err
				}
			} else if _, err := out.Write(chunk); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	size, err := in.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	return out.Truncate(size)
}

func normalizeLocalFilePath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("file path is required")
	}
	abs, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

var errSparseSeekUnsupported = errors.New("sparse seek unsupported")

func sparseCopyDataRanges(in *os.File, out *os.File, size int64) error {
	if size == 0 {
		return nil
	}
	offset := int64(0)
	for offset < size {
		data, err := unix.Seek(int(in.Fd()), offset, unix.SEEK_DATA)
		if err != nil {
			if errors.Is(err, unix.ENXIO) {
				return nil
			}
			if errors.Is(err, unix.EINVAL) {
				return errSparseSeekUnsupported
			}
			return err
		}
		if data >= size {
			return nil
		}
		hole, err := unix.Seek(int(in.Fd()), data, unix.SEEK_HOLE)
		if err != nil {
			if errors.Is(err, unix.EINVAL) {
				return errSparseSeekUnsupported
			}
			return err
		}
		if hole > size {
			hole = size
		}
		if _, err := in.Seek(data, io.SeekStart); err != nil {
			return err
		}
		if _, err := out.Seek(data, io.SeekStart); err != nil {
			return err
		}
		if _, err := io.CopyN(out, in, hole-data); err != nil {
			return err
		}
		offset = hole
	}
	return nil
}

func isZeroChunk(chunk []byte) bool {
	for _, b := range chunk {
		if b != 0 {
			return false
		}
	}
	return true
}

func activeImageMke2fsArgs(sizeBytes int64, imagePath string) []string {
	journalMB := int64(128)
	switch {
	case sizeBytes < 512<<20:
		journalMB = 16
	case sizeBytes <= 2<<30:
		journalMB = 32
	case sizeBytes <= 8<<30:
		journalMB = 64
	}
	return []string{
		"-F",
		"-F",
		"-t", "ext4",
		"-m", "0",
		"-J", fmt.Sprintf("size=%d", journalMB),
		"-E", "stride=1024,stripe-width=1024,lazy_itable_init=1,lazy_journal_init=1,assume_storage_prezeroed=1",
		"-O", "sparse_super2,^64bit,^metadata_csum",
		imagePath,
	}
}

func (r *Runtime) mountRuntime(ctx context.Context) error {
	ctx, span := r.startSpan(ctx, "runtime.mount_runtime")
	defer span.End()
	startedAt := time.Now()
	var ensureDirsDur, privateRootDur, loopAttachDur, writeLoopDur, mountUpperDur, overlayDirsDur, overlayDur, privateRootFSDur, activeViewDur, rootfsDirsDur, bindDur time.Duration
	if err := requireRoot(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	if err := requireCommands("mke2fs", "e2fsck"); err != nil {
		recordSpanErr(span, err)
		return err
	}
	stepStarted := time.Now()
	if err := r.traceStep(ctx, "runtime.mount.ensure_dirs", func(context.Context) error {
		return r.ensureDirs()
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	ensureDirsDur = time.Since(stepStarted)
	stepStarted = time.Now()
	if err := r.traceStep(ctx, "runtime.mount.make_runtime_root_private", func(context.Context) error {
		return r.ensurePrivateMountRoot(ctx, r.cfg.RuntimeRoot)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	privateRootDur = time.Since(stepStarted)
	if r.isMountpoint(ctx, r.cfg.RootFSMount) {
		r.log("Runtime already mounted at %s", r.cfg.RootFSMount)
		return nil
	}
	var dev string
	stepStarted = time.Now()
	r.log("mount_runtime step=start loop_attach active_img=%s", r.cfg.ActiveImg)
	err := r.traceStep(ctx, "runtime.mount.loop_attach", func(ctx context.Context) error {
		out, err := r.attachLoopDevice(r.cfg.ActiveImg, false)
		if err != nil {
			return err
		}
		dev = out
		return nil
	})
	if err != nil {
		recordSpanErr(span, err)
		return err
	}
	loopAttachDur = time.Since(stepStarted)
	r.log("mount_runtime step=done loop_attach active_img=%s loop_dev=%s duration=%s", r.cfg.ActiveImg, dev, humanDuration(loopAttachDur))
	stepStarted = time.Now()
	if err := os.WriteFile(r.cfg.LoopDeviceFile, []byte(dev+"\n"), 0o644); err != nil {
		recordSpanErr(span, err)
		return err
	}
	writeLoopDur = time.Since(stepStarted)
	stepStarted = time.Now()
	r.log("mount_runtime step=start mount_upper_image loop_dev=%s target=%s", dev, r.cfg.UpperImageMount)
	if err := r.traceStep(ctx, "runtime.mount.upper_image", func(ctx context.Context) error {
		return r.mountUpperImage(ctx, dev)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	mountUpperDur = time.Since(stepStarted)
	r.log("mount_runtime step=done mount_upper_image loop_dev=%s target=%s duration=%s", dev, r.cfg.UpperImageMount, humanDuration(mountUpperDur))
	upperDir := filepath.Join(r.cfg.UpperImageMount, "upper")
	workDir := filepath.Join(r.cfg.UpperImageMount, "work")
	stepStarted = time.Now()
	for _, dir := range []string{upperDir, workDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			return fmt.Errorf("overlay helper dir missing after create: %s", dir)
		}
	}
	overlayDirsDur = time.Since(stepStarted)
	lower := fmt.Sprintf("lowerdir=%s:%s:%s,upperdir=%s,workdir=%s",
		r.cfg.LowerLanguages,
		r.cfg.LowerSystem,
		r.cfg.LowerSystemBase,
		upperDir,
		workDir,
	)
	stepStarted = time.Now()
	r.log("mount_runtime step=start mount_overlay target=%s upper=%s work=%s", r.cfg.RootFSMount, upperDir, workDir)
	if err := r.traceStep(ctx, "runtime.mount.overlay", func(context.Context) error {
		return r.mountOverlay(r.cfg.RootFSMount, lower)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	overlayDur = time.Since(stepStarted)
	r.log("mount_runtime step=done mount_overlay target=%s duration=%s", r.cfg.RootFSMount, humanDuration(overlayDur))
	stepStarted = time.Now()
	if err := r.traceStep(ctx, "runtime.mount.make_rootfs_private", func(context.Context) error {
		return r.makeRPrivate(r.cfg.RootFSMount)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	privateRootFSDur = time.Since(stepStarted)
	stepStarted = time.Now()
	if err := os.MkdirAll(r.cfg.ActiveViewMount, 0o755); err != nil {
		return err
	}
	if err := r.bindMount(upperDir, r.cfg.ActiveViewMount); err != nil {
		return err
	}
	if err := r.remountBindReadOnly(r.cfg.ActiveViewMount); err != nil {
		return err
	}
	activeViewDur = time.Since(stepStarted)
	stepStarted = time.Now()
	for _, dir := range []string{
		filepath.Join(r.cfg.RootFSMount, "tmp"),
		filepath.Join(r.cfg.RootFSMount, "var/lib/docker"),
		filepath.Join(r.cfg.RootFSMount, ".wisp/logs"),
		filepath.Join(r.cfg.RootFSMount, ".wisp/policy"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	rootfsDirsDur = time.Since(stepStarted)
	stepStarted = time.Now()
	if err := r.traceStep(ctx, "runtime.mount.bind_tmp", func(context.Context) error {
		return r.bindMount(r.cfg.TmpRoot, filepath.Join(r.cfg.RootFSMount, "tmp"))
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	if err := r.traceStep(ctx, "runtime.mount.bind_docker", func(context.Context) error {
		return r.bindMount(r.cfg.DockerRoot, filepath.Join(r.cfg.RootFSMount, "var/lib/docker"))
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	if err := r.traceStep(ctx, "runtime.mount.bind_logs", func(context.Context) error {
		return r.bindMount(r.cfg.LogRoot, filepath.Join(r.cfg.RootFSMount, ".wisp/logs"))
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	if err := r.traceStep(ctx, "runtime.mount.bind_policy", func(context.Context) error {
		return r.bindMount(r.cfg.PolicyRoot, filepath.Join(r.cfg.RootFSMount, ".wisp/policy"))
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	if err := r.traceStep(ctx, "runtime.mount.remount_policy_ro", func(context.Context) error {
		return r.remountBindReadOnly(filepath.Join(r.cfg.RootFSMount, ".wisp/policy"))
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	bindDur = time.Since(stepStarted)
	r.log("SUMMARY mount_runtime container=%s total=%s ensure_dirs=%s private_runtime_root=%s loop_attach=%s write_loop_file=%s mount_upper=%s overlay_dirs=%s mount_overlay=%s private_rootfs=%s active_view=%s rootfs_dirs=%s bind_mounts=%s",
		r.cfg.WispName,
		humanDuration(time.Since(startedAt)),
		humanDuration(ensureDirsDur),
		humanDuration(privateRootDur),
		humanDuration(loopAttachDur),
		humanDuration(writeLoopDur),
		humanDuration(mountUpperDur),
		humanDuration(overlayDirsDur),
		humanDuration(overlayDur),
		humanDuration(privateRootFSDur),
		humanDuration(activeViewDur),
		humanDuration(rootfsDirsDur),
		humanDuration(bindDur),
	)
	return nil
}

func (r *Runtime) mountUpperImage(ctx context.Context, dev string) error {
	if err := r.mountDevice(dev, r.cfg.UpperImageMount, 0); err == nil {
		return r.makeRPrivate(r.cfg.UpperImageMount)
	}

	r.log("Upper image mount failed, attempting fsck repair: %s", r.cfg.ActiveImg)
	_ = r.run(ctx, "e2fsck", "-p", r.cfg.ActiveImg)
	if err := r.mountDevice(dev, r.cfg.UpperImageMount, 0); err == nil {
		return r.makeRPrivate(r.cfg.UpperImageMount)
	}

	_ = r.run(ctx, "e2fsck", "-fy", r.cfg.ActiveImg)
	if err := r.mountDevice(dev, r.cfg.UpperImageMount, 0); err == nil {
		return r.makeRPrivate(r.cfg.UpperImageMount)
	}

	return fmt.Errorf("failed to mount upper image after repair attempts: %s", r.cfg.ActiveImg)
}

func (r *Runtime) startContainer(ctx context.Context) error {
	ctx, span := r.startSpan(ctx, "runtime.start_container_inner")
	defer span.End()
	r.log("start_container step=start configure_outer_cgroup container=%s", r.cfg.WispName)
	if err := r.configureOuterCgroup(); err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("start_container step=done configure_outer_cgroup container=%s", r.cfg.WispName)
	r.log("start_container step=start container_exists container=%s container_id=%s crun_root=%s", r.cfg.WispName, r.cfg.ContainerID, r.cfg.CrunStateRoot)
	exists, err := r.containerExists(ctx)
	if err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("start_container step=done container_exists container=%s exists=%t", r.cfg.WispName, exists)
	if exists {
		r.log("start_container step=start assign_existing_container container=%s", r.cfg.WispName)
		if err := r.traceStep(ctx, "runtime.start.assign_existing_container", func(ctx context.Context) error {
			return r.assignContainerToOuterCgroup(ctx)
		}); err != nil {
			recordSpanErr(span, err)
			return err
		}
		r.log("start_container step=done assign_existing_container container=%s", r.cfg.WispName)
		r.log("crun container already running: %s", r.cfg.ContainerID)
		return nil
	}
	r.log("start_container step=start prepare_bundle container=%s bundle=%s", r.cfg.WispName, r.cfg.CrunBundleRoot)
	if err := r.traceStep(ctx, "runtime.start.prepare_bundle", func(context.Context) error {
		return r.prepareCrunBundle()
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("start_container step=done prepare_bundle container=%s", r.cfg.WispName)
	r.log("start_container step=start write_oci_config container=%s", r.cfg.WispName)
	if err := r.traceStep(ctx, "runtime.start.write_oci_config", func(context.Context) error {
		return r.writeOCIConfig()
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("start_container step=done write_oci_config container=%s", r.cfg.WispName)
	r.log("start_container step=start crun_run container=%s container_id=%s pid_file=%s", r.cfg.WispName, r.cfg.ContainerID, r.cfg.PIDFile)
	if err := r.traceStep(ctx, "runtime.start.crun_run", func(ctx context.Context) error {
		return r.runDetached(ctx, r.cfg.CrunBinaryPath, "--root", r.cfg.CrunStateRoot, "--cgroup-manager", "cgroupfs", "run", "-d", "--bundle", r.cfg.CrunBundleRoot, "--pid-file", r.cfg.PIDFile, r.cfg.ContainerID)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("start_container step=done crun_run container=%s", r.cfg.WispName)
	r.log("start_container step=start assign_new_container container=%s", r.cfg.WispName)
	if err := r.traceStep(ctx, "runtime.start.assign_new_container", func(ctx context.Context) error {
		return r.assignContainerToOuterCgroup(ctx)
	}); err != nil {
		recordSpanErr(span, err)
		return err
	}
	r.log("start_container step=done assign_new_container container=%s", r.cfg.WispName)
	return nil
}

func (r *Runtime) stopContainer(ctx context.Context) error {
	startedAt := time.Now()
	r.log("stop_container start container=%s", r.cfg.WispName)
	checkStarted := time.Now()
	exists, err := r.containerExists(ctx)
	r.log("stop_container container_exists_done container=%s exists=%t duration=%s err=%v", r.cfg.WispName, exists, humanDuration(time.Since(checkStarted)), err)
	if err != nil {
		return err
	}
	if exists {
		deleteStarted := time.Now()
		r.log("stop_container crun_delete_start container=%s crun_root=%s container_id=%s", r.cfg.WispName, r.cfg.CrunStateRoot, r.cfg.ContainerID)
		_ = r.run(ctx, r.cfg.CrunBinaryPath, "--root", r.cfg.CrunStateRoot, "delete", "-f", r.cfg.ContainerID)
		r.log("stop_container crun_delete_done container=%s duration=%s", r.cfg.WispName, humanDuration(time.Since(deleteStarted)))
	}
	_ = os.Remove(r.cfg.PIDFile)
	cgroupStarted := time.Now()
	r.cleanupOuterCgroup()
	r.log("stop_container cleanup_cgroup_done container=%s duration=%s total=%s", r.cfg.WispName, humanDuration(time.Since(cgroupStarted)), humanDuration(time.Since(startedAt)))
	return nil
}

func (r *Runtime) resetRuntime(ctx context.Context) error {
	startedAt := time.Now()
	r.log("reset_runtime start container=%s runtime_root=%s", r.cfg.WispName, r.cfg.RuntimeRoot)
	var errs []string
	var loopErr error
	for _, target := range r.runtimeUnmountTargets(r.cfg.RuntimeRoot, r.cfg.LegacyRuntimeRoot) {
		var err error
		stepStarted := time.Now()
		r.log("reset_runtime unmount_start container=%s path=%s recursive=%t", r.cfg.WispName, target.path, target.recursive)
		if target.recursive {
			err = r.ensureUnmountedRecursive(ctx, target.path)
		} else {
			err = r.ensureUnmounted(ctx, target.path)
		}
		r.log("reset_runtime unmount_done container=%s path=%s recursive=%t duration=%s err=%v", r.cfg.WispName, target.path, target.recursive, humanDuration(time.Since(stepStarted)), err)
		if err != nil {
			errs = append(errs, err.Error())
		}
	}
	if dev := strings.TrimSpace(string(readFileBestEffort(r.cfg.LoopDeviceFile))); dev != "" {
		stepStarted := time.Now()
		r.log("reset_runtime loop_detach_start container=%s loop_dev=%s", r.cfg.WispName, dev)
		if err := r.ensureLoopDetached(ctx, dev); err != nil {
			loopErr = err
		}
		r.log("reset_runtime loop_detach_done container=%s loop_dev=%s duration=%s err=%v", r.cfg.WispName, dev, humanDuration(time.Since(stepStarted)), loopErr)
	}
	_ = os.Remove(r.cfg.LoopDeviceFile)
	if len(errs) > 0 {
		if loopErr != nil {
			errs = append(errs, loopErr.Error())
		}
		return errors.New(strings.Join(errs, "; "))
	}
	if loopErr != nil {
		r.log("Loop detach still settling: %v", loopErr)
	}
	r.log("reset_runtime done container=%s duration=%s", r.cfg.WispName, humanDuration(time.Since(startedAt)))
	return nil
}

func (r *Runtime) runtimeUnmountTargets(runtimeRoot, legacyRoot string) []struct {
	path      string
	recursive bool
} {
	targets := []struct {
		path      string
		recursive bool
	}{
		{filepath.Join(runtimeRoot, "bundle", "rootfs"), true},
		{filepath.Join(runtimeRoot, "rootfs", ".wisp", "checkpoints", "active"), false},
		{filepath.Join(runtimeRoot, "rootfs", ".wisp", "policy"), false},
		{filepath.Join(runtimeRoot, "rootfs", ".wisp", "logs"), false},
		{filepath.Join(runtimeRoot, "rootfs", "var", "lib", "docker"), false},
		{filepath.Join(runtimeRoot, "rootfs", "tmp"), false},
		{filepath.Join(runtimeRoot, "rootfs"), false},
		{filepath.Join(runtimeRoot, "root-upper-rw"), false},
		{runtimeRoot, false},
	}
	if legacyRoot != "" && legacyRoot != r.cfg.RuntimeRoot {
		targets = append(targets,
			struct {
				path      string
				recursive bool
			}{filepath.Join(legacyRoot, "bundle", "rootfs"), true},
			struct {
				path      string
				recursive bool
			}{filepath.Join(legacyRoot, "rootfs", ".wisp", "checkpoints", "active"), false},
			struct {
				path      string
				recursive bool
			}{filepath.Join(legacyRoot, "rootfs", ".wisp", "policy"), false},
			struct {
				path      string
				recursive bool
			}{filepath.Join(legacyRoot, "rootfs", ".wisp", "logs"), false},
			struct {
				path      string
				recursive bool
			}{filepath.Join(legacyRoot, "rootfs", "var", "lib", "docker"), false},
			struct {
				path      string
				recursive bool
			}{filepath.Join(legacyRoot, "rootfs", "tmp"), false},
			struct {
				path      string
				recursive bool
			}{filepath.Join(legacyRoot, "rootfs"), false},
			struct {
				path      string
				recursive bool
			}{filepath.Join(legacyRoot, "root-upper-rw"), false},
			struct {
				path      string
				recursive bool
			}{legacyRoot, false},
		)
	}
	return targets
}

func (r *Runtime) CleanupStaleRuntimeRoots(ctx context.Context) error {
	if err := requireRoot(); err != nil {
		return err
	}

	var errs []string
	for _, root := range r.staleRuntimeRootsForCleanup() {
		if err := r.cleanupRuntimeRoot(ctx, root); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func (r *Runtime) staleRuntimeRootsForCleanup() []string {
	var roots []string
	runtimeRoot := strings.TrimSpace(r.cfg.RuntimeRoot)
	if runtimeRoot != "" {
		roots = append(roots, r.staleRuntimeRoots(filepath.Dir(runtimeRoot), runtimeRoot)...)
	}
	currentLegacy := strings.TrimSpace(r.cfg.LegacyRuntimeRoot)
	if currentLegacy != "" {
		roots = append(roots, r.staleRuntimeRoots(filepath.Dir(currentLegacy), currentLegacy)...)
	}
	return roots
}

func (r *Runtime) cleanupInactiveRuntimeMounts(ctx context.Context) error {
	exists, err := r.containerExists(ctx)
	if err != nil {
		r.log("cleanup_inactive_runtime_mounts container_exists_error container=%s err=%v", r.cfg.WispName, err)
	}
	if exists {
		r.log("cleanup_inactive_runtime_mounts skip container=%s reason=container_exists", r.cfg.WispName)
		return nil
	}
	if !r.hasRuntimeMountState(ctx) {
		return nil
	}
	r.log("cleanup_inactive_runtime_mounts reset_start container=%s runtime_root=%s", r.cfg.WispName, r.cfg.RuntimeRoot)
	if err := r.resetRuntime(ctx); err != nil {
		return err
	}
	r.log("cleanup_inactive_runtime_mounts reset_done container=%s runtime_root=%s", r.cfg.WispName, r.cfg.RuntimeRoot)
	return nil
}

func (r *Runtime) hasRuntimeMountState(ctx context.Context) bool {
	for _, target := range r.runtimeUnmountTargets(r.cfg.RuntimeRoot, r.cfg.LegacyRuntimeRoot) {
		if r.isMountpoint(ctx, target.path) {
			return true
		}
	}
	if dev := strings.TrimSpace(string(readFileBestEffort(r.cfg.LoopDeviceFile))); dev != "" {
		return true
	}
	return false
}

func (r *Runtime) staleRuntimeRoots(parent, current string) []string {
	parent = strings.TrimSpace(parent)
	if parent == "" {
		return nil
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		return nil
	}
	current = filepath.Clean(current)
	var roots []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		root := filepath.Join(parent, entry.Name())
		if filepath.Clean(root) == current {
			continue
		}
		roots = append(roots, root)
	}
	sort.Strings(roots)
	return roots
}

func (r *Runtime) cleanupRuntimeRoot(ctx context.Context, runtimeRoot string) error {
	var errs []string
	legacyRoot := ""
	for _, target := range r.runtimeUnmountTargets(runtimeRoot, legacyRoot) {
		var err error
		if target.recursive {
			err = r.ensureUnmountedRecursive(ctx, target.path)
		} else {
			err = r.ensureUnmounted(ctx, target.path)
		}
		if err != nil {
			errs = append(errs, err.Error())
		}
	}

	loopFile := filepath.Join(runtimeRoot, "loop-device")
	if dev := strings.TrimSpace(string(readFileBestEffort(loopFile))); dev != "" {
		if err := r.ensureLoopDetached(ctx, dev); err != nil {
			errs = append(errs, err.Error())
		}
	}
	_ = os.Remove(loopFile)
	if err := os.RemoveAll(runtimeRoot); err != nil {
		errs = append(errs, fmt.Sprintf("remove %s: %v", runtimeRoot, err))
	}
	if len(errs) > 0 {
		return fmt.Errorf("cleanup stale runtime root %s: %s", runtimeRoot, strings.Join(errs, "; "))
	}
	r.log("Cleaned stale runtime root: %s", runtimeRoot)
	return nil
}

func (r *Runtime) cleanupWorkspaceState(ctx context.Context) error {
	var errs []string
	for _, path := range r.workspaceCleanupPaths() {
		r.log("cleanup_workspace remove_start path=%s stat=%s entries=%s", path, diagnosticStat(path), diagnosticDirEntries(path))
		if err := r.removeTreeClean(ctx, path); err != nil {
			r.log("cleanup_workspace remove_failed path=%s err=%v", path, err)
			errs = append(errs, err.Error())
		} else {
			r.log("cleanup_workspace remove_done path=%s", path)
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func (r *Runtime) workspaceCleanupPaths() []string {
	protected := map[string]struct{}{}
	for _, path := range []string{
		r.cfg.JFSRoot,
		filepath.Join(r.cfg.JFSRoot, "wisp"),
		filepath.Dir(r.cfg.RuntimeRoot),
		filepath.Dir(r.cfg.TempRoot),
		filepath.Dir(strings.TrimSpace(r.cfg.LegacyRuntimeRoot)),
	} {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		protected[filepath.Clean(path)] = struct{}{}
	}

	seen := map[string]struct{}{}
	var paths []string
	for _, path := range []string{
		r.cfg.RuntimeRoot,
		r.cfg.LegacyRuntimeRoot,
		r.cfg.TempRoot,
		r.cfg.StateRoot,
	} {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		clean := filepath.Clean(path)
		if clean == "/" || clean == "." {
			continue
		}
		if _, blocked := protected[clean]; blocked {
			continue
		}
		if _, ok := seen[clean]; ok {
			continue
		}
		seen[clean] = struct{}{}
		paths = append(paths, clean)
	}
	return paths
}

func (r *Runtime) removeTreeClean(ctx context.Context, path string) error {
	if path == "" {
		return nil
	}
	const (
		removeDeadline = 5 * time.Second
		removeInterval = 100 * time.Millisecond
	)
	deadline := time.Now().Add(removeDeadline)
	var lastErr error
	for {
		_ = r.ensureUnmountedRecursive(ctx, path)
		if err := os.RemoveAll(path); err == nil {
			if _, statErr := os.Stat(path); os.IsNotExist(statErr) {
				return nil
			} else if statErr == nil {
				lastErr = fmt.Errorf("path still exists after removal: %s", path)
			} else {
				lastErr = fmt.Errorf("stat %s after removal: %w", path, statErr)
			}
		} else {
			lastErr = fmt.Errorf("remove %s: %w", path, err)
		}
		if time.Now().After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(removeInterval):
		}
	}
	return lastErr
}

func (r *Runtime) prepareCrunBundle() error {
	if err := os.MkdirAll(r.cfg.CrunBundleRootFS, 0o755); err != nil {
		return err
	}
	if !r.isMountpoint(context.Background(), r.cfg.CrunBundleRootFS) {
		if err := r.bindMountRecursive(r.cfg.RootFSMount, r.cfg.CrunBundleRootFS); err != nil {
			return err
		}
		if err := r.makeRPrivate(r.cfg.CrunBundleRootFS); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) writeOCIConfig() error {
	type ociConfig struct {
		OCIVersion string      `json:"ociVersion"`
		Process    interface{} `json:"process"`
		Root       interface{} `json:"root"`
		Hostname   string      `json:"hostname"`
		Mounts     interface{} `json:"mounts"`
		Linux      interface{} `json:"linux"`
	}

	cfg := ociConfig{
		OCIVersion: "1.0.2",
		Process: map[string]any{
			"terminal": false,
			"user": map[string]any{
				"uid": r.cfg.WispUID,
				"gid": r.cfg.WispGID,
			},
			"args": []string{"/.pilot/tini", "--", "/usr/bin/tail", "-f", "/dev/null"},
			"env": []string{
				"PATH=" + r.cfg.WispPath,
				"HOME=/home/" + r.cfg.WispUser,
				"LANG=" + r.cfg.WispLang,
				"BROWSER=" + r.cfg.WispBrowser,
				"DEBIAN_FRONTEND=" + r.cfg.WispDebianFrontend,
				"USER=" + r.cfg.WispUser,
				"LOGNAME=" + r.cfg.WispUser,
				"WISP_NAME=" + r.cfg.WispName,
			},
			"cwd":             "/home/" + r.cfg.WispUser,
			"capabilities":    allCapabilities(),
			"noNewPrivileges": false,
			"rlimits": []map[string]any{{
				"type": "RLIMIT_NOFILE",
				"hard": 1048576,
				"soft": 1048576,
			}},
		},
		Root: map[string]any{
			"path":     "rootfs",
			"readonly": false,
		},
		Hostname: r.cfg.WispName,
		Mounts: []map[string]any{
			{"destination": "/proc", "type": "proc", "source": "proc"},
			{"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": []string{"nosuid", "strictatime", "mode=755", "size=65536k"}},
			{"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": []string{"nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"}},
			{"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": []string{"nosuid", "noexec", "nodev", "mode=1777", "size=65536k"}},
			{"destination": "/dev/mqueue", "type": "mqueue", "source": "mqueue", "options": []string{"nosuid", "noexec", "nodev"}},
			{"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": []string{"nosuid", "noexec", "nodev", "ro"}},
			{"destination": "/sys/fs/cgroup", "type": "cgroup2", "source": "cgroup2", "options": []string{"nosuid", "noexec", "nodev", "rw"}},
			{"destination": "/mnt", "type": "tmpfs", "source": "tmpfs", "options": []string{"rw", "nosuid", "mode=755", "size=65536k"}},
			{"destination": "/run", "type": "tmpfs", "source": "tmpfs", "options": []string{"nosuid", "nodev", "mode=755", "size=65536k"}},
			{"destination": r.cfg.EnvSocketPath, "type": "bind", "source": r.cfg.EnvSocketHostPath, "options": []string{"bind", "rw"}},
		},
		Linux: map[string]any{
			"cgroupsPath": "wisp/" + r.cfg.WispName + "/user/" + r.cfg.ContainerID,
			"namespaces": []map[string]string{
				{"type": "pid"},
				{"type": "ipc"},
				{"type": "uts"},
				{"type": "mount"},
				{"type": "cgroup"},
			},
			"maskedPaths": []string{
				"/proc/acpi", "/proc/asound", "/proc/latency_stats",
				"/proc/timer_stats", "/proc/sched_debug",
			},
			"readonlyPaths": []string{"/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"},
		},
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(r.cfg.CrunBundleRoot, "config.json"), data, 0o644)
}

func (r *Runtime) ensureCrunBinary(ctx context.Context) error {
	if _, err := os.Stat(r.cfg.CrunBinaryPath); err == nil {
		if err := r.validateCrunBinary(ctx, r.cfg.CrunBinaryPath); err == nil {
			return nil
		}
		_ = os.Remove(r.cfg.CrunBinaryPath)
	}
	if err := os.MkdirAll(filepath.Dir(r.cfg.CrunBinaryPath), 0o755); err != nil {
		return err
	}
	switch {
	case r.cfg.CrunBinary != "":
		if err := r.run(ctx, "cp", r.cfg.CrunBinary, r.cfg.CrunBinaryPath); err != nil {
			return err
		}
	case hasCommand("crun"):
		path, _ := exec.LookPath("crun")
		if err := r.run(ctx, "cp", path, r.cfg.CrunBinaryPath); err != nil {
			return err
		}
	default:
		return errors.New("could not prepare crun; configure CRUN_BINARY or install crun on the host")
	}
	if err := os.Chmod(r.cfg.CrunBinaryPath, 0o755); err != nil {
		return err
	}
	return r.validateCrunBinary(ctx, r.cfg.CrunBinaryPath)
}

func (r *Runtime) ensureTiniBinary(ctx context.Context) error {
	target := filepath.Join(r.cfg.LowerSystem, ".pilot", "tini")
	if _, err := os.Stat(target); err == nil {
		return nil
	}
	switch {
	case r.cfg.TiniBinary != "":
		if err := r.run(ctx, "cp", r.cfg.TiniBinary, target); err != nil {
			return err
		}
	case hasCommand("tini-static"):
		path, _ := exec.LookPath("tini-static")
		if err := r.run(ctx, "cp", path, target); err != nil {
			return err
		}
	case hasCommand("tini"):
		path, _ := exec.LookPath("tini")
		if err := r.run(ctx, "cp", path, target); err != nil {
			return err
		}
	default:
		if err := downloadFile(ctx, tiniURL(r.cfg.TiniVersion), target); err != nil {
			return err
		}
	}
	return os.Chmod(target, 0o755)
}

func (r *Runtime) ensureWispFSAgentBinary(ctx context.Context) error {
	target := filepath.Join(r.cfg.LowerSystem, ".wisp", "bin", "wisp-fs-agent")
	if _, err := os.Stat(target); err == nil {
		return nil
	}
	source, err := resolveAuxBinary(r.cfg.WispFSAgentBinary, "wisp-fs-agent")
	if err != nil {
		return err
	}
	if err := r.run(ctx, "cp", source, target); err != nil {
		return err
	}
	return os.Chmod(target, 0o755)
}

func (r *Runtime) validateCrunBinary(ctx context.Context, path string) error {
	cmd := exec.CommandContext(ctx, path, "--version")
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg != "" {
			return fmt.Errorf("crun binary is not usable at %s: %s: %w", path, msg, err)
		}
		return fmt.Errorf("crun binary is not usable at %s: %w", path, err)
	}
	return nil
}

func (r *Runtime) applyOuterCgroupPolicy(ctx context.Context) error {
	if err := r.configureOuterCgroup(); err != nil {
		return err
	}
	exists, err := r.containerExists(ctx)
	if err != nil {
		return err
	}
	if exists {
		return r.assignContainerToOuterCgroup(ctx)
	}
	return nil
}

func (r *Runtime) configureOuterCgroup() error {
	for _, dir := range []string{r.cfg.CgroupRoot, r.cfg.CgroupParent, r.cfg.CgroupRuntimeParent, r.cfg.CgroupUserParent, r.cfg.CgroupUserContainer} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	for _, dir := range []string{"/sys/fs/cgroup", r.cfg.CgroupParent, r.cfg.CgroupUserParent} {
		r.enableCgroupControllers(dir)
	}

	totalMem, err := detectTotalMemoryBytes()
	if err != nil {
		return err
	}
	reserveMem := r.cfg.MemoryReserveMB * 1024 * 1024
	userMemMax := parseInt64OrDefault(r.cfg.UserMemoryMaxBytes, totalMem-reserveMem)
	if userMemMax < 268435456 {
		userMemMax = 268435456
	}
	userMemHigh := parseInt64OrDefault(r.cfg.UserMemoryHighBytes, userMemMax*r.cfg.MemoryHighPercent/100)
	_ = maybeWriteFile(filepath.Join(r.cfg.CgroupUserParent, "memory.max"), strconv.FormatInt(userMemMax, 10))
	_ = maybeWriteFile(filepath.Join(r.cfg.CgroupUserParent, "memory.high"), strconv.FormatInt(userMemHigh, 10))

	totalMilli := int64(runtime.NumCPU() * 1000)
	userMilli := parseInt64OrDefault(r.cfg.UserCPUMaxMillicores, totalMilli-r.cfg.CPUReserveMillicores)
	if userMilli < 100 {
		userMilli = 100
	}
	if userMilli >= totalMilli {
		_ = maybeWriteFile(filepath.Join(r.cfg.CgroupUserParent, "cpu.max"), fmt.Sprintf("max %d", r.cfg.CPUPeriodUS))
	} else {
		quota := userMilli * r.cfg.CPUPeriodUS / 1000
		if quota < 1000 {
			quota = 1000
		}
		_ = maybeWriteFile(filepath.Join(r.cfg.CgroupUserParent, "cpu.max"), fmt.Sprintf("%d %d", quota, r.cfg.CPUPeriodUS))
	}

	userPIDsMax := int64(1024)
	if r.cfg.UserPIDsMax != "" {
		userPIDsMax = parseInt64OrDefault(r.cfg.UserPIDsMax, userPIDsMax)
	} else if r.cfg.TotalPIDsBudget != "" {
		userPIDsMax = parseInt64OrDefault(r.cfg.TotalPIDsBudget, 1024) - r.cfg.RuntimePIDsReserve
		if userPIDsMax < 32 {
			userPIDsMax = 32
		}
	}
	_ = maybeWriteFile(filepath.Join(r.cfg.CgroupUserParent, "pids.max"), strconv.FormatInt(userPIDsMax, 10))
	_ = maybeWriteFile(filepath.Join(r.cfg.CgroupUserContainer, "memory.max"), "max")
	_ = maybeWriteFile(filepath.Join(r.cfg.CgroupUserContainer, "memory.high"), "max")
	_ = maybeWriteFile(filepath.Join(r.cfg.CgroupUserContainer, "pids.max"), "max")
	_ = maybeWriteFile(filepath.Join(r.cfg.CgroupUserContainer, "cpu.max"), fmt.Sprintf("max %d", r.cfg.CPUPeriodUS))
	return nil
}

func (r *Runtime) enableCgroupControllers(dir string) {
	subtree := filepath.Join(dir, "cgroup.subtree_control")
	controllersFile := filepath.Join(dir, "cgroup.controllers")
	if _, err := os.Stat(subtree); err != nil {
		return
	}
	current := string(readFileBestEffort(subtree))
	controllers := string(readFileBestEffort(controllersFile))
	for _, ctrl := range []string{"cpu", "memory", "pids"} {
		if strings.Contains(controllers, ctrl) && !strings.Contains(current, ctrl) {
			_ = os.WriteFile(subtree, []byte("+"+ctrl+"\n"), 0o644)
		}
	}
}

func (r *Runtime) assignContainerToOuterCgroup(ctx context.Context) error {
	pid, err := r.containerPID(ctx)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(r.cfg.CgroupUserContainer, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(r.cfg.CgroupUserContainer, "cgroup.procs"), []byte(pid+"\n"), 0o644)
}

func (r *Runtime) cleanupOuterCgroup() {
	for _, dir := range []string{r.cfg.CgroupUserContainer, r.cfg.CgroupRuntimeParent, r.cfg.CgroupUserParent, r.cfg.CgroupParent, r.cfg.CgroupRoot} {
		_ = os.Remove(dir)
	}
}

func (r *Runtime) containerExists(ctx context.Context) (bool, error) {
	cmd := exec.CommandContext(ctx, r.cfg.CrunBinaryPath, "--root", r.cfg.CrunStateRoot, "state", r.cfg.ContainerID)
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return false, nil
		}
		if errors.Is(err, exec.ErrNotFound) || strings.Contains(err.Error(), "no such file") {
			return false, nil
		}
		return false, nil
	}
	return true, nil
}

func (r *Runtime) containerPID(ctx context.Context) (string, error) {
	out, err := r.output(ctx, r.cfg.CrunBinaryPath, "--root", r.cfg.CrunStateRoot, "state", r.cfg.ContainerID)
	if err != nil {
		return "", err
	}
	var state struct {
		PID int `json:"pid"`
	}
	if err := json.Unmarshal([]byte(out), &state); err == nil && state.PID > 0 {
		return strconv.Itoa(state.PID), nil
	}
	return "", errors.New("failed to determine container PID")
}

func (r *Runtime) safeUmount(ctx context.Context, target string) error {
	_ = ctx
	if !r.isMountpoint(ctx, target) {
		return nil
	}
	return syscall.Unmount(target, 0)
}

func (r *Runtime) mountSyscall(source, target, fstype string, flags uintptr, data string) error {
	if err := syscall.Mount(source, target, fstype, flags, data); err != nil {
		detail := ""
		if fstype != "" {
			detail = " type=" + fstype
		}
		if data != "" {
			detail += " data=" + data
		}
		return fmt.Errorf("mount %s -> %s%s: %w", source, target, detail, err)
	}
	return nil
}

func (r *Runtime) mountReadOnly(source, target string) error {
	return r.mountSyscall(source, target, "ext4", syscall.MS_RDONLY, "")
}

const msLazyTime = 0x2000000

func (r *Runtime) mountDevice(source, target string, flags uintptr) error {
	flags |= syscall.MS_NOATIME | msLazyTime
	return r.mountSyscall(source, target, "ext4", flags, "commit=20,discard")
}

func (r *Runtime) mountOverlay(target, options string) error {
	return r.mountSyscall("overlay", target, "overlay", 0, options)
}

func (r *Runtime) bindMount(source, target string) error {
	return r.mountSyscall(source, target, "", syscall.MS_BIND, "")
}

func (r *Runtime) bindMountRecursive(source, target string) error {
	return r.mountSyscall(source, target, "", syscall.MS_BIND|syscall.MS_REC, "")
}

func (r *Runtime) remountBindReadOnly(target string) error {
	return r.mountSyscall("", target, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, "")
}

func (r *Runtime) makeRSlave(target string) error {
	return r.mountSyscall("", target, "", syscall.MS_SLAVE|syscall.MS_REC, "")
}

func (r *Runtime) makeRPrivate(target string) error {
	return r.mountSyscall("", target, "", syscall.MS_PRIVATE|syscall.MS_REC, "")
}

func (r *Runtime) ensurePrivateMountRoot(ctx context.Context, target string) error {
	_ = ctx
	if !r.isMountpoint(ctx, target) {
		if err := r.bindMount(target, target); err != nil {
			return err
		}
	}
	return r.makeRPrivate(target)
}

func (r *Runtime) safeUmountRecursive(ctx context.Context, target string) error {
	_ = ctx
	if !r.isMountpoint(ctx, target) {
		return nil
	}
	for _, mountpoint := range r.mountpointsUnder(target) {
		if err := syscall.Unmount(mountpoint, 0); err != nil && !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOENT) {
			return err
		}
	}
	return nil
}

func (r *Runtime) ensureUnmounted(ctx context.Context, target string) error {
	if !r.isMountpoint(ctx, target) {
		return nil
	}
	if err := r.safeUmount(ctx, target); err == nil && !r.isMountpoint(ctx, target) {
		return nil
	}
	if err := syscall.Unmount(target, syscall.MNT_DETACH); err != nil && !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOENT) && r.isMountpoint(ctx, target) {
		return fmt.Errorf("failed to unmount %s: %w", target, err)
	}
	if r.isMountpoint(ctx, target) {
		return fmt.Errorf("mountpoint still present after unmount attempts: %s", target)
	}
	return nil
}

func (r *Runtime) ensureUnmountedRecursive(ctx context.Context, target string) error {
	mounts := r.mountpointsUnder(target)
	if len(mounts) == 1 && mounts[0] == target && !r.isMountpoint(ctx, target) {
		return nil
	}
	if err := r.safeUmountRecursive(ctx, target); err == nil {
		stillMounted := false
		for _, mountpoint := range mounts {
			if r.isMountpoint(ctx, mountpoint) {
				stillMounted = true
				break
			}
		}
		if !stillMounted {
			return nil
		}
	}
	for _, mountpoint := range mounts {
		if !r.isMountpoint(ctx, mountpoint) {
			continue
		}
		if err := syscall.Unmount(mountpoint, syscall.MNT_DETACH); err != nil && !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOENT) {
			return fmt.Errorf("failed to recursively unmount %s via %s: %w", target, mountpoint, err)
		}
	}
	for _, mountpoint := range mounts {
		if r.isMountpoint(ctx, mountpoint) {
			return fmt.Errorf("mountpoint still present after recursive unmount attempts: %s", mountpoint)
		}
	}
	return nil
}

func (r *Runtime) ensureLoopDetached(ctx context.Context, dev string) error {
	_ = ctx
	f, err := os.OpenFile(dev, os.O_RDONLY, 0)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), uintptr(loopClrFD), 0); errno != 0 && errno != syscall.ENXIO && errno != syscall.EINVAL {
		return fmt.Errorf("loop detach ioctl failed for %s: %w", dev, errno)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !r.loopDeviceAttached(dev) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	if r.loopDeviceAttached(dev) {
		return fmt.Errorf("loop device still attached after detach attempts: %s", dev)
	}
	return nil
}

func (r *Runtime) attachLoopDevice(imagePath string, readOnly bool) (string, error) {
	backingFlags := os.O_RDWR
	if readOnly {
		backingFlags = os.O_RDONLY
	}
	backing, err := os.OpenFile(imagePath, backingFlags, 0)
	if err != nil {
		return "", fmt.Errorf("open backing file %s: %w", imagePath, err)
	}
	defer backing.Close()

	control, err := os.OpenFile("/dev/loop-control", os.O_RDONLY, 0)
	if err != nil {
		return "", fmt.Errorf("open /dev/loop-control: %w", err)
	}
	defer control.Close()

	loopNum, err := unix.IoctlRetInt(int(control.Fd()), unix.LOOP_CTL_GET_FREE)
	if err != nil {
		return "", fmt.Errorf("allocate free loop device: %w", err)
	}
	loopDev := fmt.Sprintf("/dev/loop%d", loopNum)

	loop, err := os.OpenFile(loopDev, os.O_RDWR, 0)
	if err != nil {
		return "", fmt.Errorf("open loop device %s: %w", loopDev, err)
	}
	defer loop.Close()

	if err := unix.IoctlSetInt(int(loop.Fd()), unix.LOOP_SET_FD, int(backing.Fd())); err != nil {
		return "", fmt.Errorf("attach loop device %s: %w", loopDev, err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_, _, _ = syscall.Syscall(syscall.SYS_IOCTL, loop.Fd(), uintptr(loopClrFD), 0)
		}
	}()

	if readOnly {
		// Do not use LO_FLAGS_AUTOCLEAR here. The loop fd is closed before the
		// caller mounts loopDev, and autoclear would detach the backing file
		// immediately. Callers already detach explicitly on failure/cleanup.
		info := &unix.LoopInfo64{Flags: unix.LO_FLAGS_READ_ONLY}
		if err := unix.IoctlLoopSetStatus64(int(loop.Fd()), info); err != nil {
			return "", fmt.Errorf("set loop read-only %s: %w", loopDev, err)
		}
	}

	cleanup = false
	return loopDev, nil
}

func (r *Runtime) mountpointsUnder(target string) []string {
	f, err := os.Open(runtimeMountInfoPath())
	if err != nil {
		return []string{target}
	}
	defer f.Close()

	var mounts []string
	scanner := bufio.NewScanner(f)
	prefix := target + "/"
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 5 {
			continue
		}
		mountpoint := fields[4]
		if mountpoint == target || strings.HasPrefix(mountpoint, prefix) {
			mounts = append(mounts, mountpoint)
		}
	}
	sort.Slice(mounts, func(i, j int) bool {
		return len(mounts[i]) > len(mounts[j])
	})
	if len(mounts) == 0 {
		return []string{target}
	}
	return mounts
}

func runtimeMountInfoPath() string {
	if runtimeMountInfoPathOverride != nil {
		return runtimeMountInfoPathOverride()
	}
	return "/proc/self/mountinfo"
}

var runtimeMountInfoPathOverride func() string

type runtimeMountInfoDetail struct {
	Mountpoint string
	FSType     string
	Source     string
	Root       string
	Line       string
	OK         bool
}

func (r *Runtime) mountInfoForPath(target string) (string, string, bool) {
	detail := r.mountInfoDetailForPath(target)
	return detail.Mountpoint, detail.FSType, detail.OK
}

func (r *Runtime) mountInfoDetailForPath(target string) runtimeMountInfoDetail {
	f, err := os.Open(runtimeMountInfoPath())
	if err != nil {
		return runtimeMountInfoDetail{}
	}
	defer f.Close()

	target = filepath.Clean(target)
	best := runtimeMountInfoDetail{}

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 {
			continue
		}
		sep := -1
		for i, field := range fields {
			if field == "-" {
				sep = i
				break
			}
		}
		if sep == -1 || sep+2 >= len(fields) {
			continue
		}
		mountpoint := fields[4]
		if !mountpointCoversPath(mountpoint, target) {
			continue
		}
		if len(mountpoint) < len(best.Mountpoint) {
			continue
		}
		best = runtimeMountInfoDetail{
			Mountpoint: mountpoint,
			FSType:     fields[sep+1],
			Source:     fields[sep+2],
			Root:       fields[3],
			Line:       line,
			OK:         true,
		}
	}
	return best
}

func isJuiceFSFSType(fsType string) bool {
	return strings.Contains(strings.ToLower(fsType), "juicefs")
}

func mountpointCoversPath(mountpoint, target string) bool {
	mountpoint = filepath.Clean(mountpoint)
	target = filepath.Clean(target)
	if mountpoint == "/" {
		return strings.HasPrefix(target, "/")
	}
	return target == mountpoint || strings.HasPrefix(target, mountpoint+"/")
}

func (r *Runtime) logCheckpointCloneMountDiagnostics(target, observedMountpoint, observedFSType string, observedOK bool) {
	detail := r.mountInfoDetailForPath(target)
	if detail.OK {
		observedMountpoint = detail.Mountpoint
		observedFSType = detail.FSType
		observedOK = true
	}
	mntNS := ""
	if ns, err := os.Readlink("/proc/self/ns/mnt"); err == nil {
		mntNS = ns
	}
	r.log("checkpoint_mount_diag target=%q jfs_root=%q active_img=%q checkpoints_root=%q jfs_bin=%q mountinfo_path=%q mnt_ns=%q mountinfo_ok=%t observed_mountpoint=%q observed_fs_type=%q observed_source=%q observed_root=%q target_statfs=%q jfs_root_statfs=%q mountinfo_line=%q",
		target,
		r.cfg.JFSRoot,
		r.cfg.ActiveImg,
		r.cfg.CheckpointsRoot,
		r.cfg.JFSBin,
		runtimeMountInfoPath(),
		mntNS,
		observedOK,
		observedMountpoint,
		observedFSType,
		detail.Source,
		detail.Root,
		statFSForLog(target),
		statFSForLog(r.cfg.JFSRoot),
		oneLineForLog(detail.Line, 1200),
	)
}

func statFSForLog(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "stat", "-f", "-c", "type=%T id=%i namelen=%l bsize=%s", path).CombinedOutput()
	text := oneLineForLog(string(out), 600)
	if err != nil {
		if text == "" {
			return err.Error()
		}
		return text + " err=" + err.Error()
	}
	return text
}

func oneLineForLog(value string, limit int) string {
	value = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\n", " "), "\r", " "))
	if limit > 0 && len(value) > limit {
		return value[:limit] + "...<truncated>"
	}
	return value
}

func isBenignSformatError(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "already exists") || strings.Contains(msg, "not empty")
}

func (r *Runtime) loopDeviceAttached(dev string) bool {
	base := filepath.Base(dev)
	data, err := os.ReadFile(filepath.Join("/sys/block", base, "loop", "backing_file"))
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(data)) != ""
}

func (r *Runtime) isMountpoint(ctx context.Context, path string) bool {
	_ = ctx
	mountpoint, _, ok := r.mountInfoForPath(path)
	return ok && mountpoint == path
}

func (r *Runtime) run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if stderr.Len() == 0 {
			return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
		}
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func (r *Runtime) runLogged(ctx context.Context, label, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	var stdout bytes.Buffer
	cmd.Stdout = io.MultiWriter(&stdout, newRuntimeLogWriter(r, label, false))
	cmd.Stderr = io.MultiWriter(&stderr, newRuntimeLogWriter(r, label, true))
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if msg == "" {
			return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
		}
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, msg)
	}
	return nil
}

type runtimeLogWriter struct {
	r      *Runtime
	label  string
	stream string
	buf    []byte
}

func newRuntimeLogWriter(r *Runtime, label string, stderr bool) *runtimeLogWriter {
	stream := "stdout"
	if stderr {
		stream = "stderr"
	}
	return &runtimeLogWriter{r: r, label: label, stream: stream}
}

func (w *runtimeLogWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		w.logLine(string(w.buf[:i]))
		w.buf = w.buf[i+1:]
	}
	return len(p), nil
}

func (w *runtimeLogWriter) logLine(line string) {
	line = strings.TrimSpace(strings.Trim(line, "\r"))
	if line == "" {
		return
	}
	w.r.log("%s %s %s", w.label, w.stream, line)
}

func (r *Runtime) runDetached(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open %s: %w", os.DevNull, err)
	}
	defer devNull.Close()

	stdoutFile, err := os.CreateTemp("", "wisp-detached-stdout-*")
	if err != nil {
		return fmt.Errorf("create detached stdout file: %w", err)
	}
	defer os.Remove(stdoutFile.Name())
	defer stdoutFile.Close()
	stderrFile, err := os.CreateTemp("", "wisp-detached-stderr-*")
	if err != nil {
		return fmt.Errorf("create detached stderr file: %w", err)
	}
	defer os.Remove(stderrFile.Name())
	defer stderrFile.Close()

	cmd.Stdin = devNull
	cmd.Stdout = stdoutFile
	cmd.Stderr = stderrFile
	if err := cmd.Run(); err != nil {
		detail := ""
		_ = stdoutFile.Close()
		_ = stderrFile.Close()
		stderr, _ := os.ReadFile(stderrFile.Name())
		stdout, _ := os.ReadFile(stdoutFile.Name())
		if text := oneLineForLog(string(stderr), 2048); text != "" {
			detail += " stderr=" + strconv.Quote(text)
		}
		if text := oneLineForLog(string(stdout), 2048); text != "" {
			detail += " stdout=" + strconv.Quote(text)
		}
		return fmt.Errorf("%s %s: %w%s", name, strings.Join(args, " "), err, detail)
	}
	return nil
}

func (r *Runtime) runTo(ctx context.Context, w io.Writer, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = w
	cmd.Stderr = io.Discard
	return cmd.Run()
}

func (r *Runtime) output(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

func (r *Runtime) log(format string, args ...any) {
	fmt.Printf("[wisp] "+format+"\n", args...)
}

func requireRoot() error {
	if os.Geteuid() != 0 {
		return errors.New("this command must run as root")
	}
	return nil
}

func requireCommands(commands ...string) error {
	var missing []string
	for _, cmd := range commands {
		if !hasCommand(cmd) {
			missing = append(missing, cmd)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing commands: %s", strings.Join(missing, " "))
	}
	return nil
}

func hasCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func parseByteSize(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, errors.New("empty size")
	}
	multiplier := int64(1)
	last := value[len(value)-1]
	switch last {
	case 'k', 'K':
		multiplier = 1 << 10
		value = value[:len(value)-1]
	case 'm', 'M':
		multiplier = 1 << 20
		value = value[:len(value)-1]
	case 'g', 'G':
		multiplier = 1 << 30
		value = value[:len(value)-1]
	case 't', 'T':
		multiplier = 1 << 40
		value = value[:len(value)-1]
	case 'p', 'P':
		multiplier = 1 << 50
		value = value[:len(value)-1]
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, err
	}
	if n < 0 {
		return 0, errors.New("negative size")
	}
	return n * multiplier, nil
}

func resolveAuxBinary(explicitPath, name string) (string, error) {
	if path := strings.TrimSpace(explicitPath); path != "" {
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
		return "", fmt.Errorf("%s binary not found at %s", name, path)
	}

	var candidates []string
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, name),
			filepath.Join(exeDir, "dist", name),
			filepath.Join(exeDir, "..", "dist", name),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(wd, name),
			filepath.Join(wd, "dist", name),
		)
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not prepare %s binary; configure WISP_FS_AGENT_BINARY or build %s on the host", name, name)
}

func appendIfMissing(path, prefix, line string) error {
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if strings.Contains(string(data), prefix) {
		return nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.WriteString(f, line)
	return err
}

func maybeWriteFile(path, value string) error {
	if info, err := os.Stat(path); err == nil && info.Mode().Perm()&0o200 == 0 {
		return nil
	}
	return os.WriteFile(path, []byte(value+"\n"), 0o644)
}

func (r *Runtime) startSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	ctx, span := runtimeTracer.Start(ctx, name)
	if len(attrs) > 0 {
		span.SetAttributes(attrs...)
	}
	span.SetAttributes(
		attribute.String("wisp.container", r.cfg.WispName),
		attribute.String("wisp.state_root", r.cfg.StateRoot),
	)
	return ctx, span
}

func (r *Runtime) traceStep(ctx context.Context, name string, fn func(context.Context) error) error {
	ctx, span := r.startSpan(ctx, name)
	defer span.End()
	if err := fn(ctx); err != nil {
		recordSpanErr(span, err)
		return err
	}
	return nil
}

func recordSpanErr(span trace.Span, err error) {
	if err == nil {
		return
	}
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
}

func detectTotalMemoryBytes() (int64, error) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, err := strconv.ParseInt(fields[1], 10, 64)
				if err != nil {
					return 0, err
				}
				return kb * 1024, nil
			}
		}
	}
	return 0, errors.New("MemTotal not found")
}

func parseInt64OrDefault(v string, fallback int64) int64 {
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return fallback
	}
	return n
}

func humanDuration(d time.Duration) string {
	if d <= 0 {
		return "0ms"
	}
	if d < time.Millisecond {
		return d.String()
	}
	ms := d.Milliseconds()
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	return fmt.Sprintf("%.3fs", d.Seconds())
}

func smhHTTPTraceEnabled() bool {
	for _, name := range []string{"SMH_HTTP_TRACE", "COS_HTTP_TRACE"} {
		v := strings.TrimSpace(os.Getenv(name))
		if v != "" && v != "0" && !strings.EqualFold(v, "false") {
			return true
		}
	}
	return false
}

type timedStep struct {
	name string
	dur  time.Duration
}

func humanOpSummary(op, container string, total time.Duration, steps ...timedStep) string {
	if len(steps) == 0 {
		return fmt.Sprintf("HUMAN %s %s took %s", op, container, humanDuration(total))
	}
	slowest := steps[0]
	for _, step := range steps[1:] {
		if step.dur > slowest.dur {
			slowest = step
		}
	}
	return fmt.Sprintf("HUMAN %s %s took %s; slowest=%s(%s)",
		op, container, humanDuration(total), slowest.name, humanDuration(slowest.dur))
}

func readFileBestEffort(path string) []byte {
	data, _ := os.ReadFile(path)
	return data
}

func diagnosticStat(path string) string {
	if strings.TrimSpace(path) == "" {
		return "empty_path"
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Sprintf("error=%v", err)
	}
	return fmt.Sprintf("mode=%s size=%d mod=%s", info.Mode(), info.Size(), info.ModTime().Format(time.RFC3339))
}

func diagnosticDirEntries(path string) string {
	if strings.TrimSpace(path) == "" {
		return "empty_path"
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return fmt.Sprintf("error=%v", err)
	}
	capacity := len(entries)
	if capacity > 20 {
		capacity = 20
	}
	names := make([]string, 0, capacity)
	for i, entry := range entries {
		if i >= 20 {
			names = append(names, fmt.Sprintf("...(+%d)", len(entries)-i))
			break
		}
		suffix := ""
		if entry.IsDir() {
			suffix = "/"
		}
		names = append(names, entry.Name()+suffix)
	}
	if len(names) == 0 {
		return "empty"
	}
	return strings.Join(names, ",")
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func daysSinceUnixEpoch() int64 {
	return time.Now().Unix() / 86400
}

func renderResolvConf(nameservers string) string {
	var lines []string
	for _, field := range strings.FieldsFunc(nameservers, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t'
	}) {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		lines = append(lines, "nameserver "+field)
	}
	if len(lines) == 0 {
		lines = append(lines, "nameserver 114.114.114.114")
	}
	return strings.Join(lines, "\n") + "\n"
}

func shellArgs(path string) []string {
	switch filepath.Base(path) {
	case "bash":
		return []string{"--noprofile", "--norc", "-i"}
	case "zsh":
		return []string{"-f", "-i"}
	case "sh":
		return []string{"-i"}
	default:
		return nil
	}
}

func shellQuote(v string) string {
	return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'"
}

func tiniURL(version string) string {
	switch runtime.GOARCH {
	case "amd64":
		return fmt.Sprintf("https://github.com/krallin/tini/releases/download/%s/tini-static-amd64", version)
	case "arm64":
		return fmt.Sprintf("https://github.com/krallin/tini/releases/download/%s/tini-static-arm64", version)
	default:
		return ""
	}
}

func downloadFile(ctx context.Context, url, target string) error {
	if url == "" {
		return errors.New("unsupported architecture for automatic binary download")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("download %s: unexpected status %s", url, resp.Status)
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

func allCapabilities() map[string][]string {
	caps := []string{
		"CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL",
		"CAP_SETGID", "CAP_SETUID", "CAP_SETPCAP", "CAP_NET_BIND_SERVICE", "CAP_NET_ADMIN",
		"CAP_NET_RAW", "CAP_SYS_CHROOT", "CAP_SYS_ADMIN", "CAP_MKNOD", "CAP_AUDIT_WRITE", "CAP_SETFCAP",
	}
	return map[string][]string{
		"bounding":    caps,
		"effective":   caps,
		"inheritable": caps,
		"permitted":   caps,
		"ambient":     caps,
	}
}

func init() {
	http.DefaultClient.Timeout = 5 * time.Minute
}

var _ = syscall.Getpid
