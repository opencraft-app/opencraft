#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib/load_env.sh"
load_cloudagent_env "$ROOT_DIR"

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    printf 'missing required env: %s\n' "$name" >&2
    exit 2
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  fi
}

PUBLISH_HELPER="$ROOT_DIR/scripts/publish_hermes_sidecar.sh"
SANDBOX_HOST_PUBLISH_HELPER="$ROOT_DIR/../sandbox-host/scripts/publish_sandbox_host.sh"
GATEWAY_WORKER_MODE="${GATEWAY_WORKER_MODE:-agent_injected}"
GATEWAY_ADDR="${GATEWAY_ADDR:-127.0.0.1:18094}"
GATEWAY_DATA_DIR="${GATEWAY_DATA_DIR:-/tmp/gateway-agent-data}"
GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS="${GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS:-300}"
E2B_DOMAIN="${GATEWAY_AGS_DOMAIN:-${E2B_DOMAIN:-ap-beijing.tencentags.com}}"
GATEWAY_AGS_TEMPLATE="${GATEWAY_AGS_TEMPLATE:-${OUTER_SANDBOX_TEMPLATE:-}}"
INNER_SANDBOX_TEMPLATE="${INNER_SANDBOX_TEMPLATE:-$GATEWAY_AGS_TEMPLATE}"
TOKENHUB_MODEL="${TOKENHUB_MODEL:-minimax-m2.7}"
SIDECAR_URL_FILE="${GATEWAY_AGENT_SIDECAR_URL_FILE:-/tmp/agent-sidecar-url.clean}"
SANDBOX_HOST_URL_FILE="${SANDBOX_HOST_URL_FILE:-/tmp/sandbox-host-url.clean}"

if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-}" ] && [ -f "$SIDECAR_URL_FILE" ]; then
  GATEWAY_AGENT_SIDECAR_URL="$(tr -d '\r' <"$SIDECAR_URL_FILE")"
fi

if [ -z "${GATEWAY_AGENT_SIDECAR_URL:-}" ] && [ -x "$PUBLISH_HELPER" ]; then
  GATEWAY_AGENT_SIDECAR_URL="$($PUBLISH_HELPER)"
fi

if [ -z "${HERMES_SANDBOX_HOST_URL:-}" ] && [ -z "${GATEWAY_SANDBOX_HOST_URL:-}" ] && [ -f "$SANDBOX_HOST_URL_FILE" ]; then
  HERMES_SANDBOX_HOST_URL="$(tr -d '\r' <"$SANDBOX_HOST_URL_FILE")"
fi

if [ -z "${HERMES_SANDBOX_HOST_URL:-}" ] && [ -z "${GATEWAY_SANDBOX_HOST_URL:-}" ] && [ -x "$SANDBOX_HOST_PUBLISH_HELPER" ]; then
  HERMES_SANDBOX_HOST_URL="$($SANDBOX_HOST_PUBLISH_HELPER)"
fi

require_env E2B_API_KEY
require_env TOKENHUB_API_KEY
require_env GATEWAY_AGS_TEMPLATE
require_env INNER_SANDBOX_TEMPLATE
require_env GATEWAY_AGENT_SIDECAR_URL

export GATEWAY_WORKER_MODE
export GATEWAY_ADDR
export GATEWAY_DATA_DIR
export GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS
export E2B_DOMAIN
export GATEWAY_AGS_TEMPLATE
export INNER_SANDBOX_TEMPLATE
export TOKENHUB_MODEL
export GATEWAY_AGENT_SIDECAR_URL
export HERMES_SANDBOX_HOST_URL

exec ./dist/gateway-server
