#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

usage() {
  cat <<'EOF_USAGE'
Usage:
  run-autonomy-audit.sh [--once] [--strict] [--interval-seconds N] [--max-failures N] [--receipt /path]

Run one or repeated autonomy audits and persist receipts for governance.

Options:
  --once               Run once and exit.
  --strict             Convert warning-only audit result to failure.
  --interval-seconds   Seconds between polls when running continuously (default: 300).
  --max-failures       Allow N consecutive failures before aborting; 0 means never abort (default: 0).

Environment variables:
  CELL                                  Required exact Cell identity
  CELL_NAMESPACE                        Default: actor-fdb-cell-system
  KUBECONFIG_PATH                       Path to kubeconfig (default: value of KUBECONFIG)
  PROM_NAMESPACE                        Default: observability
  PROM_SERVICE                          Default: actor-observability-prometheus
  ENGINE_METRICS_SERVICE                Default: actor-fleet-engine-metrics
  RUNTIME_METRICS_SERVICE               Default: <CELL>-runtime-hosts
  CLUSTER_PREFIX                        Default: CELL
  RUNTIME_RECEIPTS_DIR                  Runtime receipt directory
  RELEASE_RECEIPTS_DIR                  Immutable runtime release ledger receipt directory
  DR_RECEIPTS_DIR                       DR receipt directory
  AUTONOMY_QUALIFICATION_MODE           standalone, initial-cell, or autoscaling-cell (default: standalone)
  AUTONOMY_AUDIT_RECEIPT_DIR            Receipt output directory
  AUTONOMY_SOURCE_REVISION               Immutable reviewed-source Git commit
  AUTONOMY_SOURCE_MANIFEST_SHA256        Immutable reviewed-source manifest digest
  AUTONOMY_SOURCE_TARGET                 Immutable reviewed-source physical directory
  --receipt                              Override output receipt path
EOF_USAGE
}

once=false
strict=false
interval_seconds=300
max_failures=0
override_receipt=""

while (($# > 0)); do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --once)
      once=true
      shift
      ;;
    --strict)
      strict=true
      shift
      ;;
    --interval-seconds)
      [[ $# -ge 2 ]] || { echo "--interval-seconds requires a value" >&2; exit 2; }
      interval_seconds=$2
      shift 2
      ;;
    --max-failures)
      [[ $# -ge 2 ]] || { echo "--max-failures requires a value" >&2; exit 2; }
      max_failures=$2
      shift 2
      ;;
    --receipt)
      [[ $# -ge 2 ]] || { echo "--receipt requires a value" >&2; exit 2; }
      override_receipt=$2
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

cell=${CELL:?CELL must name the exact Cell}
cell_namespace=${CELL_NAMESPACE:-actor-fdb-cell-system}
kubeconfig=${KUBECONFIG_PATH:-${KUBECONFIG:-}}
prom_namespace=${PROM_NAMESPACE:-observability}
prom_service=${PROM_SERVICE:-actor-observability-prometheus}
engine_metrics_service=${ENGINE_METRICS_SERVICE:-actor-fleet-engine-metrics}
runtime_metrics_service=${RUNTIME_METRICS_SERVICE:-${cell}-runtime-hosts}
cluster_prefix=${CLUSTER_PREFIX:-$cell}
qualification_mode=${AUTONOMY_QUALIFICATION_MODE:-standalone}
source_revision=${AUTONOMY_SOURCE_REVISION:-}
source_manifest_sha256=${AUTONOMY_SOURCE_MANIFEST_SHA256:-}
source_target=${AUTONOMY_SOURCE_TARGET:-}
source_identity_fields=0
[[ -n $source_revision ]] && ((source_identity_fields += 1))
[[ -n $source_manifest_sha256 ]] && ((source_identity_fields += 1))
[[ -n $source_target ]] && ((source_identity_fields += 1))
if ((source_identity_fields != 0 && source_identity_fields != 3)); then
  echo "reviewed-source identity must provide revision, manifest digest, and physical target together" >&2
  exit 2
fi
source_identity_json=null
if ((source_identity_fields == 3)); then
  [[ $source_revision =~ ^[0-9a-f]{40}$ \
    && $source_manifest_sha256 =~ ^[0-9a-f]{64}$ \
    && $source_target =~ ^/[A-Za-z0-9._/-]+$ \
    && ${source_target##*/} =~ ^[a-z0-9-]+-src-${source_revision}-${source_manifest_sha256}$ ]] || {
    echo "reviewed-source identity is malformed" >&2
    exit 2
  }
  source_identity_json=$(printf \
    '{"revision":"%s","manifest_sha256":"%s","target":"%s"}' \
    "$source_revision" "$source_manifest_sha256" "$source_target")
fi

runtime_receipts_dir=${RUNTIME_RECEIPTS_DIR:-$script_dir/../runtime/receipts}
release_receipts_dir=${RELEASE_RECEIPTS_DIR:-$runtime_receipts_dir}
dr_receipts_dir=${DR_RECEIPTS_DIR:-$script_dir/../dr/receipts}
receipt_dir=${AUTONOMY_AUDIT_RECEIPT_DIR:-$script_dir/receipts}

mkdir -p "$receipt_dir"

run_once() {
  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  local receipt
  if [[ -n "${override_receipt}" ]]; then
    receipt="$override_receipt"
  else
    receipt="$receipt_dir/autonomy-audit-${cell}-${ts}.json"
  fi

  local args=(
    --namespace "$cell_namespace"
    --cell "$cell"
    --prometheus-namespace "$prom_namespace"
    --prometheus-service "$prom_service"
    --engine-metrics-service "$engine_metrics_service"
    --runtime-metrics-service "$runtime_metrics_service"
    --cluster-prefix "$cluster_prefix"
    --receipt "$receipt"
    --runtime-receipts-dir "$runtime_receipts_dir"
    --release-receipts-dir "$release_receipts_dir"
    --dr-receipts-dir "$dr_receipts_dir"
    --qualification-mode "$qualification_mode"
  )
  if ((source_identity_fields == 3)); then
    args+=(
      --source-revision "$source_revision"
      --source-manifest-sha256 "$source_manifest_sha256"
      --source-target "$source_target"
    )
  fi
  if [[ -n "$kubeconfig" ]]; then
    if [[ -f "$kubeconfig" ]]; then
      args+=(--kubeconfig "$kubeconfig")
    else
      echo "autonomy-audit: kubeconfig not found: $kubeconfig, using current kube context" >&2
    fi
  fi

  if "$strict"; then
    args+=(--strict)
  fi

  echo "autonomy-audit: start cell=$cell timestamp=$ts receipt=$receipt"
  local error_file stdout_file
  error_file=$(mktemp)
  stdout_file=$(mktemp)
  set +e
  python3 "$script_dir/autonomy_audit.py" "${args[@]}" > "$stdout_file" 2> "$error_file"
  local rc=$?
  set -e

  if (( rc == 0 )); then
    if [[ ! -f "$receipt" ]]; then
      echo "autonomy-audit: script exit success but receipt not written: $receipt" >&2
      rm -f "$error_file" "$stdout_file"
      return 1
    fi
    echo "autonomy-audit: pass $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    rm -f "$error_file" "$stdout_file"
    return 0
  fi

  # A non-passing audit is an expected control outcome. The Python collector
  # writes the detailed receipt before returning 1; preserve it so governance
  # sees the true reason instead of a synthetic wrapper failure.
  if [[ -s "$receipt" ]]; then
    echo "autonomy-audit: non-pass $(date -u +%Y-%m-%dT%H:%M:%SZ) receipt=$receipt" >&2
    rm -f "$error_file" "$stdout_file"
    return 1
  fi

  local reason
  reason=$(sed 's/[\\"]//g' "$error_file" "$stdout_file" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c1-2048)
  reason=${reason:-autonomy_audit_error}
  cat >"$receipt" <<JSON
{
  "schemaVersion": "actor-fdb-autonomy-audit-v1",
  "sourceIdentity": $source_identity_json,
  "cell": "$cell",
  "namespace": "$cell_namespace",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "verdict": "failed",
  "autonomy_score": 0.0,
  "k8s": {},
  "prometheus": {},
  "receipts": {},
  "summary": {
    "runtime": {},
    "foundationdb": {},
    "backup": {},
    "topology": {}
  },
  "failures": ["autonomy_audit_failed", "$reason"],
  "warnings": ["autonomy_audit_exit_code_${rc}"],
  "notes": "autonomy audit command failed"
}
JSON
  echo "autonomy-audit: fail $(date -u +%Y-%m-%dT%H:%M:%SZ) receipt=$receipt" >&2
  rm -f "$error_file" "$stdout_file"
  return 1
}

if "$once"; then
  run_once
  exit $?
fi

if ! [[ $interval_seconds =~ ^[0-9]+$ ]] || (( interval_seconds <= 0 )); then
  echo "interval-seconds must be a positive integer" >&2
  exit 2
fi
if ! [[ $max_failures =~ ^[0-9]+$ ]]; then
  echo "max-failures must be a non-negative integer" >&2
  exit 2
fi

consecutive_failures=0

while true; do
  if run_once; then
    consecutive_failures=0
  else
    consecutive_failures=$((consecutive_failures + 1))
    if (( max_failures > 0 && consecutive_failures >= max_failures )); then
      echo "autonomy-audit: exceeded max failures ($consecutive_failures) and aborting" >&2
      exit 1
    fi
  fi
  sleep "$interval_seconds"
done
