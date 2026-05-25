#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if [ -f "$REPO_ROOT/gateway/scripts/lib/load_env.sh" ]; then
  # shellcheck disable=SC1091
  . "$REPO_ROOT/gateway/scripts/lib/load_env.sh"
  load_cloudagent_env "$REPO_ROOT/gateway"
fi

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

COSCMD_BIN="${COSCMD_BIN:-coscmd}"
COSCMD_CONFIG="${COSCMD_CONFIG:-/tmp/cos-agent-sidecar.conf}"
COS_OBJECT_PREFIX="${COS_OBJECT_PREFIX:-/agent-sidecar/$(date +%Y%m%d)}"
LOCAL_PATH="${SANDBOX_HOST_BINARY:-$ROOT_DIR/dist/sandbox-host-linux-amd64}"
URL_FILE="${SANDBOX_HOST_URL_FILE:-/tmp/sandbox-host-url.clean}"
SHA_FILE="${SANDBOX_HOST_SHA256_FILE:-/tmp/sandbox-host-sha256.clean}"

require_cmd "$COSCMD_BIN"
require_cmd shasum

if [ ! -f "$LOCAL_PATH" ]; then
  printf '[publish-sandbox-host] build linux amd64 binary\n' >&2
  make -C "$ROOT_DIR" linux-amd64 >&2
fi

if [ ! -f "$COSCMD_CONFIG" ]; then
  printf 'missing COSCMD_CONFIG file: %s\n' "$COSCMD_CONFIG" >&2
  exit 2
fi

cos_config_value() {
  local key="$1"
  awk -F '=' -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      value = $2
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "$COSCMD_CONFIG"
}

COS_BUCKET="${COS_BUCKET:-$(cos_config_value bucket)}"
COS_REGION="${COS_REGION:-$(cos_config_value region)}"
require_env COS_BUCKET
require_env COS_REGION

SHA="$(shasum -a 256 "$LOCAL_PATH" | awk '{print $1}')"
OBJECT="${COS_OBJECT_PREFIX%/}/sandbox-host-linux-amd64-${SHA:0:12}"
PUBLIC_BASE_URL="${COS_PUBLIC_BASE_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com}"
PUBLIC_URL="${PUBLIC_BASE_URL%/}/${OBJECT#/}"

printf '[publish-sandbox-host] upload %s -> %s\n' "$LOCAL_PATH" "$OBJECT" >&2
"$COSCMD_BIN" -c "$COSCMD_CONFIG" upload -f -y "$LOCAL_PATH" "$OBJECT" >&2
printf '[publish-sandbox-host] set object acl public-read -> %s\n' "$OBJECT" >&2
"$COSCMD_BIN" -c "$COSCMD_CONFIG" putobjectacl "$OBJECT" --grant-read anyone >&2

if command -v curl >/dev/null 2>&1; then
  curl -fsSI --connect-timeout 10 --max-time 30 "$PUBLIC_URL" >/dev/null
fi

mkdir -p "$(dirname "$URL_FILE")" "$(dirname "$SHA_FILE")"
printf '%s\n' "$PUBLIC_URL" >"$URL_FILE"
printf '%s\n' "$SHA" >"$SHA_FILE"

printf '[publish-sandbox-host] public_url=%s\n' "$PUBLIC_URL" >&2
printf '[publish-sandbox-host] sha256=%s\n' "$SHA" >&2
printf '%s\n' "$PUBLIC_URL"
