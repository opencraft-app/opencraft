#!/usr/bin/env bash
# =============================================================================
# OpenClaw 微信登录两段式协议远程专项验证脚本
#
# 定义:
#   连接远端构建机，验证镜像内 `openclaw-weixin-login-session` 协议是否可用：
#   1. 协议命令存在且在最小 PATH 下可执行
#   2. `start` 立即返回 `starting`
#   3. `status` 能在超时前推进到 `waiting_qr`
#   4. `qr_ascii` / `qr_url` 至少一个非空
#   5. `cancel` 可幂等收敛到 `cancelled`
#
# 示例:
#   bash images/tests/test-weixin-login-protocol.sh ubuntu@119.28.239.108
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
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $*"; }
fail() { echo -e "${RED}FAIL${NC} $*"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "${CYAN}INFO${NC} $*"; }

usage() {
  cat <<'EOF'
Usage:
  bash images/tests/test-weixin-login-protocol.sh <user@host> [options]

Options:
  --port <port>                    SSH port. Default: 22
  --wait-timeout-seconds <sec>     Poll timeout waiting for QR. Default: 90
  --session-timeout-seconds <sec>  Session TTL passed to start. Default: 300
  -h, --help                       Show help
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
WAIT_TIMEOUT_SECONDS=90
SESSION_TIMEOUT_SECONDS=300
FAILURES=0
RUNTIME_USER="${LIGHTCLAW_RUNTIME_USER:-lightclaw}"
RUNTIME_HOME="/home/${RUNTIME_USER}"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      SSH_PORT="$2"
      shift 2
      ;;
    --wait-timeout-seconds)
      WAIT_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --session-timeout-seconds)
      SESSION_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

remote_exec() {
  sshlib_exec_retry_transport_safe "$1"
}

remote_exec_runtime() {
  local cmd="$1"
  if [ "${SSHLIB_REMOTE_USER:-}" = "${RUNTIME_USER}" ]; then
    remote_exec "${cmd}"
    return
  fi
  local escaped
  printf -v escaped '%q' "cd ${RUNTIME_HOME} && ${cmd}"
  remote_exec "sudo -u ${RUNTIME_USER} -H bash -lc ${escaped}"
}

json_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
value = payload.get(sys.argv[2], "")
if value is None:
    value = ""
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

sshlib_init "${REMOTE_HOST}" "${SSH_PORT}"
sshlib_ensure_ready

SESSION_ID="wxls_test_$(date +%s)"

info "checking protocol command with minimal PATH"
HELP_OUTPUT="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/bin:/bin openclaw-weixin-login-session --help" 2>&1 || true)"
if echo "${HELP_OUTPUT}" | grep -q 'openclaw-weixin-login-session <subcommand>'; then
  pass "protocol command is available with PATH=/usr/bin:/bin"
else
  fail "protocol command missing or not executable"
  echo "${HELP_OUTPUT}"
fi

info "starting weixin login session ${SESSION_ID}"
START_JSON="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/bin:/bin openclaw-weixin-login-session start --session-id '${SESSION_ID}' --timeout-seconds '${SESSION_TIMEOUT_SECONDS}'" 2>&1 || true)"
echo "${START_JSON}"
if [ "$(json_field "${START_JSON}" ok)" = "true" ] && [ "$(json_field "${START_JSON}" status)" = "starting" ]; then
  pass "start returned structured starting payload"
else
  fail "start did not return expected starting payload"
fi

deadline=$(( $(date +%s) + WAIT_TIMEOUT_SECONDS ))
STATUS_JSON=''
LAST_STATUS=''
QR_ASCII=''
QR_URL=''

info "polling status until waiting_qr"
while [ "$(date +%s)" -lt "${deadline}" ]; do
  STATUS_JSON="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/bin:/bin openclaw-weixin-login-session status --session-id '${SESSION_ID}'" 2>&1 || true)"
  LAST_STATUS="$(json_field "${STATUS_JSON}" status)"
  QR_ASCII="$(json_field "${STATUS_JSON}" qr_ascii)"
  QR_URL="$(json_field "${STATUS_JSON}" qr_url)"
  info "status=${LAST_STATUS}"
  if [ "${LAST_STATUS}" = "waiting_qr" ]; then
    break
  fi
  if [ "${LAST_STATUS}" = "failed" ] || [ "${LAST_STATUS}" = "expired" ] || [ "${LAST_STATUS}" = "cancelled" ]; then
    break
  fi
  sleep 3
done

if [ "${LAST_STATUS}" = "waiting_qr" ]; then
  pass "status progressed to waiting_qr"
else
  fail "status did not reach waiting_qr before timeout (last=${LAST_STATUS})"
  echo "${STATUS_JSON}"
fi

if [ -n "${QR_ASCII}" ] || [ -n "${QR_URL}" ]; then
  pass "status returned qr evidence"
else
  fail "status missing qr_ascii and qr_url"
  echo "${STATUS_JSON}"
fi

info "cancelling session"
CANCEL_JSON="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/bin:/bin openclaw-weixin-login-session cancel --session-id '${SESSION_ID}'" 2>&1 || true)"
echo "${CANCEL_JSON}"
if [ "$(json_field "${CANCEL_JSON}" status)" = "cancelled" ]; then
  pass "cancel returned cancelled"
else
  fail "cancel did not converge to cancelled"
fi

if [ "${FAILURES}" -eq 0 ]; then
  echo -e "${GREEN}all weixin protocol checks passed${NC}"
  exit 0
fi

echo -e "${RED}${FAILURES} weixin protocol check(s) failed${NC}"
exit 1
