#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib/load_env.sh"
load_cloudagent_env "$ROOT_DIR"

log() {
  printf '[cloudagent-agent-ci] %s\n' "$*" >&2
}

is_unexpanded_setting() {
  case "$1" in
    *'${{'*'}}'*) return 0 ;;
    *) return 1 ;;
  esac
}

first_env() {
  local name value
  for name in "$@"; do
    value="${!name:-}"
    if [ -n "$value" ] && ! is_unexpanded_setting "$value"; then
      printf '%s\n' "$value"
      return 0
    fi
  done
  return 1
}

first_file_value() {
  local path value
  for path in "$@"; do
    if [ -n "$path" ] && [ -f "$path" ]; then
      value="$(tr -d '\r\n' <"$path")"
      if [ -n "$value" ]; then
        printf '%s\n' "$value"
        return 0
      fi
    fi
  done
  return 1
}

first_secret_value() {
  local env_value file_value
  # Devcloud Stream settings are optional; CI runners also provide local secret files.
  env_value="$(first_env "$@" || true)"
  if [ -n "$env_value" ]; then
    printf '%s\n' "$env_value"
    return 0
  fi

  case "$1" in
    CLOUDAGENT_AGENT_COS_SECRET_ID)
      file_value="$(first_file_value "${CLOUDAGENT_AGENT_COS_SECRET_ID_FILE:-}" /etc/lightclaw-ci/tencentcloud_secret_id || true)"
      ;;
    CLOUDAGENT_AGENT_COS_SECRET_KEY)
      file_value="$(first_file_value "${CLOUDAGENT_AGENT_COS_SECRET_KEY_FILE:-}" /etc/lightclaw-ci/tencentcloud_secret_key || true)"
      ;;
    CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64)
      file_value="$(first_file_value "${CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64_FILE:-}" /etc/lightclaw-ci/cloudagent_agent_release_ed25519_seed_b64 || true)"
      ;;
    *)
      file_value=""
      ;;
  esac
  if [ -n "$file_value" ]; then
    printf '%s\n' "$file_value"
    return 0
  fi
  return 1
}

require_env_value() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
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

ensure_coscmd() {
  if command -v "${COSCMD_BIN:-coscmd}" >/dev/null 2>&1; then
    COSCMD_BIN="$(command -v "${COSCMD_BIN:-coscmd}")"
    export COSCMD_BIN
    return 0
  fi

  require_cmd python3
  local venv_dir pip_bin
  venv_dir="${CLOUDAGENT_COSCMD_VENV:-${HOME}/.cache/cloudagent-ci/coscmd-venv}"
  pip_bin="$venv_dir/bin/pip"
  if [ ! -x "$venv_dir/bin/coscmd" ]; then
    log "install coscmd into $venv_dir"
    python3 -m venv "$venv_dir"
    "$pip_bin" install --upgrade pip
    "$pip_bin" install coscmd
  fi
  COSCMD_BIN="$venv_dir/bin/coscmd"
  export COSCMD_BIN
}

COS_BUCKET="${CLOUDAGENT_AGENT_COS_BUCKET:-cloudagent-sidecar-shanghai-1388575217}"
COS_REGION="${CLOUDAGENT_AGENT_COS_REGION:-ap-shanghai}"
if [ "$COS_REGION" != "ap-shanghai" ] && [ "${CLOUDAGENT_AGENT_COS_ALLOW_NON_SHANGHAI:-0}" != "1" ]; then
  printf 'refuse to publish CloudAgent agent artifact outside Shanghai COS: COS_REGION=%s\n' "$COS_REGION" >&2
  exit 2
fi

COS_SECRET_ID="$(first_secret_value CLOUDAGENT_AGENT_COS_SECRET_ID COS_SECRETID COS_SECRET_ID TENCENTCLOUD_SECRET_ID AWS_ACCESS_KEY_ID || true)"
COS_SECRET_KEY="$(first_secret_value CLOUDAGENT_AGENT_COS_SECRET_KEY COS_SECRETKEY COS_SECRET_KEY TENCENTCLOUD_SECRET_KEY AWS_SECRET_ACCESS_KEY || true)"
SIGNING_SEED="$(first_secret_value CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64 || true)"

require_env_value CLOUDAGENT_AGENT_COS_SECRET_ID "$COS_SECRET_ID"
require_env_value CLOUDAGENT_AGENT_COS_SECRET_KEY "$COS_SECRET_KEY"
require_env_value CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64 "$SIGNING_SEED"

ensure_coscmd
require_cmd docker
require_cmd make
require_cmd shasum
require_cmd curl

case "$(uname -m)" in
  x86_64|amd64) HOST_GOARCH=amd64 ;;
  aarch64|arm64) HOST_GOARCH=arm64 ;;
  *) HOST_GOARCH="$(uname -m)" ;;
esac
AGENT_GOARCH="${CLOUDAGENT_AGENT_GOARCH:-${LINUX_GOARCH:-amd64}}"

COSCMD_CONFIG="${COSCMD_CONFIG:-/tmp/cloudagent-agent-shanghai-coscmd.conf}"
mkdir -p "$(dirname "$COSCMD_CONFIG")" "$ROOT_DIR/dist"
umask 077
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

log "target cos bucket=${COS_BUCKET} region=${COS_REGION}"
log "build CloudAgent sidecar arch=$AGENT_GOARCH and release signer host_arch=$HOST_GOARCH"
make "LINUX_GOARCH=$AGENT_GOARCH" cloudagent-sidecar-linux
make "LINUX_GOARCH=$HOST_GOARCH" cloudagent-agent-sign-linux

export COSCMD_CONFIG
export COS_BUCKET
export COS_REGION
export COS_PUBLIC_BASE_URL="${CLOUDAGENT_AGENT_COS_PUBLIC_BASE_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com}"
export COS_OBJECT_PREFIX="${CLOUDAGENT_AGENT_COS_OBJECT_PREFIX:-/agent-sidecar/releases}"
export CLOUDAGENT_SKIP_ENV_FILE=1
if [ -z "${CLOUDAGENT_AGENT_SIGN_BIN:-}" ] && [ "$(uname -s)" = "Linux" ]; then
  export CLOUDAGENT_AGENT_SIGN_BIN="$ROOT_DIR/dist/cloudagent-agent-sign-linux-$HOST_GOARCH"
fi
export CLOUDAGENT_AGENT_GOARCH="$AGENT_GOARCH"
export LINUX_GOARCH="$AGENT_GOARCH"
export CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64="$SIGNING_SEED"
export CLOUDAGENT_AGENT_VERSION_PREFIX="${CLOUDAGENT_AGENT_VERSION_PREFIX:-cloudagent.v1}"
export CLOUDAGENT_AGENT_REGISTRY_FILE="${CLOUDAGENT_AGENT_REGISTRY_FILE:-$ROOT_DIR/dist/cloudagent-agent-version-registry.json}"
export GATEWAY_AGENT_SIDECAR_URL_FILE="${GATEWAY_AGENT_SIDECAR_URL_FILE:-$ROOT_DIR/dist/agent-sidecar-url.clean}"
export GATEWAY_AGENT_SIDECAR_SHA256_FILE="${GATEWAY_AGENT_SIDECAR_SHA256_FILE:-$ROOT_DIR/dist/agent-sidecar-sha256.clean}"
export GATEWAY_AGENT_SIDECAR_SIG_URL_FILE="${GATEWAY_AGENT_SIDECAR_SIG_URL_FILE:-$ROOT_DIR/dist/agent-sidecar-sig-url.clean}"

./scripts/signupload_cloudagent_sidecar.sh

log "registry_json=$CLOUDAGENT_AGENT_REGISTRY_FILE"
log "sidecar_url=$(tr -d '\r' <"$GATEWAY_AGENT_SIDECAR_URL_FILE")"
log "sidecar_sig_url=$(tr -d '\r' <"$GATEWAY_AGENT_SIDECAR_SIG_URL_FILE")"
log "source_sha=${CI_COMMIT_SHA:-${GIT_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}}"
