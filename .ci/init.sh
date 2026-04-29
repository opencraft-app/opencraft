#!/usr/bin/env bash

set -euo pipefail

ci_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

ci_log() {
  echo "[$(ci_now)] [ci-init] $*"
}

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

ci_require_commands() {
  local command_name
  for command_name in "$@"; do
    ci_require_command "$command_name"
  done
}

ci_gitops_remote_url() {
  if [[ -n "${GITOPS_REMOTE_URL:-}" ]]; then
    printf '%s\n' "$GITOPS_REMOTE_URL"
    return 0
  fi

  if git remote get-url origin >/dev/null 2>&1; then
    git remote get-url origin
    return 0
  fi

  printf '%s\n' "git@git.woa.com:wisp/mono2.git"
}

ci_export_gongfeng_defaults() {
  export GIT_WOA_API_BASE="${GIT_WOA_API_BASE:-https://git.woa.com/api/v3}"
  export GITOPS_PROJECT_ID="${GITOPS_PROJECT_ID:-1731878}"
  export GITOPS_REPO_PATH="${GITOPS_REPO_PATH:-wisp/mono2}"
}

ci_require_gitops_validation_tools() {
  ci_require_commands python3 kustomize sops ksops
  ci_log "gitops validation tools found: kustomize=$(command -v kustomize) sops=$(command -v sops) ksops=$(command -v ksops)"
}

ci_prepare_sops_age_key() {
  local default_key_file="/etc/lightclaw-ci/sops-age.keys.txt"
  local temp_key_file=""

  if [[ -n "${SOPS_AGE_KEY_FILE:-}" ]]; then
    if [[ ! -r "$SOPS_AGE_KEY_FILE" ]]; then
      echo "SOPS_AGE_KEY_FILE is set but not readable: $SOPS_AGE_KEY_FILE" >&2
      return 1
    fi
    export SOPS_AGE_KEY_FILE
    ci_log "sops age key file selected from env:SOPS_AGE_KEY_FILE path=${SOPS_AGE_KEY_FILE}"
    return 0
  fi

  if [[ -r "$default_key_file" ]]; then
    export SOPS_AGE_KEY_FILE="$default_key_file"
    ci_log "sops age key file selected from default path=${SOPS_AGE_KEY_FILE}"
    return 0
  fi

  if [[ -n "${SOPS_AGE_KEY:-}" ]]; then
    temp_key_file="$(mktemp "${TMPDIR:-/tmp}/lightclaw-sops-age.XXXXXX")"
    chmod 600 "$temp_key_file"
    printf '%s\n' "$SOPS_AGE_KEY" > "$temp_key_file"
    export SOPS_AGE_KEY_FILE="$temp_key_file"
    export CI_SOPS_AGE_KEY_TEMP_FILE="$temp_key_file"
    ci_log "sops age key file created from env:SOPS_AGE_KEY path=${SOPS_AGE_KEY_FILE}"
    trap ci_cleanup_sops_age_key EXIT
    return 0
  fi

  echo "missing SOPS age key; set SOPS_AGE_KEY_FILE, provide ${default_key_file}, or set SOPS_AGE_KEY" >&2
  return 1
}

ci_cleanup_sops_age_key() {
  if [[ -n "${CI_SOPS_AGE_KEY_TEMP_FILE:-}" && -f "$CI_SOPS_AGE_KEY_TEMP_FILE" ]]; then
    rm -f "$CI_SOPS_AGE_KEY_TEMP_FILE"
    ci_log "removed temporary sops age key file"
  fi
}

ci_read_secret_value() {
  python3 -c 'import sys; print(sys.stdin.read().strip())'
}

ci_fingerprint_secret() {
  python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.read().encode()).hexdigest()[:12])'
}

ci_with_lock() {
  local lock_name="$1"
  shift

  local lock_root="${CI_BOOTSTRAP_LOCK_ROOT:-${HOME}/.cache/lightclaw-ci/locks}"
  local lock_timeout="${CI_BOOTSTRAP_LOCK_TIMEOUT_SECONDS:-600}"
  local lock_poll="${CI_BOOTSTRAP_LOCK_POLL_SECONDS:-2}"
  local lock_dir="${lock_root}/${lock_name}.lock"
  local owner_file="${lock_dir}/owner"
  local start_ts now elapsed owner=""

  mkdir -p "$lock_root"
  start_ts="$(date +%s)"

  while ! mkdir "$lock_dir" 2>/dev/null; do
    now="$(date +%s)"
    elapsed=$((now - start_ts))
    if (( elapsed >= lock_timeout )); then
      if [[ -r "$owner_file" ]]; then
        owner="$(cat "$owner_file")"
      else
        owner="unknown"
      fi
      ci_log "timed out waiting for lock ${lock_name} after ${elapsed}s (owner=${owner})"
      return 1
    fi

    if [[ -r "$owner_file" ]]; then
      owner="$(cat "$owner_file")"
      ci_log "waiting for lock ${lock_name} (${elapsed}s elapsed, owner=${owner})"
    else
      ci_log "waiting for lock ${lock_name} (${elapsed}s elapsed)"
    fi
    sleep "$lock_poll"
  done

  printf '%s\n' "$$ $(hostname) $(ci_now)" > "$owner_file"
  ci_log "acquired lock ${lock_name}"

  cleanup_lock() {
    rm -rf "$lock_dir"
    ci_log "released lock ${lock_name}"
  }

  trap cleanup_lock RETURN
  "$@"
}

ci_prepare_runtime_ref() {
  local runtime_ref="${1:-${CI_RUNTIME_REF:-origin/master}}"
  ci_require_commands git
  git fetch origin master --tags
  export CI_RUNTIME_REF="$runtime_ref"
  export CI_RUNTIME_COMMIT
  CI_RUNTIME_COMMIT="$(git rev-parse "${runtime_ref}")"
  ci_log "runtime ref resolved: CI_RUNTIME_REF=${CI_RUNTIME_REF} CI_RUNTIME_COMMIT=${CI_RUNTIME_COMMIT}"
}

ci_materialize_runtime_files() {
  local runtime_dir="$1"
  shift

  if [[ -z "${CI_RUNTIME_COMMIT:-}" ]]; then
    echo "CI_RUNTIME_COMMIT is not set; call ci_prepare_runtime_ref first" >&2
    return 1
  fi

  mkdir -p "${runtime_dir}/.ci" "${runtime_dir}/.ci/runtime"

  local repo_path
  for repo_path in "$@"; do
    mkdir -p "${runtime_dir}/$(dirname "${repo_path}")"
    git show "${CI_RUNTIME_COMMIT}:${repo_path}" > "${runtime_dir}/${repo_path}"
  done
}

ci_bootstrap_node_locked() {
  local node_version="$1"
  local node_archive="$2"
  local node_cache_root="$3"
  local node_install_dir="$4"

  ci_require_command curl
  if [[ ! -x "${node_install_dir}/bin/node" ]]; then
    ci_log "bootstrapping Node.js ${node_version} into ${node_install_dir}"
    curl -fsSL "https://nodejs.org/dist/v${node_version}/${node_archive}" -o "${node_cache_root}/${node_archive}"
    tar -xJf "${node_cache_root}/${node_archive}" -C "$node_cache_root"
  else
    ci_log "Node.js ${node_version} already present at ${node_install_dir}"
  fi
}

ci_bootstrap_pnpm_locked() {
  local pnpm_version="$1"
  local pnpm_bootstrap_root="$2"
  local pnpm_bin="$3"
  local npm_bin="$4"

  if [[ ! -x "$pnpm_bin" ]]; then
    ci_log "bootstrapping pnpm ${pnpm_version} into ${pnpm_bootstrap_root}"
    "$npm_bin" install -g "pnpm@${pnpm_version}" --prefix "$pnpm_bootstrap_root"
  else
    ci_log "pnpm ${pnpm_version} already present at ${pnpm_bin}"
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
  elif [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    echo "cloudflare account id loaded from settings"
  else
    echo "cloudflare account id is not configured"
  fi
}

ci_load_edgeone_credentials() {
  local api_token_file="${EDGEONE_API_TOKEN_FILE:-/etc/lightclaw-ci/edgeone_api_token}"

  if [[ -r "$api_token_file" ]]; then
    export EDGEONE_API_TOKEN
    EDGEONE_API_TOKEN="$(tr -d '\r\n' < "$api_token_file")"
    echo "edgeone api token loaded from file:$api_token_file"
  elif [[ -n "${EDGEONE_API_TOKEN:-}" ]]; then
    echo "edgeone api token loaded from settings"
  else
    echo "edgeone api token is not configured"
  fi
}

ci_load_git_woa_private_token() {
  local token_file="${GIT_WOA_PRIVATE_TOKEN_FILE:-/etc/lightclaw-ci/git_woa_private_token}"

  if [[ -r "$token_file" ]]; then
    ci_read_secret_value < "$token_file"
    return 0
  fi

  if [[ -n "${GIT_WOA_PRIVATE_TOKEN:-}" ]]; then
    printf '%s' "$GIT_WOA_PRIVATE_TOKEN" | ci_read_secret_value
    return 0
  fi

  return 1
}

ci_load_registry_password() {
  local env_name="$1"
  local beijing_file="${TCR_BEIJING_PASSWORD_FILE:-/etc/lightclaw-ci/tcr_beijing_password}"
  local shprod_file="${TCR_SHPROD_PASSWORD_FILE:-/etc/lightclaw-ci/tcr_shprod_password}"
  local password_var=""
  local password_file=""

  case "$env_name" in
    beijing-sandbox)
      password_var="${TCR_BEIJING_PASSWORD:-}"
      password_file="$beijing_file"
      ;;
    shprod)
      password_var="${TCR_SHPROD_PASSWORD:-}"
      password_file="$shprod_file"
      ;;
    *)
      return 1
      ;;
  esac

  if [[ -r "$password_file" ]]; then
    printf '%s' "$(ci_read_secret_value < "$password_file")"
    return 0
  fi

  if [[ -n "$password_var" ]]; then
    printf '%s' "$password_var" | ci_read_secret_value
    return 0
  fi

  return 1
}

ci_set_registry_credentials() {
  local env_name="$1"
  local beijing_file="${TCR_BEIJING_PASSWORD_FILE:-/etc/lightclaw-ci/tcr_beijing_password}"
  local shprod_file="${TCR_SHPROD_PASSWORD_FILE:-/etc/lightclaw-ci/tcr_shprod_password}"
  local tcr_username="${TCR_USERNAME:-100045199955}"
  local raw_password=""
  local password=""
  local source="none"

  unset REGISTRY_USERNAME REGISTRY_PASSWORD REGISTRY_PASSWORD_SOURCE

  if raw_password="$(ci_load_registry_password "$env_name")"; then
    password="$(printf '%s' "$raw_password" | ci_read_secret_value)"
    case "$env_name" in
      beijing-sandbox)
        if [[ -r "$beijing_file" ]]; then
          source="file:$beijing_file"
        else
          source="env:TCR_BEIJING_PASSWORD"
        fi
        ;;
      shprod)
        if [[ -r "$shprod_file" ]]; then
          source="file:$shprod_file"
        else
          source="env:TCR_SHPROD_PASSWORD"
        fi
        ;;
    esac
    export REGISTRY_USERNAME="$tcr_username"
    export REGISTRY_PASSWORD="$password"
    export REGISTRY_PASSWORD_SOURCE="$source"
    ci_log "registry credentials for ${env_name} loaded from ${source} (username=${REGISTRY_USERNAME}, raw_password_len=${#raw_password}, password_len=${#REGISTRY_PASSWORD}, password_trimmed=$([[ \"$raw_password\" == \"$password\" ]] && echo no || echo yes), password_fingerprint=$(printf '%s' \"$password\" | ci_fingerprint_secret))"
    return 0
  fi

  echo "registry credentials for ${env_name} are not configured; push is expected to fail" >&2
  return 1
}

ci_ensure_node() {
  local node_version="${NODE_VERSION_OVERRIDE:-22.12.0}"
  local node_dist="node-v${node_version}-linux-x64"
  local node_archive="${node_dist}.tar.xz"
  local node_cache_root="${HOME}/.cache/lightclaw-ci/node"
  local node_install_dir="${node_cache_root}/${node_dist}"

  mkdir -p "$node_cache_root"
  if [[ ! -x "${node_install_dir}/bin/node" ]]; then
    ci_with_lock "node-${node_version}" ci_bootstrap_node_locked "$node_version" "$node_archive" "$node_cache_root" "$node_install_dir"
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
    ci_with_lock "pnpm-${pnpm_version}" ci_bootstrap_pnpm_locked "$pnpm_version" "$pnpm_bootstrap_root" "$pnpm_bin" "$NPM_BIN"
  fi

  export PNPM_BIN="$pnpm_bin"
}
