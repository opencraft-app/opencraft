#!/usr/bin/env bash

set -euo pipefail

ENV_SPEC="${HERMES_REPAIR_ENV_SPEC:-${HERMES_ROLLOUT_ENV_SPEC:-}}"
OUTPUT_ROOT="${HERMES_REPAIR_OUTPUT_ROOT:-${HERMES_ROLLOUT_OUTPUT_ROOT:-.ci/.runtime-state/hermes-rollout}}"
TAT_SCRIPT_FILE="${HERMES_TAT_SCRIPT_FILE:-images/helpers/config-hermes-python-mirrors.sh}"

usage() {
  cat <<'EOF'
Usage:
  HERMES_REPAIR_ENV_SPEC=shprod:ap-shanghai:kubeconfig_shprod \
    bash .ci/runtime/commands/repair_hermes_existing_vms.sh

Repair existing Hermes VM inventory for one sandbox environment:
  1. list existing Hermes pool VMs read-only
  2. create per-region Tencent Cloud TAT commands from the checked-in repair script
  3. invoke TAT in serial batches with single-machine retry fallback

Environment:
  HERMES_REPAIR_ENV_SPEC / HERMES_ROLLOUT_ENV_SPEC
      Required env spec: <env>:<region>:<kubeconfig-key-or-path>.
  HERMES_TAT_SCRIPT_FILE
      Repair script to embed into Tencent Cloud TAT Command.
EOF
}

log() {
  printf '[repair-hermes-existing-vms] %s\n' "$*" >&2
}

fail() {
  printf '[repair-hermes-existing-vms] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

safe_name() {
  printf '%s' "$1" | tr -cs 'A-Za-z0-9_.-' '-'
}

[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 0
}

[[ -n "$ENV_SPEC" ]] || fail "HERMES_REPAIR_ENV_SPEC is required"
IFS=: read -r env_name region kube_key <<<"$ENV_SPEC"
[[ -n "${env_name:-}" && -n "${region:-}" && -n "${kube_key:-}" ]] || fail "invalid HERMES_REPAIR_ENV_SPEC: $ENV_SPEC"

require_cmd bash
require_cmd curl
require_cmd jq
require_cmd python3
require_cmd tccli

safe_env="$(safe_name "$env_name")"
output_dir="${OUTPUT_ROOT}/${safe_env}"
tat_output_dir="${output_dir}/hermes-tat"
mkdir -p "$tat_output_dir" /tmp/lightclaw-ci

[[ -r "$TAT_SCRIPT_FILE" ]] || fail "TAT script file is not readable: ${TAT_SCRIPT_FILE}"
bash -n "$TAT_SCRIPT_FILE"

VM_LIST="${tat_output_dir}/vms.jsonl"
log "listing existing VMs env=${env_name} region=${region}"
HERMES_POOL_VM_LIST_ENVS="$ENV_SPEC" \
  bash .ci/runtime/commands/list_hermes_pool_vms.sh >"$VM_LIST"
cp "$VM_LIST" "/tmp/lightclaw-ci/hermes-pool-vms-${safe_env}-${BK_CI_BUILD_ID:-manual}.jsonl"
wc -l "$VM_LIST"
if [[ ! -s "$VM_LIST" ]]; then
  fail "no Hermes pool VM rows found for ${env_name}; abort existing VM repair"
fi

REGION_MANIFEST="${tat_output_dir}/region-files.tsv"
python3 .ci/runtime/commands/split_hermes_pool_vms_by_region.py "$VM_LIST" "$tat_output_dir" >"$REGION_MANIFEST"

while IFS=$'\t' read -r tat_region region_file count; do
  [[ -n "$tat_region" ]] || continue
  command_env_file="${tat_output_dir}/command-${tat_region}.env"
  HERMES_TAT_REGION="$tat_region" \
    HERMES_TAT_SCRIPT_FILE="$TAT_SCRIPT_FILE" \
    HERMES_TAT_COMMAND_ENV_FILE="$command_env_file" \
    bash .ci/runtime/commands/create_hermes_tat_command.sh
  # shellcheck disable=SC1090
  source "$command_env_file"
  [[ -n "${HERMES_TAT_COMMAND_ID:-}" ]] || fail "failed to create Hermes TAT command for region=${tat_region}"

  log "invoking TAT env=${env_name} region=${tat_region} count=${count} command_id=${HERMES_TAT_COMMAND_ID}"
  HERMES_TAT_REGION="$tat_region" \
    HERMES_TAT_COMMAND_ID="$HERMES_TAT_COMMAND_ID" \
    HERMES_TAT_INPUT_FILE="$region_file" \
    HERMES_TAT_OUTPUT_DIR="$tat_output_dir" \
    HERMES_TAT_BATCH_SIZE="${HERMES_TAT_BATCH_SIZE:-5}" \
    HERMES_TAT_SINGLE_ATTEMPTS="${HERMES_TAT_SINGLE_ATTEMPTS:-3}" \
    bash .ci/runtime/commands/invoke_hermes_tat_command.sh
done <"$REGION_MANIFEST"

cp -R "$tat_output_dir" "/tmp/lightclaw-ci/hermes-tat-${safe_env}-${BK_CI_BUILD_ID:-manual}"
find "$tat_output_dir" -maxdepth 1 -type f -name '*.summary.json' -print -exec cat {} \;
