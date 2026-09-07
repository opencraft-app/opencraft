#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "${script_dir}/.." && pwd -P)"

mac_ssh_host="${OPENCRAFT_MAC_SSH_HOST:-127.0.0.1}"
mac_ssh_port="${OPENCRAFT_MAC_SSH_PORT:-1234}"
mac_ssh_user="${OPENCRAFT_MAC_SSH_USER:-}"
mac_repo="${OPENCRAFT_MAC_REPO:-}"
mac_node_bin="${OPENCRAFT_MAC_NODE_BIN:-/opt/homebrew/bin}"
debug_port="${OPENCRAFT_MAC_DEBUG_PORT:-9223}"

remote="${mac_ssh_user}@${mac_ssh_host}"
build_log="/tmp/opencraft-mac-build.log"
runtime_log="/tmp/opencraft-mac-live.log"
app_bundle="${mac_repo}/apps/workbench-electron/release/mac-arm64/OpenCraft.app"
app_binary="${app_bundle}/Contents/MacOS/OpenCraft"

ssh_args=(
  -p "${mac_ssh_port}"
  -o BatchMode=yes
  -o ConnectTimeout=8
  -o ServerAliveInterval=30
)

usage() {
  cat <<'EOF'
Build the current OpenCraft source on the connected Mac and launch OpenCraft.app.

Usage:
  npm run update:mac
  bash scripts/update-local-mac.sh

Required environment variables:
  OPENCRAFT_MAC_SSH_USER    SSH user on the build Mac
  OPENCRAFT_MAC_REPO        absolute checkout path on the build Mac

Optional environment variables:
  OPENCRAFT_MAC_SSH_HOST    SSH host (default: 127.0.0.1)
  OPENCRAFT_MAC_SSH_PORT    SSH port (default: 1234)
  OPENCRAFT_MAC_NODE_BIN    directory containing node/npm on macOS
  OPENCRAFT_MAC_DEBUG_PORT  Electron remote-debugging port (default: 9223)
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ $# -ne 0 ]]; then
  usage >&2
  exit 2
fi

if [[ -z "${mac_ssh_user}" || "${mac_repo}" != /* ]]; then
  printf 'Set OPENCRAFT_MAC_SSH_USER and an absolute OPENCRAFT_MAC_REPO before using remote Mac builds.\n' >&2
  exit 2
fi

status() {
  printf '[opencraft-mac] %s\n' "$*"
}

remote_quote() {
  printf '%q' "$1"
}

q_mac_repo="$(remote_quote "${mac_repo}")"
q_mac_node_bin="$(remote_quote "${mac_node_bin}")"
q_build_log="$(remote_quote "${build_log}")"
q_runtime_log="$(remote_quote "${runtime_log}")"
q_app_binary="$(remote_quote "${app_binary}")"
q_debug_port="$(remote_quote "${debug_port}")"

status "checking ${remote}:${mac_ssh_port}"
ssh "${ssh_args[@]}" "${remote}" \
  "test -d ${q_mac_repo} && test -x ${q_mac_node_bin}/node" >/dev/null

status "syncing source"
rsync -az \
  -e "ssh -p ${mac_ssh_port} -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=30" \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.runtime/' \
  --exclude='hemesclient/' \
  --exclude='releases/' \
  --exclude='release/' \
  --exclude='dist/' \
  --exclude='dist-*' \
  --exclude='*.tsbuildinfo' \
  --exclude='*.log' \
  "${repo_root}/" "${remote}:${mac_repo}/"

status "building macOS arm64 release"
if ! ssh "${ssh_args[@]}" "${remote}" \
  "export PATH=${q_mac_node_bin}:\$PATH; cd ${q_mac_repo}; : > ${q_build_log}; { npm ci --no-audit --no-fund && npm run build:electron:release && cd apps/workbench-electron && CSC_IDENTITY_AUTO_DISCOVERY=false ../../node_modules/.bin/electron-builder --mac dir --arm64; } >> ${q_build_log} 2>&1"; then
  printf '[opencraft-mac] build failed; remote log follows:\n' >&2
  ssh "${ssh_args[@]}" "${remote}" "tail -n 160 ${q_build_log}" >&2 || true
  exit 1
fi

status "launching OpenCraft.app"
if ! ssh "${ssh_args[@]}" "${remote}" \
  "test -x ${q_app_binary}; pkill -f '^'${q_app_binary}'( |\$)' >/dev/null 2>&1 || true; : > ${q_runtime_log}; nohup ${q_app_binary} --enable-logging --remote-debugging-port=${q_debug_port} > ${q_runtime_log} 2>&1 </dev/null & sleep 3; pgrep -f '^'${q_app_binary}'( |\$)' >/dev/null"; then
  printf '[opencraft-mac] launch failed; remote log follows:\n' >&2
  ssh "${ssh_args[@]}" "${remote}" "tail -n 120 ${q_runtime_log}" >&2 || true
  exit 1
fi

status "ready: ${app_bundle} (CDP ${debug_port})"
