#!/usr/bin/env bash
set -euo pipefail

pkg_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${CLOUDAGENT_SINGLE_HOST_ENV:-$pkg_root/config/env}"

if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
else
  echo "missing config env file: $env_file" >&2
  echo "copy config/env.example to config/env and fill required values" >&2
  exit 2
fi

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "missing required env: $name" >&2
    exit 2
  fi
}

pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

require_env TOKENHUB_API_KEY
require_env GATEWAY_AGENT_SIDECAR_URL
require_env SMH_LIBRARY_ID
require_env SMH_ACCESS_DOMAIN
require_env SMH_LIBRARY_SECRET

wisp_pkg="$(find "$pkg_root/packages" -maxdepth 1 -type f -name 'wisp-linux-*.tar.gz' | sort | tail -n 1)"
if [[ -z "$wisp_pkg" || ! -f "$wisp_pkg" ]]; then
  echo "missing bundled Wisp package under $pkg_root/packages" >&2
  exit 2
fi

artifact_port="${CLOUDAGENT_SINGLE_HOST_ARTIFACT_PORT:-$(pick_port)}"
artifact_host="${CLOUDAGENT_SINGLE_HOST_ARTIFACT_HOST:-127.0.0.1}"
artifact_url="http://${artifact_host}:${artifact_port}/$(basename "$wisp_pkg")"
artifact_log="${CLOUDAGENT_SINGLE_HOST_ARTIFACT_LOG:-$pkg_root/logs/artifact-server.log}"
gateway_log="${CLOUDAGENT_SINGLE_HOST_GATEWAY_LOG:-$pkg_root/logs/gateway.log}"
mkdir -p "$pkg_root/logs" "${GATEWAY_DATA_DIR:-/var/lib/cloudagent-gateway}" "${GATEWAY_LOCAL_RUNTIME_ROOT:-/var/lib/cloudagent-runtime}"

cleanup() {
  if [[ -n "${artifact_pid:-}" ]]; then
    kill "$artifact_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

python3 -m http.server "$artifact_port" --bind "$artifact_host" --directory "$pkg_root/packages" >"$artifact_log" 2>&1 &
artifact_pid="$!"

export GATEWAY_WORKER_MODE=agent_injected
export GATEWAY_RUNTIME_HOST=local_wisp
export GATEWAY_AGENT_OUTER_RUNTIME=wisp
export GATEWAY_ADDR="${GATEWAY_ADDR:-127.0.0.1:18094}"
export GATEWAY_DATA_DIR="${GATEWAY_DATA_DIR:-/var/lib/cloudagent-gateway}"
export GATEWAY_LOCAL_RUNTIME_ROOT="${GATEWAY_LOCAL_RUNTIME_ROOT:-/var/lib/cloudagent-runtime}"
export GATEWAY_LOCAL_RUNTIME_ALLOW_HOST_PATHS="${GATEWAY_LOCAL_RUNTIME_ALLOW_HOST_PATHS:-1}"
export GATEWAY_WISP_PACKAGE_URL="${GATEWAY_WISP_PACKAGE_URL:-$artifact_url}"
export GATEWAY_WISP_PACKAGE_FORMAT="${GATEWAY_WISP_PACKAGE_FORMAT:-tar.gz}"
export GATEWAY_WISP_ROOT_UPPER_SIZE="${GATEWAY_WISP_ROOT_UPPER_SIZE:-5G}"
export GATEWAY_WISP_JFS_PREFIX="${GATEWAY_WISP_JFS_PREFIX:-workspace}"
export GATEWAY_WISP_SMH_LIBRARY_ID="${GATEWAY_WISP_SMH_LIBRARY_ID:-$SMH_LIBRARY_ID}"
export GATEWAY_WISP_SMH_ACCESS_DOMAIN="${GATEWAY_WISP_SMH_ACCESS_DOMAIN:-$SMH_ACCESS_DOMAIN}"
export GATEWAY_WISP_SMH_LIBRARY_SECRET="${GATEWAY_WISP_SMH_LIBRARY_SECRET:-$SMH_LIBRARY_SECRET}"
export GATEWAY_WISP_SMH_SPACE_ID="${GATEWAY_WISP_SMH_SPACE_ID:-${SMH_SPACE_ID:-}}"
export GATEWAY_TOKENHUB_API_KEY="${GATEWAY_TOKENHUB_API_KEY:-$TOKENHUB_API_KEY}"
export GATEWAY_TOKENHUB_MODEL="${GATEWAY_TOKENHUB_MODEL:-${TOKENHUB_MODEL:-minimax-m2.7}}"
export TOKENHUB_API_KEY="$GATEWAY_TOKENHUB_API_KEY"
export TOKENHUB_MODEL="$GATEWAY_TOKENHUB_MODEL"

echo "cloudagent single-host artifact_url=$GATEWAY_WISP_PACKAGE_URL"
echo "cloudagent single-host acp_url=http://$GATEWAY_ADDR/acp"
echo "cloudagent single-host gateway_log=$gateway_log"

exec "$pkg_root/bin/cloudagent-gateway" 2>&1 | tee -a "$gateway_log"
