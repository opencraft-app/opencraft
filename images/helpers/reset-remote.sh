#!/usr/bin/env bash
# =============================================================================
# LightClaw 远端轻量重置脚本（辅助脚本）
#
# 定义:
#   在不重装操作系统的前提下，清理 LightClaw 镜像构建相关产物，方便重新验证：
#   - 停止并移除 `envd` systemd 服务（兼容清理旧版 lightclaw-envd-agent）
#   - 停止 openclaw gateway 用户服务
#   - 可选删除 openclaw 配置、pnpm 全局包与远端工作目录
#
# 角色:
#   - 非主入口
#   - 供联调和回归前清理使用
#
# 参数定义:
#   <user@host>               必填，SSH 目标主机
#   --port <port>            可选，SSH 端口，默认 22
#   --remote-dir <path>      可选，要清理的远端工作目录，默认 /root/lightclaw-image
#   --purge-openclaw         可选，删除 ~/.openclaw 与 openclaw/clawhub 全局包
#   --keep-binary            可选，保留 /usr/local/bin/envd
#   -h, --help               显示帮助
#
# 输出结果定义:
#   - stdout 打印重置步骤
#   - 退出码 0 表示成功，非 0 表示失败
#
# 示例:
#   bash images/helpers/reset-remote.sh root@119.28.239.108 --port 36000
#   bash images/helpers/reset-remote.sh root@119.28.239.108 --port 36000 --purge-openclaw
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
Usage:
  bash images/helpers/reset-remote.sh <user@host> [options]

Description:
  Reset remote LightClaw image build artifacts without reinstalling the OS.

Options:
  --port <port>         SSH port. Default: 22
  --remote-dir <path>   Remote workdir to clean. Default: /root/lightclaw-image
  --purge-openclaw      Remove ~/.openclaw and global openclaw/clawhub packages
  --keep-binary         Keep /usr/local/bin/envd
  -h, --help            Show this help message

Outputs:
  Stops services, removes selected artifacts, and prints the performed actions.

Examples:
  bash images/helpers/reset-remote.sh root@119.28.239.108 --port 36000
  bash images/helpers/reset-remote.sh root@119.28.239.108 --port 36000 --purge-openclaw
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
REMOTE_DIR="/root/lightclaw-image"
PURGE_OPENCLAW=false
KEEP_BINARY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      SSH_PORT="$2"
      shift 2
      ;;
    --remote-dir)
      REMOTE_DIR="$2"
      shift 2
      ;;
    --purge-openclaw)
      PURGE_OPENCLAW=true
      shift
      ;;
    --keep-binary)
      KEEP_BINARY=true
      shift
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
  sshlib_exec "$1"
}

sshlib_init "${REMOTE_HOST}" "${SSH_PORT}"
sshlib_ensure_ready

echo "INFO: stopping envd services (new + legacy)"
remote_exec "systemctl disable --now envd.service >/dev/null 2>&1 || true"
remote_exec "rm -f /etc/systemd/system/envd.service"
remote_exec "systemctl disable --now lightclaw-envd-agent.service >/dev/null 2>&1 || true"
remote_exec "rm -f /etc/systemd/system/lightclaw-envd-agent.service && systemctl daemon-reload"

if [ "${KEEP_BINARY}" = false ]; then
  echo "INFO: removing envd binaries"
  remote_exec "rm -f /usr/local/bin/envd /usr/local/bin/lightclaw-envd-agent"
fi

echo "INFO: stopping openclaw gateway user service"
remote_exec "systemctl --user disable --now openclaw-gateway.service >/dev/null 2>&1 || true"

echo "INFO: removing remote workdir ${REMOTE_DIR}"
remote_exec "rm -rf '${REMOTE_DIR}'"

if [ "${PURGE_OPENCLAW}" = true ]; then
  echo "INFO: purging openclaw config and global packages"
  remote_exec "rm -rf /root/.openclaw"
  remote_exec "export PNPM_HOME=\"\${PNPM_HOME:-/root/.local/share/pnpm}\"; export PATH=\"\$PNPM_HOME:\$PATH\"; pnpm remove -g openclaw clawhub >/dev/null 2>&1 || true"
fi

echo "INFO: remote reset complete host=${REMOTE_HOST}"
