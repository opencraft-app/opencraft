#!/usr/bin/env bash

set -euo pipefail

ENV_SPEC="${HERMES_REFRESH_ENV_SPEC:-${HERMES_ROLLOUT_ENV_SPEC:-}}"

usage() {
  cat <<'EOF'
Usage:
  HERMES_REFRESH_ENV_SPEC=beijing-sandbox:ap-beijing:kubeconfig_beijing_sandbox \
    bash .ci/runtime/commands/refresh_hermes_sandbox_env.sh

Refresh one Hermes sandbox environment:
  1. resolve the regional Hermes CVM image id
  2. refresh Hermes SKU and pools through sandbox-api internal API

Environment:
  HERMES_REFRESH_ENV_SPEC / HERMES_ROLLOUT_ENV_SPEC
      Required env spec: <env>:<region>:<kubeconfig-key-or-path>.
  HERMES_IMAGE_NAME
      Current image name. Used only if HERMES_IMAGE_ID_<REGION> is missing.
  HERMES_IMAGE_ID_AP_BEIJING / HERMES_IMAGE_ID_AP_SHANGHAI /
  HERMES_IMAGE_ID_AP_SINGAPORE / HERMES_IMAGE_ID_AP_TOKYO
      Region image ids produced by the current Hermes image build.
EOF
}

log() {
  printf '[refresh-hermes-sandbox] %s\n' "$*" >&2
}

fail() {
  printf '[refresh-hermes-sandbox] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

region_env_suffix() {
  printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_'
}

resolve_image_id_for_region() {
  local region="$1"
  local suffix image_var image_id
  suffix="$(region_env_suffix "$region")"
  image_var="HERMES_IMAGE_ID_${suffix}"
  image_id="${!image_var:-}"
  if [[ -z "$image_id" ]]; then
    [[ -n "${HERMES_IMAGE_NAME:-}" ]] || fail "missing HERMES_IMAGE_NAME and ${image_var}"
    log "resolving ${image_var} by exact image name: ${HERMES_IMAGE_NAME}"
    image_id="$(python3 .ci/runtime/commands/resolve_hermes_image_id.py --region "$region" --image-name "$HERMES_IMAGE_NAME")"
  fi
  export "${image_var}=${image_id}"
  printf '%s\n' "$image_id"
}

[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 0
}

[[ -n "$ENV_SPEC" ]] || fail "HERMES_REFRESH_ENV_SPEC is required"
IFS=: read -r env_name region kube_key <<<"$ENV_SPEC"
[[ -n "${env_name:-}" && -n "${region:-}" && -n "${kube_key:-}" ]] || fail "invalid HERMES_REFRESH_ENV_SPEC: $ENV_SPEC"

require_cmd bash
require_cmd curl
require_cmd jq
require_cmd python3
require_cmd tccli

image_id="$(resolve_image_id_for_region "$region")"
image_var="HERMES_IMAGE_ID_$(region_env_suffix "$region")"
export "${image_var}=${image_id}"

log "refreshing pools env=${env_name} region=${region} image=${image_id}"
HERMES_SANDBOX_POOL_REFRESH_ENVS="$ENV_SPEC" \
  bash .ci/runtime/commands/refresh_hermes_sandbox_pools.sh
