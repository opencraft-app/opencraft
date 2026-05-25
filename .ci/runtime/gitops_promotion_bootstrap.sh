#!/usr/bin/env bash

set -euo pipefail

ci_bootstrap_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

ci_bootstrap_log() {
  echo "[$(ci_bootstrap_now)] [gitops-bootstrap] $*" >&2
}

ci_bootstrap_is_unexpanded_setting() {
  [[ "$1" == *'${{'*'settings.'*'}}'* ]]
}

ci_bootstrap_read_secret_value() {
  tr -d '\r\n'
}

ci_bootstrap_load_git_woa_private_token() {
  local token_file="${GIT_WOA_PRIVATE_TOKEN_FILE:-/etc/lightclaw-ci/git_woa_private_token}"

  if [[ -r "$token_file" ]]; then
    ci_bootstrap_read_secret_value < "$token_file"
    return 0
  fi

  if [[ -n "${GIT_WOA_PRIVATE_TOKEN:-}" ]]; then
    if ci_bootstrap_is_unexpanded_setting "$GIT_WOA_PRIVATE_TOKEN"; then
      ci_bootstrap_log "GIT_WOA_PRIVATE_TOKEN contains an unexpanded CI settings placeholder; ignoring it"
      return 1
    fi
    printf '%s' "$GIT_WOA_PRIVATE_TOKEN" | ci_bootstrap_read_secret_value
    return 0
  fi

  return 1
}

ci_bootstrap_fetch_origin() {
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

  ci_bootstrap_log "git fetch ${fetch_url} ${fetch_args[*]}"
  if GIT_TERMINAL_PROMPT=0 git fetch "$fetch_url" "${fetch_args[@]}"; then
    return 0
  fi

  ci_bootstrap_log "git fetch via ${fetch_url} failed; falling back to checkout origin"

  local token askpass status=0
  if token="$(ci_bootstrap_load_git_woa_private_token 2>/dev/null)" && [[ -n "$token" ]]; then
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
    ci_bootstrap_log "git fetch origin with Git WOA token"
    GIT_ASKPASS="$askpass" \
      GIT_TERMINAL_PROMPT=0 \
      GIT_WOA_FETCH_TOKEN="$token" \
      git fetch origin "$@" || status=$?
    rm -f "$askpass"
    return "$status"
  fi

  ci_bootstrap_log "git fetch origin without Git WOA token"
  GIT_TERMINAL_PROMPT=0 git fetch origin "${fetch_args[@]}"
}

ci_bootstrap_runtime_fetch_ref() {
  local runtime_ref="${1:-origin/master}"
  local fetch_ref

  fetch_ref="$(ci_gitops_promotion_trailer Release-runtime-ref || true)"
  fetch_ref="${fetch_ref#refs/heads/}"
  fetch_ref="${fetch_ref#origin/}"
  if [[ -n "$fetch_ref" ]]; then
    printf '%s\n' "$fetch_ref"
    return 0
  fi

  fetch_ref="${runtime_ref#refs/heads/}"
  fetch_ref="${fetch_ref#origin/}"
  if [[ "$fetch_ref" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    fetch_ref="master"
  fi
  printf '%s\n' "${fetch_ref:-master}"
}

ci_bootstrap_prepare_runtime_ref() {
  local runtime_ref="${1:-origin/master}"
  local fetch_ref

  if ! git cat-file -e "${runtime_ref}^{commit}" 2>/dev/null; then
    fetch_ref="$(ci_bootstrap_runtime_fetch_ref "$runtime_ref")"
    ci_bootstrap_fetch_origin "$fetch_ref" --tags
  fi

  export CI_RUNTIME_REF="$runtime_ref"
  export CI_RUNTIME_COMMIT
  CI_RUNTIME_COMMIT="$(git rev-parse "${runtime_ref}^{commit}")"
  ci_bootstrap_log "runtime ref resolved: CI_RUNTIME_REF=${CI_RUNTIME_REF} CI_RUNTIME_COMMIT=${CI_RUNTIME_COMMIT}"
}

ci_bootstrap_gitops_promotion_runtime() {
  local runtime_dir="${1:?runtime dir required}"
  local runtime_ref="${2:-origin/master}"

  mkdir -p "${runtime_dir}/.ci" "${runtime_dir}/.ci/runtime"

  ci_bootstrap_prepare_runtime_ref "$runtime_ref"
  if ! git show "${CI_RUNTIME_COMMIT}:.ci/init.sh" > "${runtime_dir}/.ci/init.sh"; then
    ci_bootstrap_log "runtime commit ${CI_RUNTIME_COMMIT} does not contain .ci/init.sh; falling back to ${CI_RUNTIME_FALLBACK_REF:-origin/master}"
    ci_bootstrap_prepare_runtime_ref "${CI_RUNTIME_FALLBACK_REF:-origin/master}"
    git show "${CI_RUNTIME_COMMIT}:.ci/init.sh" > "${runtime_dir}/.ci/init.sh"
  fi
  # shellcheck disable=SC1091
  source "${runtime_dir}/.ci/init.sh"
  ci_export_gongfeng_defaults
  ci_materialize_runtime_manifest "${runtime_dir}" ".ci/runtime/materialize-files.txt"
  ci_init_repo_root
}

ci_gitops_promotion_trailer() {
  local key="${1:?trailer key required}"
  git log --format=%B -n 20 HEAD 2>/dev/null |
    awk -F': ' -v key="$key" '$1 == key { print substr($0, length(key) + 3); exit }'
}

ci_resolve_gitops_promotion_runtime_ref() {
  local fallback_ref="${1:-origin/master}"
  local runtime_commit

  runtime_commit="$(ci_gitops_promotion_trailer Release-runtime-commit || true)"
  if [[ -n "$runtime_commit" ]]; then
    printf '%s\n' "$runtime_commit"
    return 0
  fi

  printf '%s\n' "$fallback_ref"
}

ci_resolve_gitops_promotion_source_branch() {
  local ci_branch="${1:-}"
  local candidate

  candidate="$(ci_gitops_promotion_trailer Release-source-branch || true)"
  candidate="${candidate#refs/heads/}"
  candidate="${candidate#origin/}"
  case "$candidate" in
    promote-*)
      printf '%s\n' "$candidate"
      return 0
      ;;
  esac

  for candidate in \
    "$ci_branch" \
    "${BK_CI_REPO_GIT_WEBHOOK_BRANCH:-}" \
    "${BK_CI_REPO_GIT_WEBHOOK_SOURCE_BRANCH:-}" \
    "${BK_CI_REPO_GIT_WEBHOOK_MR_SOURCE_BRANCH:-}" \
    "${BK_CI_BRANCH:-}" \
    "${BK_CI_GIT_REPO_BRANCH:-}" \
    "${BK_CI_REPO_BRANCH:-}" \
    "${BK_CI_REPO_GIT_BRANCH:-}" \
    "${CI_COMMIT_REF_NAME:-}" \
    "${GIT_BRANCH:-}"; do
    candidate="${candidate#refs/heads/}"
    candidate="${candidate#origin/}"
    case "$candidate" in
      promote-*)
        printf '%s\n' "$candidate"
        return 0
        ;;
    esac
  done

  git fetch origin '+refs/heads/promote-*:refs/remotes/origin/promote-*' >/dev/null 2>&1 || true

  while IFS= read -r candidate; do
    candidate="${candidate#origin/}"
    case "$candidate" in
      promote-*)
        printf '%s\n' "$candidate"
        return 0
        ;;
    esac
  done < <(git for-each-ref --format='%(refname:short)' --points-at HEAD refs/remotes/origin 'refs/remotes/origin/promote-*' 2>/dev/null || true)

  while IFS= read -r candidate; do
    candidate="${candidate#origin/}"
    case "$candidate" in
      promote-*)
        printf '%s\n' "$candidate"
        return 0
        ;;
    esac
  done < <(git for-each-ref --format='%(refname:short)' --contains HEAD refs/remotes/origin 'refs/remotes/origin/promote-*' 2>/dev/null || true)

  echo "unable to resolve GitOps promote source branch" >&2
  echo "ci.branch=${ci_branch}" >&2
  echo "HEAD=$(git rev-parse --short HEAD 2>/dev/null || true)" >&2
  echo "remote promote refs pointing at HEAD:" >&2
  git for-each-ref --format='%(refname:short)' --points-at HEAD refs/remotes/origin 'refs/remotes/origin/promote-*' >&2 2>/dev/null || true
  return 1
}
