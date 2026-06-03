#!/usr/bin/env bash

set -euo pipefail

TEMPLATE_CLASS_ID="${HERMES_TEMPLATE_CLASS_ID:-hermes}"
ENV_SPECS="${HERMES_POOL_VM_LIST_ENVS:-shprod:ap-shanghai:kubeconfig_shprod}"
KUBECONFIG_ROOT="${HERMES_SANDBOX_KUBECONFIG_ROOT:-/etc/lightclaw-ci}"
OUTPUT_FORMAT="${HERMES_POOL_VM_LIST_FORMAT:-jsonl}"
INCLUDE_EMPTY_CLOUD_ID="${HERMES_POOL_VM_LIST_INCLUDE_EMPTY_CLOUD_ID:-false}"
PORT_FORWARD_PIDS=()

usage() {
  cat <<'EOF'
Usage:
  list_hermes_pool_vms.sh

Read-only script. It lists Hermes sandbox pool VMs through sandbox-api internal
APIs and does not patch pools, update SKUs, invoke TAT, or write database rows.

Environment:
  HERMES_POOL_VM_LIST_ENVS
      Comma-separated env specs: <env>:<region>:<kubeconfig-key-or-path>
      Default: shprod:ap-shanghai:kubeconfig_shprod
  HERMES_TEMPLATE_CLASS_ID
      Default: hermes
  HERMES_SANDBOX_KUBECONFIG_ROOT
      Default: /etc/lightclaw-ci
  HERMES_POOL_VM_LIST_FORMAT
      jsonl | tsv. Default: jsonl
  HERMES_POOL_VM_LIST_INCLUDE_EMPTY_CLOUD_ID
      true | false. Default: false

Examples:
  bash .ci/runtime/commands/list_hermes_pool_vms.sh
  HERMES_POOL_VM_LIST_FORMAT=tsv bash .ci/runtime/commands/list_hermes_pool_vms.sh
  bash .ci/runtime/commands/list_hermes_pool_vms.sh | jq -r '.cloud_id'
EOF
}

log() {
  printf '[list-hermes-pool-vms] %s\n' "$*" >&2
}

fail() {
  printf '[list-hermes-pool-vms] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

csv_to_lines() {
  local value="$1"
  python3 - "$value" <<'PY'
import sys
for item in sys.argv[1].split(","):
    item = item.strip()
    if item:
        print(item)
PY
}

choose_local_port() {
  python3 - <<'PY'
import socket
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
}

kubeconfig_path_for() {
  local key_or_path="$1"
  if [[ "$key_or_path" == /* ]]; then
    printf '%s\n' "$key_or_path"
  else
    printf '%s/%s\n' "$KUBECONFIG_ROOT" "$key_or_path"
  fi
}

wait_for_api() {
  local api_base="$1"
  local deadline=$((SECONDS + 30))
  until curl -fsS "${api_base}/pools" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep 1
  done
}

start_port_forward() {
  local kubeconfig="$1"
  local port="$2"
  kubectl --kubeconfig "$kubeconfig" -n sandbox port-forward svc/sandbox-api-internal "${port}:80" >/tmp/hermes-pool-vm-list-port-forward.log 2>&1 &
  STARTED_PORT_FORWARD_PID="$!"
  PORT_FORWARD_PIDS+=("$STARTED_PORT_FORWARD_PID")
}

cleanup_port_forwards() {
  local pid
  for pid in "${PORT_FORWARD_PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
}

api_get() {
  local api_base="$1"
  local path="$2"
  curl -fsS "${api_base}${path}"
}

target_pools_jsonl() {
  local pools_json="$1"
  python3 -c '
import json
import sys

template = sys.argv[1]
pools = json.load(sys.stdin)
for pool in pools:
    if pool.get("template_class_id") == template or str(pool.get("sku_id") or "").startswith("sku-hermes-"):
        print(json.dumps(pool, ensure_ascii=False, separators=(",", ":")))
  ' "$TEMPLATE_CLASS_ID" <<<"$pools_json"
}

emit_tsv_header() {
  printf '%s\n' 'env	region	pool_id	pool_name	pool_status	pool_zone	pool_base_image	pool_sku_id	template_class_id	instance_id	cloud_id	address	state	created_at	updated_at'
}

emit_instances() {
  local env_name="$1"
  local region="$2"
  local pool_json="$3"
  local instances_json="$4"

  python3 -c '
import csv
import json
import sys

env_name, region, pool_raw, output_format, include_empty_raw = sys.argv[1:6]
pool = json.loads(pool_raw)
instances = json.load(sys.stdin)
include_empty = include_empty_raw == "true"

def row_for(inst):
    return {
        "env": env_name,
        "region": region,
        "pool_id": pool.get("id", ""),
        "pool_name": pool.get("name", ""),
        "pool_status": pool.get("status", ""),
        "pool_zone": pool.get("zone") or "",
        "pool_base_image": pool.get("base_image", ""),
        "pool_sku_id": pool.get("sku_id") or "",
        "template_class_id": pool.get("template_class_id") or "",
        "instance_id": inst.get("id", ""),
        "cloud_id": inst.get("cloud_id") or "",
        "address": inst.get("address") or "",
        "state": inst.get("state", ""),
        "created_at": inst.get("created_at", ""),
        "updated_at": inst.get("updated_at", ""),
    }

rows = [row_for(inst) for inst in instances if include_empty or inst.get("cloud_id")]
if output_format == "jsonl":
    for row in rows:
        print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
elif output_format == "tsv":
    fields = ["env", "region", "pool_id", "pool_name", "pool_status", "pool_zone", "pool_base_image", "pool_sku_id", "template_class_id", "instance_id", "cloud_id", "address", "state", "created_at", "updated_at"]
    writer = csv.writer(sys.stdout, delimiter="\t", lineterminator="\n")
    for row in rows:
        writer.writerow([row.get(field, "") for field in fields])
else:
    raise SystemExit(f"unsupported HERMES_POOL_VM_LIST_FORMAT: {output_format}")
  ' "$env_name" "$region" "$pool_json" "$OUTPUT_FORMAT" "$INCLUDE_EMPTY_CLOUD_ID" <<<"$instances_json"
}

json_field() {
  local json="$1"
  local field="$2"
  python3 -c '
import json
import sys

field = sys.argv[1]
data = json.load(sys.stdin)
value = data.get(field, "")
print("" if value is None else value)
  ' "$field" <<<"$json"
}

count_instances() {
  local instances_json="$1"
  python3 -c '
import json
import sys

include_empty = sys.argv[1] == "true"
instances = json.load(sys.stdin)
print(sum(1 for inst in instances if include_empty or inst.get("cloud_id")))
  ' "$INCLUDE_EMPTY_CLOUD_ID" <<<"$instances_json"
}

list_env() {
  local spec="$1"
  local env_name region kube_key kubeconfig port api_base pools_json pool_json pool_id instances_json count total=0
  IFS=: read -r env_name region kube_key <<<"$spec"
  [[ -n "${env_name:-}" && -n "${region:-}" && -n "${kube_key:-}" ]] || fail "invalid env spec: $spec"

  kubeconfig="$(kubeconfig_path_for "$kube_key")"
  [[ -r "$kubeconfig" ]] || fail "missing kubeconfig for ${env_name}: ${kubeconfig}"

  port="$(choose_local_port)"
  api_base="http://127.0.0.1:${port}/internal"
  log "listing ${env_name} (${region}) Hermes pool VMs"
  start_port_forward "$kubeconfig" "$port"
  local pf_pid="$STARTED_PORT_FORWARD_PID"
  if ! wait_for_api "$api_base"; then
    cat /tmp/hermes-pool-vm-list-port-forward.log >&2 || true
    fail "sandbox-api did not become ready for ${env_name}"
  fi

  pools_json="$(api_get "$api_base" "/pools")"
  while IFS= read -r pool_json; do
    [[ -n "$pool_json" ]] || continue
    pool_id="$(json_field "$pool_json" id)"
    instances_json="$(api_get "$api_base" "/pools/${pool_id}/instances")"
    emit_instances "$env_name" "$region" "$pool_json" "$instances_json"
    count="$(count_instances "$instances_json")"
    log "pool ${pool_id}: ${count} VM rows"
    total=$((total + count))
  done < <(target_pools_jsonl "$pools_json")

  log "${env_name}: emitted ${total} VM rows"
  kill "$pf_pid" >/dev/null 2>&1 || true
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  require_cmd bash
  require_cmd curl
  require_cmd kubectl
  require_cmd python3

  if [[ "$OUTPUT_FORMAT" == "tsv" ]]; then
    emit_tsv_header
  fi

  local spec
  while IFS= read -r spec; do
    [[ -n "$spec" ]] || continue
    list_env "$spec"
  done < <(csv_to_lines "$ENV_SPECS")
}

trap cleanup_port_forwards EXIT
main "$@"
