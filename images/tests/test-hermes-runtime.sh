#!/usr/bin/env bash
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
  bash images/tests/test-hermes-runtime.sh <user@host> [options]

Options:
  --port <port>            SSH port. Default: 22
  --runtime-user <user>    Runtime user. Default: agentuser
  -h, --help               Show help
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
RUNTIME_USER="${LIGHTCLAW_RUNTIME_USER:-agentuser}"
RUNTIME_HOME="/home/${RUNTIME_USER}"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      SSH_PORT="$2"
      shift 2
      ;;
    --runtime-user)
      RUNTIME_USER="$2"
      RUNTIME_HOME="/home/${RUNTIME_USER}"
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

info "checking runtime user"
if remote_exec "id ${RUNTIME_USER}" >/dev/null 2>&1; then
  pass "runtime user ${RUNTIME_USER} exists"
else
  fail "runtime user ${RUNTIME_USER} is missing"
fi

info "checking linger"
LINGER_OUTPUT="$(remote_exec "loginctl show-user '${RUNTIME_USER}' -p Linger --value" 2>&1 || true)"
if [ "${LINGER_OUTPUT}" = "yes" ]; then
  pass "linger is enabled for ${RUNTIME_USER}"
else
  fail "linger is not enabled for ${RUNTIME_USER}"
  echo "${LINGER_OUTPUT}"
fi

info "checking Node.js major version"
NODE_VERSION_OUTPUT="$(remote_exec "node -p 'process.versions.node'" 2>&1 || true)"
if echo "${NODE_VERSION_OUTPUT}" | grep -Eq '^22\.'; then
  pass "Node.js 22.x is installed"
else
  fail "Node.js 22.x is not installed"
  echo "${NODE_VERSION_OUTPUT}"
fi

info "checking qwen command"
QWEN_OUTPUT="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/local/bin:/usr/bin:/bin qwen --version" 2>&1 || true)"
if echo "${QWEN_OUTPUT}" | grep -Eq '(^[0-9]+\.[0-9]+\.[0-9]+$)|qwen'; then
  pass "qwen command is available"
else
  fail "qwen command is not available"
  echo "${QWEN_OUTPUT}"
fi

info "checking hermes runtime command"
HERMES_OUTPUT="$(remote_exec_runtime '
  export HOME='"${RUNTIME_HOME}"'
  export USER='"${RUNTIME_USER}"'
  export PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.hermes/hermes-agent/venv/bin
  if command -v hermes-agent >/dev/null 2>&1; then
    hermes-agent --help
  elif command -v hermes >/dev/null 2>&1; then
    hermes --help
  else
    echo MISSING
    exit 1
  fi
' 2>&1 || true)"
if echo "${HERMES_OUTPUT}" | grep -q 'MISSING'; then
  fail "hermes command is not available"
  echo "${HERMES_OUTPUT}"
else
  pass "hermes runtime command is available"
fi

info "checking hermes profile"
PROFILE_OUTPUT="$(remote_exec "test -f /etc/profile.d/hermes-env.sh && cat /etc/profile.d/hermes-env.sh" 2>&1 || true)"
if echo "${PROFILE_OUTPUT}" | grep -q '\$HOME/.hermes/hermes-agent/venv/bin' && echo "${PROFILE_OUTPUT}" | grep -q '\$HOME/.local/bin'; then
  pass "hermes profile exports hermes and local bin paths"
else
  fail "hermes profile is missing expected PATH exports"
  echo "${PROFILE_OUTPUT}"
fi

info "checking skillhub command"
SKILLHUB_OUTPUT="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/local/bin:/usr/bin:/bin:${RUNTIME_HOME}/.local/bin skillhub --help" 2>&1 || true)"
if echo "${SKILLHUB_OUTPUT}" | grep -Eqi 'skillhub|usage'; then
  pass "skillhub command is available"
else
  fail "skillhub command is not available"
  echo "${SKILLHUB_OUTPUT}"
fi

info "checking acli command"
ACLI_OUTPUT="$(remote_exec "if command -v acli >/dev/null 2>&1; then acli --help >/dev/null && acli doctor; else echo MISSING; exit 1; fi" 2>&1 || true)"
if echo "${ACLI_OUTPUT}" | grep -Eqi 'error|failed|missing'; then
  fail "acli doctor failed"
  echo "${ACLI_OUTPUT}"
else
  pass "acli command is available"
fi

info "checking root account lock"
ROOT_STATUS="$(remote_exec "sudo passwd -S root 2>/dev/null | awk '{print \$2}'" 2>&1 || true)"
if [ "${ROOT_STATUS}" = "L" ]; then
  pass "root account is locked"
else
  fail "root account is not locked"
  echo "${ROOT_STATUS}"
fi

if [ "${FAILURES}" -eq 0 ]; then
  echo -e "${GREEN}all hermes runtime checks passed${NC}"
  exit 0
fi

echo -e "${RED}${FAILURES} hermes runtime check(s) failed${NC}"
exit 1
