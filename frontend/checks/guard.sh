#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"
source .ci/init.sh
ci_init_repo_root

if [[ "$(uname -s)" == "Linux" ]]; then
  ci_ensure_node
  ci_ensure_pnpm
elif command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  PNPM_BIN="$(command -v pnpm)"
else
  echo "frontend 约束：本地非 Linux 环境缺少 node/pnpm；CI Linux 会通过 .ci/init.sh 安装固定版本。" >&2
  exit 1
fi

echo "frontend 约束：Node=$("$NODE_BIN" --version) PNPM=$("$PNPM_BIN" --version)"

echo "frontend guard: changed files"
cat "${GUARD_CHANGED_FILES_FILE:?}"

cd "$REPO_ROOT/frontend"
if [[ ! -f pnpm-lock.yaml ]]; then
  echo "frontend 约束：当前分支缺少 frontend/pnpm-lock.yaml"
  echo "处理：从 trusted base ref ${GUARD_BASE_REF:-origin/master} materialize 锁文件，再执行 frozen install"
  git -C "$REPO_ROOT" show "${GUARD_BASE_REF:-origin/master}:frontend/pnpm-lock.yaml" > pnpm-lock.yaml
fi

echo "============================================================"
echo "frontend 约束：安装/校验 pnpm 依赖"
echo "说明：MR guard 使用 frozen lockfile，避免 CI 重解依赖导致 Tailwind/Rollup 原生 optional 包版本漂移"
echo "============================================================"
"$PNPM_BIN" install --frozen-lockfile

echo "============================================================"
echo "frontend 约束：运行 TypeScript 类型检查"
echo "目的：MR 阶段拦截类型错误，避免进入发布流水线后才失败"
echo "============================================================"
"$PNPM_BIN" check

echo "============================================================"
echo "frontend 约束：运行 i18n 完整性检查"
echo "目的：MR 阶段拦截新增中文文案但缺少英文翻译"
echo "============================================================"
"$PNPM_BIN" i18n:check

echo "============================================================"
echo "frontend 约束：检查静态目录与 BrowserRouter 路由冲突"
echo "目的：防止 EdgeOne Pages 将同名静态目录优先于 SPA fallback，导致深链刷新 404"
echo "============================================================"
"$NODE_BIN" scripts/check-static-route-conflicts.mjs

echo "============================================================"
echo "frontend 约束：运行 release matrix / static route guard 单测"
echo "目的：防止 Pages / EdgeOne 发布矩阵与 SPA fallback 约束回归"
echo "============================================================"
"$PNPM_BIN" test \
  scripts/release-matrix.test.ts \
  scripts/frontend-artifact.test.ts \
  scripts/build-release-artifacts.test.ts \
  scripts/release-edgeone-from-artifact.test.ts \
  scripts/check-static-route-conflicts.test.ts

echo "frontend 约束：全部通过"
