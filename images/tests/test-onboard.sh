#!/usr/bin/env bash
# =============================================================================
# OpenClaw Onboard 远程 E2E 测试脚本
#
# 在 VPS 上以镜像真实运行态用户执行 OpenClaw onboard，并验证：
# 1. onboard 配置写入
# 2. official gateway user service 可用
# 3. provider / channel / agent 的关键路径正常
# 4. onboard 重复执行可收敛
# =============================================================================

set -euo pipefail

usage() {
  cat <<'EOF'
用法:
  bash test-onboard.sh <user@host> [--port PORT] [--with-deploy]

说明:
  在远程主机上执行 OpenClaw onboard E2E 测试。
  配置从同目录 onboard-test.env 读取，支持可选的 Telegram / QQBot 渠道配置。

输出结果:
  stdout: 打印测试过程与最终汇总
  exit 0: 所有测试通过
  exit 1: 参数缺失、环境缺失或任一步骤失败

选项:
  --port PORT      指定 SSH 端口，默认 22
  --with-deploy    测试前执行 pack-and-deploy.sh
  -h, --help       显示帮助

示例:
  bash test-onboard.sh ubuntu@43.160.237.31
  bash test-onboard.sh ubuntu@119.28.239.108 --port 36000 --with-deploy
EOF
}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $*"; }
fail() { echo -e "${RED}FAIL${NC} $*"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "${CYAN}INFO${NC} $*"; }
warn() { echo -e "${YELLOW}WARN${NC} $*"; }

shell_escape() {
  printf '%q' "$1"
}

FAILURES=0
CURRENT_TEST=0

REMOTE_HOST="${1:-}"
WITH_DEPLOY=false
SSH_PORT=22

if [ "${REMOTE_HOST:-}" = "-h" ] || [ "${REMOTE_HOST:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ -z "${REMOTE_HOST}" ]; then
  usage
  exit 1
fi

shift
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --port)
      SSH_PORT="$2"
      shift 2
      ;;
    --with-deploy)
      WITH_DEPLOY=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_LIB="${SCRIPT_DIR}/../lib/ssh.sh"
if [ ! -f "${SSH_LIB}" ]; then
  echo "ERROR: ssh library not found: ${SSH_LIB}" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "${SSH_LIB}"

ENV_FILE="${SCRIPT_DIR}/onboard-test.env"
if [ ! -f "${ENV_FILE}" ]; then
  echo "错误: 配置文件不存在: ${ENV_FILE}"
  echo "请从模板创建: cp onboard-test.env.example onboard-test.env"
  exit 1
fi
# shellcheck source=/dev/null
source "${ENV_FILE}"

REQUIRED_VARS=(CUSTOM_BASE_URL CUSTOM_MODEL_ID CUSTOM_COMPATIBILITY)
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "错误: 配置文件缺少必要变量: ${var}"
    exit 1
  fi
done

SKIP_HEALTH=false
if [ -z "${CUSTOM_API_KEY:-}" ]; then
  warn "未配置 CUSTOM_API_KEY，将跳过 provider 健康检查和 agent 烟雾测试"
  SKIP_HEALTH=true
fi

GATEWAY_PORT="${GATEWAY_PORT:-18789}"
CUSTOM_PROVIDER_ID="${CUSTOM_PROVIDER_ID:-custom-test-provider}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
QQBOT_TOKEN="${QQBOT_TOKEN:-}"
RUNTIME_USER="${LIGHTCLAW_RUNTIME_USER:-lightclaw}"
RUNTIME_HOME="/home/${RUNTIME_USER}"
HAS_TELEGRAM=false
HAS_QQBOT=false
HAS_CHANNELS=false

if [ -n "${TELEGRAM_BOT_TOKEN}" ]; then
  HAS_TELEGRAM=true
  HAS_CHANNELS=true
fi
if [ -n "${QQBOT_TOKEN}" ]; then
  HAS_QQBOT=true
  HAS_CHANNELS=true
fi

TOTAL_TESTS=7
if [ "${HAS_TELEGRAM}" = true ]; then
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
fi
if [ "${HAS_QQBOT}" = true ]; then
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
fi
if [ "${HAS_CHANNELS}" = true ]; then
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
fi

next_test() {
  local title="$1"
  CURRENT_TEST=$((CURRENT_TEST + 1))
  echo "=== [测试 ${CURRENT_TEST}/${TOTAL_TESTS}] ${title} ==="
}

remote_exec() {
  sshlib_exec_retry_transport_safe "$1"
}

remote_exec_runtime() {
  local cmd="$1"
  local wrapped="cd ${RUNTIME_HOME} && ${cmd}"
  if [ "${SSHLIB_REMOTE_USER:-}" = "${RUNTIME_USER}" ]; then
    remote_exec "${wrapped}"
    return
  fi
  local escaped
  printf -v escaped '%q' "${wrapped}"
  remote_exec "sudo -u ${RUNTIME_USER} -H bash -lc ${escaped}"
}

sshlib_init "${REMOTE_HOST}" "${SSH_PORT}"
sshlib_ensure_ready

echo ""
echo "==========================================="
echo "  OpenClaw Onboard E2E 测试"
echo "==========================================="
echo "目标主机: ${REMOTE_HOST} (SSH 端口: ${SSH_PORT})"
echo "运行用户: ${RUNTIME_USER}"
echo "运行目录: ${RUNTIME_HOME}"
echo "API Base: ${CUSTOM_BASE_URL}"
echo "模型:     ${CUSTOM_MODEL_ID}"
echo "兼容性:   ${CUSTOM_COMPATIBILITY}"
echo "端口:     ${GATEWAY_PORT}"
echo "Provider: ${CUSTOM_PROVIDER_ID}"
if [ -n "${TELEGRAM_BOT_TOKEN}" ]; then
  echo "Telegram: 已配置"
else
  echo "Telegram: 未配置"
fi
if [ -n "${QQBOT_TOKEN}" ]; then
  echo "QQBot:    已配置"
else
  echo "QQBot:    未配置"
fi
echo "跳过健康: ${SKIP_HEALTH}"
echo "==========================================="
echo ""

if [ "${WITH_DEPLOY}" = true ]; then
  info "执行打包部署..."
  bash "${SCRIPT_DIR}/pack-and-deploy.sh" "${REMOTE_HOST}" --install
  echo ""
fi

ONBOARD_CMD="openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice custom-api-key \
  --custom-base-url $(shell_escape "${CUSTOM_BASE_URL}") \
  --custom-model-id $(shell_escape "${CUSTOM_MODEL_ID}") \
  --custom-compatibility $(shell_escape "${CUSTOM_COMPATIBILITY}") \
  --custom-provider-id $(shell_escape "${CUSTOM_PROVIDER_ID}") \
  --gateway-port ${GATEWAY_PORT} \
  --gateway-bind loopback \
  --skip-channels \
  --skip-skills \
  --json"
if [ "${SKIP_HEALTH}" = true ]; then
  ONBOARD_CMD="${ONBOARD_CMD} --skip-health"
fi
if [ -n "${CUSTOM_API_KEY:-}" ]; then
  ONBOARD_CMD="${ONBOARD_CMD} --custom-api-key $(shell_escape "${CUSTOM_API_KEY}")"
fi

echo "=== [预检] 确认 openclaw 已安装 ==="
if remote_exec_runtime 'command -v openclaw >/dev/null 2>&1 && openclaw --version | head -1'; then
  pass "openclaw 已安装，且 ${RUNTIME_USER} 可直接执行"
else
  fail "openclaw 未安装或 ${RUNTIME_USER} 不可执行"
  exit 1
fi
echo ""

next_test "清理旧配置"
info "重置 onboard 配置..."
if remote_exec_runtime '
  openclaw onboard --non-interactive --accept-risk \
    --reset --reset-scope full \
    --auth-choice skip \
    --skip-health 2>&1
'; then
  pass "配置重置成功"
else
  warn "配置重置返回非零（可能是首次运行，继续）"
fi
echo ""

next_test "Custom Provider Onboard"
info "运行 onboard（custom provider: ${CUSTOM_COMPATIBILITY}）..."
ONBOARD_OUTPUT="$(remote_exec_runtime "${ONBOARD_CMD}" 2>&1 || true)"
if printf '%s' "${ONBOARD_OUTPUT}" | grep -Eq '"ok":true|wizard|Updated|saved'; then
  pass "onboard 命令执行成功"
else
  fail "onboard 命令失败"
  echo "${ONBOARD_OUTPUT}"
fi
echo ""

if [ "${HAS_TELEGRAM}" = true ]; then
  next_test "Telegram 渠道配置"
  info "写入 Telegram bot token..."
  TG_RESULT="$(remote_exec_runtime "openclaw config set channels.telegram.botToken $(shell_escape "${TELEGRAM_BOT_TOKEN}")" 2>&1 || true)"
  if printf '%s' "${TG_RESULT}" | grep -Eq 'Updated|Created|saved'; then
    pass "Telegram 配置写入成功"
  else
    fail "Telegram 配置写入失败"
    echo "${TG_RESULT}"
  fi
  TG_VERIFY="$(remote_exec_runtime 'openclaw config get channels.telegram.botToken 2>&1' 2>&1 || true)"
  if printf '%s' "${TG_VERIFY}" | grep -Eq 'REDACTED|set'; then
    pass "Telegram 配置验证通过"
  else
    warn "Telegram 配置验证结果: ${TG_VERIFY}"
  fi
  echo ""
fi

if [ "${HAS_QQBOT}" = true ]; then
  next_test "QQBot 渠道配置"
  info "写入 QQBot token..."
  QQBOT_RESULT="$(remote_exec_runtime "openclaw channels add --channel qqbot --token $(shell_escape "${QQBOT_TOKEN}")" 2>&1 || true)"
  if printf '%s' "${QQBOT_RESULT}" | grep -Eq 'Added|Updated|already exists'; then
    pass "QQBot 配置写入成功"
  else
    fail "QQBot 配置写入失败"
    echo "${QQBOT_RESULT}"
  fi
  QQBOT_VERIFY="$(remote_exec_runtime 'openclaw config get channels.qqbot.appId 2>&1' 2>&1 || true)"
  if [ -n "${QQBOT_TOKEN%%:*}" ] && printf '%s' "${QQBOT_VERIFY}" | grep -Fq "${QQBOT_TOKEN%%:*}"; then
    pass "QQBot 配置验证通过"
  else
    warn "QQBot 配置验证结果: ${QQBOT_VERIFY}"
  fi
  echo ""
fi

next_test "验证配置文件"
info "检查生成的配置..."
VALIDATE_RESULT="$(remote_exec_runtime "
  node - <<'NODE'
const fs = require('fs');
const path = process.env.HOME + '/.openclaw/openclaw.json';
if (!fs.existsSync(path)) {
  console.log('FAIL::config missing');
  process.exit(0);
}
const raw = fs.readFileSync(path, 'utf8');
const cfg = JSON.parse(raw);
const errors = [];
if (cfg?.gateway?.mode !== 'local') errors.push('gateway.mode != local');
if (cfg?.gateway?.bind !== 'loopback') errors.push('gateway.bind != loopback');
if (!cfg?.wizard?.lastRunAt) errors.push('wizard.lastRunAt missing');
if (cfg?.wizard?.lastRunCommand !== 'onboard') errors.push('wizard.lastRunCommand != onboard');
if (cfg?.wizard?.lastRunMode !== 'local') errors.push('wizard.lastRunMode != local');
if (!raw.includes(${CUSTOM_BASE_URL@Q})) errors.push('custom base url missing');
if (!raw.includes(${CUSTOM_MODEL_ID@Q})) errors.push('custom model id missing');
if (!raw.includes(${CUSTOM_PROVIDER_ID@Q})) errors.push('custom provider id missing');
if (!raw.includes(${CUSTOM_COMPATIBILITY@Q})) errors.push('custom compatibility missing');
if (${HAS_TELEGRAM@Q} === 'true' && !cfg?.channels?.telegram?.botToken) errors.push('channels.telegram.botToken missing');
if (${HAS_QQBOT@Q} === 'true') {
  if (!cfg?.channels?.qqbot?.appId) errors.push('channels.qqbot.appId missing');
  if (!cfg?.channels?.qqbot?.clientSecret) errors.push('channels.qqbot.clientSecret missing');
}
if (errors.length > 0) {
  console.log('FAIL::' + errors.join('; '));
} else {
  console.log('OK');
}
NODE
" 2>&1 || true)"
if printf '%s' "${VALIDATE_RESULT}" | grep -q 'FAIL::'; then
  fail "配置文件验证失败: ${VALIDATE_RESULT}"
elif printf '%s' "${VALIDATE_RESULT}" | grep -q 'OK'; then
  pass "配置文件验证通过"
else
  fail "配置文件验证失败: ${VALIDATE_RESULT}"
fi
echo ""

next_test "运行态权限与目录归属"
info "检查 ${RUNTIME_USER} 的运行目录归属..."
OWNERSHIP_RESULT="$(remote_exec_runtime "
  set -e
  expected_user=$(shell_escape "${RUNTIME_USER}")
  expected_group=$(shell_escape "${RUNTIME_USER}")
  targets=(
    $(shell_escape "${RUNTIME_HOME}/.openclaw")
    $(shell_escape "${RUNTIME_HOME}/.config/systemd/user/openclaw-gateway.service")
  )
  for target in \"\${targets[@]}\"; do
    if [ ! -e \"\$target\" ]; then
      echo \"MISSING::\$target\"
      exit 0
    fi
    owner=\"\$(stat -c \"%U:%G\" \"\$target\")\"
    echo \"\$owner \$target\"
    if [ \"\$owner\" != \"\${expected_user}:\${expected_group}\" ]; then
      echo \"BAD_OWNER::\$owner::\$target\"
      exit 0
    fi
  done
  if [ -d $(shell_escape "${RUNTIME_HOME}/.openclaw/extensions") ]; then
    find $(shell_escape "${RUNTIME_HOME}/.openclaw/extensions") -mindepth 1 -maxdepth 1 -type d -printf '%u:%g %p\n'
  fi
" 2>&1 || true)"
echo "${OWNERSHIP_RESULT}"
if printf '%s' "${OWNERSHIP_RESULT}" | grep -q '^MISSING::'; then
  fail "运行态目录缺失: ${OWNERSHIP_RESULT#MISSING::}"
elif printf '%s' "${OWNERSHIP_RESULT}" | grep -q '^BAD_OWNER::'; then
  fail "运行态目录归属错误: ${OWNERSHIP_RESULT#BAD_OWNER::}"
else
  pass "运行态目录与 unit 归属正确"
fi
echo ""

next_test "Gateway user service 检查"
info "重启 official gateway user service 并校验健康状态..."
GATEWAY_SERVICE_RESULT="$(remote_exec_runtime '
  runtime_uid="$(id -u)"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${runtime_uid}}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
  mkdir -p "${XDG_RUNTIME_DIR}" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable openclaw-gateway >/dev/null 2>&1 || true
  systemctl --user restart openclaw-gateway
  systemctl --user is-enabled openclaw-gateway
  systemctl --user is-active openclaw-gateway
  ss -tln | awk "{print \$4}" | grep -Eq "(^|:)'"${GATEWAY_PORT}"'$"
' 2>&1 || true)"
if printf '%s' "${GATEWAY_SERVICE_RESULT}" | grep -q '^enabled$' && printf '%s' "${GATEWAY_SERVICE_RESULT}" | grep -q '^active$'; then
  pass "official gateway user service 已启用且 active"
else
  fail "official gateway user service 检查失败"
  echo "${GATEWAY_SERVICE_RESULT}"
fi

if [ "${SKIP_HEALTH}" = true ]; then
  warn "跳过 provider 健康探测（无 API key）"
else
  HEALTH_RESULT="$(remote_exec_runtime '
    for i in $(seq 1 20); do
      if ss -tln | awk "{print \$4}" | grep -Eq "(^|:)'"${GATEWAY_PORT}"'$"; then
        if timeout 10 curl -fsS "http://127.0.0.1:'"${GATEWAY_PORT}"'/health" >/tmp/openclaw-health-check.out 2>/dev/null; then
          cat /tmp/openclaw-health-check.out
          exit 0
        fi
      fi
      sleep 1
    done
    exit 1
  ' 2>&1 || true)"
  if printf '%s' "${HEALTH_RESULT}" | grep -Eiq 'ok|healthy|status'; then
    pass "gateway /health 探测通过"
  else
    fail "gateway /health 探测失败"
    echo "${HEALTH_RESULT}"
  fi
fi
echo ""

if [ "${HAS_CHANNELS}" = true ]; then
  next_test "Channel 状态探测"
  info "检查 channels list / status --probe..."
  CHANNEL_RESULT="$(remote_exec_runtime '
    openclaw channels list 2>&1 || true
    echo ---
    openclaw channels status --probe 2>&1 || true
  ' 2>&1 || true)"
  echo "${CHANNEL_RESULT}" | tail -n 120
  if printf '%s' "${CHANNEL_RESULT}" | grep -q 'failed to load'; then
    fail "channel 探测出现 load failure"
  elif [ "${HAS_QQBOT}" = true ] && ! printf '%s' "${CHANNEL_RESULT}" | grep -Eqi 'qqbot|openclaw-qqbot'; then
    fail "channel 探测未看到 qqbot"
  elif [ "${HAS_TELEGRAM}" = true ] && ! printf '%s' "${CHANNEL_RESULT}" | grep -Eqi 'telegram'; then
    warn "channel 探测输出未显式看到 telegram，建议人工复核"
    pass "channel 探测命令可执行"
  else
    pass "channel 探测通过"
  fi
  echo ""
fi

next_test "Onboard 幂等性"
info "再次执行 onboard，验证重复调用可收敛..."
ONBOARD_RETRY_OUTPUT="$(remote_exec_runtime "${ONBOARD_CMD}" 2>&1 || true)"
if printf '%s' "${ONBOARD_RETRY_OUTPUT}" | grep -Eq '"ok":true|wizard|Updated|saved'; then
  pass "重复 onboard 成功"
else
  fail "重复 onboard 失败"
  echo "${ONBOARD_RETRY_OUTPUT}"
fi
echo ""

next_test "Agent 烟雾测试"
if [ "${SKIP_HEALTH}" = true ]; then
  warn "跳过（无 API key）"
else
  info "运行 agent --local 快速测试..."
  AGENT_RESULT="$(remote_exec_runtime '
    timeout 45 openclaw agent --local --agent main --message "Reply with only the word OK" --thinking low 2>&1 || true
  ' 2>&1 || true)"
  if printf '%s' "${AGENT_RESULT}" | grep -iq "ok"; then
    pass "Agent 烟雾测试通过"
  else
    fail "Agent 烟雾测试失败"
    echo "${AGENT_RESULT}" | tail -n 40
  fi
fi
echo ""

echo "==========================================="
if [ "${FAILURES}" -eq 0 ]; then
  echo -e "${GREEN}所有测试通过!${NC}"
  exit 0
fi

echo -e "${RED}${FAILURES} 个测试失败${NC}"
exit 1
