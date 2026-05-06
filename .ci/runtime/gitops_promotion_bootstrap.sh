#!/usr/bin/env bash

set -euo pipefail

ci_bootstrap_gitops_promotion_runtime() {
  local runtime_dir="${1:?runtime dir required}"
  local runtime_ref="${2:-origin/master}"

  mkdir -p "${runtime_dir}/.ci" "${runtime_dir}/.ci/runtime"

  git show HEAD:.ci/init.sh > "${runtime_dir}/.ci/init.sh"
  # shellcheck disable=SC1091
  source "${runtime_dir}/.ci/init.sh"
  ci_prepare_runtime_ref "$runtime_ref"
  ci_export_gongfeng_defaults

  git show "${CI_RUNTIME_COMMIT}:.ci/init.sh" > "${runtime_dir}/.ci/init.sh"
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
