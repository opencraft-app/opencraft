#!/usr/bin/env bash
# =============================================================================
# OpenClaw 大模型 API 配置脚本
#
# 在远程服务器上配置自定义大模型 API Provider。
#
# 用法:
#   bash config-llm-api.sh <user@host> [--port PORT] [选项]
#
# 示例:
#   bash config-llm-api.sh root@119.28.239.108 --port 36000 \
#     --base-url "https://api.example.com/v1" \
#     --model-id "gpt-4" \
#     --api-key "sk-xxx"
#
# 配置文件: 可通过 --env-file 指定，或使用命令行参数
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

usage() {
  cat <<'EOF'
用法:
  bash config-llm-api.sh <user@host> [选项]

说明:
  在远程主机上配置 OpenClaw 使用自定义大模型 API。
  支持通过命令行参数或环境文件配置。

选项:
  --port PORT           SSH 端口，默认 22
  --env-file FILE       环境配置文件路径
  --base-url URL        API Base URL (必填)
  --model-id ID         模型 ID (必填)
  --api-key KEY         API Key (可选，不提供则跳过健康检查)
  --compatibility MODE  兼容模式: openai|anthropic，默认 openai
  --provider-id ID      Provider ID，默认自动生成
  --gateway-port PORT   Gateway 端口，默认 18789
  --reset               配置前重置现有配置
  --skip-health         跳过健康检查
  -h, --help            显示帮助

环境文件格式 (config-llm.env):
  CUSTOM_BASE_URL="https://api.example.com/v1"
  CUSTOM_MODEL_ID="gpt-4"
  CUSTOM_API_KEY="sk-xxx"
  CUSTOM_COMPATIBILITY="openai"
  CUSTOM_PROVIDER_ID="my-provider"
  GATEWAY_PORT=18789

示例:
  # 使用命令行参数
  bash config-llm-api.sh root@119.28.239.108 --port 36000 \
    --base-url "https://api.lkeap.cloud.tencent.com/coding/v3" \
    --model-id "glm-5" \
    --api-key "your-api-key"

  # 使用环境文件
  bash config-llm-api.sh root@119.28.239.108 --port 36000 \
    --env-file ./config-llm.env
EOF
}

# ---- 颜色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "${CYAN}▸ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }

FAILURES=0

# ---- 默认值 ----
SSH_PORT=22
ENV_FILE=""
CUSTOM_BASE_URL=""
CUSTOM_MODEL_ID=""
CUSTOM_API_KEY=""
CUSTOM_COMPATIBILITY="openai"
CUSTOM_PROVIDER_ID=""
GATEWAY_PORT=18789
RESET_CONFIG=false
SKIP_HEALTH=false

# ---- 参数解析 ----
REMOTE_HOST="${1:-}"

if [ "${REMOTE_HOST:-}" = "-h" ] || [ "${REMOTE_HOST:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ -z "$REMOTE_HOST" ] || [[ "$REMOTE_HOST" == -* ]]; then
  usage
  exit 1
fi

shift  # 移除第一个参数
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
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --base-url)
      CUSTOM_BASE_URL="$2"
      shift 2
      ;;
    --model-id)
      CUSTOM_MODEL_ID="$2"
      shift 2
      ;;
    --api-key)
      CUSTOM_API_KEY="$2"
      shift 2
      ;;
    --compatibility)
      CUSTOM_COMPATIBILITY="$2"
      shift 2
      ;;
    --provider-id)
      CUSTOM_PROVIDER_ID="$2"
      shift 2
      ;;
    --gateway-port)
      GATEWAY_PORT="$2"
      shift 2
      ;;
    --reset)
      RESET_CONFIG=true
      shift
      ;;
    --skip-health)
      SKIP_HEALTH=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# ---- 加载环境文件 ----
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  info "加载环境文件: ${ENV_FILE}"
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

# ---- 应用默认值 ----
CUSTOM_BASE_URL="${CUSTOM_BASE_URL:-${CUSTOM_BASE_URL_ENV:-}}"
CUSTOM_MODEL_ID="${CUSTOM_MODEL_ID:-${CUSTOM_MODEL_ID_ENV:-}}"
CUSTOM_API_KEY="${CUSTOM_API_KEY:-${CUSTOM_API_KEY_ENV:-}}"
CUSTOM_COMPATIBILITY="${CUSTOM_COMPATIBILITY:-${CUSTOM_COMPATIBILITY_ENV:-openai}}"
CUSTOM_PROVIDER_ID="${CUSTOM_PROVIDER_ID:-${CUSTOM_PROVIDER_ID_ENV:-}}"
GATEWAY_PORT="${GATEWAY_PORT:-${GATEWAY_PORT:-18789}}"

# ---- 校验必要参数 ----
if [ -z "$CUSTOM_BASE_URL" ]; then
  fail "缺少必填参数: --base-url 或 CUSTOM_BASE_URL"
  exit 1
fi
if [ -z "$CUSTOM_MODEL_ID" ]; then
  fail "缺少必填参数: --model-id 或 CUSTOM_MODEL_ID"
  exit 1
fi

# 生成默认 provider ID
if [ -z "$CUSTOM_PROVIDER_ID" ]; then
  CUSTOM_PROVIDER_ID="custom-$(echo "$CUSTOM_BASE_URL" | sha256sum | head -c 8)"
fi

# 如果未配置 API key，自动跳过健康检查
if [ -z "$CUSTOM_API_KEY" ]; then
  warn "未配置 API key，将跳过健康检查"
  SKIP_HEALTH=true
fi

# ---- 远程执行函数 ----
remote_exec() { sshlib_exec "$1"; }

sshlib_init "${REMOTE_HOST}" "${SSH_PORT}"
sshlib_ensure_ready

echo ""
echo "==========================================="
echo "  OpenClaw 大模型 API 配置"
echo "==========================================="
echo "目标主机:   ${REMOTE_HOST} (SSH 端口: ${SSH_PORT})"
echo "API Base:   ${CUSTOM_BASE_URL}"
echo "模型:       ${CUSTOM_MODEL_ID}"
echo "兼容性:     ${CUSTOM_COMPATIBILITY}"
echo "Provider:   ${CUSTOM_PROVIDER_ID}"
echo "Gateway:    ${GATEWAY_PORT}"
echo "重置配置:   ${RESET_CONFIG}"
echo "跳过健康:   ${SKIP_HEALTH}"
echo "==========================================="
echo ""

# ---- 预检：确认 openclaw 已安装 ----
echo "=== [预检] 确认 openclaw 已安装 ==="
if remote_exec 'command -v openclaw >/dev/null 2>&1 && openclaw --version | head -1'; then
  pass "openclaw 已安装"
else
  fail "openclaw 未安装或不在 PATH 中"
  echo "请先运行: bash images/deploy-build.sh ${REMOTE_HOST} --port ${SSH_PORT}"
  exit 1
fi
echo ""

# ---- 可选：重置配置 ----
if [ "$RESET_CONFIG" = true ]; then
  echo "=== [步骤 1/3] 重置配置 ==="
  info "重置 onboard 配置..."
  if remote_exec '
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
fi

# ---- 配置 Custom Provider ----
STEP_NUM=1
if [ "$RESET_CONFIG" = true ]; then
  STEP_NUM=2
fi
echo "=== [步骤 ${STEP_NUM}/3] 配置 Custom Provider ==="
info "运行 onboard（custom provider: ${CUSTOM_COMPATIBILITY}）..."

ONBOARD_CMD="openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice custom-api-key \
  --custom-base-url '${CUSTOM_BASE_URL}' \
  --custom-model-id '${CUSTOM_MODEL_ID}' \
  --custom-compatibility '${CUSTOM_COMPATIBILITY}' \
  --custom-provider-id '${CUSTOM_PROVIDER_ID}' \
  --gateway-port ${GATEWAY_PORT} \
  --gateway-bind loopback \
  --skip-channels \
  --skip-skills \
  --skip-health \
  --json"

# Add API key only when provided.
if [ -n "${CUSTOM_API_KEY:-}" ]; then
  ONBOARD_CMD="CUSTOM_API_KEY='${CUSTOM_API_KEY}' ${ONBOARD_CMD} --custom-api-key '${CUSTOM_API_KEY}'"
fi

ONBOARD_OUTPUT=""
if ONBOARD_OUTPUT="$(remote_exec "${ONBOARD_CMD}" 2>&1)"; then
  pass "onboard 命令执行成功"
else
  fail "onboard 命令失败"
  echo "$ONBOARD_OUTPUT"
fi
echo ""

# ---- 验证配置 ----
STEP_NUM=$((STEP_NUM + 1))
echo "=== [步骤 ${STEP_NUM}/3] 验证配置文件 ==="
info "检查生成的配置..."

CONFIG_CHECK=$(remote_exec '
  CONFIG_PATH="${HOME}/.openclaw/openclaw.json"
  if [ ! -f "$CONFIG_PATH" ]; then
    echo "MISSING"
    exit 0
  fi
  cat "$CONFIG_PATH"
' 2>&1) || true

if [ "$CONFIG_CHECK" = "MISSING" ]; then
  fail "配置文件不存在"
else
  # Validate key config fields using node.
  VALIDATE_RESULT=$(remote_exec '
    node -e \"
      const fs = require(\\\"fs\\\");
      const cfg = JSON.parse(fs.readFileSync(process.env.HOME + \\\"/.openclaw/openclaw.json\\\", \\\"utf8\\\"));
      const errors = [];
      if (cfg?.gateway?.mode !== \\\"local\\\") errors.push(\\\"gateway.mode != local\\\");
      if (cfg?.gateway?.bind !== \\\"loopback\\\") errors.push(\\\"gateway.bind != loopback\\\");
      if (!cfg?.wizard?.lastRunAt) errors.push(\\\"wizard.lastRunAt missing\\\");
      if (cfg?.wizard?.lastRunCommand !== \\\"onboard\\\") errors.push(\\\"wizard.lastRunCommand != onboard\\\");
      if (errors.length > 0) { console.log(\\\"FAIL::\\\" + errors.join(\\\"; \\\")); }
      else { console.log(\\\"OK\\\"); }
    \"
  ' 2>&1) || true

  if [[ "$VALIDATE_RESULT" == OK* ]]; then
    pass "配置文件验证通过"
  else
    fail "配置文件验证失败: ${VALIDATE_RESULT}"
  fi
fi
echo ""

# ---- 健康检查（可选）----
if [ "$SKIP_HEALTH" = false ] && [ -n "$CUSTOM_API_KEY" ]; then
  STEP_NUM=$((STEP_NUM + 1))
  echo "=== [步骤 ${STEP_NUM}/3] Gateway 健康检查 ==="
  info "启动 gateway 并检查健康状态..."

  # 清理已有的 gateway 进程
  remote_exec "ss -tlnp 2>/dev/null | grep ':${GATEWAY_PORT} ' | grep -oP 'pid=\\K[0-9]+' | head -1 | xargs -r kill -9 2>/dev/null; sleep 1" 2>/dev/null || true

  # 启动 gateway 并检测端口
  GW_RESULT=$(remote_exec "
    rm -f /tmp/openclaw-gw-test.log
    nohup bash -lc 'openclaw gateway run --bind loopback --port ${GATEWAY_PORT} --force' > /tmp/openclaw-gw-test.log 2>&1 &
    for i in \$(seq 1 20); do
      sleep 1
      if ss -tln 2>/dev/null | grep -q ':${GATEWAY_PORT} '; then
        echo GW_OK
        exit 0
      fi
    done
    echo GW_FAIL
    echo '--- gateway log ---'
    tail -n 40 /tmp/openclaw-gw-test.log 2>/dev/null
    exit 1
  " 2>&1) || true

  if echo "$GW_RESULT" | grep -q "GW_OK"; then
    pass "Gateway 启动成功，端口 ${GATEWAY_PORT} 可达"
  else
    fail "Gateway 启动失败"
    echo "$GW_RESULT"
  fi

  # Agent 烟雾测试
  info "运行 agent 烟雾测试..."
  AGENT_RESULT=$(remote_exec '
    timeout 30 openclaw agent --local --agent main --message \"Reply with only the word OK\" --thinking low 2>&1 || true
  ' 2>&1) || true

  if echo "$AGENT_RESULT" | grep -iq "ok"; then
    pass "Agent 烟雾测试通过"
  else
    fail "Agent 烟雾测试失败"
    echo "$AGENT_RESULT" | tail -n 20
  fi
else
  warn "跳过健康检查"
fi
echo ""

# ---- 结果汇总 ----
echo "==========================================="
if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}配置成功!${NC}"
  echo ""
  echo "下一步:"
  echo "  ssh -p ${SSH_PORT} ${REMOTE_HOST} 'openclaw gateway run'"
  echo "  ssh -p ${SSH_PORT} ${REMOTE_HOST} 'openclaw tui'"
  exit 0
else
  echo -e "${RED}${FAILURES} 个步骤失败${NC}"
  exit 1
fi
