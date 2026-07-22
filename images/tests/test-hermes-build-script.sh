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
HERMES_BACKEND_BLUEPRINT_RESOLVER="${TMPDIR}/resolve-hermes-backend-blueprint-id.py"
SKILLHUB_INSTALL_URL="https://example.com/skillhub.sh"
HERMES_ENV_PROFILE_PATH="${TMPDIR}/etc/profile.d/hermes-env.sh"
HERMES_SOURCE_CACHE_DIR="${TMPDIR}/var/cache/lightclaw/hermes"
HERMES_SYSTEM_BIN_DIR="${TMPDIR}/usr-local-bin"
HERMES_SYSTEM_LINK_DIR="${TMPDIR}/usr-bin"
ACLI_IDENTITY_PATH="${TMPDIR}/etc/acli/identity.yaml"
export ACLI_IDENTITY_PATH
cat >"${HERMES_BACKEND_BLUEPRINT_RESOLVER}" <<'PY'
#!/usr/bin/env python3
print("lhbp-lyx28qje")
PY
chmod +x "${HERMES_BACKEND_BLUEPRINT_RESOLVER}"

LOG_FILE="${TMPDIR}/calls.log"
PROFILE_FILE="${HERMES_ENV_PROFILE_PATH}"
INSTALLER_PAYLOAD="${TMPDIR}/installer-payload.sh"
HERMES_TARBALL="${TMPDIR}/hermes-agent.tar.gz"
LIGHTCLAWBOT_WHL="${TMPDIR}/lightclawbot-0.0.6-py3-none-any.whl"
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
if [ "${1:-}" = "-" ]; then
  script="$(cat)"
  if [[ "$script" == *"lightclawbot"* ]]; then
    config_path="${2:-$HOME/.hermes/config.yaml}"
    cat >"$config_path" <<'YAML'
plugins:
  enabled:
  - lightclawbot
platforms:
  lightclawbot:
    enabled: true
display:
  platforms:
    lightclawbot:
      streaming: true
approvals:
  mode: off
  cron_mode: approve
  destructive_slash_confirm: false
YAML
    exit 0
  fi
fi
exit 0
INNER
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/hermes-agent"
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/hermes"
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/python"
chmod +x "$HOME/.hermes/bin/uv"
mkdir -p "$HOME/.hermes/skills/software-development/plan" \
  "$HOME/.hermes/skills/software-development/noisy-skill" \
  "$HOME/.hermes/skills/empty-category"
printf 'keep\n' >"$HOME/.hermes/skills/software-development/plan/SKILL.md"
printf 'remove\n' >"$HOME/.hermes/skills/software-development/noisy-skill/SKILL.md"
printf 'description\n' >"$HOME/.hermes/skills/empty-category/DESCRIPTION.md"
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

mkdir -p "${TMPDIR}/lightclawbot-wheel/lightclawbot/src"
cat >"${TMPDIR}/lightclawbot-wheel/lightclawbot/__init__.py" <<'EOF'
def register(ctx):
    return None
EOF
cat >"${TMPDIR}/lightclawbot-wheel/lightclawbot/plugin.yaml" <<'EOF'
name: lightclawbot
kind: platform
version: 0.0.6
requires_env:
  - LIGHTCLAW_API_KEY_${UIN}
EOF
cat >"${TMPDIR}/lightclawbot-wheel/lightclawbot/src/__init__.py" <<'EOF'
EOF
python3 - "${LIGHTCLAWBOT_WHL}" "${TMPDIR}/lightclawbot-wheel" <<'PY'
import os
import sys
import zipfile

wheel_path, root = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(wheel_path, "w") as zf:
    for dirpath, _, filenames in os.walk(root):
        for filename in filenames:
            path = os.path.join(dirpath, filename)
            zf.write(path, os.path.relpath(path, root))
PY

curl() {
  local output="" url="" prev=""
  for arg in "$@"; do
    if [[ "${prev}" == "-o" ]]; then
      output="${arg}"
    fi
    if [[ "${arg}" == http* ]]; then
      url="${arg}"
    fi
    prev="${arg}"
  done
  if [[ "${url}" == "${HERMES_PYPI_INDEX_URL%/}/lightclawbot/" && -n "${output}" ]]; then
    cat >"${output}" <<'EOF'
<html><body>
<a href="lightclawbot-0.0.6-py3-none-any.whl">lightclawbot-0.0.6-py3-none-any.whl</a>
</body></html>
EOF
    log_call "curl-lightclawbot-index"
    return 0
  fi
  if [[ "${url}" == "${HERMES_PYPI_INDEX_URL%/}/lightclawbot/lightclawbot-0.0.6-py3-none-any.whl" && -n "${output}" ]]; then
    cp "${LIGHTCLAWBOT_WHL}" "${output}"
    log_call "curl-lightclawbot-wheel ${output}"
    return 0
  fi
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
cat >"$HOME/.hermes/hermes-agent/pyproject.toml" <<'INNER'
[project]
name = "hermes-agent"
version = "0.10.0"
INNER
cat >"$HOME/.hermes/hermes-agent/hermes_cli/__init__.py" <<'INNER'
__version__ = "0.10.0"
INNER
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
  if [[ "${1:-}" == "backend" && "${2:-}" == "upgrade-start" ]]; then
    sed -i.bak -e 's/^runtime_version:.*/runtime_version: 0.10.0/' "${ACLI_IDENTITY_PATH}"
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

mkdir -p "${HOME}/.local/bin" "${HOME}/.config" "${HOME}/.openclaw" "${HOME}/.agents/skills/find-skill-skillhub"
printf 'remove\n' >"${HOME}/.agents/skills/find-skill-skillhub/SKILL.md"

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

grep -q "curl-hermes-latest" "${LOG_FILE}"
grep -q "curl-hermes-tarball" "${LOG_FILE}"
grep -q "curl-installer" "${LOG_FILE}"
grep -Fq -- "--dir ${RUNTIME_HOME}/.hermes/hermes-agent --hermes-home ${RUNTIME_HOME}/.hermes --non-interactive --stage venv" "${LOG_FILE}"
grep -Fq -- "--dir ${RUNTIME_HOME}/.hermes/hermes-agent --hermes-home ${RUNTIME_HOME}/.hermes --non-interactive --stage python-deps" "${LOG_FILE}"
grep -Fq -- "--dir ${RUNTIME_HOME}/.hermes/hermes-agent --hermes-home ${RUNTIME_HOME}/.hermes --non-interactive --stage node-deps" "${LOG_FILE}"
grep -Fq -- "--dir ${RUNTIME_HOME}/.hermes/hermes-agent --hermes-home ${RUNTIME_HOME}/.hermes --non-interactive --stage path" "${LOG_FILE}"
grep -Fq -- "--dir ${RUNTIME_HOME}/.hermes/hermes-agent --hermes-home ${RUNTIME_HOME}/.hermes --non-interactive --stage config" "${LOG_FILE}"
! grep -q -- "--skip-browser" "${LOG_FILE}"
grep -Fq "uv-pip-install pip install --python ${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/python --no-deps --reinstall-package hermes-agent -e ${RUNTIME_HOME}/.hermes/hermes-agent" "${LOG_FILE}"
test "$(grep -Fc "uv-pip-install pip install --python ${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/python --no-deps --reinstall-package hermes-agent -e ${RUNTIME_HOME}/.hermes/hermes-agent" "${LOG_FILE}")" -ge 2
grep -q "npm-install @qwen-code/qwen-code@latest" "${LOG_FILE}"
grep -q ".hermes/bin/uv.*--version" "${LOG_FILE}"
grep -q "uv-pip-install pip install --index-url https://mirrors.tencent.com/pypi/simple --extra-index-url https://mirrors.cloud.tencent.com/pypi/simple --python ${RUNTIME_HOME}/.hermes/hermes-agent/venv/bin/python lark-oapi==1.5.3 qrcode==7.4.2" "${LOG_FILE}"
grep -q "curl-lightclawbot-index" "${LOG_FILE}"
grep -q "curl-lightclawbot-wheel" "${LOG_FILE}"
test -f "${RUNTIME_HOME}/.hermes/plugins/lightclawbot/plugin.yaml"
grep -q '^name: lightclawbot$' "${RUNTIME_HOME}/.hermes/plugins/lightclawbot/plugin.yaml"
grep -q 'lightclawbot' "${RUNTIME_HOME}/.hermes/config.yaml"
grep -q '^LIGHTCLAW_ALLOW_ALL_USERS=true$' "${RUNTIME_HOME}/.hermes/.env"
! grep -q '^LIGHTCLAW_API_KEY' "${RUNTIME_HOME}/.hermes/.env"
python3 - "${RUNTIME_HOME}/.hermes/sessions/agents.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)
assert data["agents"][0]["id"] == "main"
PY
grep -q '^approvals:$' "${RUNTIME_HOME}/.hermes/config.yaml"
grep -q '^  mode: off$' "${RUNTIME_HOME}/.hermes/config.yaml"
grep -q '^  cron_mode: approve$' "${RUNTIME_HOME}/.hermes/config.yaml"
grep -q '^  destructive_slash_confirm: false$' "${RUNTIME_HOME}/.hermes/config.yaml"
test ! -e "${RUNTIME_HOME}/.agents/skills/find-skill-skillhub"
test ! -e "${RUNTIME_HOME}/.openclaw"
grep -Fq "index-url = https://mirrors.tencent.com/pypi/simple" "${RUNTIME_HOME}/.config/pip/pip.conf"
grep -Fq "https://mirrors.cloud.tencent.com/pypi/simple" "${RUNTIME_HOME}/.config/pip/pip.conf"
grep -Fq 'index-url = "https://mirrors.tencent.com/pypi/simple"' "${RUNTIME_HOME}/.config/uv/uv.toml"
grep -Fq 'extra-index-url = ["https://mirrors.cloud.tencent.com/pypi/simple"]' "${RUNTIME_HOME}/.config/uv/uv.toml"
grep -Fq "chown agentuser:agentuser ${RUNTIME_HOME}/.config" "${LOG_FILE}"
grep -Fq "chmod 0700 ${RUNTIME_HOME}/.config" "${LOG_FILE}"
grep -q "sudo-npm-install pnpm" "${LOG_FILE}"
grep -q "sudo-user agentuser" "${LOG_FILE}"
grep -q "pnpm-add-whatsapp-bridge" "${LOG_FILE}"
test "$(grep -c "pnpm-add-whatsapp-bridge" "${LOG_FILE}")" -ge 2
grep -q "node-resolve-whatsapp-bridge" "${LOG_FILE}"
test "$(grep -c "node-resolve-whatsapp-bridge" "${LOG_FILE}")" -ge 2
test -d "${RUNTIME_HOME}/.config/systemd/user"
grep -Fq "chown agentuser:agentuser ${RUNTIME_HOME}/.config ${RUNTIME_HOME}/.config/systemd ${RUNTIME_HOME}/.config/systemd/user" "${LOG_FILE}"
grep -Fq "chmod 0700 ${RUNTIME_HOME}/.config ${RUNTIME_HOME}/.config/systemd ${RUNTIME_HOME}/.config/systemd/user" "${LOG_FILE}"
grep -q "printf 'n\\\\ny\\\\n' | hermes gateway install" "${LOG_FILE}"
grep -q "hermes gateway stop" "${LOG_FILE}"
grep -q "curl-skillhub" "${LOG_FILE}"
grep -Fq 'version = "0.14.0"' "${RUNTIME_HOME}/.hermes/hermes-agent/pyproject.toml"
grep -Fq '__version__ = "0.14.0"' "${RUNTIME_HOME}/.hermes/hermes-agent/hermes_cli/__init__.py"
grep -q "curl-acli" "${LOG_FILE}"
grep -q "run_as_runtime_user acli --help" "${LOG_FILE}"
grep -q "acli doctor" "${LOG_FILE}"
grep -q "acli backend --help" "${LOG_FILE}"
grep -q "acli bundle-update" "${LOG_FILE}"
grep -q "acli backend upgrade-start --blueprint-id lhbp-lyx28qje --wait=true --force=true" "${LOG_FILE}"
grep -q '\$HOME/.hermes/hermes-agent/venv/bin' "${PROFILE_FILE}"
grep -q '\$HOME/.local/bin:\$PATH' "${PROFILE_FILE}"
grep -q 'XDG_RUNTIME_DIR=.*run/user/.*id -u' "${PROFILE_FILE}"
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
test -f "${RUNTIME_HOME}/.hermes/skills/software-development/plan/SKILL.md"
test ! -e "${RUNTIME_HOME}/.hermes/skills/software-development/noisy-skill"
test ! -e "${RUNTIME_HOME}/.hermes/skills/empty-category"

echo "ok"
