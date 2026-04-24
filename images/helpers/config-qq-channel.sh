#!/usr/bin/env bash
# =============================================================================
# OpenClaw QQ 消息通道配置脚本
#
# 在远程服务器上配置 QQBot 消息通道。
#
# 用法:
#   bash config-qq-channel.sh <user@host> [--port PORT] [选项]
#
# 示例:
#   bash config-qq-channel.sh root@119.28.239.108 --port 36000 \
#     --token "123456789:your-app-secret"
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
  bash config-qq-channel.sh <user@host> [选项]

说明:
  在远程主机上配置 OpenClaw 的 QQBot 消息通道。
  QQBot token 格式: AppID:AppSecret

选项:
  --port PORT       SSH 端口，默认 22
  --env-file FILE   环境配置文件路径
  --token TOKEN     QQBot Token，格式: AppID:AppSecret (必填)
  --test            配置后发送测试消息
  --test-target ID  测试消息目标 (群号或用户ID)
  -h, --help        显示帮助

环境文件格式 (config-qq.env):
  QQBOT_TOKEN="123456789:your-app-secret"

获取 QQBot Token:
  1. 访问 QQ 开放平台: https://q.qq.com/
  2. 创建机器人应用
  3. 获取 AppID 和 AppSecret
  4. 格式: AppID:AppSecret

示例:
  # 使用命令行参数
  bash config-qq-channel.sh root@119.28.239.108 --port 36000 \
    --token "123456789:abcdefgh"

  # 使用环境文件
  bash config-qq-channel.sh root@119.28.239.108 --port 36000 \
    --env-file ./config-qq.env
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
QQBOT_TOKEN=""
TEST_MODE=false
TEST_TARGET=""

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
    --token)
      QQBOT_TOKEN="$2"
      shift 2
      ;;
    --test)
      TEST_MODE=true
      shift
      ;;
    --test-target)
      TEST_TARGET="$2"
      shift 2
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

# ---- 校验必要参数 ----
if [ -z "$QQBOT_TOKEN" ]; then
  fail "缺少必填参数: --token 或 QQBOT_TOKEN"
  exit 1
fi

# 校验 token 格式
if [[ ! "$QQBOT_TOKEN" == *:* ]]; then
  fail "Token 格式错误，应为 AppID:AppSecret"
  exit 1
fi

# 提取 AppID
APP_ID="${QQBOT_TOKEN%%:*}"

# ---- 远程执行函数 ----
remote_exec() { sshlib_exec "$1"; }

sshlib_init "${REMOTE_HOST}" "${SSH_PORT}"
sshlib_ensure_ready

echo ""
echo "==========================================="
echo "  OpenClaw QQ 消息通道配置"
echo "==========================================="
echo "目标主机:   ${REMOTE_HOST} (SSH 端口: ${SSH_PORT})"
echo "App ID:     ${APP_ID}"
echo "测试模式:   ${TEST_MODE}"
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

# ---- 预检：确认 QQBot 插件已安装 ----
echo "=== [预检] 确认 QQBot 插件已安装 ==="
QQBOT_PLUGIN=$(remote_exec 'openclaw plugins list 2>/dev/null | grep -i qqbot || echo "NOT_FOUND"')

if [[ "$QQBOT_PLUGIN" == *"NOT_FOUND"* ]]; then
  info "安装 QQBot 插件..."
  INSTALL_RESULT=$(remote_exec 'openclaw plugins install @tencent-connect/openclaw-qqbot 2>&1') || true

  if echo "$INSTALL_RESULT" | grep -qE "Installed|updated|already"; then
    pass "QQBot 插件安装成功"
  else
    warn "QQBot 插件安装可能失败，继续尝试配置..."
    echo "$INSTALL_RESULT"
  fi
else
  pass "QQBot 插件已安装"
fi
echo ""

# ---- 配置 QQBot Channel ----
echo "=== [步骤 1/3] 配置 QQBot Channel ==="
info "写入 QQBot token..."

# Base64 encode token for safe transmission
QQBOT_TOKEN_B64=$(printf '%s' "$QQBOT_TOKEN" | base64 | tr -d '\n')

QQBOT_RESULT="$(remote_exec "
  QQBOT_TOKEN_B64='${QQBOT_TOKEN_B64}'
  QQBOT_TOKEN=\$(printf %s \"\$QQBOT_TOKEN_B64\" | base64 -d)
  openclaw channels add --channel qqbot --token \"\$QQBOT_TOKEN\" 2>&1
" 2>&1)" || true

if echo "$QQBOT_RESULT" | grep -Eq "Added|Updated|already exists"; then
  pass "QQBot 配置写入成功"
else
  fail "QQBot 配置写入失败"
  echo "$QQBOT_RESULT"
fi
echo ""

# ---- 验证配置 ----
echo "=== [步骤 2/3] 验证配置 ==="
info "检查 QQBot 配置..."

QQBOT_VERIFY=$(remote_exec '
  openclaw config get channels.qqbot.appId 2>&1
' 2>&1) || true

if echo "$QQBOT_VERIFY" | grep -Fq "$APP_ID"; then
  pass "QQBot AppId 验证通过: ${APP_ID}"
else
  warn "QQBot AppId 验证结果: ${QQBOT_VERIFY}"
fi

# 检查 clientSecret 是否配置
SECRET_VERIFY=$(remote_exec '
  openclaw config get channels.qqbot.clientSecret 2>&1
' 2>&1) || true

if echo "$SECRET_VERIFY" | grep -qE "REDACTED|\*{4,}"; then
  pass "QQBot ClientSecret 已配置"
else
  warn "QQBot ClientSecret 验证结果: ${SECRET_VERIFY}"
fi
echo ""

# ---- 查看渠道状态 ----
echo "=== [步骤 3/3] 查看渠道状态 ==="
info "列出所有已配置的渠道..."

CHANNEL_LIST=$(remote_exec 'openclaw channels list 2>&1') || true
echo "$CHANNEL_LIST"
echo ""

# ---- 可选：测试消息 ----
if [ "$TEST_MODE" = true ]; then
  echo "=== [测试] 发送测试消息 ==="
  
  if [ -z "$TEST_TARGET" ]; then
    warn "未指定测试目标 (--test-target)，跳过测试"
  else
    info "向 ${TEST_TARGET} 发送测试消息..."
    
    TEST_RESULT=$(remote_exec "
      openclaw message send --channel qqbot --target '${TEST_TARGET}' --message 'OpenClaw QQBot 配置测试成功！' 2>&1
    " 2>&1) || true
    
    if echo "$TEST_RESULT" | grep -qE "sent|Sent|success"; then
      pass "测试消息发送成功"
    else
      fail "测试消息发送失败"
      echo "$TEST_RESULT"
    fi
  fi
  echo ""
fi

# ---- 结果汇总 ----
echo "==========================================="
if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}QQ 消息通道配置成功!${NC}"
  echo ""
  echo "下一步:"
  echo "  # 启动 Gateway"
  echo "  ssh -p ${SSH_PORT} ${REMOTE_HOST} 'openclaw gateway run'"
  echo ""
  echo "  # 查看渠道状态"
  echo "  ssh -p ${SSH_PORT} ${REMOTE_HOST} 'openclaw channels status --deep'"
  echo ""
  echo "  # 查看渠道日志"
  echo "  ssh -p ${SSH_PORT} ${REMOTE_HOST} 'openclaw channels logs --channel qqbot'"
  exit 0
else
  echo -e "${RED}${FAILURES} 个步骤失败${NC}"
  exit 1
fi
