#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

materialize_runtime() {
  local runtime_dir="$1"
  shift

  mkdir -p "$runtime_dir"
  local path
  for path in "$@"; do
    mkdir -p "$runtime_dir/$(dirname "$path")"
    cp "$REPO_ROOT/$path" "$runtime_dir/$path"
  done
}

smoke_command() {
  local name="$1"
  shift
  local runtime_dir
  runtime_dir="$(mktemp -d)"

  if ! materialize_runtime "$runtime_dir" "$@"; then
    rm -rf "$runtime_dir"
    return 1
  fi
  if ! python3 "$runtime_dir/.ci/runtime/harness_ci/commands/$name.py" --help >/dev/null; then
    rm -rf "$runtime_dir"
    return 1
  fi
  rm -rf "$runtime_dir"
}

common_package=(
  ".ci/runtime/harness_ci/__init__.py"
)

smoke_command "update_image_pin" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/update_image_pin.py" \
  ".ci/runtime/harness_ci/image_pin.py"

smoke_command "project_release_bundle" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/project_release_bundle.py" \
  ".ci/runtime/harness_ci/project_release_bundle.py" \
  ".ci/runtime/harness_ci/bundles.py"

smoke_command "validate_gitops_static" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/validate_gitops_static.py" \
  ".ci/runtime/harness_ci/gitops_static_validation.py" \
  ".ci/runtime/harness_ci/bundles.py"

smoke_command "validate_gitops_kustomize" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/validate_gitops_kustomize.py" \
  ".ci/runtime/harness_ci/gitops_kustomize_validation.py"

smoke_command "gitops_merge_request" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/gitops_merge_request.py" \
  ".ci/runtime/harness_ci/gitops_merge_request.py" \
  ".ci/runtime/harness_ci/gongfeng.py"

smoke_command "verify_gitops_release" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/verify_gitops_release.py" \
  ".ci/runtime/harness_ci/gitops_release_verifier.py"

smoke_command "gitops_cleanup_source_branch" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/gitops_cleanup_source_branch.py" \
  ".ci/runtime/harness_ci/gitops_cleanup_source_branch.py" \
  ".ci/runtime/harness_ci/gongfeng.py"

smoke_command "audit_gitops_drift" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/audit_gitops_drift.py" \
  ".ci/runtime/harness_ci/gitops_drift_audit.py"

smoke_command "build_release_image" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/build_release_image.py" \
  ".ci/runtime/harness_ci/build_release_image.py"

smoke_command "resolve_release_bundle" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/resolve_release_bundle.py" \
  ".ci/runtime/harness_ci/resolve_release_bundle.py" \
  ".ci/runtime/harness_ci/bundles.py"

smoke_command "gitops_merge_request_note" \
  "${common_package[@]}" \
  ".ci/runtime/harness_ci/commands/gitops_merge_request_note.py" \
  ".ci/runtime/harness_ci/gitops_merge_request_note.py" \
  ".ci/runtime/harness_ci/gongfeng.py"
