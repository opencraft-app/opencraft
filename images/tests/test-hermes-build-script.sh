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

HERMES_INSTALL_SCRIPT_URL="https://example.com/install.sh"
HERMES_INSTALL_ARGS="--skip-setup"
HERMES_COS_BASE="https://example.com/hermes"
HERMES_VERSION="hermes-agent-v20260506"
HERMES_SRC_VERSION="0.12.0"
HERMES_GIT_COMMIT="eda80e0b"
HERMES_QWEN_CODE_VERSION="latest"
HERMES_ACLI_INSTALL_URL="https://example.com/acli/install.sh"
SKILLHUB_INSTALL_URL="https://example.com/skillhub.sh"
HERMES_ENV_PROFILE_PATH="${TMPDIR}/etc/profile.d/hermes-env.sh"

LOG_FILE="${TMPDIR}/calls.log"
PROFILE_FILE="${HERMES_ENV_PROFILE_PATH}"
INSTALLER_PAYLOAD="${TMPDIR}/installer-payload.sh"
HERMES_TARBALL="${TMPDIR}/hermes-agent.tar.gz"

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

run_as_runtime_user() {
  log_call "run_as_runtime_user $*"
  eval "$*"
}

cat <<'EOF' >"${INSTALLER_PAYLOAD}"
#!/usr/bin/env bash
cat >"$HOME/.hermes/hermes-agent/venv/bin/hermes-agent" <<'INNER'
#!/usr/bin/env bash
exit 0
INNER
cat >"$HOME/.hermes/hermes-agent/venv/bin/hermes" <<'INNER'
#!/usr/bin/env bash
echo "0.12.0"
INNER
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/hermes-agent"
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/hermes"
exit 0
EOF
chmod +x "${INSTALLER_PAYLOAD}"

mkdir -p "${TMPDIR}/hermes-src/hermes-agent/venv/bin"
cat >"${TMPDIR}/hermes-src/hermes-agent/README.md" <<'EOF'
hermes fixture
EOF
tar -czf "${HERMES_TARBALL}" -C "${TMPDIR}/hermes-src" hermes-agent

curl() {
  if [[ "${1:-}" == "-fsSL" && "${2:-}" == "${HERMES_COS_BASE}/${HERMES_VERSION}/hermes-agent.tar.gz" && "${3:-}" == "-o" ]]; then
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
  command sudo "$@"
}

acli() {
  log_call "acli $*"
  return 0
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

mkdir -p "${HOME}/.local/bin" "${HOME}/.config/systemd/user"

install_hermes_runtime
install_hermes_extra_tools
install_hermes_acli

grep -q "curl-hermes-tarball" "${LOG_FILE}"
grep -q "curl-installer" "${LOG_FILE}"
grep -q "npm-install @qwen-code/qwen-code@latest" "${LOG_FILE}"
grep -q "curl-skillhub" "${LOG_FILE}"
grep -q "curl-acli" "${LOG_FILE}"
grep -q "acli doctor" "${LOG_FILE}"
grep -q '\$HOME/.hermes/hermes-agent/venv/bin' "${PROFILE_FILE}"
grep -q '\$HOME/.local/bin:\$PATH' "${PROFILE_FILE}"
grep -q '^YUANBAO_ALLOW_ALL_USERS=true$' "${HOME}/.hermes/.env"

echo "ok"
