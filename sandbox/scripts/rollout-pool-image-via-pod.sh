#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MONO_DIR="$(cd "${SANDBOX_DIR}/.." && pwd)"

source "${MONO_DIR}/scripts/lib/load-deploy-env.sh"

NAMESPACE="${SANDBOX_NAMESPACE:-sandbox}"
API_BASE="${SANDBOX_INTERNAL_API_BASE:-http://sandbox-api.sandbox.svc.cluster.local/internal}"
POD_IMAGE="${SANDBOX_ROLLOUT_POD_IMAGE:-python:3.11-alpine}"
POD_NAME="${SANDBOX_ROLLOUT_POD_NAME:-sandbox-pool-image-rollout-$(date +%s)}"
DEFAULT_POOLS="pool-c0,pool-c1,pool-c2,pool-c3,pool-c4,pool-c5"
POOLS="${SANDBOX_ROLLOUT_POOLS:-${DEFAULT_POOLS}}"
MODE=""
IMAGE_ID=""
ALL_POOLS=false
WATCH=false
WATCH_INTERVAL=15
WATCH_TIMEOUT=900
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage:
  ENV=<env> bash sandbox/scripts/rollout-pool-image-via-pod.sh status [options]
  ENV=<env> bash sandbox/scripts/rollout-pool-image-via-pod.sh rollout <img-id> [options]

Description:
  Run a one-shot bypass pod inside the sandbox namespace. The pod calls
  sandbox-api's internal pool API, so no local port-forward or direct MySQL
  access is required.

Options:
  --pools <p1,p2>        Target pool ids. Default: pool-c0,pool-c1,pool-c2,pool-c3,pool-c4,pool-c5
  --all                  Target every pool returned by /internal/pools
  --namespace <ns>       Kubernetes namespace. Default: sandbox
  --api-base <url>       Internal sandbox API base. Default: http://sandbox-api.sandbox.svc.cluster.local/internal
  --pod-image <image>    Bypass pod image. Default: python:3.11-alpine
  --pod-name <name>      Bypass pod name. Default: sandbox-pool-image-rollout-<timestamp>
  --watch                After rollout, wait until DRY/RESETTING reaches zero for target pools
  --watch-interval <sec> Watch poll interval. Default: 15
  --watch-timeout <sec>  Watch timeout. Default: 900
  --dry-run              Print intended rollout without patching pools
  -h, --help             Show help

Examples:
  ENV=beijing-sandbox bash sandbox/scripts/rollout-pool-image-via-pod.sh status --all
  ENV=beijing-sandbox bash sandbox/scripts/rollout-pool-image-via-pod.sh rollout img-xxxx --pools pool-c0,pool-c1,pool-c2,pool-c3,pool-c4,pool-c5
  ENV=beijing-sandbox bash sandbox/scripts/rollout-pool-image-via-pod.sh rollout img-xxxx --all
EOF
}

log() { printf '[pool-rollout] %s\n' "$*"; }
die() { printf '[pool-rollout] ERROR: %s\n' "$*" >&2; exit 1; }

require_cmds() {
  local missing=0
  for cmd in kubectl python3; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      printf '[pool-rollout] ERROR: missing required command: %s\n' "${cmd}" >&2
      missing=1
    fi
  done
  [[ "${missing}" -eq 0 ]] || exit 1
}

parse_args() {
  [[ $# -gt 0 ]] || { usage; exit 1; }

  case "$1" in
    status|rollout)
      MODE="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      MODE="rollout"
      IMAGE_ID="$1"
      shift
      ;;
  esac

  if [[ "${MODE}" == "rollout" && -z "${IMAGE_ID}" && $# -gt 0 && "$1" != -* ]]; then
    IMAGE_ID="$1"
    shift
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --pools)
        POOLS="${2:-}"
        shift 2
        ;;
      --all)
        ALL_POOLS=true
        shift
        ;;
      --namespace)
        NAMESPACE="${2:-}"
        shift 2
        ;;
      --api-base)
        API_BASE="${2:-}"
        shift 2
        ;;
      --pod-image)
        POD_IMAGE="${2:-}"
        shift 2
        ;;
      --pod-name)
        POD_NAME="${2:-}"
        shift 2
        ;;
      --watch)
        WATCH=true
        shift
        ;;
      --watch-interval)
        WATCH_INTERVAL="${2:-}"
        shift 2
        ;;
      --watch-timeout)
        WATCH_TIMEOUT="${2:-}"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done

  [[ -n "${NAMESPACE}" ]] || die "namespace is required"
  [[ -n "${API_BASE}" ]] || die "api base is required"
  [[ -n "${POD_IMAGE}" ]] || die "pod image is required"
  [[ -n "${POD_NAME}" ]] || die "pod name is required"
  [[ "${WATCH_INTERVAL}" =~ ^[0-9]+$ ]] || die "--watch-interval must be seconds"
  [[ "${WATCH_TIMEOUT}" =~ ^[0-9]+$ ]] || die "--watch-timeout must be seconds"
  if [[ "${MODE}" == "rollout" ]]; then
    [[ "${IMAGE_ID}" =~ ^img-[A-Za-z0-9]+$ ]] || die "image id must look like img-xxxx"
  fi
  if [[ "${ALL_POOLS}" != "true" ]]; then
    [[ -n "${POOLS}" ]] || die "--pools cannot be empty unless --all is set"
  fi
}

load_env() {
  local env_name
  env_name="$(require_deploy_env_name "${ENV:-}")"
  load_deploy_env "${MONO_DIR}" "${env_name}"
  if [[ -n "${DEPLOY_KUBECONFIG:-}" && -z "${KUBECONFIG:-}" ]]; then
    export KUBECONFIG
    KUBECONFIG="$(resolve_deploy_env_path "${MONO_DIR}" "${DEPLOY_KUBECONFIG}")"
  fi
}

run_bypass_pod() {
  log "mode=${MODE} namespace=${NAMESPACE} api=${API_BASE} pod=${POD_NAME}"
  if [[ "${ALL_POOLS}" == "true" ]]; then
    log "target_pools=all"
  else
    log "target_pools=${POOLS}"
  fi
  [[ "${MODE}" != "rollout" ]] || log "target_image=${IMAGE_ID} dry_run=${DRY_RUN}"

  kubectl -n "${NAMESPACE}" run "${POD_NAME}" \
    --image="${POD_IMAGE}" \
    --rm -i \
    --restart=Never \
    --env="SANDBOX_INTERNAL_API_BASE=${API_BASE}" \
    --env="SANDBOX_ROLLOUT_MODE=${MODE}" \
    --env="SANDBOX_ROLLOUT_IMAGE=${IMAGE_ID}" \
    --env="SANDBOX_ROLLOUT_POOLS=${POOLS}" \
    --env="SANDBOX_ROLLOUT_ALL=${ALL_POOLS}" \
    --env="SANDBOX_ROLLOUT_WATCH=${WATCH}" \
    --env="SANDBOX_ROLLOUT_WATCH_INTERVAL=${WATCH_INTERVAL}" \
    --env="SANDBOX_ROLLOUT_WATCH_TIMEOUT=${WATCH_TIMEOUT}" \
    --env="SANDBOX_ROLLOUT_DRY_RUN=${DRY_RUN}" \
    -- python - <<'PY'
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter

api_base = os.environ["SANDBOX_INTERNAL_API_BASE"].rstrip("/")
mode = os.environ["SANDBOX_ROLLOUT_MODE"]
target_image = os.environ.get("SANDBOX_ROLLOUT_IMAGE", "").strip()
target_all = os.environ.get("SANDBOX_ROLLOUT_ALL") == "true"
watch = os.environ.get("SANDBOX_ROLLOUT_WATCH") == "true"
dry_run = os.environ.get("SANDBOX_ROLLOUT_DRY_RUN") == "true"
watch_interval = int(os.environ.get("SANDBOX_ROLLOUT_WATCH_INTERVAL", "15"))
watch_timeout = int(os.environ.get("SANDBOX_ROLLOUT_WATCH_TIMEOUT", "900"))
pool_csv = os.environ.get("SANDBOX_ROLLOUT_POOLS", "")
pool_filter = [item.strip() for item in pool_csv.split(",") if item.strip()]

def call(method, path, payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(api_base + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else None

def pool_ids_from(all_pools):
    if target_all:
        return [pool["id"] for pool in all_pools if pool.get("id")]
    known = {pool.get("id") for pool in all_pools}
    missing = [pool_id for pool_id in pool_filter if pool_id not in known]
    if missing:
        raise SystemExit("missing target pools: " + ",".join(missing))
    return pool_filter

def summarize_instances(pool_id):
    instances = call("GET", f"/pools/{pool_id}/instances") or []
    states = Counter(item.get("state", "UNKNOWN") for item in instances)
    return ",".join(f"{state}={states[state]}" for state in sorted(states)) or "none"

def print_status(label, pools, ids):
    print(f"{label}_images=" + json.dumps(dict(sorted(Counter(pool.get("base_image", "") for pool in pools if pool.get("id") in ids).items())), ensure_ascii=False))
    by_id = {pool.get("id"): pool for pool in pools}
    for pool_id in ids:
        pool = by_id[pool_id]
        states = summarize_instances(pool_id)
        print(
            f"{label}_pool id={pool_id} image={pool.get('base_image','')} "
            f"status={pool.get('status','')} desired={pool.get('desired_capacity',0)} "
            f"zone={pool.get('zone','')} states={states}"
        )

pools = call("GET", "/pools")
if not isinstance(pools, list):
    raise SystemExit("unexpected /internal/pools response")
target_ids = pool_ids_from(pools)
print(f"pool_count={len(pools)} target_count={len(target_ids)}")
print_status("before", pools, target_ids)

if mode == "status":
    raise SystemExit(0)

changed = 0
skipped = 0
failed = []
by_id = {pool.get("id"): pool for pool in pools}
for pool_id in target_ids:
    pool = by_id[pool_id]
    current = pool.get("base_image", "")
    if current == target_image:
        skipped += 1
        print(f"skip id={pool_id} image={target_image} status={pool.get('status','')}")
        continue
    print(f"patch id={pool_id} {current}->{target_image} status={pool.get('status','')}")
    if dry_run:
        continue
    try:
        call("PATCH", f"/pools/{pool_id}", {"base_image": target_image, "mark_clean_as_dry": True})
        changed += 1
    except Exception as exc:
        failed.append((pool_id, str(exc)))
        print(f"ERROR patch id={pool_id}: {exc}", file=sys.stderr)

if failed:
    print("failed=" + json.dumps(failed, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(1)

if dry_run:
    print(f"dry_run_complete changed=0 would_patch={len(target_ids) - skipped} skipped={skipped}")
    raise SystemExit(0)

time.sleep(1)
after = call("GET", "/pools")
after_by_id = {pool.get("id"): pool for pool in after}
not_target = [pool_id for pool_id in target_ids if after_by_id[pool_id].get("base_image") != target_image]
print(f"changed={changed} skipped={skipped} failed=0")
print_status("after", after, target_ids)
if not_target:
    print("not_target=" + json.dumps(not_target, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(1)
print("rollout_patch_verified=true")

if watch:
    deadline = time.monotonic() + watch_timeout
    while True:
        remaining = 0
        for pool_id in target_ids:
            instances = call("GET", f"/pools/{pool_id}/instances") or []
            remaining += sum(1 for item in instances if item.get("state") in {"DRY", "RESETTING"})
        print(f"watch_remaining_dry_or_resetting={remaining}")
        if remaining == 0:
            print("rollout_watch_converged=true")
            break
        if time.monotonic() >= deadline:
            print("rollout_watch_timeout=true", file=sys.stderr)
            raise SystemExit(1)
        time.sleep(watch_interval)
PY
}

main() {
  require_cmds
  parse_args "$@"
  load_env
  run_bypass_pod
}

main "$@"
