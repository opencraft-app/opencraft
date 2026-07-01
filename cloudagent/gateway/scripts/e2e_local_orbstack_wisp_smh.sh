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
elif [ -n "$explicit_wisp_package_url" ]; then
  export WISP_PACKAGE_URL="$explicit_wisp_package_url"
else
  unset GATEWAY_WISP_PACKAGE_URL
  unset WISP_PACKAGE_URL
fi

GO_BIN="${GO_BIN:-go}"
SSH_TARGET="${CLOUDAGENT_ORBSTACK_SSH_TARGET:-orb}"
TEST_RUN='TestLiveLocalDockerWispSMHRuntime'
LOCAL_ARTIFACT_HOST="${CLOUDAGENT_LOCAL_ARTIFACT_HOST:-host.orb.internal}"
local_artifact_server_dir=""
local_artifact_server_pid=""
local_artifact_server_port=""
served_artifact_url=""

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

cleanup_local_artifact_server() {
  if [ -n "$local_artifact_server_pid" ]; then
    kill "$local_artifact_server_pid" >/dev/null 2>&1 || true
    wait "$local_artifact_server_pid" >/dev/null 2>&1 || true
    local_artifact_server_pid=""
  fi
  if [ -n "$local_artifact_server_dir" ]; then
    rm -rf "$local_artifact_server_dir"
    local_artifact_server_dir=""
  fi
}

start_local_artifact_server() {
  if [ -n "$local_artifact_server_pid" ]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    printf '[e2e-local-orbstack-wisp-smh] python3 is required to serve local artifacts\n' >&2
    exit 2
  fi
  local_artifact_server_dir="$(mktemp -d "${TMPDIR:-/tmp}/cloudagent-local-artifacts.XXXXXX")"
  local_artifact_server_port="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("", 0))
print(s.getsockname()[1])
s.close()
PY
)"
  python3 -m http.server "$local_artifact_server_port" --bind 0.0.0.0 --directory "$local_artifact_server_dir" >/tmp/cloudagent-local-artifacts-http.log 2>&1 &
  local_artifact_server_pid=$!
}

serve_local_artifact() {
  local src="$1"
  local name="$2"
  start_local_artifact_server
  cp "$src" "$local_artifact_server_dir/$name"
  served_artifact_url="http://$LOCAL_ARTIFACT_HOST:$local_artifact_server_port/$name"
}
trap cleanup_local_artifact_server EXIT

remote_arch="$(ssh -o BatchMode=yes "$SSH_TARGET" 'uname -m')"
case "$remote_arch" in
  x86_64|amd64) remote_goarch=amd64 ;;
  aarch64|arm64) remote_goarch=arm64 ;;
  *) remote_goarch="$remote_arch" ;;
esac

if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-${AGENT_SIDECAR_URL:-}}" ] && [ -f "$ROOT_DIR/dist/agent-sidecar-url-$remote_goarch.clean" ]; then
  export GATEWAY_AGENT_SIDECAR_URL="$(tr -d '\r\n' <"$ROOT_DIR/dist/agent-sidecar-url-$remote_goarch.clean")"
fi
if [ -z "${GATEWAY_AGENT_SIDECAR_SHA256:-${AGENT_SIDECAR_SHA256:-}}" ] && [ -f "$ROOT_DIR/dist/agent-sidecar-sha256-$remote_goarch.clean" ]; then
  export GATEWAY_AGENT_SIDECAR_SHA256="$(tr -d '\r\n' <"$ROOT_DIR/dist/agent-sidecar-sha256-$remote_goarch.clean")"
fi
if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-${AGENT_SIDECAR_URL:-}}" ]; then
  local_sidecar="$ROOT_DIR/dist/cloudagent-sidecar-linux-$remote_goarch"
  if [ -f "$local_sidecar" ]; then
    serve_local_artifact "$local_sidecar" "cloudagent-sidecar-linux-$remote_goarch"
    export GATEWAY_AGENT_SIDECAR_URL="$served_artifact_url"
    export GATEWAY_AGENT_SIDECAR_SHA256="$(shasum -a 256 "$local_sidecar" | awk '{print $1}')"
    printf '[e2e-local-orbstack-wisp-smh] serving local sidecar arch=%s url=%s\n' "$remote_goarch" "$GATEWAY_AGENT_SIDECAR_URL" >&2
  fi
fi
loaded_generic_sidecar_url=0
if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-${AGENT_SIDECAR_URL:-}}" ] && [ -f "$ROOT_DIR/dist/agent-sidecar-url.clean" ]; then
  generic_sidecar_url="$(tr -d '\r\n' <"$ROOT_DIR/dist/agent-sidecar-url.clean")"
  case "$generic_sidecar_url" in
    *linux-"$remote_goarch"*) export GATEWAY_AGENT_SIDECAR_URL="$generic_sidecar_url"; loaded_generic_sidecar_url=1 ;;
  esac
fi
if [ -z "${GATEWAY_AGENT_SIDECAR_SHA256:-${AGENT_SIDECAR_SHA256:-}}" ] && [ -n "${GATEWAY_AGENT_SIDECAR_URL:-}" ] && [ -f "$ROOT_DIR/dist/agent-sidecar-sha256.clean" ]; then
  if [ "$loaded_generic_sidecar_url" = "1" ]; then
    export GATEWAY_AGENT_SIDECAR_SHA256="$(tr -d '\r\n' <"$ROOT_DIR/dist/agent-sidecar-sha256.clean")"
  fi
fi
if [ -z "${GATEWAY_WISP_PACKAGE_URL:-${WISP_PACKAGE_URL:-}}" ] && [ -f "$ROOT_DIR/dist/wisp-package-url-$remote_goarch.clean" ]; then
  export GATEWAY_WISP_PACKAGE_URL="$(tr -d '\r\n' <"$ROOT_DIR/dist/wisp-package-url-$remote_goarch.clean")"
fi
if [ -z "${GATEWAY_WISP_PACKAGE_URL:-${WISP_PACKAGE_URL:-}}" ]; then
  local_wisp="$(ls -t "$ROOT_DIR/../wisp/dist-release"/wisp-linux-"$remote_goarch"-*.erofs 2>/dev/null | head -n 1 || true)"
  if [ -n "$local_wisp" ] && [ -f "$local_wisp" ]; then
    serve_local_artifact "$local_wisp" "$(basename "$local_wisp")"
    export GATEWAY_WISP_PACKAGE_URL="$served_artifact_url"
    printf '[e2e-local-orbstack-wisp-smh] serving local Wisp package arch=%s url=%s\n' "$remote_goarch" "$GATEWAY_WISP_PACKAGE_URL" >&2
  fi
fi
if [ -z "${GATEWAY_WISP_PACKAGE_URL:-${WISP_PACKAGE_URL:-}}" ] && [ -f "$ROOT_DIR/dist/wisp-package-url.clean" ]; then
  generic_wisp_url="$(tr -d '\r\n' <"$ROOT_DIR/dist/wisp-package-url.clean")"
  case "$generic_wisp_url" in
    *linux-"$remote_goarch"*) export GATEWAY_WISP_PACKAGE_URL="$generic_wisp_url" ;;
  esac
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
export GATEWAY_WISP_PACKAGE_URL="${GATEWAY_WISP_PACKAGE_URL:-${WISP_PACKAGE_URL:-https://cloudagent-sidecar-shanghai-1388575217.cos.ap-shanghai.myqcloud.com/workspace/20260528/wisp-linux-amd64-20260528T061826Z-8ceda87c563b.erofs}}"
export GATEWAY_WISP_PACKAGE_FORMAT="${GATEWAY_WISP_PACKAGE_FORMAT:-erofs-extract}"
export GATEWAY_LOCAL_WISP_SHARED_DAEMON=1
export GATEWAY_WISP_USE_HOST_E2FSPROGS=1
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
  cleanup_local_artifact_server
}
trap cleanup EXIT

echo "[e2e-local-orbstack-wisp-smh] probing OrbStack host=$SSH_TARGET"
export GATEWAY_WISP_PACKAGE_ARCH="${GATEWAY_WISP_PACKAGE_ARCH:-$remote_goarch}"
case "$GATEWAY_WISP_PACKAGE_URL" in
  *linux-amd64*) package_goarch=amd64 ;;
  *linux-arm64*) package_goarch=arm64 ;;
  *) package_goarch="$GATEWAY_WISP_PACKAGE_ARCH" ;;
esac
if [ "$package_goarch" != "$remote_goarch" ]; then
  cat >&2 <<EOF
[e2e-local-orbstack-wisp-smh] Wisp package arch does not match OrbStack Linux arch.
  remote_arch=$remote_goarch
  package_arch=$package_goarch
  package_url=$GATEWAY_WISP_PACKAGE_URL

Local Linux + SMH does not use AGS, so Wisp's OCI runtime must be native to the
local Linux host. Configure a linux/$remote_goarch Wisp package URL or run on
a matching linux/$package_goarch host.
EOF
  exit 2
fi
ssh -o BatchMode=yes "$SSH_TARGET" 'set -e; uname -a >&2; sudo -n true; test -e /dev/fuse; sudo -n losetup -f >&2; command -v fsck.erofs >/dev/null || { sudo -n apt-get update -qq; sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends erofs-utils; }; command -v fsck.erofs >&2'
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
export LIVE_LOCAL_DOCKER_WISP_CLOSE_TIMEOUT="${LIVE_LOCAL_DOCKER_WISP_CLOSE_TIMEOUT:-10m}"
export GATEWAY_WISP_STOP_TIMEOUT_SECONDS="${GATEWAY_WISP_STOP_TIMEOUT_SECONDS:-600}"
export RUN_LIVE_LOCAL_WISP_SMH=1

"$GO_BIN" test -count=1 ./internal/wrapper -run "$TEST_RUN" -v
