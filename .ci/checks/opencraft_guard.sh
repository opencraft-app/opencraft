#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"
source .ci/init.sh
ci_init_repo_root

if [[ "$(uname -s)" == "Linux" ]]; then
  ci_ensure_node
fi

echo "opencraft guard: changed files"
cat "${GUARD_CHANGED_FILES_FILE:?}"

echo "============================================================"
echo "opencraft guard：校验 mono2 vendored 生成物"
echo "============================================================"
if ! node opencraft/scripts/sync-mono2-agent-console.mjs --check; then
  echo "opencraft guard: 请先提交 frontend 源码，再运行 npm --prefix opencraft run sync:mono2-agent-console" >&2
  echo "opencraft guard: 将同步生成物作为后续独立提交，并运行 npm --prefix opencraft run check:mono2-agent-console 复验。" >&2
  exit 1
fi

echo "opencraft guard: all checks passed"
