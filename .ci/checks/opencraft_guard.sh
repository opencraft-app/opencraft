#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"

echo "opencraft guard: changed files"
cat "${GUARD_CHANGED_FILES_FILE:?}"

echo "============================================================"
echo "opencraft guard：校验 mono2 vendored 生成物"
echo "============================================================"
node opencraft/scripts/sync-mono2-agent-console.mjs --check

echo "opencraft guard: all checks passed"
