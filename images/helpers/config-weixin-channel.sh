#!/usr/bin/env bash
# =============================================================================
# OpenClaw 微信消息通道配置脚本
#
# 在远程服务器上执行微信插件登录，终端中直接展示二维码，扫码成功后重启 gateway。
#
# 用法:
#   bash config-weixin-channel.sh <user@host> [--port PORT] [选项]
#
# 示例:
#   bash config-weixin-channel.sh root@119.28.239.108 --port 36000
#   bash config-weixin-channel.sh root@119.28.239.108 --port 36000 --no-restart
#
# 输出结果:
#   stdout: 打印预检结果、登录过程和后续建议；二维码由远程 openclaw 原样输出到当前终端
#   exit 0: 登录成功，且按配置完成 gateway restart
#   exit 1: 参数错误、远程命令失败或登录未完成
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
  bash config-weixin-channel.sh <user@host> [选项]

说明:
  在远程主机上执行 OpenClaw 微信渠道登录。
  脚本会先确认插件已安装并启用，然后以交互式 SSH 执行：
    openclaw channels login --channel openclaw-weixin
  该命令会在终端中直接输出二维码，扫码成功后默认执行：
    openclaw gateway restart

输出结果:
  stdout: 预检结果、二维码登录提示、gateway 重启结果
  exit 0: 登录成功
  exit 1: 参数缺失、环境缺失、登录失败或重启失败

选项:
  --port PORT        SSH 端口，默认 22
  --no-restart       扫码成功后不自动重启 gateway
  --skip-plugin-fix  若插件缺失或未启用，只报错，不自动修复
  -h, --help         显示帮助

示例:
  bash config-weixin-channel.sh root@119.28.239.108 --port 36000
  bash config-weixin-channel.sh root@119.28.239.108 --port 36000 --no-restart
EOF
}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; }
info() { echo -e "${CYAN}▸ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }

SSH_PORT=22
AUTO_RESTART=true
SKIP_PLUGIN_FIX=false

REMOTE_HOST="${1:-}"

if [ "${REMOTE_HOST:-}" = "-h" ] || [ "${REMOTE_HOST:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ -z "$REMOTE_HOST" ] || [[ "$REMOTE_HOST" == -* ]]; then
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
    --no-restart)
      AUTO_RESTART=false
      shift
      ;;
    --skip-plugin-fix)
      SKIP_PLUGIN_FIX=true
      shift
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

remote_exec() { sshlib_exec "$1"; }

sshlib_init "${REMOTE_HOST}" "${SSH_PORT}"
sshlib_ensure_ready

echo ""
echo "==========================================="
echo "  OpenClaw 微信消息通道登录"
echo "==========================================="
echo "目标主机:   ${REMOTE_HOST} (SSH 端口: ${SSH_PORT})"
echo "自动重启:   ${AUTO_RESTART}"
echo "==========================================="
echo ""

echo "=== [预检] 确认 openclaw 已安装 ==="
if remote_exec 'command -v openclaw >/dev/null 2>&1 && openclaw --version | head -1'; then
  pass "openclaw 已安装"
else
  fail "openclaw 未安装或不在 PATH 中"
  echo "请先运行: bash images/deploy-build.sh ${REMOTE_HOST} --port ${SSH_PORT}"
  exit 1
fi
echo ""

echo "=== [预检] 确认微信插件已安装并启用 ==="
PLUGIN_LIST=$(remote_exec 'openclaw plugins list 2>/dev/null || true')
PLUGIN_ENABLED=$(remote_exec 'openclaw config get plugins.entries.openclaw-weixin.enabled 2>/dev/null || true')

if echo "$PLUGIN_LIST" | grep -qi "openclaw-weixin"; then
  pass "微信插件已安装"
else
  if [ "$SKIP_PLUGIN_FIX" = true ]; then
    fail "微信插件未安装"
    echo "镜像构建阶段应预装: openclaw plugins install \"@tencent-weixin/openclaw-weixin\""
    exit 1
  fi

  warn "微信插件未安装，尝试远程补装"
  if remote_exec 'openclaw plugins install "@tencent-weixin/openclaw-weixin"'; then
    pass "微信插件补装成功"
  else
    fail "微信插件补装失败"
    exit 1
  fi
fi

if echo "$PLUGIN_ENABLED" | grep -Eiq '^(true|1)$'; then
  pass "微信插件已启用"
else
  if [ "$SKIP_PLUGIN_FIX" = true ]; then
    fail "微信插件未启用"
    echo "镜像构建阶段应写入: openclaw config set plugins.entries.openclaw-weixin.enabled true"
    exit 1
  fi

  warn "微信插件未启用，尝试远程修复"
  if remote_exec 'openclaw config set plugins.entries.openclaw-weixin.enabled true'; then
    pass "微信插件启用成功"
  else
    fail "微信插件启用失败"
    exit 1
  fi
fi
echo ""

echo "=== [步骤 1/2] 执行微信扫码登录 ==="
info "二维码会直接显示在下面的 SSH 终端输出中，请完成扫码。"
if ! sshlib_exec_tty 'openclaw channels login --channel openclaw-weixin'; then
  fail "微信扫码登录失败或未完成"
  exit 1
fi
pass "微信扫码登录成功"
echo ""

if [ "$AUTO_RESTART" = true ]; then
  echo "=== [步骤 2/2] 重启 gateway ==="
  if remote_exec 'openclaw gateway restart'; then
    pass "gateway 重启成功"
  else
    fail "gateway 重启失败"
    exit 1
  fi
  echo ""
fi

echo "==========================================="
echo -e "${GREEN}微信消息通道登录完成!${NC}"
echo ""
echo "后续命令:"
echo "  ssh -p ${SSH_PORT} ${REMOTE_HOST} 'openclaw channels status --deep'"
echo "  ssh -p ${SSH_PORT} ${REMOTE_HOST} 'openclaw channels logs --channel openclaw-weixin'"
exit 0
