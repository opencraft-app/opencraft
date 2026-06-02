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

FRONTEND_GUARD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lightclaw-frontend-guard.XXXXXX")"
FRONTEND_GUARD_DIR="$FRONTEND_GUARD_ROOT/frontend"

cleanup_frontend_guard_workspace() {
  if [[ "${KEEP_FRONTEND_GUARD_WORKDIR:-0}" == "1" ]]; then
    echo "frontend 约束：保留隔离工作目录 ${FRONTEND_GUARD_ROOT}"
    return 0
  fi
  rm -rf "$FRONTEND_GUARD_ROOT"
}
trap cleanup_frontend_guard_workspace EXIT

echo "frontend 约束：创建隔离工作目录 ${FRONTEND_GUARD_DIR}"
tar \
  --exclude="frontend/node_modules" \
  --exclude="frontend/dist" \
  --exclude="frontend/dist-*" \
  --exclude="frontend/dist-ci-*" \
  -C "$REPO_ROOT" \
  -cf - frontend | tar -C "$FRONTEND_GUARD_ROOT" -xf -

cd "$FRONTEND_GUARD_DIR"
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
  scripts/release-cloudflare-from-artifact.test.ts \
  scripts/release-edgeone-from-artifact.test.ts \
  scripts/check-static-route-conflicts.test.ts

echo "============================================================"
echo "frontend 约束：运行国内/国际 Vite 打包"
echo "目的：MR 阶段真实验证 bundler、动态 import 与区域化编译；跳过图片优化以控制 checker 成本"
echo "============================================================"
rm -rf dist-ci-cn dist-ci-global
VITE_BIN="$FRONTEND_GUARD_DIR/node_modules/.bin/vite"
if [[ ! -x "$VITE_BIN" ]]; then
  echo "frontend 约束：隔离工作目录缺少本地 vite 可执行文件：${VITE_BIN}" >&2
  echo "处理：重新执行 frozen install 后再次检查，避免共享 runner 并发清理 node_modules 导致误报" >&2
  "$PNPM_BIN" install --frozen-lockfile
fi
if [[ ! -x "$VITE_BIN" ]]; then
  echo "frontend 约束：本地 vite 仍不可用：${VITE_BIN}" >&2
  exit 1
fi
VITE_AUTH_API_BASE_URL=https://api.lightvela.ai "$VITE_BIN" build --mode cn --outDir dist-ci-cn
VITE_AUTH_API_BASE_URL=https://lightclaw.tech "$VITE_BIN" build --mode global --outDir dist-ci-global

echo "frontend 约束：全部通过"
