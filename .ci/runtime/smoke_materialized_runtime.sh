#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST_PATH="$REPO_ROOT/.ci/runtime/materialize-files.txt"

source "$REPO_ROOT/.ci/init.sh"

read_manifest_files() {
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
    printf '%s\n' "$repo_path"
  done < "$MANIFEST_PATH"
}

assert_manifest_covers_runtime_python() {
  local expected manifest missing
  expected="$(mktemp)"
  manifest="$(mktemp)"
  missing="$(mktemp)"

  (
    cd "$REPO_ROOT"
    find .ci/runtime/commands .ci/runtime/contracts .ci/runtime/gitops .ci/runtime/gates .ci/runtime/guards .ci/runtime/support \
      -type f -name '*.py' | sort
  ) > "$expected"
  read_manifest_files | sort -u > "$manifest"
  comm -23 "$expected" "$manifest" > "$missing"

  if [[ -s "$missing" ]]; then
    echo "runtime materialize manifest is missing Python files:" >&2
    cat "$missing" >&2
    rm -f "$expected" "$manifest" "$missing"
    return 1
  fi

  rm -f "$expected" "$manifest" "$missing"
}

materialize_runtime() {
  local runtime_dir="$1"
  mkdir -p "$runtime_dir"

  local path
  while IFS= read -r path; do
    mkdir -p "$runtime_dir/$(dirname "$path")"
    cp "$REPO_ROOT/$path" "$runtime_dir/$path"
  done < <(read_manifest_files)
}

assert_materialized_release_bundle_manifest() {
  local runtime_dir="$1"
  local bundle_dir="$runtime_dir/.ci/runtime/bundles"
  local bundle_manifest="$runtime_dir/.ci/runtime/release-bundles.manifest"

  if ! find "$bundle_dir" -type f -name '*.yaml' -print -quit | grep -q .; then
    echo "materialized runtime is missing release bundle source files: $bundle_dir" >&2
    return 1
  fi
  if [[ ! -s "$bundle_manifest" ]]; then
    echo "materialized runtime did not generate release bundle manifest: $bundle_manifest" >&2
    return 1
  fi

  RUNTIME_DIR="$runtime_dir/.ci/runtime" python3 - <<'PY'
import os
import sys
from pathlib import Path

runtime_dir = Path(os.environ["RUNTIME_DIR"])
sys.path.insert(0, str(runtime_dir))

from contracts.release_bundle_manifest import dump_manifest, merge_bundle_sources  # noqa: E402

expected = dump_manifest(merge_bundle_sources(runtime_dir / "bundles"))
actual = (runtime_dir / "release-bundles.manifest").read_text()
if actual != expected:
    raise SystemExit("materialized release bundle manifest does not match bundle sources")
PY
}

assert_manifest_covers_runtime_python

runtime_dir="$(mktemp -d)"
trap 'rm -rf "$runtime_dir"' EXIT
materialize_runtime "$runtime_dir"
ci_generate_release_bundle_manifest "$runtime_dir"
assert_materialized_release_bundle_manifest "$runtime_dir"

while IFS= read -r command_path; do
  command_name="$(basename "$command_path" .py)"
  if [[ "$command_name" == "__init__" ]]; then
    continue
  fi
  python3 "$runtime_dir/$command_path" --help >/dev/null
done < <(
  cd "$REPO_ROOT"
  find .ci/runtime/commands -maxdepth 1 -type f -name '*.py' | sort
)
