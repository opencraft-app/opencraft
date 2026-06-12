#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

explicit_gateway_wisp_package_url="${GATEWAY_WISP_PACKAGE_URL:-}"
explicit_wisp_package_url="${WISP_PACKAGE_URL:-}"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib/load_env.sh"
load_cloudagent_env "$ROOT_DIR"

if [ -n "$explicit_gateway_wisp_package_url" ]; then
  export GATEWAY_WISP_PACKAGE_URL="$explicit_gateway_wisp_package_url"
fi
if [ -n "$explicit_wisp_package_url" ]; then
  export WISP_PACKAGE_URL="$explicit_wisp_package_url"
fi

GO_BIN="${GO_BIN:-go}"
SSH_TARGET="${CLOUDAGENT_ORBSTACK_SSH_TARGET:-orb}"
TEST_RUN='TestLiveLocalDockerWispSMHRuntime'

if ! command -v ssh >/dev/null 2>&1; then
  printf '[e2e-local-orbstack-wisp-smh] missing required command: ssh\n' >&2
  exit 2
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_TARGET" 'uname -s >/dev/null' >/dev/null 2>&1; then
  cat >&2 <<EOF
[e2e-local-orbstack-wisp-smh] cannot reach OrbStack Linux machine via ssh target: $SSH_TARGET

Start OrbStack, then verify:

  ssh $SSH_TARGET uname -a

Override the target with CLOUDAGENT_ORBSTACK_SSH_TARGET if needed.
EOF
  exit 2
fi

if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-${AGENT_SIDECAR_URL:-}}" ] && [ -f "$ROOT_DIR/dist/agent-sidecar-url.clean" ]; then
  export GATEWAY_AGENT_SIDECAR_URL="$(tr -d '\r\n' <"$ROOT_DIR/dist/agent-sidecar-url.clean")"
fi
if [ -z "${GATEWAY_AGENT_SIDECAR_SHA256:-${AGENT_SIDECAR_SHA256:-}}" ] && [ -f "$ROOT_DIR/dist/agent-sidecar-sha256.clean" ]; then
  export GATEWAY_AGENT_SIDECAR_SHA256="$(tr -d '\r\n' <"$ROOT_DIR/dist/agent-sidecar-sha256.clean")"
fi
if [ -z "${GATEWAY_WISP_PACKAGE_URL:-${WISP_PACKAGE_URL:-}}" ] && [ -f "$ROOT_DIR/dist/wisp-package-url.clean" ]; then
  export GATEWAY_WISP_PACKAGE_URL="$(tr -d '\r\n' <"$ROOT_DIR/dist/wisp-package-url.clean")"
fi

if [ -z "${GATEWAY_WISP_SMH_LIBRARY_SECRET:-${SMH_LIBRARY_SECRET:-}}" ]; then
  printf '[e2e-local-orbstack-wisp-smh] missing required env: GATEWAY_WISP_SMH_LIBRARY_SECRET or SMH_LIBRARY_SECRET\n' >&2
  exit 2
fi
if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-${AGENT_SIDECAR_URL:-}}" ]; then
  printf '[e2e-local-orbstack-wisp-smh] missing required env: GATEWAY_AGENT_SIDECAR_URL or AGENT_SIDECAR_URL\n' >&2
  exit 2
fi

export GATEWAY_WISP_SMH_LIBRARY_ID="${GATEWAY_WISP_SMH_LIBRARY_ID:-${SMH_LIBRARY_ID:-smh37laghvp09llc}}"
export GATEWAY_WISP_SMH_ACCESS_DOMAIN="${GATEWAY_WISP_SMH_ACCESS_DOMAIN:-${SMH_ACCESS_DOMAIN:-https://smh37laghvp09llc.ap-shanghai.api.tencentsmh.cn}}"
export GATEWAY_WISP_SMH_LIBRARY_SECRET="${GATEWAY_WISP_SMH_LIBRARY_SECRET:-${SMH_LIBRARY_SECRET:-}}"
export GATEWAY_WISP_PACKAGE_URL="${GATEWAY_WISP_PACKAGE_URL:-${WISP_PACKAGE_URL:-https://cloudagent-sidecar-shanghai-1388575217.cos.ap-shanghai.myqcloud.com/workspace/releases/wisp-linux-amd64-20260612T025943Z-3f949bac72a5.erofs}}"
export GATEWAY_WISP_PACKAGE_FORMAT="${GATEWAY_WISP_PACKAGE_FORMAT:-erofs-extract}"
export GATEWAY_WISP_PACKAGE_ARCH="${GATEWAY_WISP_PACKAGE_ARCH:-amd64}"
export GATEWAY_LOCAL_WISP_SHARED_DAEMON=1
export GATEWAY_WISP_USE_HOST_E2FSPROGS=1
export GATEWAY_WISP_USE_HOST_CRUN=1
export GATEWAY_RUNTIME_HOST=local_wisp
export GATEWAY_AGENT_OUTER_RUNTIME=wisp
export GATEWAY_AGS_TEMPLATE="${GATEWAY_AGS_TEMPLATE:-local-orbstack-agent}"
export INNER_SANDBOX_TEMPLATE="${INNER_SANDBOX_TEMPLATE:-local-orbstack-workspace}"
export GATEWAY_TOKENHUB_API_KEY="${GATEWAY_TOKENHUB_API_KEY:-${TOKENHUB_API_KEY:-local-orbstack-no-prompt-tokenhub}}"
export GATEWAY_TOKENHUB_MODEL="${GATEWAY_TOKENHUB_MODEL:-${TOKENHUB_MODEL:-minimax-m2.7}}"

work_parent="$ROOT_DIR/.tmp"
mkdir -p "$work_parent"
work_dir="$(mktemp -d "$work_parent/local-orbstack-wisp-smh.XXXXXX")"
cleanup() {
  if [ "${CLOUDAGENT_ORBSTACK_CLEANUP_STALE_WISP:-1}" = "1" ]; then
    ssh -o BatchMode=yes "$SSH_TARGET" 'set +e
      pids=$(ps -eo pid=,args= | awk '\''/\/tmp\/cloudagent-[w]/{print $1}'\'')
      if [ -n "$pids" ]; then
        echo "$pids" | xargs sudo -n kill -TERM 2>/dev/null || true
        sleep 1
        echo "$pids" | xargs sudo -n kill -KILL 2>/dev/null || true
      fi' >/dev/null 2>&1 || true
  fi
  if [ "${KEEP_LOCAL_ORBSTACK_WISP_E2E:-0}" != "1" ]; then
    rm -rf "$work_dir"
  else
    printf '[e2e-local-orbstack-wisp-smh] kept work_dir=%s\n' "$work_dir" >&2
  fi
}
trap cleanup EXIT

echo "[e2e-local-orbstack-wisp-smh] probing OrbStack host=$SSH_TARGET"
ssh -o BatchMode=yes "$SSH_TARGET" 'set -e; uname -a >&2; sudo -n true; test -e /dev/fuse; sudo -n losetup -f >&2; command -v fsck.erofs >/dev/null || { sudo -n apt-get update -qq; sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends erofs-utils; }; command -v crun >/dev/null || { sudo -n apt-get update -qq; sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends crun; }; if [ "${GATEWAY_WISP_PACKAGE_ARCH:-amd64}" = "amd64" ] && [ "$(uname -m)" != "x86_64" ] && [ ! -e /lib64/ld-linux-x86-64.so.2 ]; then if ! grep -q "\[arch=arm64\]" /etc/apt/sources.list; then sudo -n cp /etc/apt/sources.list /etc/apt/sources.list.cloudagent-bak; sudo -n sed -i "s|^deb http://ports.ubuntu.com/ubuntu-ports|deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports|" /etc/apt/sources.list; fi; codename="$(. /etc/os-release && printf "%s" "$VERSION_CODENAME")"; printf "deb [arch=amd64] http://archive.ubuntu.com/ubuntu %s main restricted universe multiverse\n" "$codename" | sudo -n tee /etc/apt/sources.list.d/cloudagent-amd64.list >/dev/null; printf "deb [arch=amd64] http://archive.ubuntu.com/ubuntu %s-updates main restricted universe multiverse\n" "$codename" | sudo -n tee -a /etc/apt/sources.list.d/cloudagent-amd64.list >/dev/null; printf "deb [arch=amd64] http://security.ubuntu.com/ubuntu %s-security main restricted universe multiverse\n" "$codename" | sudo -n tee -a /etc/apt/sources.list.d/cloudagent-amd64.list >/dev/null; sudo -n dpkg --add-architecture amd64; sudo -n apt-get update -qq; sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libc6:amd64 libgcc-s1:amd64 libstdc++6:amd64; fi; command -v fsck.erofs >&2; command -v crun >&2; [ "${GATEWAY_WISP_PACKAGE_ARCH:-amd64}" != "amd64" ] || [ -e /lib64/ld-linux-x86-64.so.2 ]'
if [ "${CLOUDAGENT_ORBSTACK_CLEANUP_STALE_WISP:-1}" = "1" ]; then
  ssh -o BatchMode=yes "$SSH_TARGET" 'set +e
    pids=$(ps -eo pid=,args= | awk '\''/\/tmp\/cloudagent-[w]/{print $1}'\'')
    if [ -n "$pids" ]; then
      echo "$pids" | xargs sudo -n kill -TERM
      sleep 1
      echo "$pids" | xargs sudo -n kill -KILL 2>/dev/null || true
    fi
    # Previous interrupted local runs can leave Wisp loop devices behind.
    # Do not try to unmount stale overlay trees here: on OrbStack a broken
    # mount can enter D state and block the cleanup SSH command itself.
    for loop_dir in /sys/block/loop*/loop; do
      file=$(sudo -n timeout 1s cat "$loop_dir/backing_file" 2>/dev/null || true)
      case "$file" in
        /tmp/cloudagent-*/*.erofs|/tmp/cloudagent-*/*/wisp-package.erofs)
          dev="/dev/$(basename "$(dirname "$loop_dir")")"
          sudo -n timeout 2s losetup -d "$dev" 2>/dev/null || true
          ;;
      esac
    done'
fi

echo "[e2e-local-orbstack-wisp-smh] shared_root=$work_dir ssh_target=$SSH_TARGET"

export GATEWAY_LOCAL_RUNTIME_ROOT="$work_dir/runtime"
export GATEWAY_LOCAL_RUNTIME_COMMAND_PREFIX="ssh -o BatchMode=yes $SSH_TARGET /bin/bash -lc"
export RUN_LIVE_LOCAL_WISP_SMH=1

"$GO_BIN" test -count=1 ./internal/wrapper -run "$TEST_RUN" -v
