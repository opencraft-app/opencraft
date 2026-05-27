#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib/load_env.sh"
load_cloudagent_env "$ROOT_DIR"

log() {
  printf '[cloudagent-artifacts-ci] %s\n' "$*" >&2
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
  printf 'refuse to publish CloudAgent artifacts outside Shanghai COS: COS_REGION=%s\n' "$COS_REGION" >&2
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

export COSCMD_CONFIG
export COS_BUCKET
export COS_REGION
export COS_PUBLIC_BASE_URL="${CLOUDAGENT_AGENT_COS_PUBLIC_BASE_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com}"
export CLOUDAGENT_SKIP_ENV_FILE=1
export CLOUDAGENT_AGENT_COS_SECRET_ID="$COS_SECRET_ID"
export CLOUDAGENT_AGENT_COS_SECRET_KEY="$COS_SECRET_KEY"
export CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64="$SIGNING_SEED"
if [ "${CLOUDAGENT_ARTIFACTS_DRY_RUN:-0}" = "1" ]; then
  export CLOUDAGENT_SIGNUPLOAD_DRY_RUN=1
  export CLOUDAGENT_WISP_PUBLISH_DRY_RUN=1
fi

log "target cos bucket=${COS_BUCKET} region=${COS_REGION}"
log "build, sign, and publish agent sidecar"
export CLOUDAGENT_AGENT_COS_OBJECT_PREFIX="${CLOUDAGENT_AGENT_COS_OBJECT_PREFIX:-/agent-sidecar/releases}"
export CLOUDAGENT_AGENT_VERSION_PREFIX="${CLOUDAGENT_AGENT_VERSION_PREFIX:-cloudagent.v1}"
export CLOUDAGENT_AGENT_REGISTRY_FILE="${CLOUDAGENT_AGENT_REGISTRY_FILE:-$ROOT_DIR/dist/cloudagent-agent-version-registry.json}"
export GATEWAY_AGENT_SIDECAR_URL_FILE="${GATEWAY_AGENT_SIDECAR_URL_FILE:-$ROOT_DIR/dist/agent-sidecar-url.clean}"
export GATEWAY_AGENT_SIDECAR_SHA256_FILE="${GATEWAY_AGENT_SIDECAR_SHA256_FILE:-$ROOT_DIR/dist/agent-sidecar-sha256.clean}"
export GATEWAY_AGENT_SIDECAR_SIG_URL_FILE="${GATEWAY_AGENT_SIDECAR_SIG_URL_FILE:-$ROOT_DIR/dist/agent-sidecar-sig-url.clean}"
export COS_OBJECT_PREFIX="$CLOUDAGENT_AGENT_COS_OBJECT_PREFIX"
if [ ! -f "${GATEWAY_AGENT_SIDECAR_BINARY:-$ROOT_DIR/dist/cloudagent-sidecar-linux-amd64}" ]; then
  make cloudagent-sidecar-linux cloudagent-agent-sign-linux
elif [ ! -f "$ROOT_DIR/dist/cloudagent-agent-sign-linux-amd64" ] && [ -z "${CLOUDAGENT_AGENT_SIGN_BIN:-}" ]; then
  make cloudagent-agent-sign-linux
fi
if [ -z "${CLOUDAGENT_AGENT_SIGN_BIN:-}" ] && [ "$(uname -s)" = "Linux" ]; then
  export CLOUDAGENT_AGENT_SIGN_BIN="$ROOT_DIR/dist/cloudagent-agent-sign-linux-amd64"
fi
"$ROOT_DIR/scripts/signupload_cloudagent_sidecar.sh"

log "build and publish Wisp package"
export COS_OBJECT_PREFIX="${CLOUDAGENT_WISP_COS_OBJECT_PREFIX:-/workspace/releases}"
export CLOUDAGENT_WORKSPACE_VERSION_PREFIX="${CLOUDAGENT_WORKSPACE_VERSION_PREFIX:-wisp.v1}"
export CLOUDAGENT_WISP_PACKAGE_URL_FILE="${CLOUDAGENT_WISP_PACKAGE_URL_FILE:-$ROOT_DIR/dist/wisp-package-url.clean}"
export CLOUDAGENT_WISP_PACKAGE_SHA256_FILE="${CLOUDAGENT_WISP_PACKAGE_SHA256_FILE:-$ROOT_DIR/dist/wisp-package-sha256.clean}"
export CLOUDAGENT_WORKSPACE_VERSION_REGISTRY_FILE="${CLOUDAGENT_WORKSPACE_VERSION_REGISTRY_FILE:-$ROOT_DIR/dist/cloudagent-workspace-version-registry.json}"
"$ROOT_DIR/scripts/publish_cloudagent_wisp_package.sh"

python3 - "$ROOT_DIR/dist/cloudagent-artifacts-registry.json" \
  "$CLOUDAGENT_AGENT_REGISTRY_FILE" \
  "$CLOUDAGENT_WORKSPACE_VERSION_REGISTRY_FILE" <<'PY'
import json
import sys

out, agent_path, workspace_path = sys.argv[1:]
combined = {
    "agent_versions": json.load(open(agent_path, encoding="utf-8")),
    "workspace_versions": json.load(open(workspace_path, encoding="utf-8")),
}
raw = json.dumps(combined, indent=2, sort_keys=True)
with open(out, "w", encoding="utf-8") as fh:
    fh.write(raw + "\n")
print(raw)
PY

log "combined_registry_json=$ROOT_DIR/dist/cloudagent-artifacts-registry.json"
log "sidecar_url=$(tr -d '\r' <"$GATEWAY_AGENT_SIDECAR_URL_FILE")"
log "wisp_package_url=$(tr -d '\r' <"$CLOUDAGENT_WISP_PACKAGE_URL_FILE")"
log "source_sha=${CI_COMMIT_SHA:-${GIT_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}}"
