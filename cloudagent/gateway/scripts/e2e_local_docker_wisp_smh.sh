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
DOCKER_IMAGE="${CLOUDAGENT_LOCAL_WISP_DOCKER_IMAGE:-debian:bookworm-slim}"
docker_server_arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || uname -m)"
case "$docker_server_arch" in
  x86_64|amd64) native_goarch=amd64 ;;
  aarch64|arm64) native_goarch=arm64 ;;
  *) native_goarch="$docker_server_arch" ;;
esac
DOCKER_PLATFORM="${CLOUDAGENT_LOCAL_WISP_DOCKER_PLATFORM:-linux/$native_goarch}"
platform_goarch="${DOCKER_PLATFORM##*/}"
case "$platform_goarch" in
  x86_64) platform_goarch=amd64 ;;
  aarch64) platform_goarch=arm64 ;;
esac
DOCKER_RUNTIME_IMAGE="${CLOUDAGENT_LOCAL_WISP_DOCKER_RUNTIME_IMAGE:-cloudagent-local-wisp-e2e:bookworm-$platform_goarch}"
DEBIAN_MIRROR="${CLOUDAGENT_LOCAL_WISP_DEBIAN_MIRROR:-http://mirrors.cloud.tencent.com/debian}"
DEBIAN_SECURITY_MIRROR="${CLOUDAGENT_LOCAL_WISP_DEBIAN_SECURITY_MIRROR:-http://mirrors.cloud.tencent.com/debian-security}"
TEST_RUN='TestLiveLocalDockerWispSMHRuntime'
LOCAL_ARTIFACT_HOST="${CLOUDAGENT_LOCAL_ARTIFACT_HOST:-host.docker.internal}"
local_artifact_server_dir=""
local_artifact_server_pid=""
local_artifact_server_port=""
served_artifact_url=""

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    printf '[e2e-local-docker-wisp-smh] missing required env: %s\n' "$name" >&2
    exit 2
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  printf '[e2e-local-docker-wisp-smh] missing required command: docker\n' >&2
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
    printf '[e2e-local-docker-wisp-smh] python3 is required to serve local artifacts\n' >&2
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

if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-${AGENT_SIDECAR_URL:-}}" ] && [ -f "$ROOT_DIR/dist/agent-sidecar-url-$platform_goarch.clean" ]; then
  export GATEWAY_AGENT_SIDECAR_URL="$(tr -d '\r\n' <"$ROOT_DIR/dist/agent-sidecar-url-$platform_goarch.clean")"
fi
if [ -z "${GATEWAY_AGENT_SIDECAR_SHA256:-${AGENT_SIDECAR_SHA256:-}}" ] && [ -f "$ROOT_DIR/dist/agent-sidecar-sha256-$platform_goarch.clean" ]; then
  export GATEWAY_AGENT_SIDECAR_SHA256="$(tr -d '\r\n' <"$ROOT_DIR/dist/agent-sidecar-sha256-$platform_goarch.clean")"
fi
if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-${AGENT_SIDECAR_URL:-}}" ]; then
  local_sidecar="$ROOT_DIR/dist/cloudagent-sidecar-linux-$platform_goarch"
  if [ -f "$local_sidecar" ]; then
    serve_local_artifact "$local_sidecar" "cloudagent-sidecar-linux-$platform_goarch"
    export GATEWAY_AGENT_SIDECAR_URL="$served_artifact_url"
    export GATEWAY_AGENT_SIDECAR_SHA256="$(shasum -a 256 "$local_sidecar" | awk '{print $1}')"
    printf '[e2e-local-docker-wisp-smh] serving local sidecar arch=%s url=%s\n' "$platform_goarch" "$GATEWAY_AGENT_SIDECAR_URL" >&2
  fi
fi
loaded_generic_sidecar_url=0
if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-${AGENT_SIDECAR_URL:-}}" ] && [ -f "$ROOT_DIR/dist/agent-sidecar-url.clean" ]; then
  generic_sidecar_url="$(tr -d '\r\n' <"$ROOT_DIR/dist/agent-sidecar-url.clean")"
  case "$generic_sidecar_url" in
    *linux-"$platform_goarch"*) export GATEWAY_AGENT_SIDECAR_URL="$generic_sidecar_url"; loaded_generic_sidecar_url=1 ;;
  esac
fi
if [ -z "${GATEWAY_AGENT_SIDECAR_SHA256:-${AGENT_SIDECAR_SHA256:-}}" ] && [ -n "${GATEWAY_AGENT_SIDECAR_URL:-}" ] && [ -f "$ROOT_DIR/dist/agent-sidecar-sha256.clean" ]; then
  if [ "$loaded_generic_sidecar_url" = "1" ]; then
    export GATEWAY_AGENT_SIDECAR_SHA256="$(tr -d '\r\n' <"$ROOT_DIR/dist/agent-sidecar-sha256.clean")"
  fi
fi
if [ -z "${GATEWAY_WISP_PACKAGE_URL:-${WISP_PACKAGE_URL:-}}" ] && [ -f "$ROOT_DIR/dist/wisp-package-url-$platform_goarch.clean" ]; then
  export GATEWAY_WISP_PACKAGE_URL="$(tr -d '\r\n' <"$ROOT_DIR/dist/wisp-package-url-$platform_goarch.clean")"
fi
if [ -z "${GATEWAY_WISP_PACKAGE_URL:-${WISP_PACKAGE_URL:-}}" ]; then
  local_wisp="$(ls -t "$ROOT_DIR/../wisp/dist-release"/wisp-linux-"$platform_goarch"-*.erofs 2>/dev/null | head -n 1 || true)"
  if [ -n "$local_wisp" ] && [ -f "$local_wisp" ]; then
    serve_local_artifact "$local_wisp" "$(basename "$local_wisp")"
    export GATEWAY_WISP_PACKAGE_URL="$served_artifact_url"
    printf '[e2e-local-docker-wisp-smh] serving local Wisp package arch=%s url=%s\n' "$platform_goarch" "$GATEWAY_WISP_PACKAGE_URL" >&2
  fi
fi
if [ -z "${GATEWAY_WISP_PACKAGE_URL:-${WISP_PACKAGE_URL:-}}" ] && [ -f "$ROOT_DIR/dist/wisp-package-url.clean" ]; then
  generic_wisp_url="$(tr -d '\r\n' <"$ROOT_DIR/dist/wisp-package-url.clean")"
  case "$generic_wisp_url" in
    *linux-"$platform_goarch"*) export GATEWAY_WISP_PACKAGE_URL="$generic_wisp_url" ;;
  esac
fi
if [ -z "${GATEWAY_WISP_SMH_LIBRARY_SECRET:-${SMH_LIBRARY_SECRET:-}}" ]; then
  printf '[e2e-local-docker-wisp-smh] missing required env: GATEWAY_WISP_SMH_LIBRARY_SECRET or SMH_LIBRARY_SECRET\n' >&2
  exit 2
fi
if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-${AGENT_SIDECAR_URL:-}}" ]; then
  printf '[e2e-local-docker-wisp-smh] missing required env: GATEWAY_AGENT_SIDECAR_URL or AGENT_SIDECAR_URL\n' >&2
  exit 2
fi

export GATEWAY_WISP_SMH_LIBRARY_ID="${GATEWAY_WISP_SMH_LIBRARY_ID:-${SMH_LIBRARY_ID:-smh37laghvp09llc}}"
export GATEWAY_WISP_SMH_ACCESS_DOMAIN="${GATEWAY_WISP_SMH_ACCESS_DOMAIN:-${SMH_ACCESS_DOMAIN:-https://smh37laghvp09llc.ap-shanghai.api.tencentsmh.cn}}"
export GATEWAY_WISP_SMH_LIBRARY_SECRET="${GATEWAY_WISP_SMH_LIBRARY_SECRET:-${SMH_LIBRARY_SECRET:-}}"
export GATEWAY_WISP_PACKAGE_URL="${GATEWAY_WISP_PACKAGE_URL:-${WISP_PACKAGE_URL:-https://cloudagent-sidecar-shanghai-1388575217.cos.ap-shanghai.myqcloud.com/workspace/20260528/wisp-linux-amd64-20260528T061826Z-8ceda87c563b.erofs}}"
export GATEWAY_WISP_PACKAGE_FORMAT="${GATEWAY_WISP_PACKAGE_FORMAT:-erofs-extract}"
export GATEWAY_WISP_PACKAGE_ARCH="${GATEWAY_WISP_PACKAGE_ARCH:-$platform_goarch}"
export GATEWAY_RUNTIME_HOST=local_wisp
export GATEWAY_AGENT_OUTER_RUNTIME=wisp
export GATEWAY_AGS_TEMPLATE="${GATEWAY_AGS_TEMPLATE:-local-docker-agent}"
export INNER_SANDBOX_TEMPLATE="${INNER_SANDBOX_TEMPLATE:-local-docker-workspace}"
export GATEWAY_TOKENHUB_API_KEY="${GATEWAY_TOKENHUB_API_KEY:-${TOKENHUB_API_KEY:-local-docker-no-prompt-tokenhub}}"
export GATEWAY_TOKENHUB_MODEL="${GATEWAY_TOKENHUB_MODEL:-${TOKENHUB_MODEL:-minimax-m2.7}}"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/cloudagent-local-docker-wisp-smh.XXXXXX")"
containers_dir="$work_dir/containers"
mkdir -p "$containers_dir"
cleanup() {
  if [ -d "$containers_dir" ]; then
    find "$containers_dir" -type f -name '*.id' -print0 2>/dev/null | while IFS= read -r -d '' file; do
      cid="$(cat "$file" 2>/dev/null || true)"
      [ -n "$cid" ] && docker rm -f "$cid" >/dev/null 2>&1 || true
    done
  fi
  cleanup_local_artifact_server
  rm -rf "$work_dir"
}
trap cleanup EXIT

cat >"$work_dir/Dockerfile" <<EOF
FROM ${DOCKER_IMAGE}
RUN set -eux; \\
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do \\
    [ -e "\$file" ] || continue; \\
    sed -i \\
      -e 's|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g' \\
      -e 's|http://security.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g' \\
      -e 's|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g' \\
      "\$file"; \\
  done
RUN apt-get update \\
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
    bash ca-certificates curl sudo fuse3 procps util-linux coreutils tar gzip findutils e2fsprogs erofs-utils \\
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /tmp/gateway /tmp/cloudagent-wisp /tmp/cloudagent-workspace-wisp /workspace \\
  && chmod 1777 /tmp /tmp/gateway
EOF

if [ "$platform_goarch" != "$native_goarch" ] && [ "${CLOUDAGENT_LOCAL_WISP_ALLOW_EMULATION:-0}" != "1" ]; then
  cat >&2 <<EOF
[e2e-local-docker-wisp-smh] refusing emulated runtime platform: docker_arch=$native_goarch requested=$DOCKER_PLATFORM

Wisp runs an OCI runtime inside the local Linux host. On Apple Silicon / arm64,
the linux/amd64 crun binary fails under QEMU re-exec. Use a native linux/$native_goarch
Wisp package, or run this e2e on a real linux/amd64 host.

Set CLOUDAGENT_LOCAL_WISP_ALLOW_EMULATION=1 only for debugging; it is expected to fail.
EOF
  exit 2
fi
case "$GATEWAY_WISP_PACKAGE_URL" in
  *linux-amd64*) package_goarch=amd64 ;;
  *linux-arm64*) package_goarch=arm64 ;;
  *) package_goarch="$GATEWAY_WISP_PACKAGE_ARCH" ;;
esac
if [ "$package_goarch" != "$platform_goarch" ]; then
  cat >&2 <<EOF
[e2e-local-docker-wisp-smh] Wisp package arch does not match local runtime arch.
  docker_platform=$DOCKER_PLATFORM
  runtime_arch=$platform_goarch
  package_arch=$package_goarch
  package_url=$GATEWAY_WISP_PACKAGE_URL

Local Linux + SMH does not use AGS, so Wisp's OCI runtime must be native to the
local Linux host. Configure a linux/$platform_goarch Wisp package URL or run on
a matching linux/$package_goarch host.
EOF
  exit 2
fi

echo "[e2e-local-docker-wisp-smh] building runtime image=$DOCKER_RUNTIME_IMAGE base=$DOCKER_IMAGE platform=$DOCKER_PLATFORM"
docker build --platform "$DOCKER_PLATFORM" -t "$DOCKER_RUNTIME_IMAGE" "$work_dir"

helper="$work_dir/local-docker-exec.sh"
cat >"$helper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
target_id="\$1"
script="\$2"
safe_id="\$(printf '%s' "\$target_id" | tr -c 'A-Za-z0-9_.-' '_')"
containers_dir="$containers_dir"
container_file="\$containers_dir/\$safe_id.id"
container=""
if [ -f "\$container_file" ]; then
  container="\$(cat "\$container_file" 2>/dev/null || true)"
  if [ -n "\$container" ] && ! docker inspect "\$container" >/dev/null 2>&1; then
    container=""
  fi
fi
if [ -z "\$container" ]; then
  args=(run -d --rm --platform "$DOCKER_PLATFORM" --privileged --cap-add SYS_ADMIN --cgroupns=host --security-opt seccomp=unconfined --security-opt apparmor=unconfined)
  if [ -e /dev/fuse ]; then
    args+=(--device /dev/fuse)
  fi
  args+=(-v "$work_dir:$work_dir" -w "$work_dir" "$DOCKER_RUNTIME_IMAGE" sleep 3600)
  container="\$(docker "\${args[@]}")"
  printf '%s' "\$container" >"\$container_file"
  docker exec "\$container" /bin/bash -lc 'if [ -e /dev/fuse ]; then chmod 666 /dev/fuse || true; fi; [ -e /dev/loop-control ] || mknod /dev/loop-control c 10 237 || true; for i in \$(seq 0 31); do [ -e /dev/loop\$i ] || mknod /dev/loop\$i b 7 \$i || true; done; chmod 660 /dev/loop* /dev/loop-control 2>/dev/null || true; uname -a >&2; losetup -f >&2 || true'
fi
exec docker exec "\$container" /bin/bash -lc "\$script"
EOF
chmod +x "$helper"

echo "[e2e-local-docker-wisp-smh] shared_root=$work_dir runtime_image=$DOCKER_RUNTIME_IMAGE"

export GATEWAY_LOCAL_RUNTIME_ROOT="$work_dir/runtime"
export GATEWAY_LOCAL_RUNTIME_COMMAND_PREFIX="$helper {target_id}"
export GATEWAY_LOCAL_RUNTIME_SHELL=/bin/bash
export LIVE_LOCAL_DOCKER_WISP_CLOSE_TIMEOUT="${LIVE_LOCAL_DOCKER_WISP_CLOSE_TIMEOUT:-10m}"
export GATEWAY_WISP_STOP_TIMEOUT_SECONDS="${GATEWAY_WISP_STOP_TIMEOUT_SECONDS:-600}"
export RUN_LIVE_LOCAL_DOCKER_WISP_SMH=1

"$GO_BIN" test -count=1 ./internal/wrapper -run "$TEST_RUN" -v
