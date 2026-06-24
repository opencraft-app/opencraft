#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '[velad-cos] %s\n' "$*" >&2
}

require_env_value() {
  local label="$1"
  local value="$2"
  if [ -z "$value" ]; then
    printf 'missing required env: %s\n' "$label" >&2
    exit 2
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  fi
}

first_env_value() {
  local name
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then
      printf '%s' "${!name}"
      return 0
    fi
  done
  return 1
}

ensure_coscmd() {
  if command -v "${COSCMD_BIN:-coscmd}" >/dev/null 2>&1; then
    COSCMD_BIN="$(command -v "${COSCMD_BIN:-coscmd}")"
    export COSCMD_BIN
    return 0
  fi

  require_cmd python3
  local venv_dir pip_bin
  venv_dir="${VELAD_COSCMD_VENV:-$ROOT_DIR/.build-cache/coscmd-venv}"
  pip_bin="$venv_dir/bin/pip"
  if [ ! -x "$venv_dir/bin/coscmd" ]; then
    log "install coscmd into $venv_dir"
    python3 -m venv "$venv_dir"
    "$pip_bin" install --upgrade pip >/dev/null
    "$pip_bin" install coscmd >/dev/null
  fi
  COSCMD_BIN="$venv_dir/bin/coscmd"
  export COSCMD_BIN
}

LOCAL_PATH="${VELAD_LOCAL_PATH:-target-linux-amd64/velad-linux-amd64}"
URL_FILE="${VELAD_URL_FILE:-target-linux-amd64/velad-linux-amd64.url}"
SHA_FILE="${VELAD_SHA_FILE:-target-linux-amd64/velad-linux-amd64.sha256}"

if [ ! -f "$LOCAL_PATH" ]; then
  log "missing $LOCAL_PATH; build linux amd64 velad first"
  make server-release-linux-amd64
fi

COS_BUCKET="$(first_env_value VELAD_COS_BUCKET COS_BUCKET || true)"
COS_REGION="$(first_env_value VELAD_COS_REGION COS_REGION || true)"
COS_REGION="${COS_REGION:-ap-beijing}"
COS_SECRET_ID="$(first_env_value VELAD_COS_SECRET_ID COS_SECRET_ID TENCENTCLOUD_SECRET_ID AWS_ACCESS_KEY_ID || true)"
COS_SECRET_KEY="$(first_env_value VELAD_COS_SECRET_KEY COS_SECRET_KEY TENCENTCLOUD_SECRET_KEY AWS_SECRET_ACCESS_KEY || true)"
COS_OBJECT_PREFIX="${VELAD_COS_OBJECT_PREFIX:-/velad/releases}"
COS_PUBLIC_BASE_URL="${VELAD_COS_PUBLIC_BASE_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com}"
if [ -n "${VELAD_COSCMD_CONFIG:-}" ]; then
  COSCMD_CONFIG="$VELAD_COSCMD_CONFIG"
  CLEAN_COSCMD_CONFIG=0
else
  COSCMD_CONFIG="$(mktemp /tmp/velad-coscmd.XXXXXX.conf)"
  CLEAN_COSCMD_CONFIG=1
fi
COS_PUBLIC_READ="${VELAD_COS_PUBLIC_READ:-1}"

require_env_value VELAD_COS_BUCKET "$COS_BUCKET"
require_env_value VELAD_COS_SECRET_ID "$COS_SECRET_ID"
require_env_value VELAD_COS_SECRET_KEY "$COS_SECRET_KEY"
require_cmd shasum
ensure_coscmd

SHA="$(shasum -a 256 "$LOCAL_PATH" | awk '{print $1}')"
OBJECT="${COS_OBJECT_PREFIX%/}/velad-linux-amd64-${SHA:0:12}"
PUBLIC_URL="${COS_PUBLIC_BASE_URL%/}/${OBJECT#/}"

mkdir -p "$(dirname "$COSCMD_CONFIG")" "$(dirname "$URL_FILE")" "$(dirname "$SHA_FILE")"
umask 077
if [ "$CLEAN_COSCMD_CONFIG" = "1" ]; then
  trap 'rm -f "$COSCMD_CONFIG"' EXIT
fi
cat >"$COSCMD_CONFIG" <<EOF
[common]
secret_id = ${COS_SECRET_ID}
secret_key = ${COS_SECRET_KEY}
bucket = ${COS_BUCKET}
region = ${COS_REGION}
schema = https
retry = 5
max_thread = 8
part_size = 20
EOF

log "upload $LOCAL_PATH -> $OBJECT"
"$COSCMD_BIN" -c "$COSCMD_CONFIG" upload -f -y "$LOCAL_PATH" "$OBJECT" >&2

if [ "$COS_PUBLIC_READ" = "1" ]; then
  log "set object acl public-read -> $OBJECT"
  "$COSCMD_BIN" -c "$COSCMD_CONFIG" putobjectacl "$OBJECT" --grant-read anyone >&2
fi

if command -v curl >/dev/null 2>&1; then
  curl -fsSI --connect-timeout 10 --max-time 30 "$PUBLIC_URL" >/dev/null
fi

printf '%s\n' "$PUBLIC_URL" >"$URL_FILE"
printf '%s\n' "$SHA" >"$SHA_FILE"

log "public_url=$PUBLIC_URL"
log "sha256=$SHA"
printf '%s\n' "$PUBLIC_URL"
