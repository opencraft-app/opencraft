#!/usr/bin/env bash
# =============================================================================
# LightClaw 镜像远端构建脚本
#
# 定义:
#   在 Ubuntu 24.04 LTS x86_64 实例内安装 LightClaw/OpenClaw 运行环境，
#   支持基础层、应用层和全量构建三种模式。
#
# 参数定义:
#   [openclaw_version]         可选，OpenClaw 版本；默认从 build-manifest.json 读取
#   --runtime <kind>           openclaw | hermes，默认 openclaw
#   --hermes-version <ver>     Hermes COS 版本；默认从 runtime_hermes.cos_base/latest.json 读取
#   --hermes-src-version <ver> Hermes 源码版本；默认从 latest.json 或 COS 包 pyproject.toml 读取
#   --envd-only                仅安装 envd
#   --base-only                仅安装基础层（Node/Python/Playwright/系统依赖）
#   --app-only                 仅安装应用层（OpenClaw/plugins/skills/gateway）
#   --only-plugins <list>      仅安装指定插件（逗号分隔）
#   --qqbot-version <ver>      指定 qqbot 插件版本；默认从 build-manifest.json 读取
#   --weixin-version <ver>     指定 weixin 插件版本；默认从 build-manifest.json 读取
#   --skills <mode>            essential | all | custom
#   --custom-skills <list>     自定义 skill 列表（逗号分隔）
#   -h, --help                 显示帮助
#
# 输出结果定义:
#   - 安装系统级 Node/OpenClaw 运行时
#   - 安装并启用 envd 与 openclaw-gateway 官方 systemd user service
#   - 清理镜像打包前的临时文件和缓存
#
# 示例:
#   bash build.sh
#   bash build.sh --base-only
#   bash build.sh --app-only --only-plugins qqbot,weixin --qqbot-version 1.6.6 --weixin-version 2.1.1
# =============================================================================

set -euo pipefail

OPENCLAW_VERSION=""
DEFAULT_OPENCLAW_VERSION=""
DEFAULT_QQBOT_VERSION=""
DEFAULT_WEIXIN_VERSION=""
HERMES_INSTALL_SCRIPT_URL=""
HERMES_INSTALL_ARGS=""
HERMES_QWEN_CODE_VERSION=""
HERMES_RUNTIME_USER=""
HERMES_NODE_MAJOR=""
HERMES_COS_BASE=""
HERMES_VERSION=""
HERMES_SRC_VERSION=""
HERMES_GIT_COMMIT=""
HERMES_ACLI_INSTALL_URL=""
HERMES_BACKEND_BLUEPRINT_ID="${HERMES_BACKEND_BLUEPRINT_ID:-}"
HERMES_SOURCE_CACHE_DIR="${HERMES_SOURCE_CACHE_DIR:-/var/cache/lightclaw/hermes}"
HERMES_SOURCE_TARBALL_CACHE=""
HERMES_SYSTEM_BIN_DIR="${HERMES_SYSTEM_BIN_DIR:-/usr/local/bin}"
HERMES_SYSTEM_LINK_DIR="${HERMES_SYSTEM_LINK_DIR:-/usr/bin}"
HERMES_WHATSAPP_BRIDGE_USER="${HERMES_WHATSAPP_BRIDGE_USER:-}"
HERMES_WHATSAPP_BRIDGE_HOME="${HERMES_WHATSAPP_BRIDGE_HOME:-}"
HERMES_PYPI_INDEX_URL="${HERMES_PYPI_INDEX_URL:-https://mirrors.tencent.com/pypi/simple}"
HERMES_PYPI_EXTRA_INDEX_URL="${HERMES_PYPI_EXTRA_INDEX_URL:-https://mirrors.cloud.tencent.com/pypi/simple}"
HERMES_LIGHTCLAWBOT_PACKAGE="${HERMES_LIGHTCLAWBOT_PACKAGE:-lightclawbot}"
HERMES_LIGHTCLAW_ALLOW_ALL_USERS="${HERMES_LIGHTCLAW_ALLOW_ALL_USERS:-true}"
ACLI_IDENTITY_PATH="${ACLI_IDENTITY_PATH:-/etc/acli/identity.yaml}"
HERMES_UV_CMD=""
NODE_VERSION=""
PNPM_VERSION=""
PLAYWRIGHT_VERSION=""
PYTHON_VENV_PATH=""
PLAYWRIGHT_BROWSERS_PATH=""
GATEWAY_PORT=""
NPM_REGISTRY=""
NODE_TARBALL_URL=""
SKILLHUB_INSTALL_URL=""
HERMES_ENV_PROFILE_PATH="${HERMES_ENV_PROFILE_PATH:-/etc/profile.d/hermes-env.sh}"

ENVD_ONLY=false
BASE_ONLY=false
APP_ONLY=false
RUNTIME_KIND="${RUNTIME_KIND:-openclaw}"
OPTIONAL_PLUGINS="${OPTIONAL_PLUGINS:-}"
ONLY_PLUGINS="${ONLY_PLUGINS:-}"
QQBOT_VERSION="${QQBOT_VERSION:-}"
WEIXIN_VERSION="${WEIXIN_VERSION:-}"
SKILLS_MODE="essential"
CUSTOM_SKILLS="${CUSTOM_SKILLS:-}"
ARG_HERMES_VERSION="${ARG_HERMES_VERSION:-}"
ARG_HERMES_SRC_VERSION="${ARG_HERMES_SRC_VERSION:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
MANIFEST_PATH="${SCRIPT_DIR}/build-manifest.json"
HERMES_BACKEND_BLUEPRINT_RESOLVER="${HERMES_BACKEND_BLUEPRINT_RESOLVER:-${SCRIPT_DIR}/helpers/resolve-hermes-backend-blueprint-id.py}"
ENVD_BINARY="/usr/local/bin/envd"
ENVD_SERVICE="envd.service"
ENVD_LISTEN_PORT="${ENVD_LISTEN_PORT:-49983}"
ENVD_LOCAL_BINARY="${ENVD_LOCAL_BINARY:-${SCRIPT_DIR}/bin/envd}"
RUNTIME_ASSETS_DIR="${SCRIPT_DIR}/runtime"
NODE_INSTALL_DIR=""
NODE_BIN_DIR=""
NPM_GLOBAL_PREFIX="/usr/local"
APT_UPDATED=false
APT_LOCK_TIMEOUT_SECONDS="${APT_LOCK_TIMEOUT_SECONDS:-300}"
LIGHTCLAW_RUNTIME_USER="${LIGHTCLAW_RUNTIME_USER:-lightclaw}"
RUNTIME_USER="${LIGHTCLAW_RUNTIME_USER}"
RUNTIME_HOME=""

usage() {
  cat <<'EOF'
Usage:
  bash build.sh [openclaw_version] [options]

Description:
  Build the LightClaw image runtime on Ubuntu 24.04 LTS x86_64.

Options:
  --envd-only              Install only envd and its systemd service
  --base-only              Install only the base layer
  --app-only               Install only the application layer
  --runtime <kind>         Runtime flavor: openclaw | hermes (default: openclaw)
  --hermes-version <ver>   Hermes COS version, for example hermes-agent-v20260520 (default: latest.json)
  --hermes-src-version <ver>
                           Hermes source version resolved from latest.json
  --only-plugins <list>    Only install the specified plugins (comma-separated)
  --qqbot-version <ver>    QQBot plugin version (default: build-manifest.json runtime.qqbot_version)
  --weixin-version <ver>   Weixin plugin version (default: build-manifest.json runtime.weixin_version)
  --skills <mode>          essential | all | custom
  --custom-skills <list>   Custom skills list (comma-separated, implies custom)
  -h, --help               Show this help message

Outputs:
  Installs system-level Node/OpenClaw binaries, prepares Python/Playwright,
  enables envd and openclaw-gateway services, and leaves the machine ready
  for image creation.

Examples:
  bash build.sh
  bash build.sh --base-only
  bash build.sh 2026.3.24 --app-only --only-plugins qqbot,weixin --qqbot-version 1.6.6 --weixin-version 2.1.1
EOF
}

log_info() { echo "INFO: $*"; }
log_warn() { echo "WARN: $*" >&2; }
log_error() { echo "ERROR: $*" >&2; }

load_manifest_defaults() {
  if [ ! -f "${MANIFEST_PATH}" ]; then
    log_error "build manifest not found: ${MANIFEST_PATH}"
    exit 1
  fi

  eval "$(
    python3 - "${MANIFEST_PATH}" <<'PY'
import json
import shlex
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

runtime = data.get("runtime", {})
artifacts = data.get("artifacts", {})
values = {
    "DEFAULT_OPENCLAW_VERSION": runtime.get("openclaw_version", ""),
    "DEFAULT_QQBOT_VERSION": runtime.get("qqbot_version", ""),
    "DEFAULT_WEIXIN_VERSION": runtime.get("weixin_version", ""),
    "HERMES_INSTALL_SCRIPT_URL": data.get("runtime_hermes", {}).get("install_script_url", ""),
    "HERMES_INSTALL_ARGS": data.get("runtime_hermes", {}).get("install_args", ""),
    "HERMES_QWEN_CODE_VERSION": data.get("runtime_hermes", {}).get("qwen_code_version", ""),
    "HERMES_RUNTIME_USER": data.get("runtime_hermes", {}).get("runtime_user", ""),
    "HERMES_NODE_MAJOR": str(data.get("runtime_hermes", {}).get("node_major", "")),
    "HERMES_COS_BASE": data.get("runtime_hermes", {}).get("cos_base", ""),
    "HERMES_VERSION": data.get("runtime_hermes", {}).get("version", ""),
    "HERMES_SRC_VERSION": data.get("runtime_hermes", {}).get("src_version", ""),
    "HERMES_GIT_COMMIT": data.get("runtime_hermes", {}).get("git_commit", ""),
    "HERMES_LIGHTCLAW_ALLOW_ALL_USERS": str(data.get("runtime_hermes", {}).get("lightclaw_allow_all_users", True)).lower(),
    "HERMES_ACLI_INSTALL_URL": data.get("runtime_hermes", {}).get("acli_install_url", ""),
    "NODE_VERSION": runtime.get("node_version", ""),
    "PNPM_VERSION": runtime.get("pnpm_version", ""),
    "PLAYWRIGHT_VERSION": runtime.get("playwright_version", ""),
    "PYTHON_VENV_PATH": runtime.get("python_venv_path", ""),
    "PLAYWRIGHT_BROWSERS_PATH": runtime.get("playwright_browsers_path", ""),
    "GATEWAY_PORT": str(runtime.get("gateway_port", "")),
    "NODE_TARBALL_URL": artifacts.get("node_tarball_url", ""),
    "NPM_REGISTRY": artifacts.get("npm_registry", ""),
    "SKILLHUB_INSTALL_URL": artifacts.get("skillhub_install_url", ""),
}
for key, value in values.items():
    print(f"{key}={shlex.quote(str(value))}")
PY
  )"
}

validate_manifest_defaults() {
  local missing=0
  local key=""
  for key in \
    DEFAULT_OPENCLAW_VERSION DEFAULT_QQBOT_VERSION DEFAULT_WEIXIN_VERSION \
    NODE_VERSION PNPM_VERSION PLAYWRIGHT_VERSION PYTHON_VENV_PATH \
    PLAYWRIGHT_BROWSERS_PATH GATEWAY_PORT NPM_REGISTRY SKILLHUB_INSTALL_URL; do
    if [ -z "${!key}" ]; then
      log_error "missing required manifest value: ${key}"
      missing=1
    fi
  done
  if [ "${missing}" -ne 0 ]; then
    exit 1
  fi
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_error "build.sh must run as root"
    exit 1
  fi
}

parse_version() {
  local placeholder='{{'"openclawVersion"'}}'

  if [ -n "${1:-}" ]; then
    OPENCLAW_VERSION="$1"
  else
    OPENCLAW_VERSION="{{openclawVersion}}"
  fi

  if [ "${OPENCLAW_VERSION}" = "${placeholder}" ] || [ -z "${OPENCLAW_VERSION}" ]; then
    OPENCLAW_VERSION="${DEFAULT_OPENCLAW_VERSION}"
  fi
}

parse_args() {
  local version_arg=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --runtime)
        RUNTIME_KIND="$2"
        shift 2
        ;;
      --hermes-version)
        ARG_HERMES_VERSION="$2"
        shift 2
        ;;
      --hermes-src-version)
        ARG_HERMES_SRC_VERSION="$2"
        shift 2
        ;;
      --envd-only)
        ENVD_ONLY=true
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
      --optional-plugins)
        OPTIONAL_PLUGINS="$2"
        shift 2
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
        SKILLS_MODE="custom"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      -*)
        log_error "unknown argument: $1"
        exit 1
        ;;
      *)
        if [ -n "${version_arg}" ]; then
          log_error "multiple version arguments provided: ${version_arg} $1"
          exit 1
        fi
        version_arg="$1"
        shift
        ;;
    esac
  done

  if [ "${BASE_ONLY}" = true ] && [ "${APP_ONLY}" = true ]; then
    log_error "--base-only and --app-only cannot be used together"
    exit 1
  fi

  if [ -n "${ONLY_PLUGINS}" ] && [ -n "${OPTIONAL_PLUGINS}" ]; then
    log_error "--only-plugins and --optional-plugins cannot be used together"
    exit 1
  fi

  if [ "${RUNTIME_KIND}" != "openclaw" ] && [ "${RUNTIME_KIND}" != "hermes" ]; then
    log_error "unsupported runtime: ${RUNTIME_KIND}"
    exit 1
  fi

  if [ "${RUNTIME_KIND}" = "hermes" ] && { [ -n "${ONLY_PLUGINS}" ] || [ -n "${OPTIONAL_PLUGINS}" ] || [ -n "${CUSTOM_SKILLS}" ] || [ "${SKILLS_MODE}" != "essential" ]; }; then
    log_error "hermes runtime does not support openclaw plugin or skill options"
    exit 1
  fi

  parse_version "${version_arg}"

  if [ -z "${QQBOT_VERSION}" ]; then
    QQBOT_VERSION="${DEFAULT_QQBOT_VERSION}"
  fi
  if [ -z "${WEIXIN_VERSION}" ]; then
    WEIXIN_VERSION="${DEFAULT_WEIXIN_VERSION}"
  fi

  if [ "${RUNTIME_KIND}" = "hermes" ] && [ -n "${HERMES_RUNTIME_USER}" ] && [ "${LIGHTCLAW_RUNTIME_USER:-lightclaw}" = "lightclaw" ]; then
    RUNTIME_USER="${HERMES_RUNTIME_USER}"
  fi
  if [ "${RUNTIME_KIND}" = "hermes" ] && [ -n "${ARG_HERMES_VERSION}" ]; then
    HERMES_VERSION="${ARG_HERMES_VERSION}"
  fi
  if [ "${RUNTIME_KIND}" = "hermes" ] && [ -n "${ARG_HERMES_SRC_VERSION}" ]; then
    HERMES_SRC_VERSION="${ARG_HERMES_SRC_VERSION}"
  fi
}

validate_platform() {
  local arch
  arch="$(uname -m)"
  if [ "${arch}" != "x86_64" ]; then
    log_error "unsupported architecture: ${arch} (expected x86_64)"
    exit 1
  fi

  if [ ! -f /etc/os-release ]; then
    log_error "/etc/os-release not found"
    exit 1
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ]; then
    log_error "unsupported distro: ${ID:-unknown} (expected ubuntu)"
    exit 1
  fi
}

apt_update_once() {
  if [ "${APT_UPDATED}" = false ]; then
    export DEBIAN_FRONTEND=noninteractive
    local attempt
    for attempt in 1 2 3 4 5; do
      if apt-get \
        -o DPkg::Lock::Timeout="${APT_LOCK_TIMEOUT_SECONDS}" \
        update \
        -o Acquire::Retries=3; then
        APT_UPDATED=true
        return 0
      fi
      log_warn "apt-get update failed (attempt ${attempt}/5), retrying"
      rm -rf /var/lib/apt/lists/partial/*
      sleep 5
    done
    log_error "apt-get update failed after retries"
    return 1
  fi
}

apt_install() {
  apt_update_once
  export DEBIAN_FRONTEND=noninteractive
  local attempt
  for attempt in 1 2 3 4 5; do
    if apt-get \
      -o DPkg::Lock::Timeout="${APT_LOCK_TIMEOUT_SECONDS}" \
      install -y --no-install-recommends "$@"; then
      return 0
    fi
    log_warn "apt-get install failed (attempt ${attempt}/5), retrying"
    sleep 5
  done
  log_error "apt-get install failed after retries: $*"
  return 1
}

setup_user() {
  local username="$1"
  if id "${username}" >/dev/null 2>&1; then
    return 0
  fi

  log_info "creating user ${username}"
  useradd -m -s /bin/bash "${username}"
  chage -M 99999 "${username}" || true
  echo "${username} ALL=(ALL) NOPASSWD: ALL" >/etc/sudoers.d/90-"${username}"
  chmod 0440 /etc/sudoers.d/90-"${username}"
}

resolve_runtime_home() {
  local home_dir=""
  home_dir="$(getent passwd "${RUNTIME_USER}" | cut -d: -f6)"
  if [ -z "${home_dir}" ]; then
    log_error "failed to resolve home directory for runtime user: ${RUNTIME_USER}"
    exit 1
  fi
  RUNTIME_HOME="${home_dir}"
}

run_as_runtime_user() {
  local cmd="$1"
  sudo -u "${RUNTIME_USER}" -H bash -lc "${cmd}"
}

ensure_runtime_user_ssh_access() {
  local bootstrap_user="${SUDO_USER:-}"
  local source_keys=""
  local user_keys="${RUNTIME_HOME}/.ssh/authorized_keys"

  mkdir -p "${RUNTIME_HOME}/.ssh"
  chmod 700 "${RUNTIME_HOME}/.ssh"

  if [ -n "${bootstrap_user}" ] && [ "${bootstrap_user}" != "${RUNTIME_USER}" ]; then
    if [ -f "/home/${bootstrap_user}/.ssh/authorized_keys" ]; then
      source_keys="/home/${bootstrap_user}/.ssh/authorized_keys"
    fi
  fi

  if [ -z "${source_keys}" ] && [ -f /home/ubuntu/.ssh/authorized_keys ]; then
    source_keys="/home/ubuntu/.ssh/authorized_keys"
  fi

  if [ -n "${source_keys}" ]; then
    touch "${user_keys}"
    if [ "${source_keys}" != "${user_keys}" ]; then
      cat "${source_keys}" >> "${user_keys}"
    fi
    sort -u "${user_keys}" -o "${user_keys}"
    chmod 600 "${user_keys}"
    chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${RUNTIME_HOME}/.ssh"
  fi
}

configure_runtime_profile() {
  cat >/etc/profile.d/lightclaw-runtime.sh <<EOF
export PATH="/usr/local/bin:/usr/bin:/bin:\$PATH"
EOF
  if [ "${RUNTIME_KIND}" = "openclaw" ]; then
    cat >>/etc/profile.d/lightclaw-runtime.sh <<EOF
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH}"
EOF
  fi
  chmod 0644 /etc/profile.d/lightclaw-runtime.sh
}

ensure_global_bin_links() {
  local bin_name
  for bin_name in node npm npx corepack pnpm openclaw clawhub agent-browser openclaw-weixin-login-session qwen hermes hermes-agent acli; do
    if [ -e "/usr/local/bin/${bin_name}" ]; then
      ln -sfn "/usr/local/bin/${bin_name}" "/usr/bin/${bin_name}"
    fi
  done
}

install_runtime_protocol_scripts() {
  local source_script="${RUNTIME_ASSETS_DIR}/openclaw-weixin-login-session.sh"
  local target_script="/usr/local/bin/openclaw-weixin-login-session"

  if [ ! -f "${source_script}" ]; then
    log_error "runtime protocol script not found: ${source_script}"
    return 1
  fi

  install -m 0755 "${source_script}" "${target_script}"
  ln -sfn "${target_script}" "/usr/bin/openclaw-weixin-login-session"
}

install_openclaw_runtime_wrapper() {
  local tool_name="$1"
  local real_bin="$2"

  rm -f "/usr/local/bin/${tool_name}" "/usr/bin/${tool_name}"
  cat >"/usr/local/bin/${tool_name}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}"
mkdir -p "\${XDG_RUNTIME_DIR}" 2>/dev/null || true
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "\$(id -un)" >/dev/null 2>&1 || true
fi
export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=\${XDG_RUNTIME_DIR}/bus}"
if [ "${tool_name}" = "openclaw" ] && [ -z "\${NODE_OPTIONS:-}" ]; then
  detect_openclaw_total_memory_mb() {
    local proc_kb cgroup_raw cgroup_kb
    proc_kb="\$(awk '/MemTotal:/ {print \$2}' /proc/meminfo 2>/dev/null || echo 0)"
    cgroup_raw=""
    if [ -r /sys/fs/cgroup/memory.max ]; then
      cgroup_raw="\$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"
    elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
      cgroup_raw="\$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)"
    fi

    cgroup_kb=0
    if [[ "\${cgroup_raw}" =~ ^[0-9]+$ ]] && [ "\${cgroup_raw}" -gt 0 ] && [ "\${cgroup_raw}" -lt 9223372036854771712 ]; then
      cgroup_kb=\$((cgroup_raw / 1024))
    fi

    if [ "\${cgroup_kb}" -gt 0 ] && { [ "\${proc_kb}" -eq 0 ] || [ "\${cgroup_kb}" -lt "\${proc_kb}" ]; }; then
      echo \$((cgroup_kb / 1024))
      return
    fi

    if [ "\${proc_kb}" -gt 0 ]; then
      echo \$((proc_kb / 1024))
      return
    fi

    echo 0
  }

  compute_openclaw_heap_mb() {
    local explicit_mb ratio min_mb cap_mb total_mb candidate_mb hard_ceiling_mb

    explicit_mb="\${OPENCLAW_MAX_OLD_SPACE_SIZE_MB:-}"
    if [[ "\${explicit_mb}" =~ ^[0-9]+$ ]] && [ "\${explicit_mb}" -gt 0 ]; then
      echo "\${explicit_mb}"
      return
    fi

    ratio="\${OPENCLAW_MAX_OLD_SPACE_SIZE_PERCENT:-50}"
    if ! [[ "\${ratio}" =~ ^[0-9]+$ ]] || [ "\${ratio}" -le 0 ] || [ "\${ratio}" -ge 100 ]; then
      ratio=50
    fi

    min_mb="\${OPENCLAW_MAX_OLD_SPACE_SIZE_MIN_MB:-1024}"
    if ! [[ "\${min_mb}" =~ ^[0-9]+$ ]] || [ "\${min_mb}" -le 0 ]; then
      min_mb=1024
    fi

    cap_mb="\${OPENCLAW_MAX_OLD_SPACE_SIZE_CAP_MB:-8192}"
    if ! [[ "\${cap_mb}" =~ ^[0-9]+$ ]] || [ "\${cap_mb}" -lt 0 ]; then
      cap_mb=8192
    fi

    total_mb="\$(detect_openclaw_total_memory_mb)"
    if ! [[ "\${total_mb}" =~ ^[0-9]+$ ]] || [ "\${total_mb}" -le 0 ]; then
      echo "\${min_mb}"
      return
    fi

    candidate_mb=\$((total_mb * ratio / 100))
    if [ "\${candidate_mb}" -lt "\${min_mb}" ]; then
      candidate_mb="\${min_mb}"
    fi

    if [ "\${cap_mb}" -gt 0 ] && [ "\${candidate_mb}" -gt "\${cap_mb}" ]; then
      candidate_mb="\${cap_mb}"
    fi

    if [ "\${total_mb}" -gt 512 ]; then
      hard_ceiling_mb=\$((total_mb - 256))
    else
      hard_ceiling_mb="\${total_mb}"
    fi
    if [ "\${hard_ceiling_mb}" -lt 256 ]; then
      hard_ceiling_mb=256
    fi
    if [ "\${candidate_mb}" -gt "\${hard_ceiling_mb}" ]; then
      candidate_mb="\${hard_ceiling_mb}"
    fi
    if [ "\${candidate_mb}" -lt 256 ]; then
      candidate_mb=256
    fi

    echo "\${candidate_mb}"
  }

  # Keep the heap policy scoped to the OpenClaw CLI instead of spraying it
  # onto every Node workload in the image. Default to half of the detected
  # host/cgroup memory, while still allowing explicit overrides.
  export NODE_OPTIONS="--max-old-space-size=\$(compute_openclaw_heap_mb)"
fi
exec "${real_bin}" "\$@"
EOF
  chmod 0755 "/usr/local/bin/${tool_name}"
  ln -sfn "/usr/local/bin/${tool_name}" "/usr/bin/${tool_name}"
}

resolve_package_bin_entry() {
  local package_name="$1"
  local tool_name="$2"

  node - "${package_name}" "${tool_name}" <<'NODE'
const fs = require('fs');
const path = require('path');

const packageName = process.argv[2];
const toolName = process.argv[3];
const pkgDir = path.join('/usr/local/lib/node_modules', packageName);
const pkgJsonPath = path.join(pkgDir, 'package.json');
if (!fs.existsSync(pkgJsonPath)) {
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
const bin = pkg.bin;
let rel = '';
if (typeof bin === 'string') {
  rel = bin;
} else if (bin && typeof bin === 'object') {
  rel = bin[toolName] || Object.values(bin)[0] || '';
}

if (!rel) {
  process.exit(3);
}

process.stdout.write(path.resolve(pkgDir, rel));
NODE
}

install_openclaw_runtime_wrappers() {
  local wrapper_root="/usr/local/lib/lightclaw/bin"
  local openclaw_entry=""
  local clawhub_entry=""

  mkdir -p "${wrapper_root}"
  openclaw_entry="$(resolve_package_bin_entry "openclaw" "openclaw")"
  clawhub_entry="$(resolve_package_bin_entry "clawhub" "clawhub")"

  ln -sfn "${openclaw_entry}" "${wrapper_root}/openclaw-real"
  ln -sfn "${clawhub_entry}" "${wrapper_root}/clawhub-real"

  install_openclaw_runtime_wrapper "openclaw" "${wrapper_root}/openclaw-real"
  install_openclaw_runtime_wrapper "clawhub" "${wrapper_root}/clawhub-real"
}

install_base_packages() {
  log_info "installing base apt packages"
  apt_install \
    ca-certificates \
    curl \
    git \
    jq \
    xz-utils \
    tar \
    unzip \
    ffmpeg \
    fonts-noto-cjk \
    openssh-server \
    python3 \
    python3-pip \
    python3-venv
}

install_node() {
  local node_archive=""
  local download_url=""
  local extracted_dir=""

  NODE_INSTALL_DIR="/opt/node/${NODE_VERSION}"
  NODE_BIN_DIR="${NODE_INSTALL_DIR}/bin"

  if [ -x "${NODE_BIN_DIR}/node" ]; then
    log_info "Node.js ${NODE_VERSION} already present"
  else
    mkdir -p /opt/node
    node_archive="/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz"
    if [ -n "${NODE_TARBALL_URL}" ]; then
      download_url="${NODE_TARBALL_URL}"
    else
      download_url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
    fi

    log_info "downloading Node.js ${NODE_VERSION} from ${download_url}"
    curl -fsSL "${download_url}" -o "${node_archive}"
    rm -rf "${NODE_INSTALL_DIR}"
    tar -xJf "${node_archive}" -C /opt/node
    extracted_dir="/opt/node/node-v${NODE_VERSION}-linux-x64"
    mv "${extracted_dir}" "${NODE_INSTALL_DIR}"
    rm -f "${node_archive}"
  fi

  ln -sfn "${NODE_BIN_DIR}/node" /usr/local/bin/node
  ln -sfn "${NODE_BIN_DIR}/npm" /usr/local/bin/npm
  ln -sfn "${NODE_BIN_DIR}/npx" /usr/local/bin/npx
  ln -sfn "${NODE_BIN_DIR}/corepack" /usr/local/bin/corepack
  ensure_global_bin_links

  npm config set prefix "${NPM_GLOBAL_PREFIX}" >/dev/null 2>&1 || true
  npm config set registry "${NPM_REGISTRY}" >/dev/null 2>&1 || true

  if ! command -v pnpm >/dev/null 2>&1 || ! pnpm --version 2>/dev/null | grep -qx "${PNPM_VERSION}"; then
    log_info "installing pnpm ${PNPM_VERSION}"
    npm install -g "pnpm@${PNPM_VERSION}"
  fi

  ensure_global_bin_links
  node -v
  npm -v
  pnpm -v
}

install_python_runtime() {
  local venv_python="${PYTHON_VENV_PATH}/bin/python"
  local venv_pip="${PYTHON_VENV_PATH}/bin/pip"

  if [ ! -d "${PYTHON_VENV_PATH}" ]; then
    log_info "creating Python venv at ${PYTHON_VENV_PATH}"
    python3 -m venv "${PYTHON_VENV_PATH}"
  fi

  "${venv_pip}" install --upgrade pip setuptools wheel >/dev/null

  if ! PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH}" "${venv_python}" -c "import playwright" >/dev/null 2>&1; then
    log_info "installing playwright ${PLAYWRIGHT_VERSION}"
    "${venv_pip}" install "playwright==${PLAYWRIGHT_VERSION}"
  fi

  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH}" "${venv_python}" -m playwright install-deps chromium
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH}" "${venv_python}" -m playwright install chromium chromium-headless-shell
}

install_node_major_from_nodesource() {
  local node_major="$1"

  if [[ ! "${node_major}" =~ ^[0-9]+$ ]]; then
    log_error "invalid hermes node major: ${node_major}"
    return 1
  fi

  if command -v node >/dev/null 2>&1; then
    local current_major=""
    current_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    if [ "${current_major}" = "${node_major}" ]; then
      log_info "Node.js major ${node_major} already installed"
      npm config set prefix "${NPM_GLOBAL_PREFIX}" >/dev/null 2>&1 || true
      npm config set registry "${NPM_REGISTRY}" >/dev/null 2>&1 || true
      return 0
    fi
  fi

  log_info "installing Node.js ${node_major}.x via NodeSource"
  apt_install ca-certificates curl gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${node_major}.x" | bash -
  apt_install nodejs
  npm config set prefix "${NPM_GLOBAL_PREFIX}" >/dev/null 2>&1 || true
  npm config set registry "${NPM_REGISTRY}" >/dev/null 2>&1 || true
}

ensure_hermes_runtime_bin_links() {
  local candidate=""
  local resolved=""
  local target=""
  local link_target=""
  local real_bin=""
  local real_bin_escaped=""
  local tmp=""
  local tool_name=""
  local found_any=false

  mkdir -p "${HERMES_SYSTEM_BIN_DIR}" "${HERMES_SYSTEM_LINK_DIR}"

  for tool_name in hermes hermes-agent; do
    real_bin=""
    for candidate in \
      "${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/${tool_name}" \
      "${RUNTIME_HOME}/.local/bin/${tool_name}" \
      "${RUNTIME_HOME}/.cargo/bin/${tool_name}"; do
      [ -x "${candidate}" ] || continue
      resolved="$(readlink -f "${candidate}" 2>/dev/null || printf '%s\n' "${candidate}")"
      case "${resolved}" in
        "${HERMES_SYSTEM_BIN_DIR}/"*|"${HERMES_SYSTEM_LINK_DIR}/"*)
          log_warn "skip ${tool_name} candidate resolving to system wrapper: ${candidate} -> ${resolved}"
          continue
          ;;
      esac
      real_bin="${resolved}"
      break
    done

    if [ -z "${real_bin}" ]; then
      continue
    fi

    if [ ! -x "${real_bin}" ]; then
      log_warn "skip ${tool_name} non-executable resolved path: ${real_bin}"
      continue
    fi

    printf -v real_bin_escaped '%q' "${real_bin}"
    target="${HERMES_SYSTEM_BIN_DIR}/${tool_name}"
    link_target="${HERMES_SYSTEM_LINK_DIR}/${tool_name}"
    tmp="$(mktemp "${HERMES_SYSTEM_BIN_DIR}/.${tool_name}.XXXXXX")"
    cat >"${tmp}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec ${real_bin_escaped} "\$@"
EOF
    chmod 0755 "${tmp}"
    rm -f "${target}" "${link_target}"
    mv "${tmp}" "${target}"
    ln -sfn "${target}" "${link_target}"
    found_any=true
    log_info "installed Hermes system wrapper: ${target} -> ${real_bin}"
  done

  if [ "${found_any}" = false ]; then
    log_warn "hermes runtime binary not found under ${RUNTIME_HOME}/.local/bin or ${RUNTIME_HOME}/.cargo/bin"
  fi

  ensure_global_bin_links
}

ensure_hermes_linger() {
  loginctl enable-linger "${RUNTIME_USER}" >/dev/null 2>&1 || true
  mkdir -p /var/lib/systemd/linger
  touch "/var/lib/systemd/linger/${RUNTIME_USER}"
}

write_hermes_env_profile() {
  local npm_global_bin=""
  npm_global_bin="$(npm prefix -g 2>/dev/null || echo /usr/local)/bin"

  mkdir -p "$(dirname "${HERMES_ENV_PROFILE_PATH}")"
  cat > "${HERMES_ENV_PROFILE_PATH}" <<EOF
export PATH="\$HOME/.hermes/hermes-agent/venv/bin:${npm_global_bin}:\$PATH"
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}"
EOF
  chmod 0644 "${HERMES_ENV_PROFILE_PATH}"
}

configure_hermes_python_mirrors() {
  local config_dir="${RUNTIME_HOME}/.config"
  local pip_config_dir="${config_dir}/pip"
  local uv_config_dir="${config_dir}/uv"

  log_info "configuring Hermes Python package mirrors for ${RUNTIME_USER}"
  mkdir -p "${pip_config_dir}" "${uv_config_dir}"
  cat > "${pip_config_dir}/pip.conf" <<EOF
[global]
index-url = ${HERMES_PYPI_INDEX_URL}
extra-index-url =
    ${HERMES_PYPI_EXTRA_INDEX_URL}
timeout = 300
disable-pip-version-check = true
EOF
  cat > "${uv_config_dir}/uv.toml" <<EOF
index-url = "${HERMES_PYPI_INDEX_URL}"
extra-index-url = ["${HERMES_PYPI_EXTRA_INDEX_URL}"]
EOF
  chown "${RUNTIME_USER}:${RUNTIME_USER}" "${config_dir}" 2>/dev/null || true
  chmod 0700 "${config_dir}" 2>/dev/null || true
  chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${pip_config_dir}" "${uv_config_dir}" 2>/dev/null || true
}

ensure_hermes_user_systemd_dir() {
  local config_dir="${RUNTIME_HOME}/.config"
  local systemd_dir="${config_dir}/systemd"
  local user_unit_dir="${systemd_dir}/user"

  mkdir -p "${user_unit_dir}"
  chown "${RUNTIME_USER}:${RUNTIME_USER}" "${config_dir}" "${systemd_dir}" "${user_unit_dir}" 2>/dev/null || true
  chmod 0700 "${config_dir}" "${systemd_dir}" "${user_unit_dir}" 2>/dev/null || true
}

ensure_hermes_uv() {
  local found_uv=""
  log_info "ensuring uv for ${RUNTIME_USER}"
  for found_uv in \
    "${RUNTIME_HOME}/.hermes/bin/uv" \
    "${RUNTIME_HOME}/.local/bin/uv" \
    "${RUNTIME_HOME}/.cargo/bin/uv"; do
    if [ -x "${found_uv}" ]; then
      HERMES_UV_CMD="${found_uv}"
      run_as_runtime_user "'${HERMES_UV_CMD}' --version"
      return 0
    fi
  done

  found_uv="$(run_as_runtime_user "export HOME='${RUNTIME_HOME}'; export PATH='${RUNTIME_HOME}/.local/bin:${RUNTIME_HOME}/.cargo/bin:'\"\$PATH\"; command -v uv 2>/dev/null || true")"
  if [ -n "${found_uv}" ]; then
    HERMES_UV_CMD="${found_uv}"
    run_as_runtime_user "'${HERMES_UV_CMD}' --version"
    return 0
  fi

  run_as_runtime_user "export HOME='${RUNTIME_HOME}'; export XDG_CONFIG_HOME='${RUNTIME_HOME}/.config'; python3 -m pip install --user --break-system-packages --index-url '${HERMES_PYPI_INDEX_URL}' --extra-index-url '${HERMES_PYPI_EXTRA_INDEX_URL}' uv"
  if [ -x "${RUNTIME_HOME}/.local/bin/uv" ]; then
    HERMES_UV_CMD="${RUNTIME_HOME}/.local/bin/uv"
  else
    found_uv="$(run_as_runtime_user "export HOME='${RUNTIME_HOME}'; export PATH='${RUNTIME_HOME}/.local/bin:${RUNTIME_HOME}/.cargo/bin:'\"\$PATH\"; command -v uv 2>/dev/null || true")"
    HERMES_UV_CMD="${found_uv}"
  fi
  [ -n "${HERMES_UV_CMD}" ] || { log_error "uv is still missing after install"; return 1; }
  run_as_runtime_user "'${HERMES_UV_CMD}' --version"
}

install_hermes_extra_tools() {
  local skillhub_url_escaped=""
  log_info "installing hermes extra tools"
  printf -v skillhub_url_escaped '%q' "${SKILLHUB_INSTALL_URL}"
  run_as_runtime_user "curl -fsSL ${skillhub_url_escaped} | bash -s -- --cli-only"
  write_hermes_env_profile
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${HERMES_ENV_PROFILE_PATH}"
  chmod 0644 "${HERMES_ENV_PROFILE_PATH}"
  if [ -x "${RUNTIME_HOME}/.local/bin/skillhub" ]; then
    install -m 0755 "${RUNTIME_HOME}/.local/bin/skillhub" /usr/local/bin/skillhub
  fi
  rm -rf "${RUNTIME_HOME}/.openclaw"
}

install_hermes_lightclawbot_plugin() {
  local hermes_home="${RUNTIME_HOME}/.hermes"
  local plugin_name="${HERMES_LIGHTCLAWBOT_PACKAGE}"
  local plugin_dir="${hermes_home}/plugins/${plugin_name}"
  local index_url="${HERMES_PYPI_INDEX_URL%/}/${plugin_name}/"
  local tmp_dir=""
  local html_file=""
  local whl_url=""
  local whl_file=""
  local extracted_dir=""
  local extracted_plugin=""
  local config_file="${hermes_home}/config.yaml"
  local env_file="${hermes_home}/.env"
  local agents_file="${hermes_home}/sessions/agents.json"
  local hermes_python="${hermes_home}/hermes-agent/venv/bin/python"

  log_info "installing Hermes ${plugin_name} platform plugin"
  if [ ! -x "${hermes_python}" ]; then
    log_error "Hermes venv python not found: ${hermes_python}"
    return 1
  fi

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/hermes-${plugin_name}-XXXXXX")"
  html_file="${tmp_dir}/index.html"
  whl_file="${tmp_dir}/${plugin_name}.whl"
  extracted_dir="${tmp_dir}/extracted"

  curl -fsSL --connect-timeout 10 --max-time 30 --retry 3 "${index_url}" -o "${html_file}"
  whl_url="$(
    python3 - "${index_url}" "${html_file}" <<'PY'
import html.parser
import pathlib
import re
import sys
import urllib.parse

index_url = sys.argv[1]
html_text = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8", errors="replace")

class LinkParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "a":
            return
        attrs = dict(attrs)
        href = attrs.get("href")
        if href and ".whl" in href:
            self.links.append(href.split("#", 1)[0])

parser = LinkParser()
parser.feed(html_text)
links = parser.links
if not links:
    raise SystemExit("no wheel link found")

def version_key(href):
    name = pathlib.PurePosixPath(urllib.parse.urlparse(href).path).name
    match = re.match(r"^[^-]+-([^-]+)-", name)
    version = match.group(1) if match else ""
    return [int(part) if part.isdigit() else part for part in re.split(r"([0-9]+)", version)]

print(urllib.parse.urljoin(index_url, sorted(links, key=version_key)[-1]))
PY
  )"
  if [ -z "${whl_url}" ]; then
    log_error "failed to resolve ${plugin_name} wheel from ${index_url}"
    rm -rf "${tmp_dir}"
    return 1
  fi

  curl -fsSL --connect-timeout 10 --max-time 120 --retry 3 "${whl_url}" -o "${whl_file}"
  mkdir -p "${extracted_dir}"
  python3 - "${whl_file}" "${extracted_dir}" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as zf:
    zf.extractall(sys.argv[2])
PY

  extracted_plugin="${extracted_dir}/${plugin_name}"
  if [ ! -f "${extracted_plugin}/__init__.py" ] || [ ! -f "${extracted_plugin}/plugin.yaml" ]; then
    log_error "${plugin_name} wheel did not contain expected plugin package"
    rm -rf "${tmp_dir}"
    return 1
  fi

  mkdir -p "${hermes_home}/plugins"
  rm -rf "${plugin_dir}"
  cp -a "${extracted_plugin}" "${plugin_dir}"
  chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${plugin_dir}" "${hermes_home}/plugins"

  touch "${config_file}"
  chown "${RUNTIME_USER}:${RUNTIME_USER}" "${config_file}"
  run_as_runtime_user "'${hermes_python}' - '${config_file}' <<'PY'
import sys
import yaml

path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as fh:
    config = yaml.safe_load(fh) or {}

plugins = config.setdefault('plugins', {})
enabled = plugins.get('enabled')
if not isinstance(enabled, list):
    enabled = []
plugins['enabled'] = enabled
if 'lightclawbot' not in enabled:
    enabled.append('lightclawbot')

platforms = config.setdefault('platforms', {})
platform = platforms.get('lightclawbot')
if not isinstance(platform, dict):
    platform = {}
platform['enabled'] = True
platforms['lightclawbot'] = platform

display = config.setdefault('display', {})
display_platforms = display.get('platforms')
if not isinstance(display_platforms, dict):
    display_platforms = {}
display['platforms'] = display_platforms
display_platform = display_platforms.get('lightclawbot')
if not isinstance(display_platform, dict):
    display_platform = {}
display_platform['streaming'] = True
display_platforms['lightclawbot'] = display_platform

approvals = config.get('approvals')
if not isinstance(approvals, dict):
    approvals = {}
config['approvals'] = approvals
approvals['mode'] = 'off'
approvals['cron_mode'] = 'approve'
approvals['destructive_slash_confirm'] = False

with open(path, 'w', encoding='utf-8') as fh:
    yaml.safe_dump(config, fh, sort_keys=False, allow_unicode=True)
PY"

  case "${HERMES_LIGHTCLAW_ALLOW_ALL_USERS}" in
    true|false) ;;
    *)
      log_error "invalid Hermes lightclaw allow-all setting: ${HERMES_LIGHTCLAW_ALLOW_ALL_USERS}"
      rm -rf "${tmp_dir}"
      return 1
      ;;
  esac

  touch "${env_file}"
  if grep -q '^LIGHTCLAW_ALLOW_ALL_USERS=' "${env_file}"; then
    sed -i "s|^LIGHTCLAW_ALLOW_ALL_USERS=.*|LIGHTCLAW_ALLOW_ALL_USERS=${HERMES_LIGHTCLAW_ALLOW_ALL_USERS}|" "${env_file}"
  else
    printf 'LIGHTCLAW_ALLOW_ALL_USERS=%s\n' "${HERMES_LIGHTCLAW_ALLOW_ALL_USERS}" >>"${env_file}"
  fi

  if [ ! -f "${agents_file}" ]; then
    mkdir -p "$(dirname "${agents_file}")"
    cat >"${agents_file}" <<'JSON'
{"agents":[{"id":"main","name":"main","identity":{"name":"默认助手","emoji":"🤖"}}]}
JSON
  fi
  chown "${RUNTIME_USER}:${RUNTIME_USER}" "${env_file}" "${agents_file}"
  chmod 0600 "${env_file}"

  run_as_runtime_user "test -f '${plugin_dir}/plugin.yaml' && grep -q '^name: lightclawbot$' '${plugin_dir}/plugin.yaml'"
  rm -rf "${tmp_dir}"
}

remove_hermes_find_skill_skillhub() {
  local skill_dir="${RUNTIME_HOME}/.agents/skills/find-skill-skillhub"

  if [ -e "${skill_dir}" ]; then
    log_info "removing preinstalled find-skill-skillhub"
    rm -rf "${skill_dir}"
  fi
}

curate_hermes_skills() {
  local skills_root="${RUNTIME_HOME}/.hermes/skills"
  local keep_list=(
    "autonomous-ai-agents/hermes-agent"
    "software-development/hermes-agent-skill-authoring"
    "software-development/plan"
    "software-development/spike"
    "software-development/systematic-debugging"
    "software-development/test-driven-development"
    "software-development/requesting-code-review"
    "github/codebase-inspection"
    "software-development/node-inspect-debugger"
    "software-development/python-debugpy"
    "dogfood"
    "productivity/ocr-and-documents"
    "productivity/nano-pdf"
    "productivity/powerpoint"
    "research/arxiv"
    "productivity/maps"
    "creative/architecture-diagram"
    "creative/humanizer"
  )
  local skill=""
  local skill_dir=""
  local category_dir=""
  local kept=0
  local removed=0
  local missing=()

  log_info "curating Hermes bundled skills"
  if [ ! -d "${skills_root}" ]; then
    log_warn "Hermes skills root not found, skipping curate: ${skills_root}"
    return 0
  fi

  should_keep_hermes_skill() {
    local candidate="$1"
    local keep=""
    for keep in "${keep_list[@]}"; do
      if [ "${candidate}" = "${keep}" ]; then
        return 0
      fi
    done
    return 1
  }

  while IFS= read -r skill_dir; do
    skill="${skill_dir#${skills_root}/}"
    if should_keep_hermes_skill "${skill}"; then
      kept=$((kept + 1))
      continue
    fi
    rm -rf "${skill_dir}"
    removed=$((removed + 1))
    log_info "removed Hermes skill: ${skill}"
  done < <(find "${skills_root}" -maxdepth 4 -name SKILL.md -type f -exec dirname {} \; | sort)

  while IFS= read -r category_dir; do
    if ! find "${category_dir}" -maxdepth 4 -name SKILL.md -type f -print -quit | grep -q .; then
      rm -rf "${category_dir}"
      log_info "removed empty Hermes skill category: ${category_dir#${skills_root}/}"
    fi
  done < <(find "${skills_root}" -mindepth 1 -maxdepth 1 -type d -not -name '.*')

  for skill in "${keep_list[@]}"; do
    if [ ! -f "${skills_root}/${skill}/SKILL.md" ]; then
      missing+=("${skill}")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    log_warn "Hermes kept-list entries not found in bundle:"
    printf 'WARN:   - %s\n' "${missing[@]}" >&2
  fi

  chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${skills_root}" 2>/dev/null || true
  log_info "Hermes skills curated: kept ${kept}, removed ${removed}"
}

install_hermes_whatsapp_bridge_deps() {
  local bridge_user="${HERMES_WHATSAPP_BRIDGE_USER:-${RUNTIME_USER}}"
  local bridge_home="${HERMES_WHATSAPP_BRIDGE_HOME:-${RUNTIME_HOME}}"
  local bridge_dir="${bridge_home}/.hermes/hermes-agent/scripts/whatsapp-bridge"
  local runtime_bridge_dir="${RUNTIME_HOME}/.hermes/hermes-agent/scripts/whatsapp-bridge"
  local bridge_home_escaped=""
  local hermes_home_escaped=""
  local bridge_dir_escaped=""
  local resolve_js=""
  local resolve_js_escaped=""
  local bridge_cmd=""

  log_info "installing Hermes WhatsApp bridge deps for ${bridge_user}"

  if ! id "${bridge_user}" >/dev/null 2>&1; then
    log_error "Hermes WhatsApp bridge user is missing: ${bridge_user}"
    return 1
  fi

  if [ ! -d "${bridge_dir}" ]; then
    if [ ! -d "${runtime_bridge_dir}" ]; then
      log_error "Hermes WhatsApp bridge source directory not found: ${runtime_bridge_dir}"
      return 1
    fi
    mkdir -p "$(dirname "${bridge_dir}")"
    cp -a "${runtime_bridge_dir}" "${bridge_dir}"
  fi
  chown "${bridge_user}:${bridge_user}" \
    "${bridge_home}/.hermes" \
    "${bridge_home}/.hermes/hermes-agent" \
    "${bridge_home}/.hermes/hermes-agent/scripts" 2>/dev/null || true
  chown -R "${bridge_user}:${bridge_user}" "${bridge_dir}" 2>/dev/null || true

  sudo npm install -g "pnpm@${PNPM_VERSION}"

  resolve_js='for (const m of ["@whiskeysockets/baileys","qrcode-terminal","express","pino"]) console.log(m, require.resolve(m))'
  printf -v bridge_home_escaped '%q' "${bridge_home}"
  printf -v hermes_home_escaped '%q' "${bridge_home}/.hermes"
  printf -v bridge_dir_escaped '%q' "${bridge_dir}"
  printf -v resolve_js_escaped '%q' "${resolve_js}"
  bridge_cmd="$(cat <<EOF
set -euo pipefail
export HOME=${bridge_home_escaped}
export HERMES_HOME=${hermes_home_escaped}
cd ${bridge_dir_escaped}
pnpm add --config.block-exotic-subdeps=false --config.dangerously-allow-all-builds=true @whiskeysockets/baileys@7.0.0-rc.9 qrcode-terminal express pino
node -e ${resolve_js_escaped}
EOF
)"
  sudo -u "${bridge_user}" -H bash -lc "${bridge_cmd}"
}

install_hermes_python_deps() {
  local hermes_python="${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/python"
  local hermes_uv_escaped=""

  log_info "installing Hermes Python integration deps"
  if [ ! -x "${hermes_python}" ]; then
    log_error "Hermes venv python not found: ${hermes_python}"
    return 1
  fi

  ensure_hermes_uv
  printf -v hermes_uv_escaped '%q' "${HERMES_UV_CMD}"
  run_as_runtime_user "export HOME='${RUNTIME_HOME}'; export XDG_CONFIG_HOME='${RUNTIME_HOME}/.config'; ${hermes_uv_escaped} pip install --index-url '${HERMES_PYPI_INDEX_URL}' --extra-index-url '${HERMES_PYPI_EXTRA_INDEX_URL}' --python '${hermes_python}' lark-oapi==1.5.3 qrcode==7.4.2"
  run_as_runtime_user "'${hermes_python}' -c 'import lark_oapi, qrcode; print(\"hermes-python-deps-ok\")'"
}

ensure_hermes_acli_identity() {
  local identity="${ACLI_IDENTITY_PATH}"
  local runtime_version="${HERMES_SRC_VERSION}"

  mkdir -p "$(dirname "${identity}")"
  touch "${identity}"

  upsert_identity_key() {
    local key="$1"
    local value="$2"
    if grep -q "^${key}:" "${identity}"; then
      sed -i -e "s|^${key}:.*|${key}: ${value}|" "${identity}"
    else
      printf '%s: %s\n' "${key}" "${value}" >>"${identity}"
    fi
  }

  if [ -z "${runtime_version}" ]; then
    runtime_version="$(run_as_runtime_user "${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/hermes --version 2>/dev/null | sed -n 's/^Hermes Agent v\\([^ ]*\\).*/\\1/p' | head -1" || true)"
  fi

  upsert_identity_key product lightvela
  upsert_identity_key run_as "${RUNTIME_USER}"
  upsert_identity_key runtime hermes
  upsert_identity_key runtime_bin "${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/hermes"
  upsert_identity_key runtime_home "${RUNTIME_HOME}/.hermes"
  if [ -n "${runtime_version}" ]; then
    upsert_identity_key runtime_version "${runtime_version}"
  fi

  log_info "ensured acli identity for Hermes runtime: ${identity}"
}

ensure_hermes_gateway_service() {
  local runtime_uid=""
  local user_env_prefix=""

  runtime_uid="$(id -u "${RUNTIME_USER}")"
  user_env_prefix="export XDG_RUNTIME_DIR=\"/run/user/${runtime_uid}\"; mkdir -p \"\${XDG_RUNTIME_DIR}\" 2>/dev/null || true;"
  ensure_hermes_linger
  ensure_hermes_user_systemd_dir
  run_as_runtime_user "${user_env_prefix} printf 'n\ny\n' | hermes gateway install"
  run_as_runtime_user "${user_env_prefix} hermes gateway stop >/dev/null 2>&1 || true"
}

verify_hermes_runtime_version() {
  local expected="${HERMES_SRC_VERSION}"
  local hermes_dir="${RUNTIME_HOME}/.hermes/hermes-agent"
  local hermes_bin="${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/hermes"
  local hermes_python="${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/python"
  local version_output=""
  local actual=""
  local import_info=""
  local import_version=""
  local import_file=""
  local hermes_dir_real=""
  local import_file_real=""
  local hermes_python_escaped=""

  if [ ! -x "${hermes_bin}" ]; then
    log_error "Hermes runtime binary not found: ${hermes_bin}"
    return 1
  fi
  if [ ! -x "${hermes_python}" ]; then
    log_error "Hermes runtime python not found: ${hermes_python}"
    return 1
  fi

  printf -v hermes_python_escaped '%q' "${hermes_python}"
  import_info="$(
    run_as_runtime_user "${hermes_python_escaped} -c 'import hermes_cli; print(getattr(hermes_cli, \"__version__\", \"\")); print(getattr(hermes_cli, \"__file__\", \"\"))'" || true
  )"
  import_version="$(printf '%s\n' "${import_info}" | sed -n '1p')"
  import_file="$(printf '%s\n' "${import_info}" | sed -n '2p')"
  hermes_dir_real="$(readlink -f "${hermes_dir}" 2>/dev/null || printf '%s\n' "${hermes_dir}")"
  import_file_real="$(readlink -f "${import_file}" 2>/dev/null || printf '%s\n' "${import_file}")"

  log_info "Hermes venv import version after install: ${import_version:-unknown} (${import_file_real:-unknown})"
  if [ -z "${import_version}" ] || [ -z "${import_file}" ]; then
    log_error "Hermes venv import check failed: hermes_cli did not report version and module path"
    return 1
  fi
  case "${import_file_real}" in
    "${hermes_dir_real}/"*) ;;
    *)
      log_error "Hermes venv imports hermes_cli outside pinned COS source: ${import_file_real}"
      log_error "expected import path under: ${hermes_dir_real}"
      return 1
      ;;
  esac
  if [ -n "${expected}" ] && [ "${import_version}" != "${expected}" ]; then
    log_error "Hermes venv import version mismatch: expected ${expected} from latest.json, got ${import_version}"
    return 1
  fi

  version_output="$(run_as_runtime_user "${hermes_bin} --version 2>/dev/null" || true)"
  actual="$(printf '%s\n' "${version_output}" | sed -n 's/^Hermes Agent v\([^ ]*\).*/\1/p' | head -1)"
  if [ -z "${actual}" ]; then
    actual="$(printf '%s\n' "${version_output}" | grep -Eo '[0-9]+(\.[0-9]+){1,2}' | head -1 || true)"
  fi

  log_info "Hermes runtime version after install: ${actual:-unknown} (output: ${version_output:-<empty>})"
  if [ -z "${expected}" ]; then
    log_info "Hermes expected src_version is unknown; skipping exact version check"
    return 0
  fi
  if [ "${actual}" != "${expected}" ]; then
    log_error "Hermes runtime version mismatch: expected ${expected} from latest.json, got ${actual:-unknown}"
    return 1
  fi
  log_info "Hermes runtime version matches latest metadata: ${expected}"
}

force_reinstall_hermes_local_package() {
  local hermes_dir="$1"
  local hermes_python="${hermes_dir}/venv/bin/python"
  local hermes_dir_escaped=""
  local hermes_python_escaped=""
  local hermes_uv_escaped=""

  if [ ! -x "${hermes_python}" ]; then
    log_error "Hermes venv python not found before local reinstall: ${hermes_python}"
    return 1
  fi

  ensure_hermes_uv
  printf -v hermes_dir_escaped '%q' "${hermes_dir}"
  printf -v hermes_python_escaped '%q' "${hermes_python}"
  printf -v hermes_uv_escaped '%q' "${HERMES_UV_CMD}"
  log_info "pinning Hermes venv package to COS source tree"
  run_as_runtime_user "${hermes_uv_escaped} pip install --python ${hermes_python_escaped} --no-deps --reinstall-package hermes-agent -e ${hermes_dir_escaped}"
}

snapshot_hermes_source_tree_git() {
  local hermes_dir="$1"
  local label="$2"

  run_as_runtime_user "$(cat <<EOF
set -e
cd '${hermes_dir}'
git init -q
git add -A
git -c user.email=build@local -c user.name=build commit -q -m 'snapshot ${label}' || true
git branch -M main
git remote remove origin >/dev/null 2>&1 || true
git remote add origin '${hermes_dir}'
git fetch origin -q
git branch --set-upstream-to=origin/main main >/dev/null
EOF
)"
}

restore_hermes_source_tree_from_cache() {
  local hermes_dir="$1"
  local actual=""
  local expected="${HERMES_SRC_VERSION}"
  local stage_dir=""
  local top_dir=""
  local preserved_venv=""

  actual="$(read_hermes_source_tree_version "${hermes_dir}/pyproject.toml" || true)"
  if [ -n "${expected}" ] && [ "${actual}" = "${expected}" ]; then
    return 0
  fi
  if [ -z "${HERMES_SOURCE_TARBALL_CACHE}" ] || [ ! -s "${HERMES_SOURCE_TARBALL_CACHE}" ]; then
    log_error "Hermes source tree drifted to ${actual:-unknown}, but COS tarball cache is missing: ${HERMES_SOURCE_TARBALL_CACHE:-<empty>}"
    return 1
  fi

  log_warn "Hermes source tree drifted after post-install steps: expected ${expected}, got ${actual:-unknown}; restoring COS source tree"
  stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/lightclaw-hermes-restore-XXXXXX")"
  tar -xzf "${HERMES_SOURCE_TARBALL_CACHE}" -C "${stage_dir}"
  top_dir="$(find "${stage_dir}" -mindepth 1 -maxdepth 1 -type d | head -1)"
  if [ -z "${top_dir}" ]; then
    log_error "Hermes cached tarball layout unexpected: no top-level directory"
    rm -rf "${stage_dir}"
    return 1
  fi

  if [ -d "${hermes_dir}/venv" ]; then
    preserved_venv="$(mktemp -d "${TMPDIR:-/tmp}/lightclaw-hermes-venv-XXXXXX")/venv"
    mv "${hermes_dir}/venv" "${preserved_venv}"
  fi
  rm -rf "${hermes_dir}"
  mkdir -p "$(dirname "${hermes_dir}")"
  mv "${top_dir}" "${hermes_dir}"
  if [ -n "${preserved_venv}" ] && [ -d "${preserved_venv}" ]; then
    rm -rf "${hermes_dir}/venv"
    mv "${preserved_venv}" "${hermes_dir}/venv"
    rm -rf "$(dirname "${preserved_venv}")"
  fi
  chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${hermes_dir}"
  rm -rf "${stage_dir}"
  verify_hermes_source_tree_version "${hermes_dir}" "after COS source restore"
  snapshot_hermes_source_tree_git "${hermes_dir}" "restored ${HERMES_VERSION:-hermes}"
}

finalize_hermes_runtime_pin() {
  local hermes_dir="${RUNTIME_HOME}/.hermes/hermes-agent"

  # acli/backend bootstrap may touch the Hermes home after the initial runtime
  # install, so make the COS tarball the final source of truth.
  restore_hermes_source_tree_from_cache "${hermes_dir}"
  verify_hermes_source_tree_version "${hermes_dir}" "after Hermes post-install steps"
  install_hermes_whatsapp_bridge_deps
  force_reinstall_hermes_local_package "${hermes_dir}"
  install_hermes_python_deps
  verify_hermes_runtime_version
  ensure_hermes_acli_identity
}

read_hermes_source_tree_version() {
  local pyproject_path="$1"
  if [ ! -f "${pyproject_path}" ]; then
    return 1
  fi
  python3 - "${pyproject_path}" <<'PY'
import sys

path = sys.argv[1]
version = ""
with open(path, "r", encoding="utf-8") as fh:
    in_project = False
    for raw in fh:
        line = raw.strip()
        if line == "[project]":
            in_project = True
            continue
        if in_project and line.startswith("[") and line.endswith("]"):
            break
        if in_project and line.startswith("version"):
            _, value = line.split("=", 1)
            version = value.strip().strip('"').strip("'")
            break
if version:
    print(version)
PY
}

verify_hermes_source_tree_version() {
  local hermes_dir="$1"
  local label="$2"
  local expected="${HERMES_SRC_VERSION}"
  local actual=""

  actual="$(read_hermes_source_tree_version "${hermes_dir}/pyproject.toml" || true)"
  log_info "Hermes source tree version ${label}: ${actual:-unknown}"
  if [ -z "${expected}" ] && [ -n "${actual}" ]; then
    HERMES_SRC_VERSION="${actual}"
    expected="${HERMES_SRC_VERSION}"
    log_info "Hermes expected src_version filled from source tree ${label}: ${HERMES_SRC_VERSION}"
  fi
  if [ -z "${expected}" ]; then
    log_error "Hermes expected src_version is unknown and source tree did not provide a version"
    return 1
  fi
  if [ "${actual}" != "${expected}" ]; then
    log_error "Hermes source tree version mismatch ${label}: expected ${expected} from latest.json, got ${actual:-unknown}"
    return 1
  fi
}

run_hermes_installer_stage() {
  local installer="$1"
  local hermes_home="$2"
  local hermes_dir="$3"
  local stage="$4"
  local installer_escaped=""
  local hermes_home_escaped=""
  local hermes_dir_escaped=""

  printf -v installer_escaped '%q' "${installer}"
  printf -v hermes_home_escaped '%q' "${hermes_home}"
  printf -v hermes_dir_escaped '%q' "${hermes_dir}"
  log_info "running Hermes installer stage: ${stage}"
  run_as_runtime_user "unset PLAYWRIGHT_BROWSERS_PATH; bash ${installer_escaped} ${HERMES_INSTALL_ARGS} --dir ${hermes_dir_escaped} --hermes-home ${hermes_home_escaped} --non-interactive --stage ${stage}"
}

install_hermes_runtime() {
  local installer=""
  local qwen_spec="@qwen-code/qwen-code"
  local hermes_cos_dir=""
  local hermes_tarball_url=""
  local hermes_home="${RUNTIME_HOME}/.hermes"
  local hermes_dir="${hermes_home}/hermes-agent"
  local tarball=""
  local stage_dir=""
  local top_dir=""
  local installer_stage=""

  log_info "installing hermes runtime for ${RUNTIME_USER}"

  if [ -n "${HERMES_QWEN_CODE_VERSION}" ] && [ "${HERMES_QWEN_CODE_VERSION}" != "latest" ]; then
    qwen_spec="${qwen_spec}@${HERMES_QWEN_CODE_VERSION}"
  else
    qwen_spec="${qwen_spec}@latest"
  fi

  if [ -z "${HERMES_INSTALL_SCRIPT_URL}" ]; then
    log_error "missing runtime_hermes.install_script_url in build-manifest.json"
    return 1
  fi
  if [ -z "${HERMES_COS_BASE}" ]; then
    log_error "missing runtime_hermes.cos_base in build-manifest.json"
    return 1
  fi

  ensure_hermes_version_resolved
  hermes_cos_dir="$(resolve_hermes_cos_dir)"
  hermes_tarball_url="${HERMES_COS_BASE%/}/${hermes_cos_dir}/hermes-agent.tar.gz"
  log_info "installing Hermes ${HERMES_VERSION:-${hermes_cos_dir}} from ${hermes_tarball_url}"

  tarball="$(mktemp "${TMPDIR:-/tmp}/lightclaw-hermes-XXXXXX.tar.gz")"
  stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/lightclaw-hermes-stage-XXXXXX")"

  curl -fsSL "${hermes_tarball_url}" -o "${tarball}"
  HERMES_SOURCE_TARBALL_CACHE="${HERMES_SOURCE_CACHE_DIR}/${hermes_cos_dir}/hermes-agent.tar.gz"
  mkdir -p "$(dirname "${HERMES_SOURCE_TARBALL_CACHE}")"
  cp "${tarball}" "${HERMES_SOURCE_TARBALL_CACHE}"
  tar -xzf "${tarball}" -C "${stage_dir}"
  top_dir="$(find "${stage_dir}" -mindepth 1 -maxdepth 1 -type d | head -1)"
  if [ -z "${top_dir}" ]; then
    log_error "Hermes tarball layout unexpected: no top-level directory"
    rm -rf "${tarball}" "${stage_dir}"
    return 1
  fi

  mkdir -p "${hermes_home}"
  rm -rf "${hermes_dir}"
  mv "${top_dir}" "${hermes_dir}"
  chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${hermes_home}"
  verify_hermes_source_tree_version "${hermes_dir}" "from COS tarball"

  snapshot_hermes_source_tree_git "${hermes_dir}" "${HERMES_VERSION:-${hermes_cos_dir}}"

  installer="$(mktemp "${TMPDIR:-/tmp}/hermes-install-XXXXXX.sh")"
  curl -fsSL "${HERMES_INSTALL_SCRIPT_URL}" -o "${installer}"
  chmod 0755 "${installer}"
  for installer_stage in venv python-deps node-deps path config; do
    run_hermes_installer_stage "${installer}" "${hermes_home}" "${hermes_dir}" "${installer_stage}"
  done
  force_reinstall_hermes_local_package "${hermes_dir}"
  rm -rf "${tarball}" "${stage_dir}" "${installer}"
  verify_hermes_source_tree_version "${hermes_dir}" "after installer stages"
  verify_hermes_runtime_version

  log_info "installing ${qwen_spec}"
  npm install -g "${qwen_spec}"
  ensure_global_bin_links
  ensure_hermes_runtime_bin_links
  write_hermes_env_profile
  ensure_yuanbao_allow_all_users
}

fetch_latest_hermes_metadata() {
  local meta=""
  meta="$(curl -fsSL "${HERMES_COS_BASE%/}/latest.json" 2>/dev/null || true)"
  if [ -z "${meta}" ]; then
    return 1
  fi
  eval "$(
    printf '%s' "${meta}" | python3 -c '
import json
import shlex
import sys

data = json.load(sys.stdin)
version = data.get("version", "")
if not version:
    raise SystemExit(1)

values = {
    "HERMES_VERSION": version,
    "HERMES_SRC_VERSION": data.get("src_version", ""),
    "HERMES_GIT_COMMIT": data.get("git_commit_full") or data.get("git_commit", ""),
}
for key, value in values.items():
    if value:
        print(f"{key}={shlex.quote(str(value))}")
' 2>/dev/null
  )"
  [ -n "${HERMES_VERSION}" ]
}

resolve_hermes_cos_dir() {
  local version="${HERMES_VERSION}"
  case "${version}" in
    hermes-agent-*) printf '%s\n' "${version}" ;;
    *) printf 'hermes-agent-%s\n' "${version}" ;;
  esac
}

ensure_hermes_version_resolved() {
  local version="${HERMES_VERSION}"
  if [ -z "${version}" ]; then
    log_info "No Hermes version specified, fetching latest from ${HERMES_COS_BASE%/}/latest.json" >&2
    fetch_latest_hermes_metadata || true
    version="${HERMES_VERSION}"
  fi
  if [ -z "${version}" ]; then
    log_error "failed to resolve Hermes version"
    return 1
  fi
  HERMES_VERSION="${version}"
  log_info "Resolved Hermes metadata: version=${HERMES_VERSION} src_version=${HERMES_SRC_VERSION:-unknown} git_commit=${HERMES_GIT_COMMIT:-unknown}"
  if [ -z "${HERMES_SRC_VERSION}" ]; then
    log_warn "Hermes metadata did not include src_version; will require the COS tarball source tree to provide it"
  fi
}

ensure_yuanbao_allow_all_users() {
  local env_file="${RUNTIME_HOME}/.hermes/.env"
  touch "${env_file}"
  if ! grep -q '^YUANBAO_ALLOW_ALL_USERS=' "${env_file}"; then
    echo "YUANBAO_ALLOW_ALL_USERS=true" >>"${env_file}"
  fi
  chown "${RUNTIME_USER}:${RUNTIME_USER}" "${env_file}"
}

install_hermes_acli() {
  if [ -z "${HERMES_ACLI_INSTALL_URL}" ]; then
    log_error "missing runtime_hermes.acli_install_url in build-manifest.json"
    return 1
  fi
  log_info "installing acli"
  ACLI_RUN_AS="${RUNTIME_USER}" curl -fsSL "${HERMES_ACLI_INSTALL_URL}" | ACLI_PRODUCT=lightvela ACLI_RUN_AS="${RUNTIME_USER}" bash
  if ! command -v acli >/dev/null 2>&1; then
    log_error "acli not found in PATH after install"
    return 1
  fi
  ensure_hermes_acli_identity
  if ! run_as_runtime_user "acli --help >/dev/null 2>&1"; then
    log_error "acli --help failed for ${RUNTIME_USER}"
    return 1
  fi
  if ! run_as_runtime_user "acli doctor >/dev/null 2>&1"; then
    log_error "acli doctor failed for ${RUNTIME_USER}"
    run_as_runtime_user "acli doctor" || true
    return 1
  fi
  local required_acli_commands=(
    "acli backend --help"
    "acli skills batch-install --help"
    "acli skills-sh batch-install --help"
    "acli clawhub batch-install --help"
  )
  local acli_bundle_update_required="false"
  local required_acli_command
  for required_acli_command in "${required_acli_commands[@]}"; do
    if ! run_as_runtime_user "${required_acli_command} >/dev/null 2>&1"; then
      log_info "required ACLI capability unavailable for ${RUNTIME_USER}: ${required_acli_command}"
      acli_bundle_update_required="true"
    fi
  done
  if [ "${acli_bundle_update_required}" = "true" ]; then
    log_info "attempting ACLI bundle-update for required Hermes capabilities"
    run_as_runtime_user "acli bundle-update >/dev/null 2>&1" || true
  fi
  for required_acli_command in "${required_acli_commands[@]}"; do
    if ! run_as_runtime_user "${required_acli_command} >/dev/null 2>&1"; then
      log_error "required ACLI capability is unavailable for ${RUNTIME_USER}: ${required_acli_command}"
      run_as_runtime_user "acli --help" || true
      return 1
    fi
  done
  ensure_global_bin_links
}

load_hermes_backend_blueprint_id() {
  local blueprint_id="${HERMES_BACKEND_BLUEPRINT_ID:-}"
  if [ -z "${blueprint_id}" ]; then
    if [ ! -r "${HERMES_BACKEND_BLUEPRINT_RESOLVER}" ]; then
      log_error "Hermes backend blueprint resolver not found: ${HERMES_BACKEND_BLUEPRINT_RESOLVER}"
      return 1
    fi
    blueprint_id="$(python3 "${HERMES_BACKEND_BLUEPRINT_RESOLVER}")"
  fi
  if [[ ! "${blueprint_id}" =~ ^lhbp-[A-Za-z0-9_-]+$ ]]; then
    log_error "invalid Hermes backend blueprint id: ${blueprint_id:-<empty>}"
    return 1
  fi
  HERMES_BACKEND_BLUEPRINT_ID="${blueprint_id}"
}

upgrade_hermes_backend_blueprint() {
  local blueprint_id_escaped=""

  load_hermes_backend_blueprint_id
  printf -v blueprint_id_escaped '%q' "${HERMES_BACKEND_BLUEPRINT_ID}"
  log_info "upgrading Hermes backend blueprint as ${RUNTIME_USER}: ${HERMES_BACKEND_BLUEPRINT_ID}"
  run_as_runtime_user "acli backend upgrade-start --blueprint-id ${blueprint_id_escaped} --wait=true --force=true"
}

install_envd_agent() {
  local binary_path="${ENVD_LOCAL_BINARY}"
  local max_attempts=15
  local attempt=1

  if [ ! -f "${binary_path}" ] && [ -f "${SCRIPT_DIR}/bin/lightclaw-envd-agent" ]; then
    binary_path="${SCRIPT_DIR}/bin/lightclaw-envd-agent"
  fi

  if [ ! -f "${binary_path}" ]; then
    log_error "local envd binary not found: ${binary_path}"
    return 1
  fi

  install -m 0755 "${binary_path}" "${ENVD_BINARY}"

  cat >"/etc/systemd/system/${ENVD_SERVICE}" <<EOF
[Unit]
Description=Sandbox envd runtime daemon
After=network.target
StartLimitIntervalSec=30
StartLimitBurst=5

[Service]
Type=simple
User=root
ExecStart=${ENVD_BINARY} -port ${ENVD_LISTEN_PORT} -isnotfc
Restart=on-failure
RestartSec=2
TimeoutStopSec=10
LimitNOFILE=65535
Environment=HOME=${RUNTIME_HOME}

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${ENVD_SERVICE}"

  while [ "${attempt}" -le "${max_attempts}" ]; do
    if curl -fsS "http://127.0.0.1:${ENVD_LISTEN_PORT}/health" >/dev/null 2>&1; then
      log_info "envd installed and healthy on port ${ENVD_LISTEN_PORT}"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  log_error "envd health check failed"
  systemctl --no-pager --full status "${ENVD_SERVICE}" || true
  journalctl -u "${ENVD_SERVICE}" -n 20 --no-pager || true
  return 1
}

configure_sshd_defaults() {
  local sshd_config_file="/etc/ssh/sshd_config"
  local sftp_server="/usr/lib/openssh/sftp-server"

  ensure_runtime_user_ssh_access

  if [ ! -x "${sftp_server}" ] && [ -x /usr/libexec/openssh/sftp-server ]; then
    sftp_server="/usr/libexec/openssh/sftp-server"
  fi

  cat >"${sshd_config_file}" <<EOF
Port 22
Protocol 2
HostKey /etc/ssh/ssh_host_rsa_key
HostKey /etc/ssh/ssh_host_ecdsa_key
HostKey /etc/ssh/ssh_host_ed25519_key
UsePAM yes
PubkeyAuthentication yes
PasswordAuthentication no
PermitRootLogin no
AuthorizedKeysFile .ssh/authorized_keys
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
X11Forwarding yes
PrintMotd no
Subsystem sftp ${sftp_server}
EOF

  mkdir -p /run/sshd
  sshd -t
  systemctl enable ssh >/dev/null 2>&1 || true
  systemctl restart ssh
}

ensure_openclaw_config() {
  local cfg_dir="${RUNTIME_HOME}/.openclaw"
  local cfg_file="${cfg_dir}/openclaw.json"
  local tmp_file="/tmp/openclaw_config_$$.json"

  mkdir -p "${cfg_dir}"
  if [ ! -s "${cfg_file}" ]; then
    echo "{}" > "${cfg_file}"
  fi

  if ! jq empty "${cfg_file}" >/dev/null 2>&1; then
    echo "{}" > "${cfg_file}"
  fi

  jq '
    .tools.profile = "full"
    | .tools.deny = ["browser","web_search","web_fetch"]
  ' "${cfg_file}" > "${tmp_file}"
  mv "${tmp_file}" "${cfg_file}"
  chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${cfg_dir}"
}

install_openclaw() {
  log_info "installing openclaw ${OPENCLAW_VERSION}"
  npm config set prefix "${NPM_GLOBAL_PREFIX}" >/dev/null 2>&1 || true
  npm config set registry "${NPM_REGISTRY}" >/dev/null 2>&1 || true
  npm install -g "openclaw@${OPENCLAW_VERSION}" clawhub
  install_openclaw_runtime_wrappers
  ensure_global_bin_links

  if [ ! -s "${RUNTIME_HOME}/.openclaw/openclaw.json" ]; then
    run_as_runtime_user "openclaw onboard \
      --non-interactive \
      --mode local \
      --gateway-bind loopback \
      --gateway-port "${GATEWAY_PORT}" \
      --no-install-daemon \
      --skip-channels \
      --skip-skills \
      --skip-health \
      --accept-risk"
  fi

  ensure_openclaw_config
}

has_optional_plugin() {
  local plugin="$1"
  case ",${OPTIONAL_PLUGINS}," in
    *,"${plugin}",*) return 0 ;;
    *) return 1 ;;
  esac
}

has_only_plugin() {
  local plugin="$1"
  case ",${ONLY_PLUGINS}," in
    *,"${plugin}",*) return 0 ;;
    *) return 1 ;;
  esac
}

should_install_plugin() {
  local plugin="$1"

  if [ -n "${ONLY_PLUGINS}" ]; then
    has_only_plugin "${plugin}"
    return $?
  fi

  if [ "${plugin}" = "qqbot" ] || [ "${plugin}" = "weixin" ]; then
    return 0
  fi

  has_optional_plugin "${plugin}"
}

ensure_openclaw_plugin_symlink() {
  local plugin_id="$1"
  local plugin_dir="${RUNTIME_HOME}/.openclaw/extensions/${plugin_id}"
  local host_root=""
  local node_modules_dir=""
  local link_path=""

  if [ ! -d "${plugin_dir}" ]; then
    return 0
  fi

  host_root="$(node - <<'NODE'
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

try {
  const pkgRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const pkgDir = path.join(pkgRoot, 'openclaw');
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    if (pkg.name === 'openclaw') {
      process.stdout.write(pkgDir);
    }
  }
} catch {}
NODE
)"

  if [ -z "${host_root}" ] || [ ! -d "${host_root}" ]; then
    log_warn "failed to resolve host openclaw root for ${plugin_id}"
    return 0
  fi

  node_modules_dir="${plugin_dir}/node_modules"
  link_path="${node_modules_dir}/openclaw"
  mkdir -p "${node_modules_dir}"
  rm -rf "${link_path}"
  ln -s "${host_root}" "${link_path}"
  chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${plugin_dir}"
}

install_all_plugins() {
  ensure_openclaw_config

  if should_install_plugin "qqbot"; then
    local plugin_id="openclaw-qqbot"
    local qqbot_spec="@tencent-connect/openclaw-qqbot"
    if [ -n "${QQBOT_VERSION}" ]; then
      qqbot_spec="${qqbot_spec}@${QQBOT_VERSION}"
    fi
    log_info "installing ${qqbot_spec}"
    if ! run_as_runtime_user "openclaw plugins install \"${qqbot_spec}\"" >/tmp/openclaw_qqbot_install.log 2>&1; then
      if grep -q "already exists" /tmp/openclaw_qqbot_install.log 2>/dev/null; then
        run_as_runtime_user "openclaw plugins update \"${plugin_id}\"" >/tmp/openclaw_qqbot_install.log 2>&1 || {
          cat /tmp/openclaw_qqbot_install.log >&2 || true
          return 1
        }
      else
        cat /tmp/openclaw_qqbot_install.log >&2 || true
        return 1
      fi
    fi
    rm -f /tmp/openclaw_qqbot_install.log
    find "${RUNTIME_HOME}/.openclaw/extensions" -maxdepth 1 -type d -name '.openclaw-install-stage-*' -exec rm -rf {} + 2>/dev/null || true
  fi
  if should_install_plugin "weixin"; then
    local plugin_id="openclaw-weixin"
    local weixin_spec="@tencent-weixin/openclaw-weixin"
    if [ -n "${WEIXIN_VERSION}" ]; then
      weixin_spec="${weixin_spec}@${WEIXIN_VERSION}"
    fi
    log_info "installing ${weixin_spec}"
    if ! run_as_runtime_user "openclaw plugins install \"${weixin_spec}\"" >/tmp/openclaw_weixin_install.log 2>&1; then
      if grep -q "already exists" /tmp/openclaw_weixin_install.log 2>/dev/null; then
        run_as_runtime_user "openclaw plugins update \"${plugin_id}\"" >/tmp/openclaw_weixin_install.log 2>&1 || {
          cat /tmp/openclaw_weixin_install.log >&2 || true
          return 1
        }
      else
        cat /tmp/openclaw_weixin_install.log >&2 || true
        return 1
      fi
    fi
    rm -f /tmp/openclaw_weixin_install.log
    find "${RUNTIME_HOME}/.openclaw/extensions" -maxdepth 1 -type d -name '.openclaw-install-stage-*' -exec rm -rf {} + 2>/dev/null || true
  fi
  if should_install_plugin "feishu"; then
    run_as_runtime_user "openclaw plugins enable feishu" >/dev/null 2>&1 || true
  fi
  if should_install_plugin "ddingtalk"; then
    run_as_runtime_user "openclaw plugins install @largezhou/ddingtalk" >/dev/null 2>&1 || true
  fi
  if should_install_plugin "wecom"; then
    run_as_runtime_user "openclaw plugins install @mocrane/wecom" >/dev/null 2>&1 || true
  fi
  if should_install_plugin "adp"; then
    run_as_runtime_user "openclaw plugins install adp-openclaw" >/dev/null 2>&1 || true
  fi
  if should_install_plugin "yuanbao"; then
    run_as_runtime_user "openclaw plugins install openclaw-plugin-yuanbao" >/dev/null 2>&1 || true
  fi

  ensure_openclaw_config
}

clawhub_install() {
  local skill_name="$1"
  local max_retries=30
  local retry_delay=5
  local attempt=1

  while [ "${attempt}" -le "${max_retries}" ]; do
    if clawhub install --force "${skill_name}" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${retry_delay}"
    attempt=$((attempt + 1))
  done

  log_warn "skill install failed after retries: ${skill_name}"
  return 1
}

install_skills() {
  case "${SKILLS_MODE}" in
    essential)
      clawhub_install "find-skills-skill" || true
      ;;
    all)
      clawhub_install "openclaw-tavily-search" || true
      clawhub_install "summarize" || true
      clawhub_install "agent-browser" || true
      clawhub_install "find-skills-skill" || true
      clawhub_install "github" || true
      clawhub_install "obsidian" || true
      clawhub_install "weather" || true
      clawhub_install "tencent-docs" || true
      ;;
    custom)
      if [ -n "${CUSTOM_SKILLS}" ]; then
        local skill=""
        local old_ifs="${IFS}"
        IFS=','
        for skill in ${CUSTOM_SKILLS}; do
          skill="${skill//[[:space:]]/}"
          if [ -n "${skill}" ]; then
            clawhub_install "${skill}" || true
          fi
        done
        IFS="${old_ifs}"
      fi
      ;;
    *)
      log_error "unsupported skills mode: ${SKILLS_MODE}"
      return 1
      ;;
  esac

  npm install -g agent-browser >/dev/null 2>&1 || true
  ensure_global_bin_links

  if ! command -v skillhub >/dev/null 2>&1; then
    curl -fsSL "${SKILLHUB_INSTALL_URL}" | bash >/dev/null 2>&1 || true
  fi
}

customize_agents_md() {
  local agents_file="${RUNTIME_HOME}/.openclaw/workspace/AGENTS.md"
  local marker="<!-- LIGHTCLAW-USAGE-NOTES-START -->"

  if [ ! -f "${agents_file}" ]; then
    return 0
  fi

  if grep -q "${marker}" "${agents_file}" 2>/dev/null; then
    return 0
  fi

  cat >> "${agents_file}" <<'EOF'

<!-- LIGHTCLAW-USAGE-NOTES-START -->
## Usage Notes

- The built-in `browser`, `web_search`, and `web_fetch` tools are disabled on this instance.
- For all browser-related operations (web browsing, screenshots, form filling, DOM inspection, clicking, navigation, etc.), you MUST use the `agent-browser` skill.
- For web search or fetching webpage content, you MUST also use the `agent-browser` skill instead of the disabled built-in tools.
- Do NOT attempt to use `openclaw browser` commands directly - they will not work.
- When asked to interact with a webpage, search the web, or fetch URL content, always invoke the agent-browser skill instead.
- When using the `agent-browser` skill to perform tasks, you MUST take screenshots at key steps and send them to the user so they can verify the progress and results visually.
<!-- LIGHTCLAW-USAGE-NOTES-END -->
EOF
  chown "${RUNTIME_USER}:${RUNTIME_USER}" "${agents_file}"
}

ensure_openclaw_gateway_service() {
  local gateway_unit="${RUNTIME_HOME}/.config/systemd/user/openclaw-gateway.service"
  local runtime_uid
  runtime_uid="$(id -u "${RUNTIME_USER}")"
  local user_env_prefix="export XDG_RUNTIME_DIR=\"/run/user/${runtime_uid}\"; export DBUS_SESSION_BUS_ADDRESS=\"unix:path=\${XDG_RUNTIME_DIR}/bus\"; mkdir -p \"\${XDG_RUNTIME_DIR}\" 2>/dev/null || true;"
  loginctl enable-linger "${RUNTIME_USER}" >/dev/null 2>&1 || true

  rm -f /etc/systemd/system/openclaw-gateway.service
  systemctl daemon-reload || true

  if ! run_as_runtime_user "${user_env_prefix} openclaw gateway install --force --port \"${GATEWAY_PORT}\"" >/tmp/openclaw_gateway_install.log 2>&1; then
    if [ -f "${gateway_unit}" ] && grep -q "Unit file openclaw-gateway.service does not exist" /tmp/openclaw_gateway_install.log 2>/dev/null; then
      log_warn "openclaw gateway install returned early after writing the user unit; continuing with manual enable"
    else
      cat /tmp/openclaw_gateway_install.log >&2 || true
      return 1
    fi
  fi
  rm -f /tmp/openclaw_gateway_install.log

  run_as_runtime_user "${user_env_prefix} systemctl --user daemon-reload"
  run_as_runtime_user "${user_env_prefix} systemctl --user enable openclaw-gateway >/dev/null 2>&1 || true"
  run_as_runtime_user "${user_env_prefix} systemctl --user restart openclaw-gateway"

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if run_as_runtime_user "${user_env_prefix} systemctl --user is-active openclaw-gateway >/dev/null 2>&1" && \
      ss -tln 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${GATEWAY_PORT}$"; then
      return 0
    fi
    sleep 1
  done

  log_error "openclaw-gateway did not become ready"
  run_as_runtime_user "${user_env_prefix} systemctl --user --no-pager --full status openclaw-gateway || true"
  run_as_runtime_user "${user_env_prefix} journalctl --user -u openclaw-gateway -n 50 --no-pager || true"
  return 1
}

uninstall_security_agent() {
  pkill -9 -f '/usr/local/sa/agent/plugins/sap1' 2>/dev/null || true
  pkill -9 -f '/bin/bash /usr/local/sa/agent/watchdog.sh' 2>/dev/null || true
  pkill -9 -f '/usr/local/sa/agent/watchdog.sh' 2>/dev/null || true
  killall -9 secu-tcs-agent 2>/dev/null || true
  rm -rf /usr/local/sa
}

cleanup_for_image() {
  rm -rf /tmp/tat_agent/
  if [ -f /usr/local/qcloud/tat_agent/log/tat_agent.log ]; then
    : > /usr/local/qcloud/tat_agent/log/tat_agent.log
  fi

  rm -f /root/.bash_history "${RUNTIME_HOME}/.bash_history" /home/*/.bash_history 2>/dev/null || true
  find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  find /var/tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  passwd -l root 2>/dev/null || true
  passwd -d ubuntu 2>/dev/null || true
}

build_base_layer() {
  setup_user "${RUNTIME_USER}"
  resolve_runtime_home
  if [ "${RUNTIME_KIND}" = "hermes" ]; then
    log_info "installing hermes base packages"
    apt_install \
      ca-certificates \
      curl \
      git \
      openssh-server \
      python3 \
      python3-pip \
      ripgrep \
      ffmpeg
    install_node_major_from_nodesource "${HERMES_NODE_MAJOR:-22}"
    python3 -m pip install --break-system-packages dingtalk-stream aiohttp httpx
    ensure_hermes_linger
  else
    install_base_packages
    install_node
    install_python_runtime
  fi
  configure_runtime_profile
  configure_sshd_defaults
  uninstall_security_agent
}

build_app_layer() {
  resolve_runtime_home
  if [ "${RUNTIME_KIND}" = "hermes" ]; then
    install_hermes_runtime
    configure_hermes_python_mirrors
    install_hermes_python_deps
    install_hermes_lightclawbot_plugin
    install_hermes_whatsapp_bridge_deps
    ensure_hermes_gateway_service
    install_hermes_extra_tools
    install_hermes_acli
    upgrade_hermes_backend_blueprint
    finalize_hermes_runtime_pin
    curate_hermes_skills
    remove_hermes_find_skill_skillhub
  else
    install_openclaw
    install_all_plugins
    install_runtime_protocol_scripts
    install_skills
    customize_agents_md
    ensure_openclaw_gateway_service
  fi
  cleanup_for_image
}

main() {
  load_manifest_defaults
  validate_manifest_defaults
  require_root
  parse_args "$@"
  validate_platform
  setup_user "${RUNTIME_USER}"
  resolve_runtime_home
  install_envd_agent

  if [ "${ENVD_ONLY}" = true ]; then
    log_info "envd-only install completed"
    return 0
  fi

  if [ "${BASE_ONLY}" = true ]; then
    build_base_layer
    log_info "base layer build completed"
    return 0
  fi

  if [ "${APP_ONLY}" = true ]; then
    build_app_layer
    log_info "app layer build completed"
    return 0
  fi

  build_base_layer
  build_app_layer
  log_info "full build completed"
}

if [ "${LIGHTCLAW_BUILD_SH_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi
