#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_SCRIPT="${ROOT_DIR}/images/build.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

export LIGHTCLAW_BUILD_SH_SOURCE_ONLY=1
# shellcheck source=/dev/null
source "${BUILD_SCRIPT}"
unset LIGHTCLAW_BUILD_SH_SOURCE_ONLY

RUNTIME_USER="agentuser"
RUNTIME_HOME="${TMPDIR}/home/${RUNTIME_USER}"
mkdir -p "${RUNTIME_HOME}"
HOME="${RUNTIME_HOME}"
export HOME
REAL_RUNTIME_HOME="$(readlink -f "${RUNTIME_HOME}" 2>/dev/null || printf '%s\n' "${RUNTIME_HOME}")"

HERMES_INSTALL_SCRIPT_URL="https://example.com/install.sh"
HERMES_INSTALL_ARGS="--skip-setup"
HERMES_COS_BASE="https://example.com/hermes"
HERMES_VERSION=""
HERMES_SRC_VERSION=""
HERMES_GIT_COMMIT=""
HERMES_QWEN_CODE_VERSION="latest"
HERMES_ACLI_INSTALL_URL="https://example.com/acli/install.sh"
HERMES_BACKEND_BLUEPRINT_ID_FILE="${TMPDIR}/hermes-backend-blueprint-id"
SKILLHUB_INSTALL_URL="https://example.com/skillhub.sh"
HERMES_ENV_PROFILE_PATH="${TMPDIR}/etc/profile.d/hermes-env.sh"
HERMES_SYSTEM_BIN_DIR="${TMPDIR}/usr-local-bin"
HERMES_SYSTEM_LINK_DIR="${TMPDIR}/usr-bin"
ACLI_IDENTITY_PATH="${TMPDIR}/etc/acli/identity.yaml"
export ACLI_IDENTITY_PATH
printf 'lhbp-8gsotw6u\n' >"${HERMES_BACKEND_BLUEPRINT_ID_FILE}"

LOG_FILE="${TMPDIR}/calls.log"
PROFILE_FILE="${HERMES_ENV_PROFILE_PATH}"
INSTALLER_PAYLOAD="${TMPDIR}/installer-payload.sh"
HERMES_TARBALL="${TMPDIR}/hermes-agent.tar.gz"
ACLI_BACKEND_MARKER="${TMPDIR}/acli-backend-ready"

log_call() {
  printf '%s\n' "$*" >>"${LOG_FILE}"
}

apt_install() {
  log_call "apt_install $*"
}

install_node_major_from_nodesource() {
  log_call "install_node_major_from_nodesource $*"
}

ensure_global_bin_links() {
  log_call "ensure_global_bin_links"
}

ensure_hermes_linger() {
  log_call "ensure_hermes_linger"
}

run_as_runtime_user() {
  log_call "run_as_runtime_user $*"
  eval "$*"
}

cat <<'EOF' >"${INSTALLER_PAYLOAD}"
#!/usr/bin/env bash
mkdir -p "$HOME/.hermes/bin"
cat >"$HOME/.hermes/bin/uv" <<'INNER'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo "uv fixture"
  exit 0
fi
if [ "${1:-}" = "pip" ] && [ "${2:-}" = "install" ]; then
  echo "uv-pip-install $*" >>"__LOG_FILE__"
  exit 0
fi
exit 0
INNER
cat >"$HOME/.hermes/hermes-agent/venv/bin/hermes-agent" <<'INNER'
#!/usr/bin/env bash
exit 0
INNER
cat >"$HOME/.hermes/hermes-agent/venv/bin/hermes" <<'INNER'
#!/usr/bin/env bash
echo "0.14.0"
INNER
cat >"$HOME/.hermes/hermes-agent/venv/bin/python" <<'INNER'
#!/usr/bin/env bash
if [ "${1:-}" = "-m" ] && [ "${2:-}" = "pip" ]; then
  echo "python-pip-install $*" >>"__LOG_FILE__"
  exit 0
fi
if [ "${1:-}" = "-c" ]; then
  if [[ "${2:-}" == *"import hermes_cli"* ]]; then
    echo "0.14.0"
    echo "$HOME/.hermes/hermes-agent/hermes_cli/__init__.py"
    exit 0
  fi
  if [[ "${2:-}" == *"import lark_oapi"* ]]; then
    echo "hermes-python-deps-ok"
    exit 0
  fi
fi
exit 0
INNER
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/hermes-agent"
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/hermes"
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/python"
chmod +x "$HOME/.hermes/bin/uv"
exit 0
EOF
python3 - "${INSTALLER_PAYLOAD}" "${LOG_FILE}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
path.write_text(path.read_text().replace("__LOG_FILE__", sys.argv[2]))
PY
chmod +x "${INSTALLER_PAYLOAD}"

mkdir -p "${TMPDIR}/hermes-src/hermes-agent/venv/bin"
mkdir -p "${TMPDIR}/hermes-src/hermes-agent/hermes_cli"
mkdir -p "${TMPDIR}/hermes-src/hermes-agent/scripts/whatsapp-bridge"
cat >"${TMPDIR}/hermes-src/hermes-agent/README.md" <<'EOF'
hermes fixture
EOF
cat >"${TMPDIR}/hermes-src/hermes-agent/pyproject.toml" <<'EOF'
[project]
name = "hermes-agent"
version = "0.14.0"
EOF
cat >"${TMPDIR}/hermes-src/hermes-agent/hermes_cli/__init__.py" <<'EOF'
__version__ = "0.14.0"
EOF
cat >"${TMPDIR}/hermes-src/hermes-agent/scripts/whatsapp-bridge/package.json" <<'EOF'
{"private":true,"name":"whatsapp-bridge-fixture"}
EOF
tar -czf "${HERMES_TARBALL}" -C "${TMPDIR}/hermes-src" hermes-agent

curl() {
  if [[ "${1:-}" == "-fsSL" && "${2:-}" == "${HERMES_COS_BASE}/latest.json" ]]; then
    cat <<'EOF'
{
  "version": "hermes-agent-v20260520",
  "src_version": "0.14.0",
  "git_commit": "main",
  "git_commit_full": "main"
}
EOF
    log_call "curl-hermes-latest"
    return 0
  fi
  if [[ "${1:-}" == "-fsSL" && "${2:-}" == "${HERMES_COS_BASE}/hermes-agent-v20260520/hermes-agent.tar.gz" && "${3:-}" == "-o" ]]; then
    cp "${HERMES_TARBALL}" "${4}"
    log_call "curl-hermes-tarball ${4}"
    return 0
  fi
  if [[ "${1:-}" == "-fsSL" && "${2:-}" == "${HERMES_INSTALL_SCRIPT_URL}" && "${3:-}" == "-o" ]]; then
    cp "${INSTALLER_PAYLOAD}" "${4}"
    log_call "curl-installer ${4}"
    return 0
  fi
  if [[ "${1:-}" == "-fsSL" && "${2:-}" == "${SKILLHUB_INSTALL_URL}" ]]; then
    cat <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    log_call "curl-skillhub"
    return 0
  fi
  if [[ "${1:-}" == "-fsSL" && "${2:-}" == "${HERMES_ACLI_INSTALL_URL}" ]]; then
    cat <<'EOF'
#!/usr/bin/env bash
[ "${ACLI_PRODUCT:-}" = "lightvela" ] || exit 41
[ "${ACLI_RUN_AS:-}" = "${LIGHTCLAW_RUNTIME_USER:-agentuser}" ] || exit 42
mkdir -p "$(dirname "${ACLI_IDENTITY_PATH:-/etc/acli/identity.yaml}")"
cat >"${ACLI_IDENTITY_PATH:-/etc/acli/identity.yaml}" <<IDENTITY
product: common
run_as: root
runtime: hermes
runtime_bin: /usr/local/bin/hermes
runtime_home: /root/.hermes
runtime_version: 0.10.0
IDENTITY
exit 0
EOF
    log_call "curl-acli"
    return 0
  fi
  command curl "$@"
}

npm() {
  if [[ "${1:-}" == "install" && "${2:-}" == "-g" ]]; then
    log_call "npm-install ${3:-}"
    return 0
  fi
  if [[ "${1:-}" == "prefix" && "${2:-}" == "-g" ]]; then
    printf '%s\n' "${TMPDIR}/npm-global"
    log_call "npm-prefix"
    return 0
  fi
  command npm "$@"
}

uv() {
  if [[ "${1:-}" == "pip" && "${2:-}" == "install" ]]; then
    log_call "uv-pip-install $*"
    return 0
  fi
  command uv "$@"
}

su() {
  if [[ "${1:-}" == "-" && "${2:-}" == "${RUNTIME_USER}" && "${3:-}" == "-c" ]]; then
    log_call "su ${4:-}"
    bash -lc "${4:-}"
    return 0
  fi
  command su "$@"
}

sudo() {
  if [[ "${1:-}" == "npm" && "${2:-}" == "install" && "${3:-}" == "-g" ]]; then
    log_call "sudo-npm-install ${4:-}"
    return 0
  fi
  if [[ "${1:-}" == "-u" && "${2:-}" == "${RUNTIME_USER}" && "${3:-}" == "-H" && "${4:-}" == "bash" && "${5:-}" == "-lc" ]]; then
    log_call "sudo-user ${2} ${6:-}"
    if [[ "${6:-}" == *"pnpm add --config.block-exotic-subdeps=false --config.dangerously-allow-all-builds=true @whiskeysockets/baileys@7.0.0-rc.9 qrcode-terminal express pino"* ]]; then
      log_call "pnpm-add-whatsapp-bridge"
    fi
    if [[ "${6:-}" == *"require.resolve"* && "${6:-}" == *"@whiskeysockets/baileys"* ]]; then
      log_call "node-resolve-whatsapp-bridge"
    fi
    return 0
  fi
  command sudo "$@"
}

acli() {
  log_call "acli $*"
  if [[ "${1:-}" == "backend" && "${2:-}" == "--help" && ! -f "${ACLI_BACKEND_MARKER}" ]]; then
    return 1
  fi
  if [[ "${1:-}" == "bundle-update" ]]; then
    touch "${ACLI_BACKEND_MARKER}"
  fi
  return 0
}

hermes() {
  log_call "hermes $*"
  return 0
}

id() {
  if [[ "${1:-}" == "${RUNTIME_USER}" ]]; then
    return 0
  fi
  if [[ "${1:-}" == "-u" && "${2:-}" == "${RUNTIME_USER}" ]]; then
    printf '1000\n'
    return 0
  fi
  command id "$@"
}

command() {
  if [[ "${1:-}" == "-v" && "${2:-}" == "skillhub" ]]; then
    return 1
  fi
  builtin command "$@"
}

loginctl() {
  log_call "loginctl $*"
}

chown() {
  log_call "chown $*"
}

chmod() {
  log_call "chmod $*"
}

ln() {
  log_call "ln $*"
}

mkdir -p "${HOME}/.local/bin" "${HOME}/.config"

install_hermes_runtime
configure_hermes_python_mirrors
install_hermes_python_deps
install_hermes_whatsapp_bridge_deps
ensure_hermes_gateway_service
install_hermes_extra_tools
install_hermes_acli
upgrade_hermes_backend_blueprint

grep -q "curl-hermes-latest" "${LOG_FILE}"
grep -q "curl-hermes-tarball" "${LOG_FILE}"
grep -q "curl-installer" "${LOG_FILE}"
grep -Fq -- "--dir ${RUNTIME_HOME}/.hermes/hermes-agent --hermes-home ${RUNTIME_HOME}/.hermes --skip-browser --non-interactive --stage venv" "${LOG_FILE}"
grep -Fq -- "--dir ${RUNTIME_HOME}/.hermes/hermes-agent --hermes-home ${RUNTIME_HOME}/.hermes --skip-browser --non-interactive --stage python-deps" "${LOG_FILE}"
grep -Fq -- "--dir ${RUNTIME_HOME}/.hermes/hermes-agent --hermes-home ${RUNTIME_HOME}/.hermes --skip-browser --non-interactive --stage node-deps" "${LOG_FILE}"
grep -Fq -- "--dir ${RUNTIME_HOME}/.hermes/hermes-agent --hermes-home ${RUNTIME_HOME}/.hermes --skip-browser --non-interactive --stage path" "${LOG_FILE}"
grep -Fq -- "--dir ${RUNTIME_HOME}/.hermes/hermes-agent --hermes-home ${RUNTIME_HOME}/.hermes --skip-browser --non-interactive --stage config" "${LOG_FILE}"
grep -Fq "python-pip-install -m pip install --no-deps --force-reinstall -e ${RUNTIME_HOME}/.hermes/hermes-agent" "${LOG_FILE}"
grep -q "npm-install @qwen-code/qwen-code@latest" "${LOG_FILE}"
grep -q ".hermes/bin/uv.*--version" "${LOG_FILE}"
grep -q "uv-pip-install pip install --index-url https://mirrors.tencent.com/pypi/simple --extra-index-url https://mirrors.cloud.tencent.com/pypi/simple --python ${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/python lark-oapi==1.5.3 qrcode==7.4.2" "${LOG_FILE}"
grep -Fq "index-url = https://mirrors.tencent.com/pypi/simple" "${RUNTIME_HOME}/.config/pip/pip.conf"
grep -Fq "https://mirrors.cloud.tencent.com/pypi/simple" "${RUNTIME_HOME}/.config/pip/pip.conf"
grep -Fq 'index-url = "https://mirrors.tencent.com/pypi/simple"' "${RUNTIME_HOME}/.config/uv/uv.toml"
grep -Fq 'extra-index-url = ["https://mirrors.cloud.tencent.com/pypi/simple"]' "${RUNTIME_HOME}/.config/uv/uv.toml"
grep -Fq "chown agentuser:agentuser ${RUNTIME_HOME}/.config" "${LOG_FILE}"
grep -Fq "chmod 0700 ${RUNTIME_HOME}/.config" "${LOG_FILE}"
grep -q "sudo-npm-install pnpm" "${LOG_FILE}"
grep -q "sudo-user agentuser" "${LOG_FILE}"
grep -q "pnpm-add-whatsapp-bridge" "${LOG_FILE}"
grep -q "node-resolve-whatsapp-bridge" "${LOG_FILE}"
test -d "${RUNTIME_HOME}/.config/systemd/user"
grep -Fq "chown agentuser:agentuser ${RUNTIME_HOME}/.config ${RUNTIME_HOME}/.config/systemd ${RUNTIME_HOME}/.config/systemd/user" "${LOG_FILE}"
grep -Fq "chmod 0700 ${RUNTIME_HOME}/.config ${RUNTIME_HOME}/.config/systemd ${RUNTIME_HOME}/.config/systemd/user" "${LOG_FILE}"
grep -q "printf 'n\\\\ny\\\\n' | hermes gateway install" "${LOG_FILE}"
grep -q "hermes gateway stop" "${LOG_FILE}"
grep -q "curl-skillhub" "${LOG_FILE}"
grep -q "curl-acli" "${LOG_FILE}"
grep -q "run_as_runtime_user acli --help" "${LOG_FILE}"
grep -q "acli doctor" "${LOG_FILE}"
grep -q "acli backend --help" "${LOG_FILE}"
grep -q "acli bundle-update" "${LOG_FILE}"
grep -q "acli backend upgrade-start --blueprint-id lhbp-8gsotw6u --wait=true" "${LOG_FILE}"
grep -q '\$HOME/.hermes/hermes-agent/venv/bin' "${PROFILE_FILE}"
grep -q '\$HOME/.local/bin:\$PATH' "${PROFILE_FILE}"
grep -q '^YUANBAO_ALLOW_ALL_USERS=true$' "${HOME}/.hermes/.env"
grep -q '^product: lightvela$' "${ACLI_IDENTITY_PATH}"
grep -q '^run_as: agentuser$' "${ACLI_IDENTITY_PATH}"
grep -q "^runtime_bin: ${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/hermes$" "${ACLI_IDENTITY_PATH}"
grep -q "^runtime_home: ${RUNTIME_HOME}/.hermes$" "${ACLI_IDENTITY_PATH}"
grep -q '^runtime_version: 0.14.0$' "${ACLI_IDENTITY_PATH}"
grep -q "exec ${REAL_RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/hermes " "${HERMES_SYSTEM_BIN_DIR}/hermes"
grep -q "exec ${REAL_RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/hermes-agent " "${HERMES_SYSTEM_BIN_DIR}/hermes-agent"
! grep -q "ln -sfn ${HOME}/.hermes/hermes-agent/venv/bin/hermes ${HERMES_SYSTEM_BIN_DIR}/hermes" "${LOG_FILE}"
! grep -q "ln -sfn ${HOME}/.local/bin/hermes ${HERMES_SYSTEM_BIN_DIR}/hermes" "${LOG_FILE}"

echo "ok"
