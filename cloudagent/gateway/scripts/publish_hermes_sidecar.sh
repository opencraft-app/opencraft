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

COSCMD_BIN="${COSCMD_BIN:-coscmd}"
COSCMD_CONFIG="${COSCMD_CONFIG:-/tmp/cos-agent-sidecar.conf}"
COS_OBJECT_PREFIX="${COS_OBJECT_PREFIX:-/agent-sidecar/$(date +%Y%m%d)}"
URL_FILE="${GATEWAY_AGENT_SIDECAR_URL_FILE:-/tmp/agent-sidecar-url.clean}"
SHA_FILE="${GATEWAY_AGENT_SIDECAR_SHA256_FILE:-/tmp/agent-sidecar-sha256.clean}"

require_cmd "$COSCMD_BIN"
require_cmd shasum
if command -v curl >/dev/null 2>&1; then
  CURL_BIN="curl"
else
  CURL_BIN=""
fi

if [ ! -f "$COSCMD_CONFIG" ]; then
  printf 'missing COSCMD_CONFIG file: %s\n' "$COSCMD_CONFIG" >&2
  exit 2
fi

SIDECAR_LOCAL_PATH="${GATEWAY_AGENT_SIDECAR_BINARY:-$ROOT_DIR/dist/hermes-sidecar-linux-amd64}"
SIDECAR_BASENAME="hermes-sidecar-linux-amd64"

if [ ! -f "$SIDECAR_LOCAL_PATH" ]; then
  printf 'missing sidecar binary: %s\n' "$SIDECAR_LOCAL_PATH" >&2
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

SIDECAR_SHA="$(shasum -a 256 "$SIDECAR_LOCAL_PATH" | awk '{print $1}')"
SIDECAR_OBJECT="${COS_OBJECT_PREFIX%/}/${SIDECAR_BASENAME}-${SIDECAR_SHA:0:12}"
PUBLIC_BASE_URL="${COS_PUBLIC_BASE_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com}"
PUBLIC_URL="${PUBLIC_BASE_URL%/}/${SIDECAR_OBJECT#/}"

printf '[publish] upload %s -> %s\n' "$SIDECAR_LOCAL_PATH" "$SIDECAR_OBJECT" >&2
"$COSCMD_BIN" -c "$COSCMD_CONFIG" upload -f -y "$SIDECAR_LOCAL_PATH" "$SIDECAR_OBJECT" >&2
printf '[publish] set object acl public-read -> %s\n' "$SIDECAR_OBJECT" >&2
"$COSCMD_BIN" -c "$COSCMD_CONFIG" putobjectacl "$SIDECAR_OBJECT" --grant-read anyone >&2

if [ -n "$CURL_BIN" ]; then
  "$CURL_BIN" -fsSI --connect-timeout 10 --max-time 30 "$PUBLIC_URL" >/dev/null
fi

mkdir -p "$(dirname "$URL_FILE")" "$(dirname "$SHA_FILE")"
printf '%s\n' "$PUBLIC_URL" >"$URL_FILE"
printf '%s\n' "$SIDECAR_SHA" >"$SHA_FILE"

printf '[publish] public_url=%s\n' "$PUBLIC_URL" >&2
printf '[publish] sha256=%s\n' "$SIDECAR_SHA" >&2
printf '%s\n' "$PUBLIC_URL"
