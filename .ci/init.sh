#!/usr/bin/env bash

set -euo pipefail

ci_init_repo_root() {
  export REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$REPO_ROOT"
}

ci_require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "missing required command: $command_name" >&2
    return 1
  fi
}

ci_load_cloudflare_credentials() {
  local api_token_file="${CLOUDFLARE_API_TOKEN_FILE:-/etc/lightclaw-ci/cloudflare_api_token}"
  local account_id_file="${CLOUDFLARE_ACCOUNT_ID_FILE:-/etc/lightclaw-ci/cloudflare_account_id}"

  if [[ -r "$api_token_file" ]]; then
    export CLOUDFLARE_API_TOKEN
    CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < "$api_token_file")"
    echo "cloudflare api token loaded from file:$api_token_file"
  else
    echo "cloudflare api token loaded from settings"
  fi

  if [[ -r "$account_id_file" ]]; then
    export CLOUDFLARE_ACCOUNT_ID
    CLOUDFLARE_ACCOUNT_ID="$(tr -d '\r\n' < "$account_id_file")"
    echo "cloudflare account id loaded from file:$account_id_file"
  else
    echo "cloudflare account id loaded from settings"
  fi

  test -n "${CLOUDFLARE_API_TOKEN:-}"
  test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
}

ci_ensure_node() {
  local node_version="${NODE_VERSION_OVERRIDE:-22.12.0}"
  local node_dist="node-v${node_version}-linux-x64"
  local node_archive="${node_dist}.tar.xz"
  local node_cache_root="${HOME}/.cache/lightclaw-ci/node"
  local node_install_dir="${node_cache_root}/${node_dist}"

  mkdir -p "$node_cache_root"
  if [[ ! -x "${node_install_dir}/bin/node" ]]; then
    ci_require_command curl
    curl -fsSL "https://nodejs.org/dist/v${node_version}/${node_archive}" -o "${node_cache_root}/${node_archive}"
    tar -xJf "${node_cache_root}/${node_archive}" -C "$node_cache_root"
  fi

  export PATH="${node_install_dir}/bin:${PATH}"
  export NODE_BIN="${node_install_dir}/bin/node"
  export NPM_BIN="${node_install_dir}/bin/npm"
}

ci_ensure_pnpm() {
  local pnpm_bootstrap_root="${HOME}/.cache/lightclaw-ci/pnpm"
  local pnpm_version="${PNPM_VERSION_OVERRIDE:-10.32.1}"
  local pnpm_bin="${pnpm_bootstrap_root}/bin/pnpm"

  mkdir -p "$pnpm_bootstrap_root"
  if [[ ! -x "$pnpm_bin" ]]; then
    ci_ensure_node
    "$NPM_BIN" install -g "pnpm@${pnpm_version}" --prefix "$pnpm_bootstrap_root"
  fi

  export PNPM_BIN="$pnpm_bin"
}

ci_ensure_kubectl() {
  if [[ -n "${KUBECTL_BIN:-}" && -x "${KUBECTL_BIN}" ]]; then
    return 0
  fi

  local existing
  existing="$(command -v kubectl || true)"
  if [[ -n "$existing" ]]; then
    export KUBECTL_BIN="$existing"
    return 0
  fi

  ci_require_command curl

  local version="${KUBECTL_VERSION_OVERRIDE:-v1.31.2}"
  local machine
  machine="$(uname -m)"
  local arch=""
  case "$machine" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      echo "unsupported kubectl bootstrap architecture: $machine" >&2
      return 1
      ;;
  esac

  local system
  system="$(uname -s | tr '[:upper:]' '[:lower:]')"
  if [[ "$system" != "linux" ]]; then
    echo "unsupported kubectl bootstrap operating system: $system" >&2
    return 1
  fi

  local cache_root="${HOME}/.cache/lightclaw-ci/kubectl"
  local binary_path="${cache_root}/${version}/${system}/${arch}/kubectl"
  if [[ ! -x "$binary_path" ]]; then
    mkdir -p "$(dirname "$binary_path")"
    curl -fsSL "https://dl.k8s.io/release/${version}/bin/${system}/${arch}/kubectl" -o "$binary_path"
    chmod 755 "$binary_path"
  fi

  export KUBECTL_BIN="$binary_path"
}
