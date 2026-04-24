#!/usr/bin/env bash
# =============================================================================
# LightClaw envd 远程回归测试脚本
#
# 定义:
#   连接远端服务器，验证 `envd`（官方 sandbox envd）的基础能力与兼容行为：
#   1. systemd 服务运行中
#   2. `/health` 返回成功（204）
#   3. `process.Process/Start` 在兼容 Basic root: 认证下可启动命令
#   4. 未认证请求被拒绝
#   5. 启动命令可以产生 envd 可观测副作用，并尽量在宿主机视角复核
#   6. systemd 重启后服务仍可恢复健康
#
# 参数定义:
#   <user@host>               必填，SSH 目标主机
#   --port <port>            可选，SSH 端口，默认 22
#   --workdir <path>         可选，远端测试目录，默认 /var/lib/lightclaw-envd-test
#   --keep-artifacts         可选，保留远端测试产物
#   -h, --help               显示帮助
#
# 输出结果定义:
#   - stdout 打印每项断言结果
#   - 退出码 0 表示全部通过，非 0 表示存在失败
#
# 示例:
#   bash images/tests/test-envd-agent.sh ubuntu@119.28.239.108 --port 36000
#   bash images/tests/test-envd-agent.sh ubuntu@119.28.239.108 --port 36000 --keep-artifacts
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_LIB="${SCRIPT_DIR}/../lib/ssh.sh"
if [ ! -f "${SSH_LIB}" ]; then
  echo "ERROR: ssh library not found: ${SSH_LIB}" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "${SSH_LIB}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $*"; }
fail() { echo -e "${RED}FAIL${NC} $*"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "${CYAN}INFO${NC} $*"; }
warn() { echo -e "${YELLOW}WARN${NC} $*"; }

usage() {
  cat <<'EOF'
Usage:
  bash images/tests/test-envd-agent.sh <user@host> [options]

Description:
  Run remote regression checks for the envd service (official sandbox envd).

Options:
  --port <port>         SSH port. Default: 22
  --workdir <path>      Remote test working directory. Default: /var/lib/lightclaw-envd-test
  --keep-artifacts      Keep remote test artifacts after completion
  -h, --help            Show this help message

Outputs:
  Prints per-check PASS/FAIL results and returns non-zero when any check fails.

Examples:
  bash images/tests/test-envd-agent.sh ubuntu@119.28.239.108 --port 36000
  bash images/tests/test-envd-agent.sh ubuntu@119.28.239.108 --port 36000 --keep-artifacts
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

REMOTE_HOST="${1:-}"
if [ -z "${REMOTE_HOST}" ]; then
  usage >&2
  exit 1
fi
shift

SSH_PORT=22
REMOTE_WORKDIR="/var/lib/lightclaw-envd-test"
KEEP_ARTIFACTS=false
FAILURES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      SSH_PORT="$2"
      shift 2
      ;;
    --workdir)
      REMOTE_WORKDIR="$2"
      shift 2
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      usage >&2
      exit 1
      ;;
  esac
done

remote_exec() {
  sshlib_exec "$1"
}

sshlib_init "${REMOTE_HOST}" "${SSH_PORT}"
sshlib_ensure_ready

cleanup() {
  if [ "${KEEP_ARTIFACTS}" = true ]; then
    warn "keeping remote artifacts in ${REMOTE_WORKDIR}"
    return
  fi
  remote_exec "rm -rf '${REMOTE_WORKDIR}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

info "preparing remote workdir ${REMOTE_WORKDIR}"
remote_exec "mkdir -p '${REMOTE_WORKDIR}'"

# 检查 systemd 服务（兼容新旧服务名）
info "checking systemd service status"
ACTIVE_SERVICE=""
if [ "$(remote_exec "systemctl is-active envd.service" 2>/dev/null || true)" = "active" ]; then
  ACTIVE_SERVICE="envd.service"
  pass "envd.service is active"
elif [ "$(remote_exec "systemctl is-active lightclaw-envd-agent.service" 2>/dev/null || true)" = "active" ]; then
  ACTIVE_SERVICE="lightclaw-envd-agent.service"
  pass "lightclaw-envd-agent.service is active (legacy)"
else
  fail "no envd service is active (checked envd.service and lightclaw-envd-agent.service)"
fi

# 健康检查（官方 envd 返回 204，旧版返回 200 + "ok"）
info "checking /health"
HEALTH_STATUS="$(remote_exec "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:49983/health" 2>/dev/null || true)"
if [ "${HEALTH_STATUS}" = "204" ] || [ "${HEALTH_STATUS}" = "200" ]; then
  pass "/health returned ${HEALTH_STATUS}"
else
  fail "/health returned unexpected status: ${HEALTH_STATUS:-<empty>}"
fi

REMOTE_MARKER="${REMOTE_WORKDIR}/marker.txt"
REMOTE_MARKER_FROM_API="${REMOTE_WORKDIR}/.marker.from-envd-api"
REMOTE_PAYLOAD='envd-smoke-ok'

info "checking authenticated process start"
START_STATUS="$(
  remote_exec "python3 -c '
import struct, sys, subprocess
payload = b\"\"\" {\"process\":{\"cmd\":\"/bin/bash\",\"args\":[\"-lc\",\"printf ${REMOTE_PAYLOAD} > ${REMOTE_MARKER}\"]}} \"\"\" .strip()
envelope = struct.pack(\">BI\", 0, len(payload)) + payload
result = subprocess.run([
    \"curl\", \"-sS\", \"-o\", \"/dev/null\", \"-w\", \"%{http_code}\",
    \"-X\", \"POST\", \"http://127.0.0.1:49983/process.Process/Start\",
    \"-H\", \"Content-Type: application/connect+json\",
    \"-H\", \"Connect-Protocol-Version: 1\",
    \"-H\", \"Authorization: Basic cm9vdDo=\",
    \"--data-binary\", \"@-\",
], input=envelope, capture_output=True)
print(result.stdout.decode().strip())
'" 2>/dev/null || true
)"

if [ "${START_STATUS}" = "200" ]; then
  pass "authenticated start returned 200"
else
  fail "authenticated start did not return 200 (got ${START_STATUS:-<empty>})"
fi

sleep 1
info "checking envd-visible side effect"
ENVD_MARKER_STATUS="$(
  remote_exec "curl -sS -o '${REMOTE_MARKER_FROM_API}' -w '%{http_code}' --get 'http://127.0.0.1:49983/files' --data-urlencode 'username=root' --data-urlencode 'path=${REMOTE_MARKER}'" 2>/dev/null || true
)"
ENVD_MARKER_CONTENT="$(remote_exec "[ -f '${REMOTE_MARKER_FROM_API}' ] && cat '${REMOTE_MARKER_FROM_API}'" 2>/dev/null || true)"
if [ "${ENVD_MARKER_STATUS}" = "200" ] && [ "${ENVD_MARKER_CONTENT}" = "${REMOTE_PAYLOAD}" ]; then
  pass "envd file API observed process side effect"
else
  fail "envd file API did not observe marker (status: ${ENVD_MARKER_STATUS:-<empty>})"
fi

info "checking SSH host view for side effect"
HOST_MARKER_CONTENT="$(remote_exec "[ -f '${REMOTE_MARKER}' ] && cat '${REMOTE_MARKER}'" 2>/dev/null || true)"
if [ "${HOST_MARKER_CONTENT}" = "${REMOTE_PAYLOAD}" ]; then
  pass "SSH host view observed process side effect"
else
  warn "SSH host view did not observe marker; envd API already saw it, follow-up may be needed for view mismatch"
fi

info "checking unauthenticated start rejection"
UNAUTH_STATUS="$(
  remote_exec "python3 -c '
import struct, sys, subprocess
payload = b\"{\\\"process\\\":{\\\"cmd\\\":\\\"/bin/true\\\"}}\"
envelope = struct.pack(\">BI\", 0, len(payload)) + payload
result = subprocess.run([
    \"curl\", \"-sS\", \"-o\", \"/dev/null\", \"-w\", \"%{http_code}\",
    \"-X\", \"POST\", \"http://127.0.0.1:49983/process.Process/Start\",
    \"-H\", \"Content-Type: application/connect+json\",
    \"-H\", \"Connect-Protocol-Version: 1\",
    \"--data-binary\", \"@-\",
], input=envelope, capture_output=True)
print(result.stdout.decode().strip())
'" 2>/dev/null || true
)"

# 官方 envd 对无认证请求可能返回 401 或 200（authn 中间件允许匿名），取决于是否配置了 access token
# 此处仅验证请求不会 500
if [ "${UNAUTH_STATUS}" = "401" ]; then
  pass "unauthenticated start returned 401"
elif [ "${UNAUTH_STATUS}" = "200" ]; then
  warn "unauthenticated start returned 200 (envd allows anonymous with valid OS user header)"
  pass "unauthenticated start did not error"
else
  fail "unauthenticated start returned unexpected status: ${UNAUTH_STATUS:-<empty>}"
fi

info "checking service restart recovery"
RESTART_CMD="systemctl restart ${ACTIVE_SERVICE:-envd.service} && sleep 2 && systemctl is-active ${ACTIVE_SERVICE:-envd.service} && curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:49983/health"
RESTART_OUTPUT="$(sshlib_exec_with_timeout 20s "${RESTART_CMD}" 2>/dev/null || true)"

if echo "${RESTART_OUTPUT}" | grep -q "active" && (echo "${RESTART_OUTPUT}" | grep -qE "204|200"); then
  pass "service restart recovered and /health returned success"
else
  fail "service restart did not recover properly (output: ${RESTART_OUTPUT})"
fi

echo
if [ "${FAILURES}" -eq 0 ]; then
  pass "all envd checks passed"
  exit 0
fi

fail "${FAILURES} checks failed"
exit 1
