#!/usr/bin/env bash

set -euo pipefail

ENV_SPEC="${HERMES_ROLLOUT_ENV_SPEC:-}"
OUTPUT_ROOT="${HERMES_ROLLOUT_OUTPUT_ROOT:-.ci/.runtime-state/hermes-rollout}"
TAT_SCRIPT_FILE="${HERMES_TAT_SCRIPT_FILE:-images/helpers/config-hermes-python-mirrors.sh}"

usage() {
  cat <<'EOF'
Usage:
  HERMES_ROLLOUT_ENV_SPEC=beijing-sandbox:ap-beijing:kubeconfig_beijing_sandbox \
    bash .ci/runtime/commands/rollout_hermes_sandbox_env.sh

Refresh then repair one Hermes sandbox environment.

This compatibility wrapper runs:
  1. refresh_hermes_sandbox_env.sh
  2. repair_hermes_existing_vms.sh

Environment:
  HERMES_ROLLOUT_ENV_SPEC
      Required env spec: <env>:<region>:<kubeconfig-key-or-path>.
  HERMES_IMAGE_NAME
      Current image name. Used only if HERMES_IMAGE_ID_<REGION> is missing.
  HERMES_IMAGE_ID_AP_BEIJING / HERMES_IMAGE_ID_AP_SHANGHAI / HERMES_IMAGE_ID_AP_SINGAPORE
      Region image ids produced by the current Hermes image build.
EOF
}

fail() {
  printf '[rollout-hermes-sandbox] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 0
}

[[ -n "$ENV_SPEC" ]] || fail "HERMES_ROLLOUT_ENV_SPEC is required"
IFS=: read -r env_name region kube_key <<<"$ENV_SPEC"
[[ -n "${env_name:-}" && -n "${region:-}" && -n "${kube_key:-}" ]] || fail "invalid HERMES_ROLLOUT_ENV_SPEC: $ENV_SPEC"

require_cmd bash
require_cmd curl
require_cmd jq
require_cmd python3
require_cmd tccli

HERMES_REFRESH_ENV_SPEC="$ENV_SPEC" \
  bash .ci/runtime/commands/refresh_hermes_sandbox_env.sh

HERMES_REPAIR_ENV_SPEC="$ENV_SPEC" \
  HERMES_REPAIR_OUTPUT_ROOT="$OUTPUT_ROOT" \
  HERMES_TAT_SCRIPT_FILE="$TAT_SCRIPT_FILE" \
  bash .ci/runtime/commands/repair_hermes_existing_vms.sh
