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

ci_os_name() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    *) echo "unsupported os: $(uname -s)" >&2; return 1 ;;
  esac
}

ci_arch_name() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'amd64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *) echo "unsupported arch: $(uname -m)" >&2; return 1 ;;
  esac
}

ci_tune_staticpages_upload_tcp() {
  if [[ "${CI_STATICPAGES_TCP_TUNING:-1}" == "0" ]]; then
    ci_log "staticpages tcp tuning disabled by CI_STATICPAGES_TCP_TUNING=0"
    return 0
  fi

  if [[ "$(ci_os_name)" != "linux" ]]; then
    ci_log "staticpages tcp tuning skipped on non-linux host"
    return 0
  fi

  if [[ "$(id -u)" -ne 0 ]]; then
    ci_log "staticpages tcp tuning skipped because current user is not root"
    return 0
  fi

  local conf_path="${CI_STATICPAGES_TCP_SYSCTL_CONF:-/etc/sysctl.d/99-lightclaw-ci-tcp-upload.conf}"
  local qdisc="${CI_STATICPAGES_TCP_QDISC:-fq}"
  local congestion="${CI_STATICPAGES_TCP_CONGESTION:-bbr}"
  local buffer_max="${CI_STATICPAGES_TCP_BUFFER_MAX:-134217728}"

  if [[ "$congestion" == "bbr" ]] && command -v modprobe >/dev/null 2>&1; then
    modprobe tcp_bbr >/dev/null 2>&1 || ci_log "tcp_bbr module is not loadable; sysctl will keep the current congestion control if bbr is unavailable"
  fi

  mkdir -p "$(dirname "$conf_path")"
  cat > "$conf_path" <<EOF
# LightClaw CI: improve long-RTT StaticPages archive uploads to Beijing.
net.core.rmem_max = ${buffer_max}
net.core.wmem_max = ${buffer_max}
net.ipv4.tcp_rmem = 4096 87380 ${buffer_max}
net.ipv4.tcp_wmem = 4096 65536 ${buffer_max}
net.core.default_qdisc = ${qdisc}
net.ipv4.tcp_congestion_control = ${congestion}
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_slow_start_after_idle = 0
EOF

  if sysctl -p "$conf_path"; then
    ci_log "staticpages tcp tuning applied from ${conf_path}"
    return 0
  fi

  ci_log "staticpages tcp tuning failed to apply from ${conf_path}; continuing without blocking preview build"
  return 0
}

ci_is_unexpanded_setting() {
  [[ "$1" == *'${{'*'settings.'*'}}'* ]]
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
  ci_ensure_gitops_validation_tools
  ci_require_commands python3 kustomize sops ksops
  ci_log "gitops validation tools found: kustomize=$(command -v kustomize) sops=$(command -v sops) ksops=$(command -v ksops)"
}

ci_ensure_db_job_tools() {
  ci_ensure_kubectl
  ci_ensure_sops
  ci_require_commands python3 kubectl sops openssl
  ci_prepare_sops_age_key
  ci_log "db job tools found: kubectl=$(command -v kubectl) sops=$(command -v sops) openssl=$(command -v openssl)"
}

ci_ensure_gitops_validation_tools() {
  ci_ensure_kustomize
  ci_ensure_sops
  ci_ensure_ksops
}

ci_download_file() {
  local url="$1"
  local output="$2"

  ci_require_command curl
  ci_log "downloading ${url}"
  curl -fsSL "$url" -o "$output"
}

ci_ensure_kustomize() {
  local version="${KUSTOMIZE_VERSION_OVERRIDE:-5.4.3}"
  local os arch archive cache_root install_dir bin url

  os="$(ci_os_name)"
  arch="$(ci_arch_name)"
  archive="kustomize_v${version}_${os}_${arch}.tar.gz"
  cache_root="${HOME}/.cache/lightclaw-ci/gitops-tools/kustomize"
  install_dir="${cache_root}/v${version}/${os}/${arch}"
  bin="${install_dir}/kustomize"
  url="https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v${version}/${archive}"

  if [[ ! -x "$bin" ]]; then
    ci_with_lock "kustomize-${version}-${os}-${arch}" ci_install_kustomize "$url" "$archive" "$cache_root" "$install_dir"
  else
    ci_log "kustomize ${version} already present at ${bin}"
  fi

  export PATH="${install_dir}:${PATH}"
}

ci_install_kustomize() {
  local url="$1"
  local archive="$2"
  local cache_root="$3"
  local install_dir="$4"

  mkdir -p "$cache_root" "$install_dir"
  ci_download_file "$url" "${cache_root}/${archive}"
  tar -xzf "${cache_root}/${archive}" -C "$install_dir" kustomize
  chmod +x "${install_dir}/kustomize"
  ci_log "installed kustomize at ${install_dir}/kustomize"
}

ci_ensure_kubectl() {
  if command -v kubectl >/dev/null 2>&1; then
    ci_log "kubectl already present at $(command -v kubectl)"
    return 0
  fi

  local version="${KUBECTL_VERSION_OVERRIDE:-v1.36.0}"
  local os arch cache_root install_dir bin url

  os="$(ci_os_name)"
  arch="$(ci_arch_name)"
  cache_root="${HOME}/.cache/lightclaw-ci/gitops-tools/kubectl"
  install_dir="${cache_root}/${version}/${os}/${arch}"
  bin="${install_dir}/kubectl"
  url="https://dl.k8s.io/release/${version}/bin/${os}/${arch}/kubectl"

  if [[ ! -x "$bin" ]]; then
    ci_with_lock "kubectl-${version}-${os}-${arch}" ci_install_kubectl "$url" "$install_dir"
  else
    ci_log "kubectl ${version} already present at ${bin}"
  fi

  export PATH="${install_dir}:${PATH}"
}

ci_install_kubectl() {
  local url="$1"
  local install_dir="$2"

  mkdir -p "$install_dir"
  ci_download_file "$url" "${install_dir}/kubectl"
  chmod +x "${install_dir}/kubectl"
  ci_log "installed kubectl at ${install_dir}/kubectl"
}

ci_ensure_sops() {
  local version="${SOPS_VERSION_OVERRIDE:-3.9.1}"
  local os arch sops_os sops_arch cache_root install_dir bin url

  os="$(ci_os_name)"
  arch="$(ci_arch_name)"
  sops_os="$os"
  sops_arch="$arch"
  cache_root="${HOME}/.cache/lightclaw-ci/gitops-tools/sops"
  install_dir="${cache_root}/v${version}/${os}/${arch}"
  bin="${install_dir}/sops"
  url="https://github.com/getsops/sops/releases/download/v${version}/sops-v${version}.${sops_os}.${sops_arch}"

  if [[ ! -x "$bin" ]]; then
    ci_with_lock "sops-${version}-${os}-${arch}" ci_install_sops "$url" "$install_dir"
  else
    ci_log "sops ${version} already present at ${bin}"
  fi

  export PATH="${install_dir}:${PATH}"
}

ci_install_sops() {
  local url="$1"
  local install_dir="$2"

  mkdir -p "$install_dir"
  ci_download_file "$url" "${install_dir}/sops"
  chmod +x "${install_dir}/sops"
  ci_log "installed sops at ${install_dir}/sops"
}

ci_ensure_ksops() {
  local version="${KSOPS_VERSION_OVERRIDE:-4.5.1}"
  local os arch ksops_os ksops_arch archive cache_root install_dir bin plugin_home plugin_bin url

  os="$(ci_os_name)"
  arch="$(ci_arch_name)"
  case "$os" in
    linux) ksops_os="Linux" ;;
    darwin) ksops_os="Darwin" ;;
    *) echo "unsupported ksops os: $os" >&2; return 1 ;;
  esac
  case "$arch" in
    amd64) ksops_arch="x86_64" ;;
    arm64) ksops_arch="arm64" ;;
    *) echo "unsupported ksops arch: $arch" >&2; return 1 ;;
  esac

  archive="ksops_${version}_${ksops_os}_${ksops_arch}.tar.gz"
  cache_root="${HOME}/.cache/lightclaw-ci/gitops-tools/ksops"
  install_dir="${cache_root}/v${version}/${os}/${arch}"
  bin="${install_dir}/ksops"
  plugin_home="${KUSTOMIZE_PLUGIN_HOME:-${HOME}/.config/kustomize/plugin}"
  plugin_bin="${plugin_home}/viaduct.ai/v1/ksops/ksops"
  url="https://github.com/viaduct-ai/kustomize-sops/releases/download/v${version}/${archive}"

  if [[ ! -x "$bin" || ! -x "$plugin_bin" ]]; then
    ci_with_lock "ksops-${version}-${os}-${arch}" ci_install_ksops "$url" "$archive" "$cache_root" "$install_dir" "$plugin_bin"
  else
    ci_log "ksops ${version} already present at ${bin} and ${plugin_bin}"
  fi

  export KUSTOMIZE_PLUGIN_HOME="$plugin_home"
  export PATH="${install_dir}:${PATH}"
}

ci_install_ksops() {
  local url="$1"
  local archive="$2"
  local cache_root="$3"
  local install_dir="$4"
  local plugin_bin="$5"

  mkdir -p "$cache_root" "$install_dir" "$(dirname "$plugin_bin")"
  ci_download_file "$url" "${cache_root}/${archive}"
  tar -xzf "${cache_root}/${archive}" -C "$install_dir" ksops
  chmod +x "${install_dir}/ksops"
  cp "${install_dir}/ksops" "$plugin_bin"
  chmod +x "$plugin_bin"
  ci_log "installed ksops at ${install_dir}/ksops and ${plugin_bin}"
}

ci_prepare_sops_age_key() {
  local default_key_file="/etc/lightclaw-ci/sops-age.keys.txt"
  local user_key_file="${HOME}/.config/sops/age/keys.txt"
  local root_key_file="/.config/sops/age/keys.txt"
  local temp_key_file=""
  local env_key_file="${SOPS_AGE_KEY_FILE:-}"
  local env_key="${SOPS_AGE_KEY:-}"

  if ci_is_unexpanded_setting "$env_key_file"; then
    ci_log "SOPS_AGE_KEY_FILE contains an unexpanded CI settings placeholder; ignoring it"
    env_key_file=""
    unset SOPS_AGE_KEY_FILE
  fi
  if ci_is_unexpanded_setting "$env_key"; then
    ci_log "SOPS_AGE_KEY contains an unexpanded CI settings placeholder; ignoring it"
    env_key=""
    unset SOPS_AGE_KEY
  fi

  if [[ -n "$env_key_file" ]]; then
    if [[ ! -r "$env_key_file" ]]; then
      echo "SOPS_AGE_KEY_FILE is set but not readable: $env_key_file" >&2
      return 1
    fi
    export SOPS_AGE_KEY_FILE="$env_key_file"
    ci_log "sops age key file selected from env:SOPS_AGE_KEY_FILE path=${SOPS_AGE_KEY_FILE}"
    return 0
  fi

  if [[ -r "$default_key_file" ]]; then
    export SOPS_AGE_KEY_FILE="$default_key_file"
    ci_log "sops age key file selected from default path=${SOPS_AGE_KEY_FILE}"
    return 0
  fi

  if [[ -r "$user_key_file" ]]; then
    export SOPS_AGE_KEY_FILE="$user_key_file"
    ci_log "sops age key file selected from user path=${SOPS_AGE_KEY_FILE}"
    return 0
  fi

  if [[ -r "$root_key_file" ]]; then
    export SOPS_AGE_KEY_FILE="$root_key_file"
    ci_log "sops age key file selected from root path=${SOPS_AGE_KEY_FILE}"
    return 0
  fi

  if [[ -n "$env_key" ]]; then
    temp_key_file="$(mktemp "${TMPDIR:-/tmp}/lightclaw-sops-age.XXXXXX")"
    chmod 600 "$temp_key_file"
    printf '%s\n' "$env_key" > "$temp_key_file"
    export SOPS_AGE_KEY_FILE="$temp_key_file"
    export CI_SOPS_AGE_KEY_TEMP_FILE="$temp_key_file"
    ci_log "sops age key file created from env:SOPS_AGE_KEY path=${SOPS_AGE_KEY_FILE}"
    trap ci_cleanup_sops_age_key EXIT
    return 0
  fi

  echo "missing SOPS age key; set SOPS_AGE_KEY_FILE, provide ${default_key_file}, provide ${user_key_file}, provide ${root_key_file}, or set SOPS_AGE_KEY" >&2
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

  local status=0
  "$@" || status=$?
  rm -rf "$lock_dir"
  ci_log "released lock ${lock_name}"
  return "$status"
}

ci_prepare_runtime_ref() {
  local runtime_ref="${1:-${CI_RUNTIME_REF:-origin/master}}"
  ci_require_commands git
  ci_git_fetch_origin master --tags
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

ci_generate_release_bundle_manifest() {
  local runtime_dir="$1"
  local generator="${runtime_dir}/.ci/runtime/commands/generate_release_bundle_manifest.py"
  local source_dir="${runtime_dir}/.ci/runtime/bundles"
  local output_path="${runtime_dir}/.ci/runtime/release-bundles.manifest"

  if [[ -f "$generator" && -d "$source_dir" ]]; then
    ci_require_commands python3
    python3 "$generator" \
      --source-dir "$source_dir" \
      --output "$output_path" >/dev/null
  fi
}

ci_materialize_runtime_manifest() {
  local runtime_dir="$1"
  local manifest_path="${2:-.ci/runtime/materialize-files.txt}"

  if [[ -z "${CI_RUNTIME_COMMIT:-}" ]]; then
    echo "CI_RUNTIME_COMMIT is not set; call ci_prepare_runtime_ref first" >&2
    return 1
  fi

  local manifest_content
  if ! manifest_content="$(git show "${CI_RUNTIME_COMMIT}:${manifest_path}")"; then
    echo "failed to read runtime materialize manifest: ${manifest_path} at ${CI_RUNTIME_COMMIT}" >&2
    return 1
  fi

  local runtime_files=()
  local repo_path
  while IFS= read -r repo_path; do
    repo_path="${repo_path%%#*}"
    repo_path="${repo_path#"${repo_path%%[![:space:]]*}"}"
    repo_path="${repo_path%"${repo_path##*[![:space:]]}"}"
    [[ -z "$repo_path" ]] && continue
    case "$repo_path" in
      .ci/runtime/*) ;;
      *)
        echo "runtime materialize manifest may only reference .ci/runtime/* paths: ${repo_path}" >&2
        return 1
        ;;
    esac
    runtime_files+=("$repo_path")
  done <<< "$manifest_content"

  if [[ "${#runtime_files[@]}" -eq 0 ]]; then
    echo "runtime materialize manifest is empty: ${manifest_path}" >&2
    return 1
  fi

  ci_materialize_runtime_files "$runtime_dir" "${runtime_files[@]}"
  ci_generate_release_bundle_manifest "$runtime_dir"
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
  local raw_token=""
  local token=""
  local source=""

  if [[ -r "$api_token_file" ]]; then
    raw_token="$(cat "$api_token_file")"
    token="$(printf '%s' "$raw_token" | ci_read_secret_value)"
    source="file:$api_token_file"
  elif [[ -n "${EDGEONE_API_TOKEN:-}" ]]; then
    raw_token="$EDGEONE_API_TOKEN"
    token="$(printf '%s' "$raw_token" | ci_read_secret_value)"
    source="settings"
  else
    if [[ "${EDGEONE_API_TOKEN_REQUIRED:-}" == "1" ]]; then
      echo "edgeone api token is required but not configured" >&2
      return 1
    fi
    echo "edgeone api token is not configured"
    return 0
  fi

  if [[ -z "$token" ]]; then
    echo "edgeone api token loaded from ${source} but is empty after trimming" >&2
    return 1
  fi

  if [[ "$token" == '${{'* ]]; then
    echo "edgeone api token loaded from ${source} but still looks like an unresolved CI settings expression" >&2
    return 1
  fi

  export EDGEONE_API_TOKEN="$token"
  export EDGEONE_API_TOKEN_SOURCE="$source"
  ci_log "edgeone api token loaded from ${source} (raw_token_len=${#raw_token}, token_len=${#EDGEONE_API_TOKEN}, token_trimmed=$([[ "$raw_token" == "$token" ]] && echo no || echo yes), token_fingerprint=$(printf '%s' "$EDGEONE_API_TOKEN" | ci_fingerprint_secret))"
}

ci_frontend_release_matrix_needs_edgeone() {
  local matrix="${1:-}"
  matrix="$(printf '%s' "$matrix" | tr -d '[:space:]')"
  if [[ -z "$matrix" ]]; then
    return 0
  fi
  [[ ",${matrix}," == *",eo:"* ]]
}

ci_load_git_woa_private_token() {
  local token_file="${GIT_WOA_PRIVATE_TOKEN_FILE:-/etc/lightclaw-ci/git_woa_private_token}"

  if [[ -r "$token_file" ]]; then
    ci_read_secret_value < "$token_file"
    return 0
  fi

  if [[ -n "${GIT_WOA_PRIVATE_TOKEN:-}" ]]; then
    if ci_is_unexpanded_setting "$GIT_WOA_PRIVATE_TOKEN"; then
      ci_log "GIT_WOA_PRIVATE_TOKEN contains an unexpanded CI settings placeholder; ignoring it"
      return 1
    fi
    printf '%s' "$GIT_WOA_PRIVATE_TOKEN" | ci_read_secret_value
    return 0
  fi

  return 1
}

ci_git_fetch_origin() {
  ci_require_commands git

  local fetch_url="${CI_GIT_FETCH_REMOTE_URL:-git@git.woa.com:wisp/mono2.git}"
  local fetch_args=()
  local arg
  for arg in "$@"; do
    case "$arg" in
      -* | *:*)
        fetch_args+=("$arg")
        ;;
      *)
        fetch_args+=("+refs/heads/${arg}:refs/remotes/origin/${arg}")
        ;;
    esac
  done

  ci_log "git fetch ${fetch_url} ${fetch_args[*]}"
  if GIT_TERMINAL_PROMPT=0 git fetch "$fetch_url" "${fetch_args[@]}"; then
    return 0
  fi

  ci_log "git fetch via ${fetch_url} failed; falling back to checkout origin"

  local token askpass status=0
  if token="$(ci_load_git_woa_private_token 2>/dev/null)" && [[ -n "$token" ]]; then
    askpass="$(mktemp)"
    cat > "$askpass" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' "${GIT_WOA_FETCH_USERNAME:-oauth2}" ;;
  *Password*) printf '%s\n' "$GIT_WOA_FETCH_TOKEN" ;;
  *) printf '\n' ;;
esac
EOF
    chmod 700 "$askpass"
    ci_log "git fetch origin with Git WOA token"
    GIT_ASKPASS="$askpass" \
      GIT_TERMINAL_PROMPT=0 \
      GIT_WOA_FETCH_TOKEN="$token" \
      git fetch origin "$@" || status=$?
    rm -f "$askpass"
    return "$status"
  fi

  ci_log "git fetch origin without Git WOA token"
  GIT_TERMINAL_PROMPT=0 git fetch origin "${fetch_args[@]}"
}

ci_load_registry_password() {
  local env_name="$1"
  local beijing_file="${TCR_BEIJING_PASSWORD_FILE:-/etc/lightclaw-ci/tcr_beijing_password}"
  local beijing2_file="${TCR_BEIJING_SANDBOX2_PASSWORD_FILE:-${TCR_BEIJING_PASSWORD_FILE:-/etc/lightclaw-ci/tcr_beijing_password}}"
  local shprod_file="${TCR_SHPROD_PASSWORD_FILE:-/etc/lightclaw-ci/tcr_shprod_password}"
  local password_var=""
  local password_file=""

  case "$env_name" in
    beijing-sandbox)
      password_var="${TCR_BEIJING_PASSWORD:-}"
      password_file="$beijing_file"
      ;;
    beijing-sandbox-2|sandbox-bj-*)
      password_var="${TCR_BEIJING_SANDBOX2_PASSWORD:-${TCR_BEIJING_PASSWORD:-}}"
      password_file="$beijing2_file"
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
  local beijing2_file="${TCR_BEIJING_SANDBOX2_PASSWORD_FILE:-${TCR_BEIJING_PASSWORD_FILE:-/etc/lightclaw-ci/tcr_beijing_password}}"
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
      beijing-sandbox-2|sandbox-bj-*)
        if [[ -r "$beijing2_file" ]]; then
          source="file:$beijing2_file"
        elif [[ -n "${TCR_BEIJING_SANDBOX2_PASSWORD:-}" ]]; then
          source="env:TCR_BEIJING_SANDBOX2_PASSWORD"
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

ci_ensure_oras() {
  local version="${ORAS_VERSION_OVERRIDE:-1.2.3}"
  local os arch archive cache_root install_dir bin url

  os="$(ci_os_name)"
  arch="$(ci_arch_name)"
  archive="oras_${version}_${os}_${arch}.tar.gz"
  cache_root="${HOME}/.cache/lightclaw-ci/oras"
  install_dir="${cache_root}/v${version}/${os}/${arch}"
  bin="${install_dir}/oras"
  url="https://github.com/oras-project/oras/releases/download/v${version}/${archive}"

  if [[ ! -x "$bin" ]]; then
    ci_with_lock "oras-${version}-${os}-${arch}" ci_install_oras "$url" "$archive" "$cache_root" "$install_dir"
  else
    ci_log "oras ${version} already present at ${bin}"
  fi

  export PATH="${install_dir}:${PATH}"
  export ORAS_BIN="$bin"
}

ci_install_oras() {
  local url="$1"
  local archive="$2"
  local cache_root="$3"
  local install_dir="$4"

  mkdir -p "$cache_root" "$install_dir"
  ci_download_file "$url" "${cache_root}/${archive}"
  tar -xzf "${cache_root}/${archive}" -C "$install_dir" oras
  chmod +x "${install_dir}/oras"
  ci_log "installed oras at ${install_dir}/oras"
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
