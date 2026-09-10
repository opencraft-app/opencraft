#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
source .ci/init.sh
ci_init_repo_root

if [[ "$(uname -s)" == "Linux" ]]; then
  ci_ensure_node
elif command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  NPM_BIN="$(command -v npm)"
else
  echo "OpenCraft guard: local non-Linux environment is missing node/npm." >&2
  exit 1
fi

echo "OpenCraft guard: Node=$($NODE_BIN --version) npm=$($NPM_BIN --version)"
if [[ -n "${GUARD_CHANGED_FILES_FILE:-}" && -f "${GUARD_CHANGED_FILES_FILE}" ]]; then
  echo "OpenCraft guard: changed files"
  cat "${GUARD_CHANGED_FILES_FILE}"
fi

OPENCRAFT_GUARD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencraft-guard.XXXXXX")"
cleanup_opencraft_guard_workspace() {
  if [[ "${KEEP_OPENCRAFT_GUARD_WORKDIR:-0}" == "1" ]]; then
    echo "OpenCraft guard: keeping isolated workspace ${OPENCRAFT_GUARD_ROOT}"
    return 0
  fi
  rm -rf "$OPENCRAFT_GUARD_ROOT"
}
trap cleanup_opencraft_guard_workspace EXIT

echo "OpenCraft guard: creating isolated workspace ${OPENCRAFT_GUARD_ROOT}"
tar \
  --exclude="opencraft/node_modules" \
  --exclude="opencraft/apps/*/dist*" \
  --exclude="opencraft/coverage" \
  -C "$REPO_ROOT" \
  -cf - opencraft frontend/src frontend/public | tar -C "$OPENCRAFT_GUARD_ROOT" -xf -

cd "$OPENCRAFT_GUARD_ROOT/opencraft"
"$NPM_BIN" ci
"$NPM_BIN" run check:mono2-agent-console
"$NPM_BIN" run gate

echo "OpenCraft guard: all checks passed"
