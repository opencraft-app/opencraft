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
  # Devcloud Stream settings are optional; CI runners can also provide local secret files.
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

export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"
ensure_coscmd
require_cmd docker
require_cmd make
require_cmd shasum
require_cmd curl

host_goarch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'amd64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    *) uname -m ;;
  esac
}

normalize_arches() {
  printf '%s\n' "$1" | tr ',' ' ' | awk '
    {
      for (i = 1; i <= NF; i++) {
        if ($i != "") print $i
      }
    }
  '
}

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
artifact_arches_raw="${CLOUDAGENT_ARTIFACT_ARCHES:-${CLOUDAGENT_AGENT_GOARCH:-${LINUX_GOARCH:-amd64}}}"
mapfile -t artifact_arches < <(normalize_arches "$artifact_arches_raw")
if [ "${#artifact_arches[@]}" -eq 0 ]; then
  artifact_arches=(amd64)
fi
if [ "${#artifact_arches[@]}" -gt 1 ] && [ -n "${CLOUDAGENT_WISP_PACKAGE_ARTIFACT:-}" ]; then
  printf 'CLOUDAGENT_WISP_PACKAGE_ARTIFACT can only be used with one artifact arch, got: %s\n' "$artifact_arches_raw" >&2
  exit 2
fi
log "artifact_arches=${artifact_arches[*]}"

if [ -z "${CLOUDAGENT_AGENT_SIGN_BIN:-}" ] && [ "$(uname -s)" = "Linux" ]; then
  signer_arch="$(host_goarch)"
  log "build release signer for host arch=$signer_arch"
  make "LINUX_GOARCH=$signer_arch" cloudagent-agent-sign-linux
  export CLOUDAGENT_AGENT_SIGN_BIN="$ROOT_DIR/dist/cloudagent-agent-sign-linux-$signer_arch"
fi

merged_agent_registry="$ROOT_DIR/dist/cloudagent-agent-version-registry.json"
merged_workspace_registry="$ROOT_DIR/dist/cloudagent-workspace-version-registry.json"
rm -f "$merged_agent_registry" "$merged_workspace_registry"
agent_registry_parts=()
workspace_registry_parts=()

export CLOUDAGENT_AGENT_COS_OBJECT_PREFIX="${CLOUDAGENT_AGENT_COS_OBJECT_PREFIX:-/agent-sidecar/releases}"
export CLOUDAGENT_AGENT_VERSION_PREFIX="${CLOUDAGENT_AGENT_VERSION_PREFIX:-cloudagent.v1}"
export CLOUDAGENT_WISP_COS_OBJECT_PREFIX="${CLOUDAGENT_WISP_COS_OBJECT_PREFIX:-/workspace/releases}"
export CLOUDAGENT_WORKSPACE_VERSION_PREFIX="${CLOUDAGENT_WORKSPACE_VERSION_PREFIX:-wisp.v1}"

for arch in "${artifact_arches[@]}"; do
  case "$arch" in
    amd64|arm64) ;;
    *) printf 'unsupported CloudAgent artifact arch: %s\n' "$arch" >&2; exit 2 ;;
  esac

  log "build, sign, and publish agent sidecar arch=$arch"
  export CLOUDAGENT_AGENT_GOARCH="$arch"
  export LINUX_GOARCH="$arch"
  export DOCKER_PLATFORM="linux/$arch"
  export COS_OBJECT_PREFIX="$CLOUDAGENT_AGENT_COS_OBJECT_PREFIX"
  export GATEWAY_AGENT_SIDECAR_BINARY="$ROOT_DIR/dist/cloudagent-sidecar-linux-$arch"
  export CLOUDAGENT_SIDECAR_BASENAME="cloudagent-sidecar-linux-$arch"
  export CLOUDAGENT_AGENT_REGISTRY_FILE="$ROOT_DIR/dist/cloudagent-agent-version-registry-$arch.json"
  export GATEWAY_AGENT_SIDECAR_URL_FILE="$ROOT_DIR/dist/agent-sidecar-url-$arch.clean"
  export GATEWAY_AGENT_SIDECAR_SHA256_FILE="$ROOT_DIR/dist/agent-sidecar-sha256-$arch.clean"
  export GATEWAY_AGENT_SIDECAR_SIG_URL_FILE="$ROOT_DIR/dist/agent-sidecar-sig-url-$arch.clean"
  make "LINUX_GOARCH=$arch" cloudagent-sidecar-linux
  "$ROOT_DIR/scripts/signupload_cloudagent_sidecar.sh"
  agent_registry_parts+=("$CLOUDAGENT_AGENT_REGISTRY_FILE")
  if [ "$arch" = "amd64" ]; then
    cp "$GATEWAY_AGENT_SIDECAR_URL_FILE" "$ROOT_DIR/dist/agent-sidecar-url.clean"
    cp "$GATEWAY_AGENT_SIDECAR_SHA256_FILE" "$ROOT_DIR/dist/agent-sidecar-sha256.clean"
    cp "$GATEWAY_AGENT_SIDECAR_SIG_URL_FILE" "$ROOT_DIR/dist/agent-sidecar-sig-url.clean"
  fi

  log "build and publish Wisp package arch=$arch"
  export GOARCH="$arch"
  export COS_OBJECT_PREFIX="$CLOUDAGENT_WISP_COS_OBJECT_PREFIX"
  export CLOUDAGENT_WISP_PACKAGE_URL_FILE="$ROOT_DIR/dist/wisp-package-url-$arch.clean"
  export CLOUDAGENT_WISP_PACKAGE_SHA256_FILE="$ROOT_DIR/dist/wisp-package-sha256-$arch.clean"
  export CLOUDAGENT_WORKSPACE_VERSION_REGISTRY_FILE="$ROOT_DIR/dist/cloudagent-workspace-version-registry-$arch.json"
  "$ROOT_DIR/scripts/publish_cloudagent_wisp_package.sh"
  workspace_registry_parts+=("$CLOUDAGENT_WORKSPACE_VERSION_REGISTRY_FILE")
  if [ "$arch" = "amd64" ]; then
    cp "$CLOUDAGENT_WISP_PACKAGE_URL_FILE" "$ROOT_DIR/dist/wisp-package-url.clean"
    cp "$CLOUDAGENT_WISP_PACKAGE_SHA256_FILE" "$ROOT_DIR/dist/wisp-package-sha256.clean"
  fi
done

python3 - "$merged_agent_registry" "${agent_registry_parts[@]}" <<'PY'
import json
import sys

out, *parts = sys.argv[1:]
merged = {}
for part in parts:
    with open(part, encoding="utf-8") as fh:
        merged.update(json.load(fh))
with open(out, "w", encoding="utf-8") as fh:
    json.dump(merged, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY

python3 - "$merged_workspace_registry" "${workspace_registry_parts[@]}" <<'PY'
import json
import sys

out, *parts = sys.argv[1:]
merged = {}
for part in parts:
    with open(part, encoding="utf-8") as fh:
        merged.update(json.load(fh))
with open(out, "w", encoding="utf-8") as fh:
    json.dump(merged, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY

python3 - "$ROOT_DIR/dist/cloudagent-artifacts-registry.json" \
  "$merged_agent_registry" \
  "$merged_workspace_registry" <<'PY'
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
for arch in "${artifact_arches[@]}"; do
  if [ -f "$ROOT_DIR/dist/agent-sidecar-url-$arch.clean" ]; then
    log "sidecar_url_${arch}=$(tr -d '\r' <"$ROOT_DIR/dist/agent-sidecar-url-$arch.clean")"
  fi
  if [ -f "$ROOT_DIR/dist/wisp-package-url-$arch.clean" ]; then
    log "wisp_package_url_${arch}=$(tr -d '\r' <"$ROOT_DIR/dist/wisp-package-url-$arch.clean")"
  fi
done
log "source_sha=${CI_COMMIT_SHA:-${GIT_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}}"
