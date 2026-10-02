#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

usage() {
  cat <<'USAGE'
Usage:
  run-autonomy-governance.sh --receipt-dir DIR [--policy FILE] [--output-dir PATH] [--interval-seconds N] [--continuous] [--no-strict]

Run strict one-shot or continuous governance loop:
  1) run run-autonomy-audit.sh
  2) evaluate output receipt against policy
  3) write control decision JSON

Exit code:
  0 = allow
  1 = degrade
  2 = block
USAGE
}

if (($# == 0)); then
  usage
  exit 2
fi

receipt_dir=""
output_dir=""
policy_file=""
interval_seconds=0
strict=true
continuous=false
pass_env=()
cell=${CELL:?CELL must name the exact Cell}
cell_namespace=${CELL_NAMESPACE:-actor-fdb-cell-system}
[[ $cell =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
  echo "CELL is not a safe receipt path component: $cell" >&2
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --receipt-dir)
      [[ $# -ge 2 ]] || { echo "--receipt-dir requires value" >&2; exit 2; }
      receipt_dir=$2
      shift 2
      ;;
    --policy)
      [[ $# -ge 2 ]] || { echo "--policy requires value" >&2; exit 2; }
      policy_file=$2
      shift 2
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || { echo "--output-dir requires value" >&2; exit 2; }
      output_dir=$2
      shift 2
      ;;
    --interval-seconds)
      [[ $# -ge 2 ]] || { echo "--interval-seconds requires value" >&2; exit 2; }
      interval_seconds=$2
      shift 2
      ;;
    --continuous)
      continuous=true
      shift
      ;;
    --no-strict)
      strict=false
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

[[ -n "$receipt_dir" ]] || { echo "--receipt-dir is required" >&2; exit 2; }
[[ $interval_seconds =~ ^[0-9]+$ ]] || {
  echo "interval must be a non-negative integer" >&2
  exit 2
}

pass_env+=(CELL="$CELL")
if [[ -n "${CELL_NAMESPACE-}" ]]; then
  pass_env+=(CELL_NAMESPACE="$CELL_NAMESPACE")
fi
if [[ -n "${KUBECONFIG_PATH-}" ]]; then
  pass_env+=(KUBECONFIG_PATH="$KUBECONFIG_PATH")
fi
if [[ -n "${PROM_NAMESPACE-}" ]]; then
  pass_env+=(PROM_NAMESPACE="$PROM_NAMESPACE")
fi
if [[ -n "${PROM_SERVICE-}" ]]; then
  pass_env+=(PROM_SERVICE="$PROM_SERVICE")
fi
if [[ -n "${ENGINE_METRICS_SERVICE-}" ]]; then
  pass_env+=(ENGINE_METRICS_SERVICE="$ENGINE_METRICS_SERVICE")
fi
if [[ -n "${RUNTIME_METRICS_SERVICE-}" ]]; then
  pass_env+=(RUNTIME_METRICS_SERVICE="$RUNTIME_METRICS_SERVICE")
fi
if [[ -n "${RUNTIME_RECEIPTS_DIR-}" ]]; then
  pass_env+=(RUNTIME_RECEIPTS_DIR="$RUNTIME_RECEIPTS_DIR")
fi
if [[ -n "${RELEASE_RECEIPTS_DIR-}" ]]; then
  pass_env+=(RELEASE_RECEIPTS_DIR="$RELEASE_RECEIPTS_DIR")
fi
if [[ -n "${DR_RECEIPTS_DIR-}" ]]; then
  pass_env+=(DR_RECEIPTS_DIR="$DR_RECEIPTS_DIR")
fi
if [[ -n "${AUTONOMY_QUALIFICATION_MODE-}" ]]; then
  pass_env+=(AUTONOMY_QUALIFICATION_MODE="$AUTONOMY_QUALIFICATION_MODE")
fi
if [[ -n "${AUTONOMY_AUDIT_RECEIPT_DIR-}" ]]; then
  pass_env+=(AUTONOMY_AUDIT_RECEIPT_DIR="$AUTONOMY_AUDIT_RECEIPT_DIR")
fi
for source_variable in AUTONOMY_SOURCE_REVISION AUTONOMY_SOURCE_MANIFEST_SHA256 AUTONOMY_SOURCE_TARGET; do
  if [[ -n ${!source_variable-} ]]; then
    pass_env+=("$source_variable=${!source_variable}")
  fi
done

mkdir -p "$receipt_dir"
: "${AUTONOMY_AUDIT_RECEIPT_DIR:=$receipt_dir}"

run_once() {
  local ts
  local audit_rc=0
  local eval_rc=0
  local state
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  local audit_receipt="$AUTONOMY_AUDIT_RECEIPT_DIR/autonomy-audit-${cell}-${ts}.json"
  local control_base="$receipt_dir"
  [[ -n "$output_dir" ]] && control_base="$output_dir"
  mkdir -p "$control_base"
  local control_receipt="$control_base/autonomy-control-${cell}-${ts}.json"

  local args=(--once --receipt "$audit_receipt")
  [[ "$strict" == true ]] && args+=(--strict)

  if env ${pass_env[@]+"${pass_env[@]}"} "$script_dir/run-autonomy-audit.sh" "${args[@]}"; then
    audit_rc=0
  else
    audit_rc=1
  fi

  local eval_cmd=(python3 "$script_dir/evaluate-autonomy-receipt.py" "$audit_receipt")
  if [[ -n "$policy_file" ]]; then
    eval_cmd+=(--policy "$policy_file")
  fi
  eval_cmd+=(--output "$control_receipt" --pretty)

  set +e
  "${eval_cmd[@]}"
  eval_rc=$?
  set -e
  if (( eval_rc != 0 )); then
    if [[ ! -f "$control_receipt" ]]; then
      local eval_fail_payload
      local source_identity_json=null
      if [[ -s $audit_receipt ]]; then
        source_identity_json=$(python3 - "$audit_receipt" <<'PY'
import json,sys
try:
    value=json.load(open(sys.argv[1])).get("sourceIdentity")
except (OSError,TypeError,ValueError):
    value=None
print(json.dumps(value,separators=(",",":")))
PY
)
      fi
      eval_fail_payload="$(cat <<JSON
{
  "schemaVersion": "actor-fdb-autonomy-control-v1",
  "sourceIdentity": $source_identity_json,
  "policy_version": "autonomy-control-policy-v1",
  "control": "block",
  "verdict": "failed",
  "cell": "$cell",
  "namespace": "$cell_namespace",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "actions": [
    "open_incident_and_page",
    "run_topology_recheck",
    "block_rollout_or_qualification"
  ],
  "matched_rules": [
    {
      "rule": "governance-eval-error",
      "notes": "governance evaluate failed; defaulting to block"
    }
  ],
  "autonomy_score": 0.0,
  "warnings": ["governance_evaluation_failed_exit_${eval_rc}"],
  "failures": ["governance_evaluation_failed"],
  "source_receipt": "$audit_receipt"
}
JSON
)"
      echo "$eval_fail_payload" > "$control_receipt"
    fi
  fi

  echo "autonomy-governance: receipt=$audit_receipt"
  echo "autonomy-governance: decision=$control_receipt"
  cat "$control_receipt"

  if [[ ! -s "$control_receipt" ]]; then
    echo "autonomy-governance: control receipt empty: $control_receipt" >&2
    return 2
  fi

  state=$(python3 - "$control_receipt" <<'PY'
import json
import sys
with open(sys.argv[1]) as f:
    print(json.load(f).get("control", "unknown"))
PY
)

  if [[ "$state" == "block" ]]; then
    eval_rc=2
  elif [[ "$state" == "degrade" ]]; then
    eval_rc=1
  else
    eval_rc=0
  fi

  if (( audit_rc != 0 )); then
    (( audit_rc = 2 ))
  fi

  if (( eval_rc > audit_rc )); then
    return "$eval_rc"
  fi
  return "$audit_rc"
}

if $continuous; then
  if (( interval_seconds == 0 )); then
    interval_seconds=300
  fi
  while true; do
    set +e
    run_once
    rc=$?
    set -e
    if (( rc >= 2 )); then
      echo "autonomy-governance: blocking condition reached; stopping loop" >&2
      exit "$rc"
    fi
    sleep "$interval_seconds"
  done
fi

run_once
exit $?
