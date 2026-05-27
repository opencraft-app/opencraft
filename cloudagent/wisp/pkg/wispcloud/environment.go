package wispcloud

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const defaultWispPackageURL = "http://cloudagent-sidecar-shanghai-1388575217.cos.ap-shanghai.myqcloud.com/workspace/20260522/wisp-linux-amd64-20260522T181421Z-7826101eb1c5.tar.gz"

type WispEnvironmentSDK struct {
	ags        *AGSClient
	smh        *SMHClient
	workspaces WorkspaceService
}

type WispEnvironmentSDKConfig struct {
	AGSClient        *AGSClient
	SMHClient        *SMHClient
	WorkspaceService WorkspaceService
	AGS              AGSClientConfig
	SMH              SMHClientConfig
}

type WispEnvironmentOptions struct {
	WorkspaceID           string
	EnvironmentID         string
	TemplateID            string
	PackageURL            string
	WispName              string
	JFSPrefix             string
	RootUpperSize         string
	SandboxTimeoutSeconds int
	LeaseTTL              time.Duration
	Mount                 WispMountOptions
	Metadata              map[string]string
}

type WispMountOptions struct {
	Writeback           string
	UploadDelay         string
	MaxUploads          string
	CacheSize           string
	MinFreeBytes        string
	BarrierPollInterval string
	SMHHTTPTrace        string
}

type WispEnvironment struct {
	sdk *WispEnvironmentSDK

	WorkspaceID   string
	EnvironmentID string
	Sandbox       AGSSandbox
	SMHSpace      SMHSpace
	WispName      string
	PackageURL    string
	JFSPrefix     string
	RootUpper     string
	CreateStdout  string
	CreateStderr  string
	CreatedAt     time.Time
	Lease         WorkspaceLease

	ownsSMHSpace bool
}

type WispCommandOutput struct {
	CommandResult
	Elapsed time.Duration
}

type WispEnvironmentInfo struct {
	WorkspaceID string    `json:"workspace_id"`
	RuntimeID   string    `json:"runtime_id"`
	WispName    string    `json:"wisp_name"`
	PackageURL  string    `json:"package_url"`
	JFSPrefix   string    `json:"jfs_prefix"`
	RootUpper   string    `json:"root_upper"`
	CreatedAt   time.Time `json:"created_at"`
	LeaseID     string    `json:"lease_id,omitempty"`
	Fence       int64     `json:"fencing_token,omitempty"`
	LeaseUntil  time.Time `json:"lease_until,omitempty"`

	EnvironmentID string `json:"environment_id,omitempty"`
	SMHSpaceID    string `json:"smh_space_id,omitempty"`
	SandboxID     string `json:"sandbox_id,omitempty"`
}

type WispEnvironmentState struct {
	WorkspaceID   string         `json:"workspace_id"`
	EnvironmentID string         `json:"environment_id,omitempty"`
	Sandbox       AGSSandbox     `json:"sandbox"`
	SMHSpace      SMHSpace       `json:"smh_space"`
	WispName      string         `json:"wisp_name"`
	PackageURL    string         `json:"package_url"`
	JFSPrefix     string         `json:"jfs_prefix"`
	RootUpper     string         `json:"root_upper"`
	CreatedAt     time.Time      `json:"created_at"`
	Lease         WorkspaceLease `json:"lease,omitempty"`
	OwnsSMHSpace  bool           `json:"owns_smh_space,omitempty"`
}

func NewWispEnvironmentSDK(cfg WispEnvironmentSDKConfig) (*WispEnvironmentSDK, error) {
	ags := cfg.AGSClient
	var err error
	if ags == nil {
		ags, err = NewAGSClient(cfg.AGS)
		if err != nil {
			return nil, err
		}
	}
	smh := cfg.SMHClient
	if smh == nil {
		smh, err = NewSMHClient(cfg.SMH)
		if err != nil {
			return nil, err
		}
	}
	return &WispEnvironmentSDK{ags: ags, smh: smh, workspaces: cfg.WorkspaceService}, nil
}

func (s *WispEnvironmentSDK) Attach(state WispEnvironmentState) *WispEnvironment {
	if s == nil {
		return nil
	}
	return &WispEnvironment{
		sdk:           s,
		WorkspaceID:   state.WorkspaceID,
		EnvironmentID: state.EnvironmentID,
		Sandbox:       state.Sandbox,
		SMHSpace:      state.SMHSpace,
		WispName:      state.WispName,
		PackageURL:    state.PackageURL,
		JFSPrefix:     state.JFSPrefix,
		RootUpper:     state.RootUpper,
		CreatedAt:     state.CreatedAt,
		Lease:         state.Lease,
		ownsSMHSpace:  state.OwnsSMHSpace,
	}
}

func (s *WispEnvironmentSDK) Create(ctx context.Context, opts WispEnvironmentOptions) (*WispEnvironment, error) {
	templateID := strings.TrimSpace(opts.TemplateID)
	if templateID == "" {
		templateID = strings.TrimSpace(firstEnv("GATEWAY_AGS_TEMPLATE", "INNER_SANDBOX_TEMPLATE", "E2B_TEMPLATE"))
	}
	if templateID == "" {
		return nil, errors.New("Wisp environment template id is required")
	}
	packageURL := strings.TrimSpace(opts.PackageURL)
	if packageURL == "" {
		packageURL = firstNonEmpty(firstEnv("WISP_SDK_PACKAGE_URL", "WISP_FAST_PACKAGE_URL", "WISP_PACKAGE_URL"), defaultWispPackageURL)
	}
	jfsPrefix := strings.TrimSpace(opts.JFSPrefix)
	if jfsPrefix == "" {
		jfsPrefix = "workspace-wisp-sdk"
	}
	rootUpper := strings.TrimSpace(opts.RootUpperSize)
	if rootUpper == "" {
		rootUpper = "5G"
	}
	timeout := opts.SandboxTimeoutSeconds
	if timeout == 0 {
		timeout = 900
	}

	workspaceID := firstNonEmpty(strings.TrimSpace(opts.WorkspaceID), strings.TrimSpace(opts.EnvironmentID))
	var (
		space      SMHSpace
		err        error
		spaceOwned bool
	)
	if workspaceID != "" {
		space, err = s.smh.OpenSpace(ctx, workspaceID)
	} else {
		space, err = s.smh.ProvisionSpace(ctx)
		spaceOwned = true
	}
	if err != nil {
		return nil, err
	}
	workspaceID = space.SpaceID
	if s.workspaces != nil {
		if err := s.workspaces.EnsureWorkspace(ctx, WorkspaceRecord{
			WorkspaceID:         workspaceID,
			Backend:             "smh",
			ProviderWorkspaceID: space.SpaceID,
			State:               "active",
		}); err != nil {
			return nil, err
		}
	}
	wispName := strings.TrimSpace(opts.WispName)
	if wispName == "" {
		wispName = wispNameFromWorkspaceID(workspaceID)
	}
	var sandbox AGSSandbox
	sandboxOwned := false
	var lease WorkspaceLease
	leaseHeld := false
	defer func() {
		if leaseHeld && s.workspaces != nil {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_ = s.workspaces.ReleaseLease(cleanupCtx, lease)
		}
		if sandboxOwned {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			_ = s.ags.DeleteSandbox(cleanupCtx, sandbox.SandboxID)
		}
		if spaceOwned {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			_ = s.smh.DeleteSpace(cleanupCtx, space.SpaceID)
		}
	}()

	metadata := map[string]string{
		"purpose":        "wisp-runtime",
		"workspace_id":   workspaceID,
		"environment_id": workspaceID,
		"smh_space_id":   space.SpaceID,
	}
	for k, v := range opts.Metadata {
		metadata[k] = v
	}
	sandbox, err = s.ags.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:          templateID,
		TimeoutSeconds:      timeout,
		AllowInternetAccess: true,
		Metadata:            metadata,
	})
	if err != nil {
		return nil, err
	}
	sandboxOwned = true
	if s.workspaces != nil {
		lease, err = s.workspaces.AcquireLease(ctx, WorkspaceLeaseRequest{
			WorkspaceID: workspaceID,
			RuntimeID:   sandbox.SandboxID,
			Provider:    "ags",
			TTL:         opts.LeaseTTL,
		})
		if err != nil {
			return nil, err
		}
		leaseHeld = true
	}

	env := wispCreateEnv(s.smh, space, packageURL, wispName, jfsPrefix, rootUpper, opts.Mount)
	var stdout strings.Builder
	var stderr strings.Builder
	result, err := s.ags.RunCommand(ctx, sandbox, wispCreateScript(), env, func(text string) error {
		stdout.WriteString(text)
		return nil
	}, func(text string) error {
		stderr.WriteString(text)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("create Wisp environment: %w\nstdout:\n%s\nstderr:\n%s", err, redactWispSecrets(stdout.String()), redactWispSecrets(stderr.String()))
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("create Wisp environment exited with code %d\nstdout:\n%s\nstderr:\n%s", result.ExitCode, redactWispSecrets(result.Stdout), redactWispSecrets(result.Stderr))
	}
	if !strings.Contains(result.Stdout, "WISP_ENV_READY") {
		return nil, fmt.Errorf("create Wisp environment did not report ready\nstdout:\n%s\nstderr:\n%s", redactWispSecrets(result.Stdout), redactWispSecrets(result.Stderr))
	}

	envOwnsSpace := spaceOwned
	sandboxOwned = false
	spaceOwned = false
	leaseHeld = false
	return &WispEnvironment{
		sdk:           s,
		WorkspaceID:   workspaceID,
		EnvironmentID: workspaceID,
		Sandbox:       sandbox,
		SMHSpace:      space,
		WispName:      wispName,
		PackageURL:    packageURL,
		JFSPrefix:     jfsPrefix,
		RootUpper:     rootUpper,
		CreateStdout:  result.Stdout,
		CreateStderr:  result.Stderr,
		CreatedAt:     time.Now().UTC(),
		Lease:         lease,
		ownsSMHSpace:  envOwnsSpace,
	}, nil
}

func (e *WispEnvironment) ID() string {
	if e == nil {
		return ""
	}
	return e.Workspace()
}

func (e *WispEnvironment) Workspace() string {
	if e == nil {
		return ""
	}
	return firstNonEmpty(e.WorkspaceID, e.EnvironmentID, e.SMHSpace.SpaceID)
}

func (e *WispEnvironment) RuntimeID() string {
	if e == nil {
		return ""
	}
	return e.Sandbox.SandboxID
}

func (e *WispEnvironment) SpaceID() string {
	if e == nil {
		return ""
	}
	return e.SMHSpace.SpaceID
}

func (e *WispEnvironment) SandboxID() string {
	return e.RuntimeID()
}

func (e *WispEnvironment) Info() WispEnvironmentInfo {
	if e == nil {
		return WispEnvironmentInfo{}
	}
	return WispEnvironmentInfo{
		WorkspaceID:   e.Workspace(),
		RuntimeID:     e.RuntimeID(),
		WispName:      e.WispName,
		PackageURL:    e.PackageURL,
		JFSPrefix:     e.JFSPrefix,
		RootUpper:     e.RootUpper,
		CreatedAt:     e.CreatedAt,
		LeaseID:       e.Lease.LeaseID,
		Fence:         e.Lease.FencingToken,
		LeaseUntil:    e.Lease.ExpiresAt,
		EnvironmentID: e.Workspace(),
		SMHSpaceID:    e.SpaceID(),
		SandboxID:     e.RuntimeID(),
	}
}

func (e *WispEnvironment) State() WispEnvironmentState {
	if e == nil {
		return WispEnvironmentState{}
	}
	return WispEnvironmentState{
		WorkspaceID:   e.Workspace(),
		EnvironmentID: e.EnvironmentID,
		Sandbox:       e.Sandbox,
		SMHSpace:      e.SMHSpace,
		WispName:      e.WispName,
		PackageURL:    e.PackageURL,
		JFSPrefix:     e.JFSPrefix,
		RootUpper:     e.RootUpper,
		CreatedAt:     e.CreatedAt,
		Lease:         e.Lease,
		OwnsSMHSpace:  e.ownsSMHSpace,
	}
}

func (e *WispEnvironment) ExecShell(ctx context.Context, command string) (WispCommandOutput, error) {
	if e == nil || e.sdk == nil {
		return WispCommandOutput{}, errors.New("Wisp environment is not initialized")
	}
	command = strings.TrimSpace(command)
	if command == "" {
		return WispCommandOutput{}, errors.New("command is required")
	}
	started := time.Now()
	result, err := e.sdk.ags.RunCommand(ctx, e.Sandbox, wispExecScript(), map[string]string{
		"WISP_NAME":    e.WispName,
		"WISP_COMMAND": command,
	}, nil, nil)
	return WispCommandOutput{CommandResult: result, Elapsed: time.Since(started)}, err
}

func (e *WispEnvironment) Stop(ctx context.Context) (WispCommandOutput, error) {
	if e == nil || e.sdk == nil {
		return WispCommandOutput{}, errors.New("Wisp environment is not initialized")
	}
	started := time.Now()
	result, err := e.sdk.ags.RunCommand(ctx, e.Sandbox, wispStopScript(), map[string]string{
		"WISP_NAME": e.WispName,
	}, nil, nil)
	return WispCommandOutput{CommandResult: result, Elapsed: time.Since(started)}, err
}

func (e *WispEnvironment) Close(ctx context.Context) error {
	return e.close(ctx, e != nil && e.ownsSMHSpace)
}

func (e *WispEnvironment) CloseRuntime(ctx context.Context) error {
	return e.close(ctx, false)
}

func (e *WispEnvironment) Delete(ctx context.Context) error {
	return e.close(ctx, true)
}

func (e *WispEnvironment) close(ctx context.Context, deleteSpace bool) error {
	if e == nil || e.sdk == nil {
		return nil
	}
	var errs []string
	if e.sdk.workspaces != nil && e.Lease.LeaseID != "" {
		if err := e.sdk.workspaces.MarkLeaseReleasing(ctx, e.Lease); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if e.Sandbox.SandboxID != "" {
		if err := e.sdk.ags.DeleteSandbox(ctx, e.Sandbox.SandboxID); err != nil {
			errs = append(errs, err.Error())
		} else {
			e.Sandbox.SandboxID = ""
		}
	}
	if e.sdk.workspaces != nil && e.Lease.LeaseID != "" {
		if err := e.sdk.workspaces.ReleaseLease(ctx, e.Lease); err != nil {
			errs = append(errs, err.Error())
		} else {
			e.Lease = WorkspaceLease{}
		}
	}
	if deleteSpace && e.SMHSpace.SpaceID != "" {
		if err := e.sdk.smh.DeleteSpace(ctx, e.SMHSpace.SpaceID); err != nil {
			errs = append(errs, err.Error())
		} else {
			e.SMHSpace.SpaceID = ""
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func wispNameFromWorkspaceID(workspaceID string) string {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return "wisp-" + randomHex(6)
	}
	var b strings.Builder
	for _, r := range workspaceID {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	name := strings.Trim(b.String(), "-_.")
	if name == "" {
		name = randomHex(6)
	}
	if len(name) > 48 {
		name = name[:48]
	}
	return "wisp-" + name
}

func wispCreateEnv(smh *SMHClient, space SMHSpace, packageURL, wispName, jfsPrefix, rootUpper string, mount WispMountOptions) map[string]string {
	return map[string]string{
		"WISP_PACKAGE_URL":                    packageURL,
		"WISP_NAME":                           wispName,
		"SMH_LIBRARY_ID":                      smh.LibraryID(),
		"SMH_ACCESS_DOMAIN":                   smh.AccessDomain(),
		"SMH_SPACE_ID":                        space.SpaceID,
		"SMH_ACCESS_TOKEN":                    space.AccessToken,
		"SMH_HTTP_TRACE":                      firstNonEmpty(mount.SMHHTTPTrace, os.Getenv("SMH_HTTP_TRACE")),
		"JFS_PREFIX":                          jfsPrefix,
		"ROOT_UPPER_SIZE":                     rootUpper,
		"JFS_MOUNT_WRITEBACK":                 firstNonEmpty(mount.Writeback, os.Getenv("JFS_MOUNT_WRITEBACK"), "1"),
		"JFS_MOUNT_UPLOAD_DELAY":              firstNonEmpty(mount.UploadDelay, os.Getenv("JFS_MOUNT_UPLOAD_DELAY"), "10s"),
		"JFS_MOUNT_MAX_UPLOADS":               firstNonEmpty(mount.MaxUploads, os.Getenv("JFS_MOUNT_MAX_UPLOADS"), "20"),
		"JFS_MOUNT_CACHE_SIZE":                firstNonEmpty(mount.CacheSize, os.Getenv("JFS_MOUNT_CACHE_SIZE"), "64M"),
		"JFS_MOUNT_MIN_FREE_BYTES":            firstNonEmpty(mount.MinFreeBytes, os.Getenv("JFS_MOUNT_MIN_FREE_BYTES"), "200M"),
		"JFS_WRITEBACK_BARRIER_POLL_INTERVAL": firstNonEmpty(mount.BarrierPollInterval, os.Getenv("JFS_WRITEBACK_BARRIER_POLL_INTERVAL"), "30ms"),
	}
}

func wispCreateScript() string {
	return `
set -euo pipefail
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
step() { echo "TIMELINE $(ts) $*"; }

work="$(mktemp -d /tmp/wisp-sdk.XXXXXX)"
install="$work/install"
jfs_root="/mnt/smh-workspace"
log="$work/daemon.log"

step download_install_start
mkdir -p "$install"
curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 10 "$WISP_PACKAGE_URL" \
  | tar -xzf - -C "$install" --strip-components=1
"$install/scripts/install.sh" "$install" >/dev/null
step download_install_done

cat >"$install/config/config.jsonnet" <<EOF
local projectRoot = "$install";
{
  WISP_NAME: "default",
  REMOTE_BACKEND: "smh",
  COS_ENABLED: false,
  COS_WORKSPACE: "default",
  JFS_ROOT: "$jfs_root",
  SMH_ENABLED: true,
  SMH_LIBRARY_ID: "$SMH_LIBRARY_ID",
  SMH_ACCESS_DOMAIN: "$SMH_ACCESS_DOMAIN",
  SMH_SPACE_ID: "$SMH_SPACE_ID",
  SMH_TOKEN_TTL_SECONDS: 3600,
  JFS_LOCAL_ROOT: "$work/jfs-local",
  JFS_PREFIX: "$JFS_PREFIX",
  JFS_BIN: projectRoot + "/bin/juicefs-smount",
  JFS_BUILD: "0",
  JFS_SMOUNT_SCRIPT: projectRoot + "/juicefs/hack/smount.sh",
  JFS_SFORMAT_SCRIPT: projectRoot + "/juicefs/hack/sformat.sh",
  BASE_ROOTFS_IMG: projectRoot + "/assets/rootfs/images/plucky-amd64.img",
  CRUN_BINARY: projectRoot + "/assets/bin/crun/crun-amd64",
  WISPENV_BINARY: projectRoot + "/bin/wispenv",
  WISP_FS_AGENT_BINARY: projectRoot + "/bin/wisp-fs-agent",
  TINI_BINARY: projectRoot + "/assets/bin/tini/tini",
  WISP_USER: "root",
  WISP_UID: 0,
  WISP_GID: 0,
  ROOT_UPPER_SIZE: "$ROOT_UPPER_SIZE",
  ADMIN_LISTEN_ADDR: "127.0.0.1:8520",
}
EOF

sudo -n chmod 666 /dev/fuse || true
export PATH="$install/assets/bin/e2fsprogs/bin:$PATH"
export LD_LIBRARY_PATH="$install/assets/bin/e2fsprogs/lib:${LD_LIBRARY_PATH:-}"
if [[ ! -e /sys/fs/cgroup/cgroup.controllers ]]; then
  sudo -n mount -t cgroup2 cgroup2 /sys/fs/cgroup || true
fi

export WISP_CONFIG="$install/config/config.jsonnet"
export REMOTE_BACKEND=smh
export SMH_ENABLED=true
export COS_ENABLED=false
export JFS_ROOT="$jfs_root"
export JFS_LOCAL_ROOT="$work/jfs-local"
export JFS_BIN="$install/bin/juicefs-smount"
export JFS_BUILD=0
export JFS_SMOUNT_SCRIPT="$install/juicefs/hack/smount.sh"
export JFS_SFORMAT_SCRIPT="$install/juicefs/hack/sformat.sh"
export BASE_ROOTFS_IMG="$install/assets/rootfs/images/plucky-amd64.img"
export CRUN_BINARY="$install/assets/bin/crun/crun-amd64"
export CRUN_BINARY_PATH="/var/lib/wisp/shared/tools/crun"
export WISPENV_BINARY="$install/bin/wispenv"
export WISP_FS_AGENT_BINARY="$install/bin/wisp-fs-agent"
export TINI_BINARY="$install/assets/bin/tini/tini"
export ADMIN_LISTEN_ADDR="127.0.0.1:8520"

step daemon_start
sudo -n env \
  WISP_CONFIG="$WISP_CONFIG" \
  REMOTE_BACKEND="$REMOTE_BACKEND" \
  SMH_ENABLED="$SMH_ENABLED" \
  COS_ENABLED="$COS_ENABLED" \
  JFS_ROOT="$JFS_ROOT" \
  JFS_PREFIX="$JFS_PREFIX" \
  JFS_LOCAL_ROOT="$JFS_LOCAL_ROOT" \
  JFS_BIN="$JFS_BIN" \
  JFS_BUILD="$JFS_BUILD" \
  JFS_SMOUNT_SCRIPT="$JFS_SMOUNT_SCRIPT" \
  JFS_SFORMAT_SCRIPT="$JFS_SFORMAT_SCRIPT" \
  BASE_ROOTFS_IMG="$BASE_ROOTFS_IMG" \
  CRUN_BINARY="$CRUN_BINARY" \
  CRUN_BINARY_PATH="$CRUN_BINARY_PATH" \
  WISPENV_BINARY="$WISPENV_BINARY" \
  WISP_FS_AGENT_BINARY="$WISP_FS_AGENT_BINARY" \
  TINI_BINARY="$TINI_BINARY" \
  WISP_USER=root \
  WISP_UID=0 \
  WISP_GID=0 \
  PATH="$PATH" \
  LD_LIBRARY_PATH="$LD_LIBRARY_PATH" \
  ROOT_UPPER_SIZE="$ROOT_UPPER_SIZE" \
  ADMIN_LISTEN_ADDR="$ADMIN_LISTEN_ADDR" \
  SMH_LIBRARY_ID="$SMH_LIBRARY_ID" \
  SMH_ACCESS_DOMAIN="$SMH_ACCESS_DOMAIN" \
  SMH_SPACE_ID="$SMH_SPACE_ID" \
  SMH_ACCESS_TOKEN="$SMH_ACCESS_TOKEN" \
  SMH_HTTP_TRACE="$SMH_HTTP_TRACE" \
  JFS_MOUNT_WRITEBACK="$JFS_MOUNT_WRITEBACK" \
  JFS_MOUNT_UPLOAD_DELAY="$JFS_MOUNT_UPLOAD_DELAY" \
  JFS_MOUNT_MAX_UPLOADS="$JFS_MOUNT_MAX_UPLOADS" \
  JFS_MOUNT_CACHE_SIZE="$JFS_MOUNT_CACHE_SIZE" \
  JFS_MOUNT_MIN_FREE_BYTES="$JFS_MOUNT_MIN_FREE_BYTES" \
  JFS_WRITEBACK_BARRIER_POLL_INTERVAL="$JFS_WRITEBACK_BARRIER_POLL_INTERVAL" \
  "$install/bin/wisp" daemon run --config "$WISP_CONFIG" >"$log" 2>&1 &

for i in $(seq 1 30); do
  if "$install/bin/wispclient" -server http://127.0.0.1:8520 ls >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
"$install/bin/wispclient" -server http://127.0.0.1:8520 ls >/dev/null || { echo "daemon did not become ready" >&2; cat "$log" >&2 || true; exit 1; }
step daemon_ready

step bootstrap_start
"$install/bin/wispclient" -server http://127.0.0.1:8520 bootstrap || { echo "daemon log after bootstrap failure:" >&2; cat "$log" >&2 || true; exit 1; }
step bootstrap_done

step create_start
"$install/bin/wispclient" -server http://127.0.0.1:8520 create "$WISP_NAME" || { echo "daemon log after create failure:" >&2; cat "$log" >&2 || true; exit 1; }
step create_done

step start_start
"$install/bin/wispclient" -server http://127.0.0.1:8520 start "$WISP_NAME" || { echo "daemon log after start failure:" >&2; cat "$log" >&2 || true; exit 1; }
step start_done
step timing_summary_start
grep -aE 'ensure_cos_root (assertmount|wait_mount|usable_check|mounted)|ensure_workspace_ready|pre_start_recovery|active_image_valid|Restored active image|ensure_active_image|mount_runtime|persist_active_image|writeback_barrier|assertmount_detail |mount_target_timing |litestream barrier|checkpoint cut|file barrier|writeback barrier|SUMMARY (ensure_workspace_ready|ensure_active_image|mount_runtime|stop)|HUMAN stop|smh_http |cos_http |sqlite_litestream_trace |s3_litestream_trace ' "$log" || true
assert_log="/tmp/juicefs-assertmount.log"
if [[ -f "$assert_log" ]]; then
  grep -aE 'assertmount_detail |mount_target_timing |litestream sqlite startup timings|litestream barrier|checkpoint cut|file barrier|writeback barrier|Mounting volume|Data use|new session|skip mountpoint ready wait' "$assert_log" || true
fi
step timing_summary_done
echo "WISP_ENV_READY name=$WISP_NAME space=$SMH_SPACE_ID"
`
}

func wispExecScript() string {
	return `
set -euo pipefail
/tmp/wisp-sdk.*/install/bin/wispclient -server http://127.0.0.1:8520 exec "$WISP_NAME" -- /bin/sh -lc "$WISP_COMMAND"
`
}

func wispStopScript() string {
	return `
set -euo pipefail
/tmp/wisp-sdk.*/install/bin/wispclient -server http://127.0.0.1:8520 stop "$WISP_NAME"
`
}

func redactWispSecrets(text string) string {
	for _, secret := range []string{os.Getenv("SMH_LIBRARY_SECRET"), os.Getenv("SMH_ACCESS_TOKEN")} {
		if secret = strings.TrimSpace(secret); secret != "" {
			text = strings.ReplaceAll(text, secret, "<redacted>")
		}
	}
	const marker = "access_token="
	var out strings.Builder
	for {
		idx := strings.Index(text, marker)
		if idx < 0 {
			out.WriteString(text)
			return out.String()
		}
		out.WriteString(text[:idx+len(marker)])
		rest := text[idx+len(marker):]
		end := 0
		for end < len(rest) {
			ch := rest[end]
			if ch == '&' || ch == '\n' || ch == '\r' || ch == ' ' || ch == '"' || ch == '\'' {
				break
			}
			end++
		}
		out.WriteString("<redacted>")
		text = rest[end:]
	}
}
