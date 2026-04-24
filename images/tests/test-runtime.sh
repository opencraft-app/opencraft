#!/usr/bin/env bash
# =============================================================================
# OpenClaw Runtime 远程门禁验证脚本
#
# 定义:
#   连接远端构建机，验证 OpenClaw 运行时是否满足制作镜像前的最小正确条件：
#   1. `openclaw` 在非交互 shell 下可直接运行
#   2. 系统级 CLI 入口存在且非空
#   3. `~/.openclaw/openclaw.json` 非空且为合法 JSON
#   4. `openclaw-qqbot` 插件已安装
#   5. `openclaw-weixin` 插件已安装
#
# 参数定义:
#   <user@host>               必填，SSH 目标主机
#   --port <port>            可选，SSH 端口，默认 22
#   -h, --help               显示帮助
#
# 输出结果定义:
#   - stdout 打印每项断言结果与关键输出摘要
#   - 退出码 0 表示全部通过，非 0 表示至少一项失败
#
# 示例:
#   bash images/tests/test-runtime.sh ubuntu@119.28.239.108
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
usage() {
  cat <<'EOF'
Usage:
  bash images/tests/test-runtime.sh <user@host> [options]

Description:
  Run runtime gate checks for OpenClaw on the remote build machine before creating an image.

Options:
  --port <port>            SSH port. Default: 22
  -h, --help               Show this help message

Outputs:
  Prints per-check PASS/FAIL results and returns non-zero when any check fails.

Examples:
  bash images/tests/test-runtime.sh ubuntu@119.28.239.108
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
FAILURES=0
RUNTIME_USER="${LIGHTCLAW_RUNTIME_USER:-lightclaw}"
RUNTIME_HOME="/home/${RUNTIME_USER}"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      SSH_PORT="$2"
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

sshlib_init "${REMOTE_HOST}" "${SSH_PORT}"
sshlib_ensure_ready

info "checking non-interactive openclaw version"
VERSION_OUTPUT="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/bin:/bin openclaw --version" 2>&1 || true)"
if echo "${VERSION_OUTPUT}" | grep -q "OpenClaw "; then
  pass "openclaw --version works without sourcing bashrc"
else
  fail "openclaw --version failed in non-interactive shell"
  echo "${VERSION_OUTPUT}"
fi

info "checking openclaw with minimal PATH"
MIN_PATH_OUTPUT="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/bin:/bin openclaw --version" 2>&1 || true)"
if echo "${MIN_PATH_OUTPUT}" | grep -q "OpenClaw "; then
  pass "openclaw --version works with PATH=/usr/bin:/bin"
else
  fail "openclaw --version failed with minimal PATH"
  echo "${MIN_PATH_OUTPUT}"
fi

info "checking openclaw gateway restart with minimal PATH"
MIN_PATH_GATEWAY_OUTPUT="$(remote_exec_runtime "runtime_uid=\$(id -u); env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/\${runtime_uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/\${runtime_uid}/bus openclaw gateway restart" 2>&1 || true)"
if echo "${MIN_PATH_GATEWAY_OUTPUT}" | grep -Eq 'Gateway service disabled|systemctl --user unavailable|Cannot access user instance remotely'; then
  fail "openclaw gateway restart failed with minimal PATH"
  echo "${MIN_PATH_GATEWAY_OUTPUT}"
elif echo "${MIN_PATH_GATEWAY_OUTPUT}" | grep -Eq 'Restarted systemd service'; then
  pass "openclaw gateway restart works with PATH=/usr/bin:/bin"
else
  fail "openclaw gateway restart failed with minimal PATH"
  echo "${MIN_PATH_GATEWAY_OUTPUT}"
fi

info "checking system runtime binaries"
WRAPPER_REPORT="$(remote_exec_runtime '
  set -e
  for path in /usr/local/bin/openclaw /usr/bin/openclaw /usr/local/bin/clawhub /usr/bin/clawhub /usr/local/bin/node /usr/bin/node /usr/local/bin/pnpm /usr/bin/pnpm /usr/local/bin/openclaw-weixin-login-session /usr/bin/openclaw-weixin-login-session; do
    if [ -e "$path" ]; then
      size=$(wc -c < "$path" 2>/dev/null || echo 0)
      printf "%s %s\n" "$path" "$size"
    else
      printf "%s MISSING\n" "$path"
    fi
  done
' 2>&1 || true)"
echo "${WRAPPER_REPORT}"
if echo "${WRAPPER_REPORT}" | awk '$2 == "MISSING" || $2 == "0" { exit 1 }'; then
  pass "system runtime binaries are present and non-empty"
else
  fail "system runtime binary missing or empty"
fi

info "checking weixin session protocol command with minimal PATH"
WEIXIN_PROTOCOL_OUTPUT="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/bin:/bin openclaw-weixin-login-session --help" 2>&1 || true)"
if echo "${WEIXIN_PROTOCOL_OUTPUT}" | grep -q 'openclaw-weixin-login-session <subcommand>'; then
  pass "openclaw-weixin-login-session is available with PATH=/usr/bin:/bin"
else
  fail "openclaw-weixin-login-session missing or not executable with minimal PATH"
  echo "${WEIXIN_PROTOCOL_OUTPUT}"
fi

info "checking gateway user service"
GATEWAY_SERVICE_STATUS="$(remote_exec_runtime '
  runtime_uid="$(id -u)"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${runtime_uid}}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
  test -s "'"${RUNTIME_HOME}"'/.config/systemd/user/openclaw-gateway.service"
  systemctl --user is-enabled openclaw-gateway
  systemctl --user is-active openclaw-gateway
  ss -tln | awk "{print \$4}" | grep -Eq "(^|:)18789$"
' 2>&1 || true)"
if echo "${GATEWAY_SERVICE_STATUS}" | grep -q '^enabled$' && echo "${GATEWAY_SERVICE_STATUS}" | grep -q '^active$'; then
  pass "openclaw-gateway user service is enabled, active, and unit file is non-empty"
else
  fail "openclaw-gateway user service is not ready"
  echo "${GATEWAY_SERVICE_STATUS}"
fi

info "checking openclaw config file"
CONFIG_STATUS="$(remote_exec_runtime '
  set -e
  test -s "'"${RUNTIME_HOME}"'/.openclaw/openclaw.json"
  jq empty "'"${RUNTIME_HOME}"'/.openclaw/openclaw.json" >/dev/null
  wc -c < "'"${RUNTIME_HOME}"'/.openclaw/openclaw.json"
' 2>&1 || true)"
if echo "${CONFIG_STATUS}" | grep -Eq '^[0-9]+$'; then
  pass "openclaw config exists and is valid JSON (${CONFIG_STATUS} bytes)"
else
  fail "openclaw config missing/empty/invalid"
  echo "${CONFIG_STATUS}"
fi

info "checking plugin discovery"
PLUGIN_LIST_OUTPUT="$(remote_exec_runtime 'openclaw plugins list 2>&1 || true' 2>&1 || true)"
echo "${PLUGIN_LIST_OUTPUT}" | tail -n 80
if echo "${PLUGIN_LIST_OUTPUT}" | grep -q 'failed to load'; then
  fail "plugin discovery reported load failure"
elif echo "${PLUGIN_LIST_OUTPUT}" | grep -Eqi 'qqbot|openclaw-qqbot'; then
  pass "qqbot appears in plugin list"
else
  fail "qqbot missing from plugin list"
fi
if echo "${PLUGIN_LIST_OUTPUT}" | grep -Eqi 'weixin|openclaw-weixin'; then
  pass "weixin appears in plugin list"
else
  fail "weixin missing from plugin list"
fi

info "checking plugin directories"
PLUGIN_DIRS="$(remote_exec_runtime '
  if [ -d "'"${RUNTIME_HOME}"'/.openclaw/extensions" ]; then
    find "'"${RUNTIME_HOME}"'/.openclaw/extensions" -mindepth 1 -maxdepth 1 -type d -printf "%f\n" | sort
  fi
' 2>&1 || true)"
echo "${PLUGIN_DIRS}"
if echo "${PLUGIN_DIRS}" | grep -Eqi 'qqbot'; then
  pass "qqbot extension directory exists"
else
  fail "qqbot extension directory missing"
fi
if echo "${PLUGIN_DIRS}" | grep -Eqi 'weixin'; then
  pass "weixin extension directory exists"
else
  fail "weixin extension directory missing"
fi

echo "==========================================="
if [ "${FAILURES}" -eq 0 ]; then
  echo -e "${GREEN}all runtime checks passed${NC}"
  exit 0
fi

echo -e "${RED}${FAILURES} runtime check(s) failed${NC}"
exit 1
