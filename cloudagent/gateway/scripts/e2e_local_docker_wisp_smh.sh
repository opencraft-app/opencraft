#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib/load_env.sh"
load_cloudagent_env "$ROOT_DIR"

GO_BIN="${GO_BIN:-go}"
DOCKER_IMAGE="${CLOUDAGENT_LOCAL_WISP_DOCKER_IMAGE:-debian:bookworm-slim}"
DOCKER_RUNTIME_IMAGE="${CLOUDAGENT_LOCAL_WISP_DOCKER_RUNTIME_IMAGE:-cloudagent-local-wisp-e2e:bookworm-amd64}"
DOCKER_PLATFORM="${CLOUDAGENT_LOCAL_WISP_DOCKER_PLATFORM:-linux/amd64}"
TEST_RUN='TestLiveLocalDockerWispSMHRuntime'

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
  rm -rf "$work_dir"
}
trap cleanup EXIT

cat >"$work_dir/Dockerfile" <<EOF
FROM ${DOCKER_IMAGE}
RUN apt-get update \\
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
    bash ca-certificates curl sudo fuse3 procps util-linux coreutils tar gzip findutils e2fsprogs erofs-utils \\
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /tmp/gateway /tmp/cloudagent-wisp /tmp/cloudagent-workspace-wisp /workspace \\
  && chmod 1777 /tmp /tmp/gateway
EOF

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
export RUN_LIVE_LOCAL_DOCKER_WISP_SMH=1

"$GO_BIN" test -count=1 ./internal/wrapper -run "$TEST_RUN" -v
