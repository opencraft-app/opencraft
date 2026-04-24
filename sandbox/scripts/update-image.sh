#!/usr/bin/env bash
set -euo pipefail

# 脚本定义:
#   统一执行 sandbox pool 的镜像切换、状态观察，以及临时 reset worker 管理。
#   默认通过 sandbox-api 的 Pool API 改 base_image，不再直接改数据库。
#   本地执行时默认自动起 port-forward；临时 worker 会复用当前集群 sandbox-worker
#   deployment 的镜像与运行配置，只覆盖 reset 参数和目标 image。
#
# 参数定义:
#   rollout <image-id>     更新目标 pools 的 base_image，并可选等待回填完成
#   status                 查看目标 pools 当前 base_image 和实例状态分布
#   cleanup-worker         删除临时 reset worker pod
#
# 输出结果定义:
#   stdout 打印 pool 配置、实例状态分布、临时 worker 状态和失败原因。
#   exit 0 表示执行成功；非 0 表示参数、kubectl、curl 或 API 调用失败。
#
# 关键设计决策:
#   - 默认只滚动主力 pools: pool-c2~pool-c5，保留 pool-bj8 作为兜底池
#   - 运行参数从现网 sandbox-worker deployment 提取，避免硬编码镜像/hostAliases
#   - rollout 只把 CLEAN 标成 DRY，ALLOCATED 不动，后续由 reset worker 异步回填

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MONO_DIR="$(cd "${SANDBOX_DIR}/.." && pwd)"
source "${MONO_DIR}/scripts/lib/load-deploy-env.sh"

ENV_NAME="$(require_deploy_env_name "${ENV:-}")"
load_deploy_env "${MONO_DIR}" "${ENV_NAME}"

K8S_NS="${K8S_NS:-${SANDBOX_NAMESPACE:-sandbox}}"
API_DEPLOY="${API_DEPLOY:-sandbox-api}"
WORKER_DEPLOY="${WORKER_DEPLOY:-sandbox-worker}"
WORKER_POD_NAME="${WORKER_POD_NAME:-sandbox-temp-reset-worker}"

DEFAULT_POOLS="pool-c2,pool-c3,pool-c4,pool-c5"
DEFAULT_API_LOCAL_PORT="18080"
DEFAULT_RESET_CONCURRENCY="10"
DEFAULT_RESET_INTERVAL="5s"
DEFAULT_REFILL_CONCURRENCY="1"
DEFAULT_REFILL_INTERVAL="30s"
DEFAULT_CLEANUP_INTERVAL="30s"
DEFAULT_WATERLINE_INTERVAL="1m"
DEFAULT_WATERLINE_SAMPLE="1"
DEFAULT_WATCH_INTERVAL="15"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  ./sandbox/scripts/update-image.sh rollout <image-id> [options]
  ./sandbox/scripts/update-image.sh <image-id> [options]
  ./sandbox/scripts/update-image.sh status [options]
  ./sandbox/scripts/update-image.sh cleanup-worker [options]

Description:
  High-level sandbox pool image rollout helper.
  It inspects current pool state, patches pool base_image through sandbox-api,
  and manages a temporary reset worker pod derived from the live sandbox-worker deployment.

Commands:
  rollout           Patch pools to a new image and optionally watch reset progress.
  status            Show pool base_image and per-state instance counts.
  cleanup-worker    Delete the temporary reset worker pod.

Options:
  --pools <p1,p2>             Target pools. Default: pool-c2,pool-c3,pool-c4,pool-c5
  --api-base <url>            sandbox-api base URL. Default: http://127.0.0.1:18080
  --api-local-port <port>     Local port for automatic port-forward. Default: 18080
  --no-port-forward           Do not auto-create kubectl port-forward for sandbox-api
  --watch                     Poll pool state until DRY/RESETTING reaches zero
  --watch-interval <sec>      Watch poll interval in seconds. Default: 15
  --skip-reset-worker         Do not create/replace the temporary reset worker pod
  --worker-pod-name <name>    Temporary reset worker pod name. Default: sandbox-temp-reset-worker
  --reset-concurrency <n>     Temporary worker reset concurrency. Default: 10
  --reset-interval <dur>      Temporary worker reset interval. Default: 5s
  --dry-run                   Print intended operations only
  -h, --help                  Show help

Outputs:
  - rollout: prints before/after pool status, worker actions, and optional watch progress
  - status: prints base_image plus instance-state counts for each pool
  - cleanup-worker: deletes the temporary worker pod if it exists
  - exit 0 on success; non-zero on validation, kubectl, or API failure

Examples:
  ENV=beijing-sandbox ./sandbox/scripts/update-image.sh rollout img-abcdefgh
  ENV=beijing-sandbox ./sandbox/scripts/update-image.sh img-abcdefgh --watch
  ENV=beijing-sandbox ./sandbox/scripts/update-image.sh status --pools pool-c2,pool-c3
  ENV=beijing-sandbox ./sandbox/scripts/update-image.sh cleanup-worker
EOF
}

require_cmds() {
  local missing=0
  for cmd in kubectl curl python3; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      log_error "missing required command: ${cmd}"
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    exit 1
  fi
}

API_LOCAL_PORT="${DEFAULT_API_LOCAL_PORT}"
API_BASE=""
USE_PORT_FORWARD=true
WATCH=false
WATCH_INTERVAL="${DEFAULT_WATCH_INTERVAL}"
POOLS="${DEFAULT_POOLS}"
SKIP_RESET_WORKER=false
RESET_CONCURRENCY="${DEFAULT_RESET_CONCURRENCY}"
RESET_INTERVAL="${DEFAULT_RESET_INTERVAL}"
DRY_RUN=false
PORT_FORWARD_PID=""
COMMAND=""
IMAGE_ID=""

parse_args() {
  if [[ $# -eq 0 ]]; then
    usage
    exit 1
  fi

  case "${1}" in
    rollout|status|cleanup-worker)
      COMMAND="${1}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      COMMAND="rollout"
      IMAGE_ID="${1}"
      shift
      ;;
  esac

  if [[ "${COMMAND}" == "rollout" && -z "${IMAGE_ID}" && $# -gt 0 && "${1}" != -* ]]; then
    IMAGE_ID="${1}"
    shift
  fi

  while [[ $# -gt 0 ]]; do
    case "${1}" in
      --pools)
        POOLS="${2:-}"
        shift 2
        ;;
      --api-base)
        API_BASE="${2:-}"
        USE_PORT_FORWARD=false
        shift 2
        ;;
      --api-local-port)
        API_LOCAL_PORT="${2:-}"
        shift 2
        ;;
      --no-port-forward)
        USE_PORT_FORWARD=false
        shift
        ;;
      --watch)
        WATCH=true
        shift
        ;;
      --watch-interval)
        WATCH_INTERVAL="${2:-}"
        shift 2
        ;;
      --skip-reset-worker)
        SKIP_RESET_WORKER=true
        shift
        ;;
      --worker-pod-name)
        WORKER_POD_NAME="${2:-}"
        shift 2
        ;;
      --reset-concurrency)
        RESET_CONCURRENCY="${2:-}"
        shift 2
        ;;
      --reset-interval)
        RESET_INTERVAL="${2:-}"
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
        log_error "unknown argument: ${1}"
        usage
        exit 1
        ;;
    esac
  done

  if [[ -z "${API_BASE}" ]]; then
    API_BASE="http://127.0.0.1:${API_LOCAL_PORT}"
  fi

  if [[ "${COMMAND}" == "rollout" ]]; then
    validate_image_id "${IMAGE_ID}"
  fi
  validate_numeric "${WATCH_INTERVAL}" "watch interval"
  validate_numeric "${RESET_CONCURRENCY}" "reset concurrency"
}

validate_image_id() {
  local image_id="$1"
  if [[ -z "${image_id}" ]]; then
    log_error "missing image id"
    usage
    exit 1
  fi
  if [[ ! "${image_id}" =~ ^img-[A-Za-z0-9]+$ ]]; then
    log_error "invalid image id: ${image_id}"
    exit 1
  fi
}

validate_numeric() {
  local value="$1"
  local label="$2"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    log_error "${label} must be a non-negative integer, got: ${value}"
    exit 1
  fi
}

cleanup_port_forward() {
  if [[ -n "${PORT_FORWARD_PID}" ]]; then
    kill "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true
    wait "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true
    PORT_FORWARD_PID=""
  fi
}

start_port_forward() {
  if [[ "${USE_PORT_FORWARD}" != "true" ]]; then
    return
  fi

  if curl -fsS "${API_BASE%/}/health" >/dev/null 2>&1; then
    return
  fi

  log_info "starting port-forward for ${API_DEPLOY} on localhost:${API_LOCAL_PORT}"
  kubectl -n "${K8S_NS}" port-forward "deploy/${API_DEPLOY}" "${API_LOCAL_PORT}:8080" \
    >/tmp/sandbox-api-port-forward.log 2>&1 &
  PORT_FORWARD_PID=$!

  local attempts=0
  until curl -fsS "${API_BASE%/}/health" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if ! kill -0 "${PORT_FORWARD_PID}" >/dev/null 2>&1; then
      log_error "sandbox-api port-forward exited early"
      cat /tmp/sandbox-api-port-forward.log >&2 || true
      exit 1
    fi
    if [[ "${attempts}" -ge 20 ]]; then
      log_error "sandbox-api port-forward did not become ready in time"
      cat /tmp/sandbox-api-port-forward.log >&2 || true
      exit 1
    fi
    sleep 1
  done
}

api_get() {
  local path="$1"
  curl -fsS "${API_BASE%/}${path}"
}

api_patch_pool() {
  local pool_id="$1"
  local image_id="$2"
  curl -fsS -X PATCH "${API_BASE%/}/pools/${pool_id}" \
    -H 'Content-Type: application/json' \
    -d "{\"base_image\":\"${image_id}\",\"mark_clean_as_dry\":true}"
}

pool_csv_to_lines() {
  python3 - "${POOLS}" <<'PY'
import sys
pools = [item.strip() for item in sys.argv[1].split(",") if item.strip()]
for item in pools:
    print(item)
PY
}

print_pool_status() {
  local pool
  local pools_json
  pools_json="$(api_get "/pools")"

  for pool in $(pool_csv_to_lines); do
    local pool_meta
    local pool_instances
    pool_meta="$(printf '%s' "${pools_json}" | python3 -c '
import json
import sys

pool_id = sys.argv[1]
for item in json.load(sys.stdin):
    if item.get("id") == pool_id:
        print(json.dumps(item))
        break
else:
    sys.exit(2)
' "${pool}")"
    if [[ $? -ne 0 || -z "${pool_meta}" ]]; then
      log_warn "pool not found: ${pool}"
      continue
    fi

    pool_instances="$(api_get "/pools/${pool}/instances")"
    printf '%s' "${pool_instances}" | python3 -c '
import collections
import json
import sys

pool = json.loads(sys.argv[1])
instances = json.load(sys.stdin)
counts = collections.Counter(item.get("state", "UNKNOWN") for item in instances)
ordered = ",".join(f"{state}={counts[state]}" for state in sorted(counts))
if not ordered:
    ordered = "none"
print(
    "{}: status={} base_image={} states={}".format(
        pool["id"],
        pool.get("status", "UNKNOWN"),
        pool.get("base_image", ""),
        ordered,
    )
)
' "${pool_meta}"
  done
}

remaining_reset_work() {
  local total=0
  local pool
  for pool in $(pool_csv_to_lines); do
    local instances_json
    local pool_remaining
    instances_json="$(api_get "/pools/${pool}/instances")"
    pool_remaining="$(printf '%s' "${instances_json}" | python3 -c '
import json
import sys

items = json.load(sys.stdin)
remaining = sum(1 for item in items if item.get("state") in {"DRY", "RESETTING"})
print(remaining)
')"
    total=$((total + pool_remaining))
  done
  echo "${total}"
}

cleanup_worker() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    log_info "[dry-run] would delete pod ${WORKER_POD_NAME} in namespace ${K8S_NS}"
    return
  fi

  kubectl -n "${K8S_NS}" delete pod "${WORKER_POD_NAME}" --ignore-not-found >/dev/null
  log_info "deleted temporary worker pod: ${WORKER_POD_NAME}"
}

render_worker_pod() {
  local image_id="$1"
  local deploy_json
  deploy_json="$(kubectl -n "${K8S_NS}" get deploy "${WORKER_DEPLOY}" -o json)"

  printf '%s' "${deploy_json}" | python3 -c '
import json
import sys

pod_name = sys.argv[1]
namespace = sys.argv[2]
image_id = sys.argv[3]
reset_concurrency = sys.argv[4]
reset_interval = sys.argv[5]
refill_concurrency = sys.argv[6]
refill_interval = sys.argv[7]
cleanup_interval = sys.argv[8]
waterline_interval = sys.argv[9]
waterline_sample = sys.argv[10]

deploy = json.load(sys.stdin)
spec = deploy["spec"]["template"]["spec"]
container = spec["containers"][0]

pod = {
    "apiVersion": "v1",
    "kind": "Pod",
    "metadata": {
        "name": pod_name,
        "namespace": namespace,
        "labels": {
            "app": pod_name,
            "managed-by": "sandbox-update-image-sh",
        },
    },
    "spec": {
        "restartPolicy": "Always",
        "containers": [
            {
                "name": "worker",
                "image": container["image"],
                "imagePullPolicy": container.get("imagePullPolicy", "IfNotPresent"),
                "command": ["worker"],
                "args": [
                    "-refill-count", "0",
                    "-refill-concurrency", refill_concurrency,
                    "-refill-interval", refill_interval,
                    "-reset-concurrency", reset_concurrency,
                    "-reset-interval", reset_interval,
                    "-cleanup-interval", cleanup_interval,
                    "-waterline-interval", waterline_interval,
                    "-waterline-sample", waterline_sample,
                    "-image", image_id,
                ],
                "envFrom": container.get("envFrom", []),
                "ports": container.get("ports", []),
                "resources": container.get("resources", {}),
            }
        ],
    },
}

for key in [
    "affinity",
    "dnsPolicy",
    "hostAliases",
    "hostNetwork",
    "imagePullSecrets",
    "nodeSelector",
    "priorityClassName",
    "securityContext",
    "serviceAccountName",
    "terminationGracePeriodSeconds",
    "tolerations",
    "topologySpreadConstraints",
]:
    if key in spec:
        pod["spec"][key] = spec[key]

print(json.dumps(pod))
' "${WORKER_POD_NAME}" "${K8S_NS}" "${image_id}" "${RESET_CONCURRENCY}" "${RESET_INTERVAL}" \
    "${DEFAULT_REFILL_CONCURRENCY}" "${DEFAULT_REFILL_INTERVAL}" "${DEFAULT_CLEANUP_INTERVAL}" \
    "${DEFAULT_WATERLINE_INTERVAL}" "${DEFAULT_WATERLINE_SAMPLE}"
}

ensure_worker() {
  if [[ "${SKIP_RESET_WORKER}" == "true" ]]; then
    log_info "skip creating temporary reset worker"
    return
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    log_info "[dry-run] would recreate temporary worker pod ${WORKER_POD_NAME}"
    return
  fi

  cleanup_worker
  render_worker_pod "${IMAGE_ID}" | kubectl apply -f - >/dev/null
  kubectl -n "${K8S_NS}" wait --for=condition=Ready "pod/${WORKER_POD_NAME}" --timeout=120s >/dev/null
  log_info "temporary reset worker is ready: ${WORKER_POD_NAME}"
}

run_status() {
  log_info "sandbox pool status"
  print_pool_status
}

run_rollout() {
  log_info "target pools: ${POOLS}"
  log_info "target image: ${IMAGE_ID}"
  if [[ "${POOLS}" == "${DEFAULT_POOLS}" ]]; then
    log_info "default target keeps fallback pools untouched, for example pool-bj8"
  fi

  log_info "status before rollout"
  print_pool_status

  if [[ "${DRY_RUN}" == "true" ]]; then
    local pool
    for pool in $(pool_csv_to_lines); do
      log_info "[dry-run] would patch ${pool} -> ${IMAGE_ID}"
    done
    ensure_worker
    return
  fi

  local pool
  for pool in $(pool_csv_to_lines); do
    log_info "patching pool ${pool} -> ${IMAGE_ID}"
    api_patch_pool "${pool}" "${IMAGE_ID}" >/dev/null
  done

  ensure_worker

  log_info "status after rollout patch"
  print_pool_status

  if [[ "${WATCH}" != "true" ]]; then
    log_info "watch disabled; rerun with 'status' or use --watch to follow reset progress"
    return
  fi

  while true; do
    local remaining
    remaining="$(remaining_reset_work)"
    log_info "remaining DRY/RESETTING instances: ${remaining}"
    print_pool_status
    if [[ "${remaining}" == "0" ]]; then
      log_info "target pools finished resetting to the new image"
      break
    fi
    sleep "${WATCH_INTERVAL}"
  done
}

main() {
  require_cmds
  parse_args "$@"

  trap cleanup_port_forward EXIT
  start_port_forward

  case "${COMMAND}" in
    rollout)
      run_rollout
      ;;
    status)
      run_status
      ;;
    cleanup-worker)
      cleanup_worker
      ;;
    *)
      log_error "unknown command: ${COMMAND}"
      exit 1
      ;;
  esac
}

main "$@"
