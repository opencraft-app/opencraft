#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST_PATH="$REPO_ROOT/.ci/runtime/materialize-files.txt"

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
    find .ci/runtime/commands .ci/runtime/contracts .ci/runtime/gitops .ci/runtime/db_gates .ci/runtime/guards \
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

assert_manifest_covers_runtime_python

runtime_dir="$(mktemp -d)"
trap 'rm -rf "$runtime_dir"' EXIT
materialize_runtime "$runtime_dir"

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
