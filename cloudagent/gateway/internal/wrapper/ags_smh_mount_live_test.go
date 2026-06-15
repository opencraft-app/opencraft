package wrapper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

const (
	defaultLiveWispFastPackageURL    = "https://cloudagent-sidecar-shanghai-1388575217.cos.ap-shanghai.myqcloud.com/workspace/releases/wisp-linux-amd64-20260612T025943Z-3f949bac72a5.erofs"
	defaultLiveWispFastPackageSHA256 = "8ceda87c563b684037ff390977e18e47f13bf215af0f262c82ea99316b73b67c"
)

func TestLiveAGSSMHMountSmoke(t *testing.T) {
	if os.Getenv("RUN_LIVE_AGS_SMH_MOUNT") != "1" {
		t.Skip("set RUN_LIVE_AGS_SMH_MOUNT=1 to run live AGS + SMH mount smoke")
	}
	templateID := strings.TrimSpace(os.Getenv("GATEWAY_AGS_TEMPLATE"))
	if templateID == "" {
		t.Skip("GATEWAY_AGS_TEMPLATE is required")
	}
	packageURL := strings.TrimSpace(os.Getenv("WISP_PACKAGE_URL"))
	packageSHA := strings.TrimSpace(os.Getenv("WISP_PACKAGE_SHA256"))
	if packageURL == "" || packageSHA == "" {
		t.Skip("WISP_PACKAGE_URL and WISP_PACKAGE_SHA256 are required")
	}

	libraryID := strings.TrimSpace(os.Getenv("SMH_LIBRARY_ID"))
	accessDomain := strings.TrimRight(strings.TrimSpace(os.Getenv("SMH_ACCESS_DOMAIN")), "/")
	librarySecret := strings.TrimSpace(os.Getenv("SMH_LIBRARY_SECRET"))
	if libraryID == "" || accessDomain == "" || librarySecret == "" {
		t.Skip("SMH_LIBRARY_ID, SMH_ACCESS_DOMAIN, and SMH_LIBRARY_SECRET are required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	spaceID, accessToken := provisionLiveSMHSpace(t, ctx, accessDomain, libraryID, librarySecret)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		if err := deleteLiveSMHSpace(cleanupCtx, accessDomain, libraryID, librarySecret, spaceID); err != nil {
			t.Logf("delete SMH space %s: %v", spaceID, err)
		}
	})

	client, err := NewAGSClient(AGSClientConfig{
		RequestTimeout: 4 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	sb, err := client.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:          templateID,
		TimeoutSeconds:      1800,
		AllowInternetAccess: true,
		Metadata: map[string]string{
			"purpose": "wisp-smh-mount-smoke",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer deleteCancel()
		if err := client.DeleteSandbox(deleteCtx, sb.SandboxID); err != nil {
			t.Logf("delete AGS sandbox %s: %v", sb.SandboxID, err)
		}
	})
	t.Logf("created AGS sandbox %s for SMH space %s", sb.SandboxID, spaceID)

	command := `
set -euo pipefail
work="$(mktemp -d /tmp/wisp-smh-smoke.XXXXXX)"
pkg="$work/wisp-package"
curl -fsSL "$WISP_PACKAGE_URL" -o "$pkg"
printf '%s  %s\n' "$WISP_PACKAGE_SHA256" "$pkg" | sha256sum -c -
mkdir -p "$work/root"
case "$WISP_PACKAGE_URL" in
  *.erofs) sudo -n mount -t erofs -o loop,ro "$pkg" "$work/root" ;;
  *) tar -xzf "$pkg" -C "$work/root" --strip-components=1 ;;
esac
root="$work/root"
workspace="smh-smoke-$(date +%s)"
mountpoint="$work/mount"
mkdir -p "$mountpoint" "$work/local" "$work/cache"
echo "fuse_probe:"
(id || true) >&2
(if ! command -v fusermount >/dev/null 2>&1 && [[ -x "$root/assets/bin/fuse/fusermount3" ]]; then sudo -n cp "$root/assets/bin/fuse/fusermount3" /bin/fusermount && sudo -n chmod 4755 /bin/fusermount; fi) >&2
(sudo -n chmod 666 /dev/fuse || chmod 666 /dev/fuse || true) >&2
(ls -l /dev/fuse || true) >&2
(grep -w fuse /proc/filesystems || true) >&2
(command -v fusermount || command -v fusermount3 || true) >&2
export REMOTE_BACKEND=smh
export SMH_ENABLED=true
export JFS_BIN="$root/bin/juicefs-smount"
export JFS_BUILD=0
export JFS_PREFIX="workspace-smh-smoke"
export JFS_LOCAL_ROOT="$work/local"
"$root/juicefs/hack/sformat.sh" "$workspace" -- --force --trash-days 0
"$root/juicefs/hack/smount.sh" "$workspace" "$mountpoint" -- -d --log "$work/juicefs.log" --cache-dir "$work/cache" >"$work/smount.log" 2>&1 &
smount_pid=$!
for i in $(seq 1 75); do
  if mountpoint -q "$mountpoint"; then
    break
  fi
  if ! kill -0 "$smount_pid" 2>/dev/null && ! mountpoint -q "$mountpoint"; then
    echo "smount exited before mount was ready" >&2
    cat "$work/smount.log" >&2 || true
    exit 1
  fi
  sleep 1
done
if ! mountpoint -q "$mountpoint"; then
  echo "mountpoint was not ready" >&2
  ps -ef | grep -E 'juicefs|smount' | grep -v grep >&2 || true
  echo "supervisor log:" >&2
  cat "$work/smount.log" >&2 || true
  echo "mount process log:" >&2
  cat "$work/juicefs.log" >&2 || true
  exit 1
fi
printf 'hello-smh\n' >"$mountpoint/probe.txt"
sync
cat "$mountpoint/probe.txt"
df -h "$mountpoint" | tail -1
(fusermount -u "$mountpoint" || umount "$mountpoint") >/dev/null 2>&1 || true
`
	var stdoutBuf strings.Builder
	var stderrBuf strings.Builder
	result, err := client.RunCommand(ctx, sb, command, map[string]string{
		"WISP_PACKAGE_URL":    packageURL,
		"WISP_PACKAGE_SHA256": packageSHA,
		"SMH_LIBRARY_ID":      libraryID,
		"SMH_ACCESS_DOMAIN":   accessDomain,
		"SMH_SPACE_ID":        spaceID,
		"SMH_ACCESS_TOKEN":    accessToken,
	}, func(text string) error {
		stdoutBuf.WriteString(text)
		return nil
	}, func(text string) error {
		stderrBuf.WriteString(text)
		return nil
	})
	if err != nil {
		t.Fatalf("%v\nstdout:\n%s\nstderr:\n%s", err, stdoutBuf.String(), stderrBuf.String())
	}
	if result.ExitCode != 0 {
		t.Fatalf("smh mount smoke exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "hello-smh") {
		t.Fatalf("smh mount smoke did not read probe file: stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
	t.Logf("SMH mount smoke succeeded")
}

func TestLiveAGSWispConsoleFull(t *testing.T) {
	if os.Getenv("RUN_LIVE_AGS_WISP_CONSOLE") != "1" {
		t.Skip("set RUN_LIVE_AGS_WISP_CONSOLE=1 to run live AGS + SMH + Wisp console integration")
	}
	templateID := strings.TrimSpace(os.Getenv("GATEWAY_AGS_TEMPLATE"))
	if templateID == "" {
		t.Skip("GATEWAY_AGS_TEMPLATE is required")
	}
	packageURL := strings.TrimSpace(os.Getenv("WISP_PACKAGE_URL"))
	packageSHA := strings.TrimSpace(os.Getenv("WISP_PACKAGE_SHA256"))
	if packageURL == "" || packageSHA == "" {
		t.Skip("WISP_PACKAGE_URL and WISP_PACKAGE_SHA256 are required")
	}

	libraryID := strings.TrimSpace(os.Getenv("SMH_LIBRARY_ID"))
	accessDomain := strings.TrimRight(strings.TrimSpace(os.Getenv("SMH_ACCESS_DOMAIN")), "/")
	librarySecret := strings.TrimSpace(os.Getenv("SMH_LIBRARY_SECRET"))
	if libraryID == "" || accessDomain == "" || librarySecret == "" {
		t.Skip("SMH_LIBRARY_ID, SMH_ACCESS_DOMAIN, and SMH_LIBRARY_SECRET are required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()

	spaceID, accessToken := provisionLiveSMHSpace(t, ctx, accessDomain, libraryID, librarySecret)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		if err := deleteLiveSMHSpace(cleanupCtx, accessDomain, libraryID, librarySecret, spaceID); err != nil {
			t.Logf("delete SMH space %s: %v", spaceID, err)
		}
	})

	client, err := NewAGSClient(AGSClientConfig{RequestTimeout: 11 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	sb, err := client.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:          templateID,
		TimeoutSeconds:      1800,
		AllowInternetAccess: true,
		Metadata: map[string]string{
			"purpose": "wisp-console-full",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer deleteCancel()
		if err := client.DeleteSandbox(deleteCtx, sb.SandboxID); err != nil {
			t.Logf("delete AGS sandbox %s: %v", sb.SandboxID, err)
		}
	})
	t.Logf("created AGS sandbox %s for full Wisp console flow using SMH space %s", sb.SandboxID, spaceID)

	command := `
set -euo pipefail
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
step() { echo "TIMELINE $(ts) $*"; }

work="$(mktemp -d /tmp/wisp-console-full.XXXXXX)"
pkg="$work/wisp-package"
install="$work/install"
wisp_name="full-$(date +%s)"
log="$work/daemon.log"

step download_package_start
curl -fsSL "$WISP_PACKAGE_URL" -o "$pkg"
printf '%s  %s\n' "$WISP_PACKAGE_SHA256" "$pkg" | sha256sum -c -
step download_package_done

step install_package_start
mkdir -p "$install"
case "$WISP_PACKAGE_URL" in
  *.erofs) sudo -n mount -t erofs -o loop,ro "$pkg" "$install" ;;
  *) tar -xzf "$pkg" -C "$install" --strip-components=1; "$install/scripts/install.sh" "$install" >/dev/null ;;
esac
cat >"$install/config/config.jsonnet" <<EOF
local projectRoot = "$install";
{
  WISP_NAME: "default",
  REMOTE_BACKEND: "smh",
  COS_ENABLED: false,
  COS_WORKSPACE: "default",
  JFS_ROOT: "/mnt/smh-workspace",
  SMH_ENABLED: true,
  SMH_LIBRARY_ID: "$SMH_LIBRARY_ID",
  SMH_ACCESS_DOMAIN: "$SMH_ACCESS_DOMAIN",
  SMH_SPACE_ID: "$SMH_SPACE_ID",
  SMH_TOKEN_TTL_SECONDS: 3600,
  JFS_LOCAL_ROOT: "$work/jfs-local",
  JFS_PREFIX: "workspace-full",
  JFS_BIN: projectRoot + "/bin/juicefs-smount",
  JFS_BUILD: "0",
  JFS_SMOUNT_SCRIPT: projectRoot + "/juicefs/hack/smount.sh",
  JFS_SFORMAT_SCRIPT: projectRoot + "/juicefs/hack/sformat.sh",
  LOWER_SYSTEM_BASE: projectRoot + "/assets/rootfs/rootfs",
  BASE_ROOTFS_DIR: projectRoot + "/assets/rootfs/rootfs",
  BASE_ROOTFS_IMG: "",
  CRUN_BINARY: projectRoot + "/assets/bin/crun/crun-amd64",
  WISPENV_BINARY: projectRoot + "/bin/wispenv",
  WISP_FS_AGENT_BINARY: projectRoot + "/bin/wisp-fs-agent",
  TINI_BINARY: projectRoot + "/assets/bin/tini/tini",
  ROOT_UPPER_SIZE: "2G",
  ADMIN_LISTEN_ADDR: "127.0.0.1:8520",
}
EOF
if ! command -v fusermount >/dev/null 2>&1 && [[ -x "$install/assets/bin/fuse/fusermount3" ]]; then
  sudo -n cp "$install/assets/bin/fuse/fusermount3" /bin/fusermount
  sudo -n chmod 4755 /bin/fusermount
fi
sudo -n chmod 666 /dev/fuse || true
step install_package_done

step host_prereq_start
export PATH="$install/assets/bin/e2fsprogs/bin:$PATH"
export LD_LIBRARY_PATH="$install/assets/bin/e2fsprogs/lib:${LD_LIBRARY_PATH:-}"
if [[ ! -e /sys/fs/cgroup/cgroup.controllers ]]; then
  sudo -n mount -t cgroup2 cgroup2 /sys/fs/cgroup || true
fi
echo "host_prereq commands: $(command -v mke2fs || true) $(command -v e2fsck || true)"
echo "host_prereq cgroup2: $(test -e /sys/fs/cgroup/cgroup.controllers && echo yes || echo no)"
step host_prereq_done

step loop_ext4_probe_start
probe_img="$work/probe-ext4.img"
probe_mnt="$work/probe-ext4-mnt"
probe_loop=""
truncate -s 64M "$probe_img"
mke2fs -F -t ext4 -m 0 -O sparse_super2,^64bit,^metadata_csum "$probe_img" >/dev/null
mkdir -p "$probe_mnt"
probe_loop="$(sudo -n losetup --find --show "$probe_img")"
if sudo -n mount -t ext4 -o ro "$probe_loop" "$probe_mnt"; then
  echo "loop_ext4_probe: ok loop=$probe_loop"
  sudo -n umount "$probe_mnt"
  sudo -n losetup -d "$probe_loop"
  probe_loop=""
else
  echo "loop_ext4_probe: failed loop=$probe_loop" >&2
  dmesg | tail -50 >&2 || true
  sudo -n losetup -d "$probe_loop" >/dev/null 2>&1 || true
  exit 1
fi
step loop_ext4_probe_done

export WISP_CONFIG="$install/config/config.jsonnet"
export REMOTE_BACKEND=smh
export SMH_ENABLED=true
export COS_ENABLED=false
export JFS_ROOT="/mnt/smh-workspace"
export JFS_PREFIX="workspace-full"
export JFS_LOCAL_ROOT="$work/jfs-local"
export JFS_BIN="$install/bin/juicefs-smount"
export JFS_BUILD=0
export JFS_SMOUNT_SCRIPT="$install/juicefs/hack/smount.sh"
export JFS_SFORMAT_SCRIPT="$install/juicefs/hack/sformat.sh"
export BASE_ROOTFS_DIR="$install/assets/rootfs/rootfs"
export BASE_ROOTFS_IMG=""
export CRUN_BINARY="$install/assets/bin/crun/crun-amd64"
export CRUN_BINARY_PATH="/var/lib/wisp/shared/tools/crun"
export WISPENV_BINARY="$install/bin/wispenv"
export WISP_FS_AGENT_BINARY="$install/bin/wisp-fs-agent"
export TINI_BINARY="$install/assets/bin/tini/tini"
export ROOT_UPPER_SIZE="2G"
export ADMIN_LISTEN_ADDR="127.0.0.1:8520"
export SMH_LIBRARY_ID
export SMH_ACCESS_DOMAIN
export SMH_SPACE_ID
export SMH_ACCESS_TOKEN
export SMH_HTTP_TRACE="${SMH_HTTP_TRACE:-}"

step base_rootfs_probe_start
ls -la "$BASE_ROOTFS_DIR" | head
if [[ ! -f "$BASE_ROOTFS_DIR/.wisp-base-ready" ]]; then
  echo "base_rootfs_probe: missing .wisp-base-ready in $BASE_ROOTFS_DIR" >&2
  exit 1
fi
echo "base_rootfs_probe: direct_dir_ok path=$BASE_ROOTFS_DIR"
step base_rootfs_probe_done

step daemon_start
ls -lh "$install/bin/wisp" "$install/bin/wispclient"
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
  BASE_ROOTFS_DIR="$BASE_ROOTFS_DIR" \
  BASE_ROOTFS_IMG="$BASE_ROOTFS_IMG" \
  CRUN_BINARY="$CRUN_BINARY" \
  CRUN_BINARY_PATH="$CRUN_BINARY_PATH" \
  WISPENV_BINARY="$WISPENV_BINARY" \
  WISP_FS_AGENT_BINARY="$WISP_FS_AGENT_BINARY" \
  TINI_BINARY="$TINI_BINARY" \
  PATH="$PATH" \
  LD_LIBRARY_PATH="$LD_LIBRARY_PATH" \
  ROOT_UPPER_SIZE="$ROOT_UPPER_SIZE" \
  ADMIN_LISTEN_ADDR="$ADMIN_LISTEN_ADDR" \
  SMH_LIBRARY_ID="$SMH_LIBRARY_ID" \
  SMH_ACCESS_DOMAIN="$SMH_ACCESS_DOMAIN" \
  SMH_SPACE_ID="$SMH_SPACE_ID" \
  SMH_ACCESS_TOKEN="$SMH_ACCESS_TOKEN" \
  SMH_HTTP_TRACE="$SMH_HTTP_TRACE" \
  "$install/bin/wisp" daemon run --config "$WISP_CONFIG" >"$log" 2>&1 &
daemon_pid=$!
trap 'sudo -n kill '"$daemon_pid"' >/dev/null 2>&1 || true' EXIT

for i in $(seq 1 60); do
  if "$install/bin/wispclient" -server http://127.0.0.1:8520 ls >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"$install/bin/wispclient" -server http://127.0.0.1:8520 ls >/dev/null || { echo "daemon did not become ready" >&2; cat "$log" >&2 || true; exit 1; }
step daemon_ready

step bootstrap_global_start
"$install/bin/wispclient" -server http://127.0.0.1:8520 bootstrap || { echo "daemon log after bootstrap failure:" >&2; cat "$log" >&2 || true; exit 1; }
step bootstrap_global_done

step create_wisp_start
"$install/bin/wispclient" -server http://127.0.0.1:8520 create "$wisp_name" || { echo "daemon log after create failure:" >&2; cat "$log" >&2 || true; exit 1; }
step create_wisp_done

step start_wisp_start
"$install/bin/wispclient" -server http://127.0.0.1:8520 start "$wisp_name" || { echo "daemon log after start failure:" >&2; cat "$log" >&2 || true; exit 1; }
step start_wisp_done

step console_exec_start
"$install/bin/wispclient" -server http://127.0.0.1:8520 exec "$wisp_name" -- /bin/sh -lc 'set -e; echo WISP_CONSOLE_OK; id; pwd; ls -la / | head; /.wisp/bin/wispenv info || true' || { echo "daemon log after console failure:" >&2; cat "$log" >&2 || true; exit 1; }
step console_exec_done

step status_start
"$install/bin/wispclient" -server http://127.0.0.1:8520 status "$wisp_name"
step status_done
`
	var stdoutBuf strings.Builder
	var stderrBuf strings.Builder
	result, err := client.RunCommand(ctx, sb, command, map[string]string{
		"WISP_PACKAGE_URL":    packageURL,
		"WISP_PACKAGE_SHA256": packageSHA,
		"SMH_LIBRARY_ID":      libraryID,
		"SMH_ACCESS_DOMAIN":   accessDomain,
		"SMH_SPACE_ID":        spaceID,
		"SMH_ACCESS_TOKEN":    accessToken,
		"SMH_HTTP_TRACE":      os.Getenv("SMH_HTTP_TRACE"),
	}, func(text string) error {
		stdoutBuf.WriteString(text)
		return nil
	}, func(text string) error {
		stderrBuf.WriteString(text)
		return nil
	})
	if err != nil {
		t.Fatalf("%v\nstdout:\n%s\nstderr:\n%s", err, redactLiveSMHSecrets(stdoutBuf.String()), redactLiveSMHSecrets(stderrBuf.String()))
	}
	if result.ExitCode != 0 {
		t.Fatalf("full Wisp console flow exit=%d stdout=%q stderr=%q", result.ExitCode, redactLiveSMHSecrets(result.Stdout), redactLiveSMHSecrets(result.Stderr))
	}
	if !strings.Contains(result.Stdout, "WISP_CONSOLE_OK") {
		t.Fatalf("full Wisp console flow did not reach console: stdout=%q stderr=%q", redactLiveSMHSecrets(result.Stdout), redactLiveSMHSecrets(result.Stderr))
	}
	t.Logf("full Wisp console flow succeeded")
}

func TestLiveAGSWispConsoleFast(t *testing.T) {
	if os.Getenv("RUN_LIVE_AGS_WISP_CONSOLE_FAST") != "1" {
		t.Skip("set RUN_LIVE_AGS_WISP_CONSOLE_FAST=1 to run the fast live AGS + SMH + Wisp console path")
	}
	templateID := strings.TrimSpace(os.Getenv("GATEWAY_AGS_TEMPLATE"))
	if templateID == "" {
		t.Skip("GATEWAY_AGS_TEMPLATE is required")
	}
	packageURL := firstNonEmpty(firstEnv("WISP_FAST_PACKAGE_URL", "WISP_PACKAGE_URL"), defaultLiveWispFastPackageURL)
	packageSHA := firstNonEmpty(firstEnv("WISP_FAST_PACKAGE_SHA256", "WISP_PACKAGE_SHA256"), defaultLiveWispFastPackageSHA256)

	backend := strings.ToLower(strings.TrimSpace(os.Getenv("WISP_FAST_BACKEND")))
	if backend == "" {
		backend = "smh"
	}
	if backend != "smh" && backend != "cos" {
		t.Fatalf("WISP_FAST_BACKEND must be smh or cos, got %q", backend)
	}

	libraryID := strings.TrimSpace(os.Getenv("SMH_LIBRARY_ID"))
	accessDomain := strings.TrimRight(strings.TrimSpace(os.Getenv("SMH_ACCESS_DOMAIN")), "/")
	librarySecret := strings.TrimSpace(os.Getenv("SMH_LIBRARY_SECRET"))
	if backend == "smh" && (libraryID == "" || accessDomain == "" || librarySecret == "") {
		t.Skip("SMH_LIBRARY_ID, SMH_ACCESS_DOMAIN, and SMH_LIBRARY_SECRET are required")
	}
	reuseSMHSpaceID := strings.TrimSpace(os.Getenv("WISP_FAST_REUSE_SPACE_ID"))
	keepSMHSpace := truthyTestEnv("WISP_FAST_KEEP_SPACE")
	wispNameOverride := strings.TrimSpace(os.Getenv("WISP_FAST_NAME"))
	cosBucket := strings.TrimSpace(os.Getenv("COS_BUCKET"))
	cosRegion := strings.TrimSpace(os.Getenv("COS_REGION"))
	cosEndpoint := strings.TrimSpace(os.Getenv("COS_ENDPOINT"))
	cosSecretID := strings.TrimSpace(firstEnv("COS_SECRETID", "AWS_ACCESS_KEY_ID"))
	cosSecretKey := strings.TrimSpace(firstEnv("COS_SECRETKEY", "AWS_SECRET_ACCESS_KEY"))
	if backend == "cos" {
		if cosEndpoint == "" && cosRegion != "" {
			cosEndpoint = "https://cos." + cosRegion + ".myqcloud.com"
		}
		if cosBucket == "" || cosRegion == "" || cosEndpoint == "" || cosSecretID == "" || cosSecretKey == "" {
			t.Skip("COS_BUCKET, COS_REGION, COS_ENDPOINT, COS_SECRETID, and COS_SECRETKEY are required for WISP_FAST_BACKEND=cos")
		}
	}

	requestTimeout := liveDurationEnv("WISP_FAST_REQUEST_TIMEOUT", 4*time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()

	client, err := NewAGSClient(AGSClientConfig{RequestTimeout: requestTimeout})
	if err != nil {
		t.Fatal(err)
	}

	type sandboxCreateResult struct {
		sandbox AGSSandbox
		err     error
	}
	type smhProvisionResult struct {
		spaceID     string
		accessToken string
		err         error
	}
	sandboxCh := make(chan sandboxCreateResult, 1)
	smhCh := make(chan smhProvisionResult, 1)

	go func() {
		sb, err := client.CreateSandbox(ctx, CreateSandboxOptions{
			TemplateID:          templateID,
			TimeoutSeconds:      900,
			AllowInternetAccess: true,
			Metadata: map[string]string{
				"purpose": "wisp-console-fast",
			},
		})
		sandboxCh <- sandboxCreateResult{sandbox: sb, err: err}
	}()
	var spaceID, accessToken string
	if backend == "smh" {
		if reuseSMHSpaceID != "" {
			go func() {
				httpClient := &http.Client{Timeout: 30 * time.Second}
				accessToken, err := issueLiveSMHTokenValue(ctx, httpClient, accessDomain, libraryID, librarySecret, reuseSMHSpaceID, "admin")
				smhCh <- smhProvisionResult{spaceID: reuseSMHSpaceID, accessToken: accessToken, err: err}
			}()
		} else {
			go func() {
				spaceID, accessToken, err := provisionLiveSMHSpaceValue(ctx, accessDomain, libraryID, librarySecret)
				smhCh <- smhProvisionResult{spaceID: spaceID, accessToken: accessToken, err: err}
			}()
		}

		smhResult := <-smhCh
		if smhResult.err != nil {
			t.Fatal(smhResult.err)
		}
		spaceID, accessToken = smhResult.spaceID, smhResult.accessToken
		if reuseSMHSpaceID != "" || keepSMHSpace {
			t.Logf("keeping SMH space %s (reuse=%t keep=%t)", spaceID, reuseSMHSpaceID != "", keepSMHSpace)
		} else {
			t.Cleanup(func() {
				cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 45*time.Second)
				defer cleanupCancel()
				if err := deleteLiveSMHSpace(cleanupCtx, accessDomain, libraryID, librarySecret, spaceID); err != nil {
					t.Logf("delete SMH space %s: %v", spaceID, err)
				}
			})
		}
	}

	sandboxResult := <-sandboxCh
	if sandboxResult.err != nil {
		t.Fatal(sandboxResult.err)
	}
	sb := sandboxResult.sandbox
	t.Cleanup(func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer deleteCancel()
		if err := client.DeleteSandbox(deleteCtx, sb.SandboxID); err != nil {
			t.Logf("delete AGS sandbox %s: %v", sb.SandboxID, err)
		}
	})
	if backend == "smh" {
		t.Logf("created AGS sandbox %s for fast Wisp console flow using SMH space %s", sb.SandboxID, spaceID)
	} else {
		t.Logf("created AGS sandbox %s for fast Wisp console flow using COS bucket %s region %s", sb.SandboxID, cosBucket, cosRegion)
	}

	command := `
set -euo pipefail
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
step() { echo "TIMELINE $(ts) $*"; }

work="$(mktemp -d /tmp/wisp-console-fast.XXXXXX)"
pkg="$work/wisp-package"
install="$work/install"
wisp_name="${WISP_FAST_NAME:-fast-$(date +%s)}"
log="$work/daemon.log"

step download_start
curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 10 "$WISP_PACKAGE_URL" -o "$pkg"
printf '%s  %s\n' "$WISP_PACKAGE_SHA256" "$pkg" | sha256sum -c -
step download_done

step install_start
mkdir -p "$install"
case "$WISP_PACKAGE_URL" in
  *.erofs) sudo -n mount -t erofs -o loop,ro "$pkg" "$install" ;;
  *) tar -xzf "$pkg" -C "$install" --strip-components=1; "$install/scripts/install.sh" "$install" >/dev/null ;;
esac
backend="${WISP_REMOTE_BACKEND:-smh}"
jfs_prefix="${JFS_PREFIX_OVERRIDE:-workspace-fast}"
wisp_user="${WISP_FAST_WISP_USER:-wisp}"
wisp_uid="${WISP_FAST_WISP_UID:-1001}"
wisp_gid="${WISP_FAST_WISP_GID:-1001}"
case "$backend" in
  smh)
    jfs_root="/mnt/smh-workspace"
    smh_enabled=true
    cos_enabled=false
    ;;
  cos)
    jfs_root="/mnt/cos-workspace"
    smh_enabled=false
    cos_enabled=true
    ;;
  *)
    echo "unsupported WISP_REMOTE_BACKEND=$backend" >&2
    exit 2
    ;;
esac
cat >"$install/config/config.jsonnet" <<EOF
local projectRoot = "$install";
{
  WISP_NAME: "default",
  REMOTE_BACKEND: "$backend",
  COS_ENABLED: $cos_enabled,
  COS_WORKSPACE: "default",
  COS_BUCKET: "$COS_BUCKET",
  COS_REGION: "$COS_REGION",
  COS_ENDPOINT: "$COS_ENDPOINT",
  TENCENTCLOUD_SECRET_ID: "$COS_SECRETID",
  TENCENTCLOUD_SECRET_KEY: "$COS_SECRETKEY",
  SMH_ENABLED: $smh_enabled,
  SMH_LIBRARY_ID: "$SMH_LIBRARY_ID",
  SMH_ACCESS_DOMAIN: "$SMH_ACCESS_DOMAIN",
  SMH_SPACE_ID: "$SMH_SPACE_ID",
  SMH_TOKEN_TTL_SECONDS: 3600,
  JFS_ROOT: "$jfs_root",
  JFS_LOCAL_ROOT: "$work/jfs-local",
  JFS_PREFIX: "$jfs_prefix",
  JFS_BIN: projectRoot + "/bin/juicefs-smount",
  JFS_BUILD: "0",
  JFS_SMOUNT_SCRIPT: projectRoot + "/juicefs/hack/smount.sh",
  JFS_SFORMAT_SCRIPT: projectRoot + "/juicefs/hack/sformat.sh",
  LOWER_SYSTEM_BASE: projectRoot + "/assets/rootfs/rootfs",
  BASE_ROOTFS_DIR: projectRoot + "/assets/rootfs/rootfs",
  BASE_ROOTFS_IMG: "",
  CRUN_BINARY: projectRoot + "/assets/bin/crun/crun-amd64",
  WISPENV_BINARY: projectRoot + "/bin/wispenv",
  WISP_FS_AGENT_BINARY: projectRoot + "/bin/wisp-fs-agent",
  TINI_BINARY: projectRoot + "/assets/bin/tini/tini",
  WISP_USER: "$wisp_user",
  WISP_UID: $wisp_uid,
  WISP_GID: $wisp_gid,
  ROOT_UPPER_SIZE: "2G",
  ADMIN_LISTEN_ADDR: "127.0.0.1:8520",
}
EOF
if ! command -v fusermount >/dev/null 2>&1 && [[ -x "$install/assets/bin/fuse/fusermount3" ]]; then
  sudo -n cp "$install/assets/bin/fuse/fusermount3" /bin/fusermount
  sudo -n chmod 4755 /bin/fusermount
fi
sudo -n chmod 666 /dev/fuse || true
export PATH="$install/assets/bin/e2fsprogs/bin:$PATH"
export LD_LIBRARY_PATH="$install/assets/bin/e2fsprogs/lib:${LD_LIBRARY_PATH:-}"
if [[ ! -e /sys/fs/cgroup/cgroup.controllers ]]; then
  sudo -n mount -t cgroup2 cgroup2 /sys/fs/cgroup || true
fi
step install_done

export WISP_CONFIG="$install/config/config.jsonnet"
export REMOTE_BACKEND="$backend"
export SMH_ENABLED="$smh_enabled"
export COS_ENABLED="$cos_enabled"
export JFS_ROOT="$jfs_root"
export JFS_PREFIX="$jfs_prefix"
export JFS_LOCAL_ROOT="$work/jfs-local"
export JFS_BIN="$install/bin/juicefs-smount"
export JFS_BUILD=0
export JFS_SMOUNT_SCRIPT="$install/juicefs/hack/smount.sh"
export JFS_SFORMAT_SCRIPT="$install/juicefs/hack/sformat.sh"
export BASE_ROOTFS_DIR="$install/assets/rootfs/rootfs"
export BASE_ROOTFS_IMG=""
export CRUN_BINARY="$install/assets/bin/crun/crun-amd64"
export CRUN_BINARY_PATH="/var/lib/wisp/shared/tools/crun"
export WISPENV_BINARY="$install/bin/wispenv"
export WISP_FS_AGENT_BINARY="$install/bin/wisp-fs-agent"
export TINI_BINARY="$install/assets/bin/tini/tini"
export ROOT_UPPER_SIZE="2G"
export ADMIN_LISTEN_ADDR="127.0.0.1:8520"
export SMH_LIBRARY_ID
export SMH_ACCESS_DOMAIN
export SMH_SPACE_ID
export SMH_ACCESS_TOKEN
export SMH_HTTP_TRACE="${SMH_HTTP_TRACE:-}"
export COS_BUCKET
export COS_REGION
export COS_ENDPOINT
export COS_SECRETID
export COS_SECRETKEY
export TENCENTCLOUD_SECRET_ID="$COS_SECRETID"
export TENCENTCLOUD_SECRET_KEY="$COS_SECRETKEY"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-$COS_SECRETID}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-$COS_SECRETKEY}"
export COS_HTTP_TRACE="${COS_HTTP_TRACE:-}"
export LITESTREAM_S3_HTTP_TRACE="${LITESTREAM_S3_HTTP_TRACE:-$COS_HTTP_TRACE}"
export JFS_ASSERTMOUNT_SYNC_INTERVAL="${JFS_ASSERTMOUNT_SYNC_INTERVAL:-}"
export JFS_ASSERTMOUNT_SKIP_OBJECT_STORAGE_CHECK="${JFS_ASSERTMOUNT_SKIP_OBJECT_STORAGE_CHECK:-}"
export JFS_ASSERTMOUNT_SNAPSHOT_INTERVAL="${JFS_ASSERTMOUNT_SNAPSHOT_INTERVAL:-}"
export JFS_ASSERTMOUNT_RUNTIME_MAINTENANCE="${JFS_ASSERTMOUNT_RUNTIME_MAINTENANCE:-}"

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
  BASE_ROOTFS_DIR="$BASE_ROOTFS_DIR" \
  BASE_ROOTFS_IMG="$BASE_ROOTFS_IMG" \
  CRUN_BINARY="$CRUN_BINARY" \
  CRUN_BINARY_PATH="$CRUN_BINARY_PATH" \
  WISPENV_BINARY="$WISPENV_BINARY" \
  WISP_FS_AGENT_BINARY="$WISP_FS_AGENT_BINARY" \
  TINI_BINARY="$TINI_BINARY" \
  WISP_USER="$wisp_user" \
  WISP_UID="$wisp_uid" \
  WISP_GID="$wisp_gid" \
  PATH="$PATH" \
  LD_LIBRARY_PATH="$LD_LIBRARY_PATH" \
  ROOT_UPPER_SIZE="$ROOT_UPPER_SIZE" \
  ADMIN_LISTEN_ADDR="$ADMIN_LISTEN_ADDR" \
  SMH_LIBRARY_ID="$SMH_LIBRARY_ID" \
  SMH_ACCESS_DOMAIN="$SMH_ACCESS_DOMAIN" \
  SMH_SPACE_ID="$SMH_SPACE_ID" \
  SMH_ACCESS_TOKEN="$SMH_ACCESS_TOKEN" \
  SMH_HTTP_TRACE="$SMH_HTTP_TRACE" \
  COS_BUCKET="$COS_BUCKET" \
  COS_REGION="$COS_REGION" \
  COS_ENDPOINT="$COS_ENDPOINT" \
  COS_SECRETID="$COS_SECRETID" \
  COS_SECRETKEY="$COS_SECRETKEY" \
  TENCENTCLOUD_SECRET_ID="$TENCENTCLOUD_SECRET_ID" \
  TENCENTCLOUD_SECRET_KEY="$TENCENTCLOUD_SECRET_KEY" \
  AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  COS_HTTP_TRACE="$COS_HTTP_TRACE" \
  LITESTREAM_S3_HTTP_TRACE="$LITESTREAM_S3_HTTP_TRACE" \
  JFS_ASSERTMOUNT_SYNC_INTERVAL="$JFS_ASSERTMOUNT_SYNC_INTERVAL" \
  JFS_ASSERTMOUNT_SKIP_OBJECT_STORAGE_CHECK="$JFS_ASSERTMOUNT_SKIP_OBJECT_STORAGE_CHECK" \
  JFS_ASSERTMOUNT_SNAPSHOT_INTERVAL="$JFS_ASSERTMOUNT_SNAPSHOT_INTERVAL" \
  JFS_ASSERTMOUNT_RUNTIME_MAINTENANCE="$JFS_ASSERTMOUNT_RUNTIME_MAINTENANCE" \
  "$install/bin/wisp" daemon run --config "$WISP_CONFIG" >"$log" 2>&1 &
daemon_pid=$!
trap 'sudo -n kill '"$daemon_pid"' >/dev/null 2>&1 || true' EXIT

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
"$install/bin/wispclient" -server http://127.0.0.1:8520 create "$wisp_name" || { echo "daemon log after create failure:" >&2; cat "$log" >&2 || true; exit 1; }
step create_done

step start_start
"$install/bin/wispclient" -server http://127.0.0.1:8520 start "$wisp_name" || { echo "daemon log after start failure:" >&2; cat "$log" >&2 || true; exit 1; }
step start_done

step exec_start
exec_script="${WISP_FAST_EXEC_SCRIPT:-}"
if [[ -z "$exec_script" ]]; then
  exec_script='set -e; echo WISP_CONSOLE_FAST_OK; pwd; id'
fi
"$install/bin/wispclient" -server http://127.0.0.1:8520 exec "$wisp_name" -- /bin/sh -lc "$exec_script" || { echo "daemon log after exec failure:" >&2; cat "$log" >&2 || true; exit 1; }
step exec_done

if [[ "${WISP_FAST_REPEAT_EXEC:-}" == "1" ]]; then
  step repeat_exec_start
  repeat_start_ns="$(date +%s%N)"
  "$install/bin/wispclient" -server http://127.0.0.1:8520 exec "$wisp_name" -- /bin/sh -lc 'set -e; echo WISP_CONSOLE_REPEAT_OK; pwd; id' || { echo "daemon log after repeat exec failure:" >&2; cat "$log" >&2 || true; exit 1; }
  repeat_end_ns="$(date +%s%N)"
  step repeat_exec_done elapsed_ms=$(( (repeat_end_ns - repeat_start_ns) / 1000000 ))
fi

if [[ "${WISP_FAST_FLUSH_ON_EXIT:-}" == "1" ]]; then
  step flush_start
  "$install/bin/wispclient" -server http://127.0.0.1:8520 stop "$wisp_name" || { echo "daemon log after stop failure:" >&2; cat "$log" >&2 || true; exit 1; }
  sync
  sudo -n umount /mnt/smh-workspace >/dev/null 2>&1 || sudo -n umount -l /mnt/smh-workspace >/dev/null 2>&1 || true
  if findmnt -n /mnt/smh-workspace >/dev/null 2>&1; then
    echo "flush umount failed: /mnt/smh-workspace is still mounted" >&2
    findmnt /mnt/smh-workspace >&2 || true
    exit 1
  fi
  step flush_done
fi

if [[ "${WISP_FAST_WARM_REBOOT:-}" == "1" ]]; then
  step warm_reboot_start
  sudo -n kill "$daemon_pid" >/dev/null 2>&1 || true
  wait "$daemon_pid" >/dev/null 2>&1 || true
  sudo -n umount /mnt/smh-workspace >/dev/null 2>&1 || sudo -n umount -l /mnt/smh-workspace >/dev/null 2>&1 || true
  warm_log="$work/daemon-warm.log"
  step warm_daemon_start
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
    BASE_ROOTFS_DIR="$BASE_ROOTFS_DIR" \
    BASE_ROOTFS_IMG="$BASE_ROOTFS_IMG" \
    CRUN_BINARY="$CRUN_BINARY" \
    CRUN_BINARY_PATH="$CRUN_BINARY_PATH" \
    WISPENV_BINARY="$WISPENV_BINARY" \
    WISP_FS_AGENT_BINARY="$WISP_FS_AGENT_BINARY" \
    TINI_BINARY="$TINI_BINARY" \
    PATH="$PATH" \
    LD_LIBRARY_PATH="$LD_LIBRARY_PATH" \
    ROOT_UPPER_SIZE="$ROOT_UPPER_SIZE" \
    ADMIN_LISTEN_ADDR="$ADMIN_LISTEN_ADDR" \
    SMH_LIBRARY_ID="$SMH_LIBRARY_ID" \
    SMH_ACCESS_DOMAIN="$SMH_ACCESS_DOMAIN" \
    SMH_SPACE_ID="$SMH_SPACE_ID" \
    SMH_ACCESS_TOKEN="$SMH_ACCESS_TOKEN" \
    SMH_HTTP_TRACE="$SMH_HTTP_TRACE" \
    COS_BUCKET="$COS_BUCKET" \
    COS_REGION="$COS_REGION" \
    COS_ENDPOINT="$COS_ENDPOINT" \
    COS_SECRETID="$COS_SECRETID" \
    COS_SECRETKEY="$COS_SECRETKEY" \
    TENCENTCLOUD_SECRET_ID="$TENCENTCLOUD_SECRET_ID" \
    TENCENTCLOUD_SECRET_KEY="$TENCENTCLOUD_SECRET_KEY" \
    AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
    COS_HTTP_TRACE="$COS_HTTP_TRACE" \
    LITESTREAM_S3_HTTP_TRACE="$LITESTREAM_S3_HTTP_TRACE" \
    JFS_ASSERTMOUNT_SYNC_INTERVAL="$JFS_ASSERTMOUNT_SYNC_INTERVAL" \
    JFS_ASSERTMOUNT_SKIP_OBJECT_STORAGE_CHECK="$JFS_ASSERTMOUNT_SKIP_OBJECT_STORAGE_CHECK" \
    JFS_ASSERTMOUNT_SNAPSHOT_INTERVAL="$JFS_ASSERTMOUNT_SNAPSHOT_INTERVAL" \
    JFS_ASSERTMOUNT_RUNTIME_MAINTENANCE="$JFS_ASSERTMOUNT_RUNTIME_MAINTENANCE" \
    "$install/bin/wisp" daemon run --config "$WISP_CONFIG" >"$warm_log" 2>&1 &
  daemon_pid=$!
  for i in $(seq 1 30); do
    if "$install/bin/wispclient" -server http://127.0.0.1:8520 ls >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  "$install/bin/wispclient" -server http://127.0.0.1:8520 ls >/dev/null || { echo "warm daemon did not become ready" >&2; cat "$warm_log" >&2 || true; exit 1; }
  step warm_daemon_ready
  step warm_bootstrap_start
  "$install/bin/wispclient" -server http://127.0.0.1:8520 bootstrap || { echo "warm daemon log after bootstrap failure:" >&2; cat "$warm_log" >&2 || true; exit 1; }
  step warm_bootstrap_done
  step warm_mount_detail_log_start
	grep -aE 'ensure_cos_root (assertmount|sformat|smount|wait_mount|usable_check|mounted)|assertmount_detail |mount_target_timing |smh_http |cos_http |sqlite_litestream_trace |s3_litestream_trace ' "$warm_log" || true
  step warm_mount_detail_log_done
fi

step mount_detail_log_start
grep -aE 'ensure_cos_root (assertmount|sformat|smount|wait_mount|usable_check|mounted)|assertmount_detail |mount_target_timing |ensure_workspace_ready|ensure_active_image|mount_runtime|SUMMARY (ensure_workspace_ready|ensure_active_image|mount_runtime)|smh_http |cos_http |sqlite_litestream_trace |s3_litestream_trace ' "$log" || true
jfs_log="$JFS_LOCAL_ROOT/default/log/juicefs.log"
if [[ -f "$jfs_log" ]]; then
  grep -aE 'assertmount_detail |mount_target_timing |litestream sqlite startup timings|smh_http |cos_http |sqlite_litestream_trace |s3_litestream_trace |OK.*ready|Mounting volume|Data use|new session' "$jfs_log" || true
fi
assert_log="/tmp/juicefs-assertmount.log"
if [[ -f "$assert_log" ]]; then
  grep -aE 'assertmount_detail |mount_target_timing |litestream sqlite startup timings|smh_http |cos_http |sqlite_litestream_trace |s3_litestream_trace |OK.*ready|Mounting volume|Data use|new session|skip mountpoint ready wait' "$assert_log" || true
fi
step mount_detail_log_done
`
	started := time.Now()
	var stdoutBuf strings.Builder
	var stderrBuf strings.Builder
	result, err := client.RunCommand(ctx, sb, command, map[string]string{
		"WISP_PACKAGE_URL":      packageURL,
		"WISP_PACKAGE_SHA256":   packageSHA,
		"WISP_REMOTE_BACKEND":   backend,
		"SMH_LIBRARY_ID":        libraryID,
		"SMH_ACCESS_DOMAIN":     accessDomain,
		"SMH_SPACE_ID":          spaceID,
		"SMH_ACCESS_TOKEN":      accessToken,
		"SMH_HTTP_TRACE":        os.Getenv("SMH_HTTP_TRACE"),
		"COS_BUCKET":            cosBucket,
		"COS_REGION":            cosRegion,
		"COS_ENDPOINT":          cosEndpoint,
		"COS_SECRETID":          cosSecretID,
		"COS_SECRETKEY":         cosSecretKey,
		"AWS_ACCESS_KEY_ID":     cosSecretID,
		"AWS_SECRET_ACCESS_KEY": cosSecretKey,
		"COS_HTTP_TRACE":        os.Getenv("COS_HTTP_TRACE"),
		"LITESTREAM_S3_HTTP_TRACE": firstNonEmpty(
			os.Getenv("LITESTREAM_S3_HTTP_TRACE"),
			os.Getenv("COS_HTTP_TRACE"),
		),
		"JFS_ASSERTMOUNT_SYNC_INTERVAL":             os.Getenv("JFS_ASSERTMOUNT_SYNC_INTERVAL"),
		"JFS_ASSERTMOUNT_SKIP_OBJECT_STORAGE_CHECK": os.Getenv("JFS_ASSERTMOUNT_SKIP_OBJECT_STORAGE_CHECK"),
		"JFS_ASSERTMOUNT_SNAPSHOT_INTERVAL":         os.Getenv("JFS_ASSERTMOUNT_SNAPSHOT_INTERVAL"),
		"JFS_ASSERTMOUNT_RUNTIME_MAINTENANCE":       os.Getenv("JFS_ASSERTMOUNT_RUNTIME_MAINTENANCE"),
		"JFS_PREFIX_OVERRIDE":                       os.Getenv("JFS_PREFIX_OVERRIDE"),
		"WISP_FAST_WARM_REBOOT":                     os.Getenv("WISP_FAST_WARM_REBOOT"),
		"WISP_FAST_FLUSH_ON_EXIT":                   os.Getenv("WISP_FAST_FLUSH_ON_EXIT"),
		"WISP_FAST_REPEAT_EXEC":                     os.Getenv("WISP_FAST_REPEAT_EXEC"),
		"WISP_FAST_NAME":                            wispNameOverride,
		"WISP_FAST_WISP_USER":                       os.Getenv("WISP_FAST_WISP_USER"),
		"WISP_FAST_WISP_UID":                        os.Getenv("WISP_FAST_WISP_UID"),
		"WISP_FAST_WISP_GID":                        os.Getenv("WISP_FAST_WISP_GID"),
		"WISP_FAST_EXEC_SCRIPT":                     os.Getenv("WISP_FAST_EXEC_SCRIPT"),
	}, func(text string) error {
		stdoutBuf.WriteString(text)
		return nil
	}, func(text string) error {
		stderrBuf.WriteString(text)
		return nil
	})
	if err != nil {
		t.Fatalf("%v\nstdout:\n%s\nstderr:\n%s", err, redactLiveSMHSecrets(stdoutBuf.String()), redactLiveSMHSecrets(stderrBuf.String()))
	}
	if result.ExitCode != 0 {
		t.Fatalf("fast Wisp console flow exit=%d stdout=%q stderr=%q", result.ExitCode, redactLiveSMHSecrets(result.Stdout), redactLiveSMHSecrets(result.Stderr))
	}
	if !strings.Contains(result.Stdout, "WISP_CONSOLE_FAST_OK") {
		t.Fatalf("fast Wisp console flow did not reach console: stdout=%q stderr=%q", redactLiveSMHSecrets(result.Stdout), redactLiveSMHSecrets(result.Stderr))
	}
	t.Logf("fast Wisp console timeline:\n%s", redactLiveSMHSecrets(liveTimeline(result.Stdout)))
	t.Logf("fast Wisp console flow succeeded in %s", time.Since(started).Round(time.Millisecond))
}

func provisionLiveSMHSpace(t *testing.T, ctx context.Context, accessDomain, libraryID, librarySecret string) (spaceID, accessToken string) {
	t.Helper()
	spaceID, accessToken, err := provisionLiveSMHSpaceValue(ctx, accessDomain, libraryID, librarySecret)
	if err != nil {
		t.Fatal(err)
	}
	return spaceID, accessToken
}

func provisionLiveSMHSpaceValue(ctx context.Context, accessDomain, libraryID, librarySecret string) (spaceID, accessToken string, err error) {
	httpClient := &http.Client{Timeout: 30 * time.Second}
	createToken, err := issueLiveSMHTokenValue(ctx, httpClient, accessDomain, libraryID, librarySecret, "", "create_space,admin")
	if err != nil {
		return "", "", err
	}

	body, _ := json.Marshal(map[string]string{"spaceTag": fmt.Sprintf("codex-smh-%d", time.Now().UnixNano())})
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		fmt.Sprintf("%s/api/v1/space/%s?access_token=%s", accessDomain, url.PathEscape(libraryID), url.QueryEscape(createToken)),
		bytes.NewReader(body),
	)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", "", fmt.Errorf("SMH create space http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		SpaceID string `json:"spaceId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", "", err
	}
	if strings.TrimSpace(out.SpaceID) == "" {
		return "", "", errors.New("SMH create space returned empty spaceId")
	}
	accessToken, err = issueLiveSMHTokenValue(ctx, httpClient, accessDomain, libraryID, librarySecret, out.SpaceID, "admin")
	if err != nil {
		return "", "", err
	}
	return out.SpaceID, accessToken, nil
}

func issueLiveSMHToken(t *testing.T, ctx context.Context, httpClient *http.Client, accessDomain, libraryID, librarySecret, spaceID, grant string) string {
	t.Helper()
	accessToken, err := issueLiveSMHTokenValue(ctx, httpClient, accessDomain, libraryID, librarySecret, spaceID, grant)
	if err != nil {
		t.Fatal(err)
	}
	return accessToken
}

func issueLiveSMHTokenValue(ctx context.Context, httpClient *http.Client, accessDomain, libraryID, librarySecret, spaceID, grant string) (string, error) {
	q := url.Values{}
	q.Set("library_id", libraryID)
	q.Set("library_secret", librarySecret)
	if strings.TrimSpace(spaceID) != "" {
		q.Set("space_id", spaceID)
	}
	q.Set("grant", grant)
	q.Set("period", "3600")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, accessDomain+"/api/v1/token?"+q.Encode(), nil)
	if err != nil {
		return "", err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("SMH issue token http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if strings.TrimSpace(out.AccessToken) == "" {
		return "", errors.New("SMH issue token returned empty accessToken")
	}
	return out.AccessToken, nil
}

func deleteLiveSMHSpace(ctx context.Context, accessDomain, libraryID, librarySecret, spaceID string) error {
	if strings.TrimSpace(spaceID) == "" {
		return nil
	}
	httpClient := &http.Client{Timeout: 30 * time.Second}
	token, err := issueLiveSMHTokenForCleanup(ctx, httpClient, accessDomain, libraryID, librarySecret)
	if err != nil {
		return err
	}
	spaceToken, err := issueLiveSMHSpaceTokenForCleanup(ctx, httpClient, accessDomain, libraryID, librarySecret, spaceID)
	if err != nil {
		return err
	}
	if err := deleteLiveSMHRootEntries(ctx, httpClient, accessDomain, libraryID, spaceID, spaceToken); err != nil {
		return err
	}
	q := url.Values{}
	q.Set("access_token", token)
	q.Set("force", "1")
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodDelete,
		fmt.Sprintf("%s/api/v1/space/%s/%s?%s", accessDomain, url.PathEscape(libraryID), url.PathEscape(spaceID), q.Encode()),
		nil,
	)
	if err != nil {
		return err
	}
	var lastErr error
	for attempt := 1; attempt <= 6; attempt++ {
		resp, err := httpClient.Do(req.Clone(ctx))
		if err != nil {
			return err
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
			return nil
		}
		lastErr = fmt.Errorf("SMH delete space http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		if resp.StatusCode != http.StatusConflict || !strings.Contains(string(body), "SpaceNotEmpty") {
			return lastErr
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}
	return lastErr
}

func deleteLiveSMHRootEntries(ctx context.Context, httpClient *http.Client, accessDomain, libraryID, spaceID, accessToken string) error {
	q := url.Values{}
	q.Set("access_token", accessToken)
	q.Set("permanent", "1")
	q.Set("page_size", "200")
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		fmt.Sprintf("%s/api/v1/directory/%s/%s?%s", accessDomain, url.PathEscape(libraryID), url.PathEscape(spaceID), q.Encode()),
		nil,
	)
	if err != nil {
		return err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("SMH list root http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		Contents []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"contents"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	for _, entry := range out.Contents {
		name := strings.TrimSpace(entry.Name)
		if name == "" {
			continue
		}
		kind := "file"
		if entry.Type == "dir" || entry.Type == "directory" {
			kind = "directory"
		}
		if err := deleteLiveSMHEntry(ctx, httpClient, accessDomain, libraryID, spaceID, accessToken, kind, name); err != nil {
			return err
		}
	}
	return nil
}

func liveDurationEnv(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func deleteLiveSMHEntry(ctx context.Context, httpClient *http.Client, accessDomain, libraryID, spaceID, accessToken, kind, name string) error {
	q := url.Values{}
	q.Set("access_token", accessToken)
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodDelete,
		fmt.Sprintf("%s/api/v1/%s/%s/%s/%s?%s", accessDomain, kind, url.PathEscape(libraryID), url.PathEscape(spaceID), url.PathEscape(name), q.Encode()),
		nil,
	)
	if err != nil {
		return err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Errorf("SMH delete %s %q http %d: %s", kind, name, resp.StatusCode, strings.TrimSpace(string(body)))
}

func issueLiveSMHTokenForCleanup(ctx context.Context, httpClient *http.Client, accessDomain, libraryID, librarySecret string) (string, error) {
	q := url.Values{}
	q.Set("library_id", libraryID)
	q.Set("library_secret", librarySecret)
	q.Set("grant", "admin,delete_space")
	q.Set("period", "3600")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, accessDomain+"/api/v1/token?"+q.Encode(), nil)
	if err != nil {
		return "", err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("SMH issue cleanup token http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if strings.TrimSpace(out.AccessToken) == "" {
		return "", errors.New("SMH issue cleanup token returned empty accessToken")
	}
	return out.AccessToken, nil
}

func issueLiveSMHSpaceTokenForCleanup(ctx context.Context, httpClient *http.Client, accessDomain, libraryID, librarySecret, spaceID string) (string, error) {
	q := url.Values{}
	q.Set("library_id", libraryID)
	q.Set("library_secret", librarySecret)
	q.Set("space_id", spaceID)
	q.Set("grant", "admin")
	q.Set("period", "3600")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, accessDomain+"/api/v1/token?"+q.Encode(), nil)
	if err != nil {
		return "", err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("SMH issue space cleanup token http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if strings.TrimSpace(out.AccessToken) == "" {
		return "", errors.New("SMH issue space cleanup token returned empty accessToken")
	}
	return out.AccessToken, nil
}

func redactLiveSMHSecrets(text string) string {
	if text == "" {
		return text
	}
	for _, marker := range []string{
		"access_token=",
		"SMH_ACCESS_TOKEN=",
		"COS_SECRETID=",
		"COS_SECRETKEY=",
		"AWS_ACCESS_KEY_ID=",
		"AWS_SECRET_ACCESS_KEY=",
		"X-Amz-Credential=",
		"X-Amz-Signature=",
		"X-Amz-Security-Token=",
		"x-amz-credential=",
		"x-amz-signature=",
		"x-amz-security-token=",
	} {
		var b strings.Builder
		offset := 0
		for {
			idx := strings.Index(text[offset:], marker)
			if idx < 0 {
				b.WriteString(text[offset:])
				break
			}
			idx += offset
			b.WriteString(text[offset : idx+len(marker)])
			start := idx + len(marker)
			end := start
			for end < len(text) {
				switch text[end] {
				case '&', '\n', '\r', ' ', '\t', '"', '\'':
					goto done
				default:
					end++
				}
			}
		done:
			b.WriteString("<redacted>")
			offset = end
		}
		text = b.String()
	}
	return text
}

func TestRedactLiveSMHSecretsDoesNotLoopOnRedactedValues(t *testing.T) {
	got := redactLiveSMHSecrets("url=https://example.test?a=1&access_token=%3Credacted%3E\nSMH_ACCESS_TOKEN=<redacted>\n")
	if strings.Count(got, "<redacted>") != 2 {
		t.Fatalf("unexpected redaction result: %q", got)
	}
	if strings.Contains(got, "%3Credacted%3E") {
		t.Fatalf("encoded redacted token should be normalized: %q", got)
	}
}

func liveTimeline(text string) string {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "TIMELINE ") ||
			strings.Contains(line, "ensure_cos_root ") ||
			strings.Contains(line, "ensure_workspace_ready") ||
			strings.Contains(line, "ensure_active_image") ||
			strings.Contains(line, "mount_runtime") ||
			strings.Contains(line, "assertmount_detail ") ||
			strings.Contains(line, "mount_target_timing ") ||
			strings.Contains(line, "smh_http ") ||
			strings.Contains(line, "sqlite_litestream_trace ") {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

func truthyTestEnv(name string) bool {
	value := strings.TrimSpace(os.Getenv(name))
	return value != "" && value != "0" && !strings.EqualFold(value, "false")
}
