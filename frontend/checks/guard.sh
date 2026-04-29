#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"
if command -v pnpm >/dev/null 2>&1; then
  REPO_ROOT="$(pwd)"
  PNPM_BIN="$(command -v pnpm)"
else
  source .ci/init.sh
  ci_init_repo_root
  ci_ensure_node
  ci_ensure_pnpm
fi

echo "frontend guard: changed files"
cat "${GUARD_CHANGED_FILES_FILE:?}"

cd "$REPO_ROOT/frontend"
echo "============================================================"
echo "frontend 约束：安装/校验 pnpm 依赖"
echo "说明：使用 --no-frozen-lockfile，保持与现有发布 CI 行为一致"
echo "============================================================"
"$PNPM_BIN" install --no-frozen-lockfile

echo "============================================================"
echo "frontend 约束：运行 release matrix 单测"
echo "目的：防止 Pages / EdgeOne 发布矩阵回归"
echo "============================================================"
"$PNPM_BIN" test scripts/release-matrix.test.ts

echo "frontend 约束：全部通过"
