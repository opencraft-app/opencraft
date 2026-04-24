#!/usr/bin/env bash
# =============================================================================
# LightClaw 镜像构建上传执行脚本（手动入口）
#
# 定义:
#   在本地构建 `envd` 二进制（基于官方 sandbox envd 源码），上传 `images/build.sh`
#   与二进制到远端，然后在远端目录执行镜像构建脚本。
#
# 角色:
#   - 这是 `images/` 目录的手动部署入口
#   - 依赖 `images/helpers/build-envd-agent.sh`
#   - 远端实际执行的核心脚本是 `images/build.sh`
#
# 参数定义:
#   <user@host>               必填，SSH 目标主机
#   --port <port>            可选，SSH 端口，默认 22
#   --remote-dir <path>      可选，远端工作目录，默认 /opt/lightclaw-image
#   --version <ver>          可选，传给 build.sh 的 openclaw 版本
#   --runtime <kind>         可选，运行时类型：openclaw | hermes
#   --envd-only              可选，仅安装 envd 及 systemd 服务
#   --upload-only            可选，仅上传构建材料，不在远端执行 build.sh
#   --skip-build-agent       可选，跳过本地构建，直接使用现有二进制
#   --agent-binary <path>    可选，指定本地二进制路径
#   --only-plugins <list>     可选，仅安装指定插件；默认镜像安装 qqbot,weixin
#   --qqbot-version <ver>     可选，指定 qqbot 插件版本，如 1.6.6
#   --weixin-version <ver>    可选，指定 weixin 插件版本，如 2.1.1
#   --skills <mode>           可选，skill 安装模式: essential | all | custom
#   --custom-skills <list>    可选，自定义 skill 列表
#   -h, --help               显示帮助
#
# 输出结果定义:
#   - 在远端创建工作目录并上传构建材料
#   - 在远端执行 build.sh
#   - stdout 打印关键步骤与远端路径
#   - 退出码 0 表示成功，非 0 表示失败
#
# 示例:
#   bash images/deploy-build.sh ubuntu@119.28.239.108
#   bash images/deploy-build.sh ubuntu@119.28.239.108 --version 2026.3.24
#   bash images/deploy-build.sh ubuntu@119.28.239.108 --app-only --only-plugins qqbot,weixin --qqbot-version 1.6.6 --weixin-version 2.1.1
#   bash images/deploy-build.sh ubuntu@119.28.239.108 --runtime hermes --app-only
# =============================================================================

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash images/deploy-build.sh <user@host> [options]

Description:
  Build the local envd binary, upload build materials to a remote
  host, and execute images/build.sh there.

Options:
  --port <port>            SSH port. Default: 22
  --remote-dir <path>      Remote working directory. Default: /opt/lightclaw-image
  --version <ver>          Optional openclaw version forwarded to build.sh
  --runtime <kind>         Runtime flavor: openclaw | hermes (default: openclaw)
  --envd-only              Install only the envd daemon and its systemd service
  --upload-only            Upload build materials only; do not execute build.sh remotely
  --base-only              Install only the system base layer (node, python, chromium, etc.)
  --app-only               Install only the application layer (openclaw, plugins, skills)
  --only-plugins <list>    Only install specified plugins (comma-separated). Default image installs qqbot,weixin
  --qqbot-version <ver>    Install qqbot with the specified version, for example 1.6.6
  --weixin-version <ver>   Install weixin with the specified version, for example 2.1.1
  --skills <mode>          Skill install mode: essential | all | custom (default: essential)
  --custom-skills <list>   Custom skills list (comma-separated, implies --skills custom)
  --skip-build-agent       Skip local envd build and reuse existing binary
  --agent-binary <path>    Local envd binary path. Default: images/bin/envd
  -h, --help               Show this help message

Outputs:
  Uploads build.sh and the envd agent binary to the target host, then runs build.sh remotely.

Examples:
  bash images/deploy-build.sh ubuntu@119.28.239.108
  bash images/deploy-build.sh ubuntu@119.28.239.108 --version 2026.3.24
  bash images/deploy-build.sh ubuntu@119.28.239.108 --envd-only
  bash images/deploy-build.sh ubuntu@119.28.239.108 --app-only --only-plugins qqbot,weixin
  bash images/deploy-build.sh ubuntu@119.28.239.108 --app-only --only-plugins qqbot,weixin --qqbot-version 1.6.6 --weixin-version 2.1.1
  bash images/deploy-build.sh ubuntu@119.28.239.108 --runtime hermes --app-only
  bash images/deploy-build.sh ubuntu@119.28.239.108 --app-only --skills all
EOF
}

log_info() { echo "INFO: $*"; }
log_error() { echo "ERROR: $*" >&2; }
log_warn() { echo "WARN: $*" >&2; }

SSH_PORT=22
REMOTE_DIR="/opt/lightclaw-image"
OPENCLAW_VERSION=""
RUNTIME_KIND="openclaw"
ENVD_ONLY=false
UPLOAD_ONLY=false
BASE_ONLY=false
APP_ONLY=false
ONLY_PLUGINS=""
QQBOT_VERSION=""
WEIXIN_VERSION=""
SKILLS_MODE=""
CUSTOM_SKILLS=""
SKIP_BUILD_AGENT=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPERS_DIR="${SCRIPT_DIR}/helpers"
LIB_DIR="${SCRIPT_DIR}/lib"
BUILD_SCRIPT="${SCRIPT_DIR}/build.sh"
BUILD_MANIFEST="${SCRIPT_DIR}/build-manifest.json"
RUNNER_SCRIPT="${SCRIPT_DIR}/remote-build-runner.sh"
BUILD_AGENT_SCRIPT="${HELPERS_DIR}/build-envd-agent.sh"
AGENT_BINARY="${SCRIPT_DIR}/bin/envd"
SSH_LIB="${LIB_DIR}/ssh.sh"
RUNTIME_DIR="${SCRIPT_DIR}/runtime"
WEIXIN_PROTOCOL_SCRIPT="${RUNTIME_DIR}/openclaw-weixin-login-session.sh"

if [ ! -f "${SSH_LIB}" ]; then
  log_error "ssh library not found: ${SSH_LIB}"
  exit 1
fi
# shellcheck source=/dev/null
source "${SSH_LIB}"

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
    --version)
      OPENCLAW_VERSION="$2"
      shift 2
      ;;
    --runtime)
      RUNTIME_KIND="$2"
      shift 2
      ;;
    --envd-only)
      ENVD_ONLY=true
      shift
      ;;
    --upload-only)
      UPLOAD_ONLY=true
      shift
      ;;
    --base-only)
      BASE_ONLY=true
      shift
      ;;
    --app-only)
      APP_ONLY=true
      shift
      ;;
    --only-plugins)
      ONLY_PLUGINS="$2"
      shift 2
      ;;
    --qqbot-version)
      QQBOT_VERSION="$2"
      shift 2
      ;;
    --weixin-version)
      WEIXIN_VERSION="$2"
      shift 2
      ;;
    --skills)
      SKILLS_MODE="$2"
      shift 2
      ;;
    --custom-skills)
      CUSTOM_SKILLS="$2"
      shift 2
      ;;
    --skip-build-agent)
      SKIP_BUILD_AGENT=true
      shift
      ;;
    --agent-binary)
      AGENT_BINARY="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_error "unknown argument: $1"
      usage >&2
      exit 1
      ;;
  esac
done

upload_file_via_ssh() {
  local local_path="$1"
  local remote_path="$2"

  log_info "uploading $(basename "${local_path}") -> ${remote_path}"
  if [ "${SSHLIB_REMOTE_USER:-}" = "root" ]; then
    sshlib_upload_file "${local_path}" "${remote_path}" false
    return $?
  fi
  sshlib_upload_file "${local_path}" "${remote_path}" true
}

if [ ! -f "${BUILD_SCRIPT}" ]; then
  log_error "build.sh not found: ${BUILD_SCRIPT}"
  exit 1
fi

if [ ! -f "${BUILD_MANIFEST}" ]; then
  log_error "build-manifest.json not found: ${BUILD_MANIFEST}"
  exit 1
fi

if [ ! -f "${RUNNER_SCRIPT}" ]; then
  log_error "remote-build-runner.sh not found: ${RUNNER_SCRIPT}"
  exit 1
fi

if [ ! -f "${WEIXIN_PROTOCOL_SCRIPT}" ]; then
  log_error "runtime protocol script not found: ${WEIXIN_PROTOCOL_SCRIPT}"
  exit 1
fi

if [ "${SKIP_BUILD_AGENT}" = false ]; then
  log_info "building local envd binary"
  bash "${BUILD_AGENT_SCRIPT}" --output "${AGENT_BINARY}"
fi

if [ ! -f "${AGENT_BINARY}" ]; then
  log_error "envd binary not found: ${AGENT_BINARY}"
  exit 1
fi

sshlib_init "${REMOTE_HOST}" "${SSH_PORT}"
sshlib_ensure_ready

log_info "ensuring remote directory exists: ${REMOTE_DIR}"
if [ "${SSHLIB_REMOTE_USER:-}" = "root" ]; then
  sshlib_run_raw_retry_transport_safe "mkdir -p '${REMOTE_DIR}/bin' '${REMOTE_DIR}/runtime'"
else
  sshlib_run_raw_retry_transport_safe "sudo mkdir -p '${REMOTE_DIR}/bin' '${REMOTE_DIR}/runtime'"
fi

log_info "uploading build assets"
upload_file_via_ssh "${BUILD_SCRIPT}" "${REMOTE_DIR}/build.sh"
upload_file_via_ssh "${BUILD_MANIFEST}" "${REMOTE_DIR}/build-manifest.json"
upload_file_via_ssh "${RUNNER_SCRIPT}" "${REMOTE_DIR}/remote-build-runner.sh"
upload_file_via_ssh "${AGENT_BINARY}" "${REMOTE_DIR}/bin/envd"
upload_file_via_ssh "${WEIXIN_PROTOCOL_SCRIPT}" "${REMOTE_DIR}/runtime/openclaw-weixin-login-session.sh"

if [ "${UPLOAD_ONLY}" = true ]; then
  log_info "upload-only mode finished host=${REMOTE_HOST} remote_dir=${REMOTE_DIR}"
  exit 0
fi

if [ "${SSHLIB_REMOTE_USER:-}" = "root" ]; then
  REMOTE_CMD="cd '${REMOTE_DIR}' && chmod +x build.sh bin/envd runtime/openclaw-weixin-login-session.sh && bash ./build.sh"
else
  REMOTE_CMD="sudo bash -lc 'cd ${REMOTE_DIR} && chmod +x build.sh bin/envd runtime/openclaw-weixin-login-session.sh && bash ./build.sh"
fi
if [ -n "${OPENCLAW_VERSION}" ]; then
  REMOTE_CMD="${REMOTE_CMD} '${OPENCLAW_VERSION}'"
fi
if [ "${RUNTIME_KIND}" != "openclaw" ]; then
  REMOTE_CMD="${REMOTE_CMD} --runtime '${RUNTIME_KIND}'"
fi
if [ "${ENVD_ONLY}" = true ]; then
  REMOTE_CMD="${REMOTE_CMD} --envd-only"
fi
if [ "${BASE_ONLY}" = true ]; then
  REMOTE_CMD="${REMOTE_CMD} --base-only"
fi
if [ "${APP_ONLY}" = true ]; then
  REMOTE_CMD="${REMOTE_CMD} --app-only"
fi
if [ -n "${ONLY_PLUGINS}" ]; then
  REMOTE_CMD="${REMOTE_CMD} --only-plugins '${ONLY_PLUGINS}'"
fi
if [ -n "${QQBOT_VERSION}" ]; then
  REMOTE_CMD="${REMOTE_CMD} --qqbot-version '${QQBOT_VERSION}'"
fi
if [ -n "${WEIXIN_VERSION}" ]; then
  REMOTE_CMD="${REMOTE_CMD} --weixin-version '${WEIXIN_VERSION}'"
fi
if [ -n "${SKILLS_MODE}" ]; then
  REMOTE_CMD="${REMOTE_CMD} --skills '${SKILLS_MODE}'"
fi
if [ -n "${CUSTOM_SKILLS}" ]; then
  REMOTE_CMD="${REMOTE_CMD} --custom-skills '${CUSTOM_SKILLS}'"
fi
if [ "${SSHLIB_REMOTE_USER:-}" != "root" ]; then
  REMOTE_CMD="${REMOTE_CMD}'"
fi

log_info "executing remote build"
sshlib_run_raw_tty "${REMOTE_CMD}"

log_info "remote build finished host=${REMOTE_HOST} remote_dir=${REMOTE_DIR}"
