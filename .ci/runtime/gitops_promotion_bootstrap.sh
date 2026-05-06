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
