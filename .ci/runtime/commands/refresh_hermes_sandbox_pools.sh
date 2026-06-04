#!/usr/bin/env bash

set -euo pipefail

TEMPLATE_CLASS_ID="${HERMES_TEMPLATE_CLASS_ID:-hermes}"
ENV_SPECS="${HERMES_SANDBOX_POOL_REFRESH_ENVS:-shprod:ap-shanghai:kubeconfig_shprod}"
LEGACY_POOL_IDS="${HERMES_LEGACY_POOL_IDS:-}"
KUBECONFIG_ROOT="${HERMES_SANDBOX_KUBECONFIG_ROOT:-/etc/lightclaw-ci}"
PATCH_INTERVAL_SECONDS="${HERMES_POOL_PATCH_INTERVAL_SECONDS:-20}"
VERIFY_TIMEOUT_SECONDS="${HERMES_POOL_VERIFY_TIMEOUT_SECONDS:-180}"
PORT_FORWARD_PIDS=()

usage() {
  cat <<'EOF'
Usage:
  refresh_hermes_sandbox_pools.sh

Environment:
  HERMES_SANDBOX_POOL_REFRESH_ENVS
      Comma-separated env specs: <env>:<region>:<kubeconfig-key-or-path>
      Default: shprod:ap-shanghai:kubeconfig_shprod
  HERMES_IMAGE_ID_AP_SHANGHAI
      Required for the default shprod refresh target.
      This value should come from the current Hermes image build result, not from a latest-image lookup.
  HERMES_TEMPLATE_CLASS_ID
      Default: hermes
  HERMES_LEGACY_POOL_IDS
      Optional comma-separated pool ids used only when sandbox-api has no
      template-class resolution and pools have no Hermes template/SKU fields.
  HERMES_POOL_PATCH_INTERVAL_SECONDS
      Default: 20
EOF
}

log() {
  printf '[refresh-hermes-pools] %s\n' "$*"
}

fail() {
  printf '[refresh-hermes-pools] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

region_env_suffix() {
  printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_'
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

image_id_for_region() {
  local region="$1"
  local suffix var_name
  suffix="$(region_env_suffix "$region")"
  var_name="HERMES_IMAGE_ID_${suffix}"
  if [[ -z "${!var_name:-}" ]]; then
    fail "missing ${var_name}; pass the image id produced by the current Hermes image build"
  fi
  printf '%s\n' "${!var_name}"
}

verify_image_normal() {
  local region="$1"
  local image_id="$2"
  local state
  state="$(
    tccli cvm DescribeImages --region "$region" --ImageIds "$(jq -nc --arg id "$image_id" '[$id]')" |
      jq -r '.ImageSet[0].ImageState // empty'
  )"
  [[ "$state" == "NORMAL" ]] || fail "image ${image_id} in ${region} is not NORMAL, got ${state:-missing}"
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
  kubectl --kubeconfig "$kubeconfig" -n sandbox port-forward svc/sandbox-api-internal "${port}:80" >/tmp/hermes-pool-refresh-port-forward.log 2>&1 &
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

api_post_json() {
  local api_base="$1"
  local path="$2"
  local body="$3"
  curl -fsS -X POST "${api_base}${path}" -H 'Content-Type: application/json' -d "$body"
}

api_patch_json() {
  local api_base="$1"
  local path="$2"
  local body="$3"
  curl -fsS -X PATCH "${api_base}${path}" -H 'Content-Type: application/json' -d "$body"
}

refresh_skus() {
  local api_base="$1"
  local image_id="$2"
  local skus_json sku_ids sku_id body

  if ! skus_json="$(api_get "$api_base" "/skus" 2>/dev/null)"; then
    log "SKU endpoint unavailable; pool patch will continue"
    return
  fi
  sku_ids="$(
    jq -r --arg template "$TEMPLATE_CLASS_ID" '
      .[]
      | select((.template_class_id == $template) or ((.id // "") | startswith("sku-hermes-")))
      | .id
    ' <<<"$skus_json"
  )"

  if [[ -z "$sku_ids" ]]; then
    log "no Hermes SKU found; pool patch will continue"
    return
  fi

  while IFS= read -r sku_id; do
    [[ -n "$sku_id" ]] || continue
    body="$(
      jq -c --arg id "$sku_id" --arg image "$image_id" '
        .[]
        | select(.id == $id)
        | .base_image = $image
        | .desired_image_id = $image
        | if ((.stable_image_id // "") == $image)
          then .
          else .rollout_state = "rolling"
          end
        | .last_rollout_error = ""
      ' <<<"$skus_json"
    )"
    log "updating SKU ${sku_id} desired image -> ${image_id}"
    api_post_json "$api_base" "/skus" "$body" | jq -r '[.id,.base_image,.desired_image_id,.stable_image_id,.rollout_state,(.rollout_cursor_pool_id // "")] | @tsv'
  done <<<"$sku_ids"
}

target_pool_ids() {
  local api_base="$1"
  local pools_json="$2"
  python3 -c '
import json
import sys
import urllib.request

api_base, template, legacy_raw = sys.argv[1:4]
legacy_ids = [item.strip() for item in legacy_raw.split(",") if item.strip()]
pools = json.load(sys.stdin)
by_id = {str(pool.get("id") or ""): pool for pool in pools}
selected = []
seen = set()

def add(pool_id):
    pool_id = str(pool_id or "")
    if not pool_id or pool_id in seen:
        return
    if pool_id in by_id:
        seen.add(pool_id)
        selected.append(pool_id)

for pool_id in legacy_ids:
    add(pool_id)

for pool in pools:
    if pool.get("template_class_id") == template or str(pool.get("sku_id") or "").startswith("sku-hermes-"):
        add(pool.get("id"))

try:
    with urllib.request.urlopen(f"{api_base}/template-classes/{template}/resolve", timeout=10) as resp:
        resolved = json.load(resp)
    for pool in resolved.get("pools") or []:
        pool_id = str(pool.get("id") or "")
        if pool_id and pool_id not in by_id:
            by_id[pool_id] = pool
        add(pool_id)
except Exception:
    pass

for pool_id in selected:
    print(pool_id)
  ' "$api_base" "$TEMPLATE_CLASS_ID" "$LEGACY_POOL_IDS" <<<"$pools_json"
}

print_pool_discovery_debug() {
  local api_base="$1"
  local pools_json="$2"
  local resolved_json
  log "available pool summary"
  jq -r '
    .[]
    | [.id,.name,(.template_class_id // ""),(.sku_id // ""),(.base_image // ""),(.status // ""),(.zone // "")]
    | @tsv
  ' <<<"$pools_json" >&2
  if resolved_json="$(api_get "$api_base" "/template-classes/${TEMPLATE_CLASS_ID}/resolve" 2>/dev/null)"; then
    log "template ${TEMPLATE_CLASS_ID} resolve summary"
    jq -r '
      "template_class=" + ((.template_class.id // "")|tostring) + "\tbindings=" + (((.bindings // [])|length)|tostring) + "\tpools=" + (((.pools // [])|length)|tostring)
    ' <<<"$resolved_json" >&2
  else
    log "template ${TEMPLATE_CLASS_ID} resolve endpoint unavailable"
  fi
}

patch_pools() {
  local api_base="$1"
  local image_id="$2"
  local pool_ids="$3"
  local first=1
  local pool_id body

  body="$(jq -nc --arg image "$image_id" '{base_image:$image, mark_clean_as_dry:true}')"
  while IFS= read -r pool_id; do
    [[ -n "$pool_id" ]] || continue
    if [[ "$first" -eq 0 && "$PATCH_INTERVAL_SECONDS" != "0" ]]; then
      log "waiting ${PATCH_INTERVAL_SECONDS}s before next pool"
      sleep "$PATCH_INTERVAL_SECONDS"
    fi
    first=0
    log "patching pool ${pool_id} -> ${image_id}"
    api_patch_json "$api_base" "/pools/${pool_id}" "$body" |
      jq -r '[.id,.base_image,.status,(.zone // ""),(.last_autoscale_action // "")] | @tsv'
  done <<<"$pool_ids"
}

verify_refresh() {
  local api_base="$1"
  local image_id="$2"
  local deadline=$((SECONDS + VERIFY_TIMEOUT_SECONDS))
  local mismatches pools_json pool_ids

  while true; do
    pools_json="$(api_get "$api_base" "/pools")"
    pool_ids="$(target_pool_ids "$api_base" "$pools_json")"
    mismatches="$(
      jq -r --arg ids "$pool_ids" --arg image "$image_id" '
          ($ids | split("\n") | map(select(length > 0))) as $target_ids
          |
          .[]
          | select(.id as $id | $target_ids | index($id))
          | select(.base_image != $image)
          | "\(.id)=\(.base_image)"
        ' <<<"$pools_json"
    )"
    if [[ -z "$mismatches" ]]; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      printf '%s\n' "$mismatches" >&2
      return 1
    fi
    log "waiting for pool image convergence: ${mismatches//$'\n'/, }"
    sleep 10
  done
}

print_summary() {
  local api_base="$1"
  local _image_id="$2"
  local pools_json pool_ids pool_id instances_json counts skus_json

  pools_json="$(api_get "$api_base" "/pools")"
  pool_ids="$(target_pool_ids "$api_base" "$pools_json")"
  log "pool image summary"
  jq -r --arg ids "$pool_ids" '
    ($ids | split("\n") | map(select(length > 0))) as $target_ids
    |
    .[]
    | select(.id as $id | $target_ids | index($id))
    | [.id,.base_image,.status,(.desired_capacity|tostring),(.zone // "")]
    | @tsv
  ' <<<"$pools_json"

  log "pool instance-state summary"
  while IFS= read -r pool_id; do
    [[ -n "$pool_id" ]] || continue
    instances_json="$(api_get "$api_base" "/pools/${pool_id}/instances")"
    counts="$(
      jq -r '
        group_by(.state)
        | map("\(.[0].state)=\(length)")
        | join(",")
        | if length == 0 then "none" else . end
      ' <<<"$instances_json"
    )"
    printf '%s\t%s\n' "$pool_id" "$counts"
  done <<<"$pool_ids"

  log "SKU summary"
  if skus_json="$(api_get "$api_base" "/skus" 2>/dev/null)"; then
    jq -r --arg template "$TEMPLATE_CLASS_ID" --arg image "$image_id" '
      .[]
      | select((.template_class_id == $template) or ((.id // "") | startswith("sku-hermes-")))
      | [.id,.base_image,.desired_image_id,.stable_image_id,.rollout_state,(.rollout_cursor_pool_id // ""),((.converged_pool_count // "")|tostring),((.total_pool_count // "")|tostring),((.pools_pending_rollout // "")|tostring)]
      | @tsv
    ' <<<"$skus_json"
  else
    log "SKU summary unavailable"
  fi
}

refresh_env() {
  local spec="$1"
  local env_name region kube_key kubeconfig image_id port api_base pf_pid pools_json pool_ids
  IFS=: read -r env_name region kube_key <<<"$spec"
  [[ -n "${env_name:-}" && -n "${region:-}" && -n "${kube_key:-}" ]] || fail "invalid env spec: $spec"

  image_id="$(image_id_for_region "$region")"
  verify_image_normal "$region" "$image_id"

  kubeconfig="$(kubeconfig_path_for "$kube_key")"
  [[ -r "$kubeconfig" ]] || fail "missing kubeconfig for ${env_name}: ${kubeconfig}"

  port="$(choose_local_port)"
  api_base="http://127.0.0.1:${port}/internal"
  log "refreshing ${env_name} (${region}) with ${image_id}"
  start_port_forward "$kubeconfig" "$port"
  pf_pid="$STARTED_PORT_FORWARD_PID"
  if ! wait_for_api "$api_base"; then
    cat /tmp/hermes-pool-refresh-port-forward.log >&2 || true
    fail "sandbox-api did not become ready for ${env_name}"
  fi

  pools_json="$(api_get "$api_base" "/pools")"
  pool_ids="$(target_pool_ids "$api_base" "$pools_json")"
  if [[ -z "$pool_ids" ]]; then
    print_pool_discovery_debug "$api_base" "$pools_json"
    fail "no Hermes pools found in ${env_name}"
  fi
  log "target pools for ${env_name}: ${pool_ids//$'\n'/ }"

  refresh_skus "$api_base" "$image_id"
  patch_pools "$api_base" "$image_id" "$pool_ids"
  verify_refresh "$api_base" "$image_id" || fail "pool image verification failed for ${env_name}"
  print_summary "$api_base" "$image_id"
  kill "$pf_pid" >/dev/null 2>&1 || true
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  require_cmd bash
  require_cmd curl
  require_cmd jq
  require_cmd kubectl
  require_cmd python3
  require_cmd tccli

  local spec
  while IFS= read -r spec; do
    [[ -n "$spec" ]] || continue
    refresh_env "$spec"
  done < <(csv_to_lines "$ENV_SPECS")
}

trap cleanup_port_forwards EXIT
main "$@"
