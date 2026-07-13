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
FRONTEND_NEXT_CACHE_ROOT="${FRONTEND_NEXT_CACHE_ROOT:-${HOME}/.cache/lightclaw-ci/frontend-next}"
FRONTEND_NEXT_CACHE_LOCK_TIMEOUT_SECONDS="${FRONTEND_NEXT_CACHE_LOCK_TIMEOUT_SECONDS:-60}"
FRONTEND_NEXT_CACHE_MAX_AGE_DAYS="${FRONTEND_NEXT_CACHE_MAX_AGE_DAYS:-14}"
FRONTEND_NEXT_CACHE_NAMESPACE=""
FRONTEND_NEXT_CACHE_RESTORED=0

frontend_next_cache_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return
  fi
  return 1
}

frontend_next_cache_key() {
  local config_file
  {
    printf 'os=%s\n' "$(ci_os_name)"
    printf 'arch=%s\n' "$(ci_arch_name)"
    printf 'node=%s\n' "$("$NODE_BIN" --version)"
    for config_file in pnpm-lock.yaml package.json next.config.*; do
      if [[ ! -f "$config_file" ]]; then
        continue
      fi
      printf 'file=%s\n' "$config_file"
      if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$config_file"
      else
        shasum -a 256 "$config_file"
      fi
    done
  } | frontend_next_cache_sha256
}

initialize_frontend_next_cache() {
  local cache_key node_version platform

  if [[ "${FRONTEND_NEXT_LOCAL_CACHE_ENABLED:-1}" != "1" ]]; then
    echo "frontend 约束：本机 Next 缓存已通过 FRONTEND_NEXT_LOCAL_CACHE_ENABLED 禁用"
    return 0
  fi
  if [[ "$(uname -s)" != "Linux" || ! -x "$(command -v flock 2>/dev/null || true)" ]] || \
    ! flock --help 2>&1 | grep -q -- '--timeout'; then
    echo "frontend 约束：当前环境不支持 util-linux flock，本机 Next 缓存禁用"
    return 0
  fi
  if ! cache_key="$(frontend_next_cache_key)"; then
    echo "frontend 约束：无法生成本机 Next 缓存 key，降级为冷构建" >&2
    return 0
  fi

  platform="$(ci_os_name)-$(ci_arch_name)"
  node_version="$("$NODE_BIN" --version | tr -d '\r\n')"
  FRONTEND_NEXT_CACHE_NAMESPACE="${FRONTEND_NEXT_CACHE_ROOT}/v1/${platform}/node-${node_version}/${cache_key}"
  if ! mkdir -p "$FRONTEND_NEXT_CACHE_NAMESPACE"; then
    echo "frontend 约束：无法创建本机 Next 缓存目录，降级为冷构建" >&2
    FRONTEND_NEXT_CACHE_NAMESPACE=""
    return 0
  fi

  echo "frontend 约束：本机 Next 缓存 namespace=${FRONTEND_NEXT_CACHE_NAMESPACE}"
  if [[ "$FRONTEND_NEXT_CACHE_MAX_AGE_DAYS" =~ ^[0-9]+$ ]]; then
    find "$FRONTEND_NEXT_CACHE_ROOT" -type f -name cache.tar -mtime "+${FRONTEND_NEXT_CACHE_MAX_AGE_DAYS}" -delete 2>/dev/null || \
      echo "frontend 约束：清理过期本机 Next 缓存失败，不阻断 CI" >&2
  fi
  find "$FRONTEND_NEXT_CACHE_ROOT" -type f -name 'cache.tar.tmp.*' -mtime +1 -delete 2>/dev/null || \
    echo "frontend 约束：清理中断写入的本机 Next 缓存失败，不阻断 CI" >&2
}

with_frontend_next_cache_lock() {
  local lock_file="$1"
  shift
  local status=0

  mkdir -p "$(dirname "$lock_file")" || return 1
  exec 9>"$lock_file" || return 1
  if ! flock -w "$FRONTEND_NEXT_CACHE_LOCK_TIMEOUT_SECONDS" 9; then
    exec 9>&-
    return 1
  fi
  "$@" || status=$?
  flock -u 9 || true
  exec 9>&-
  return "$status"
}

extract_frontend_next_cache() {
  local cache_archive="$1"
  local destination="$2"

  tar -tf "$cache_archive" >/dev/null || return 1
  mkdir -p "$destination"
  tar -C "$destination" -xf "$cache_archive"
}

restore_frontend_next_cache() {
  local region="$1"
  local cache_dir cache_archive started_at elapsed_seconds
  FRONTEND_NEXT_CACHE_RESTORED=0

  if [[ -z "$FRONTEND_NEXT_CACHE_NAMESPACE" ]]; then
    return 0
  fi
  cache_dir="${FRONTEND_NEXT_CACHE_NAMESPACE}/${region}"
  cache_archive="${cache_dir}/cache.tar"
  if [[ ! -f "$cache_archive" ]]; then
    echo "frontend 约束：本机 Next 缓存未命中 region=${region}"
    return 0
  fi

  started_at="$(date +%s)"
  if ! with_frontend_next_cache_lock "${cache_dir}/cache.lock" \
    extract_frontend_next_cache "$cache_archive" "$FRONTEND_GUARD_DIR/.next/cache"; then
    rm -rf "$FRONTEND_GUARD_DIR/.next/cache"
    mkdir -p "$FRONTEND_GUARD_DIR/.next/cache"
    echo "frontend 约束：本机 Next 缓存恢复失败，降级为冷构建 region=${region}" >&2
    return 0
  fi
  elapsed_seconds=$(($(date +%s) - started_at))
  FRONTEND_NEXT_CACHE_RESTORED=1
  touch "$cache_archive" 2>/dev/null || true
  echo "frontend 约束：本机 Next 缓存命中 region=${region} restore_seconds=${elapsed_seconds} size=$(du -h "$cache_archive" | awk '{print $1}')"
}

install_frontend_next_cache_archive() {
  local staging_archive="$1"
  local cache_archive="$2"
  mv -f "$staging_archive" "$cache_archive"
}

save_frontend_next_cache() {
  local region="$1"
  local source_dir cache_dir cache_archive staging_archive started_at elapsed_seconds

  source_dir="$FRONTEND_GUARD_DIR/.next/cache"
  if [[ -z "$FRONTEND_NEXT_CACHE_NAMESPACE" || ! -d "$source_dir" ]]; then
    return 0
  fi
  cache_dir="${FRONTEND_NEXT_CACHE_NAMESPACE}/${region}"
  cache_archive="${cache_dir}/cache.tar"
  staging_archive="${cache_dir}/cache.tar.tmp.$$.$RANDOM"
  if ! mkdir -p "$cache_dir"; then
    echo "frontend 约束：本机 Next 缓存回写失败，不阻断 CI region=${region}" >&2
    return 0
  fi

  started_at="$(date +%s)"
  if ! tar -C "$source_dir" -cf "$staging_archive" .; then
    rm -f "$staging_archive"
    echo "frontend 约束：本机 Next 缓存回写失败，不阻断 CI region=${region}" >&2
    return 0
  fi
  if ! with_frontend_next_cache_lock "${cache_dir}/cache.lock" \
    install_frontend_next_cache_archive "$staging_archive" "$cache_archive"; then
    rm -f "$staging_archive"
    echo "frontend 约束：本机 Next 缓存回写失败，不阻断 CI region=${region}" >&2
    return 0
  fi
  elapsed_seconds=$(($(date +%s) - started_at))
  echo "frontend 约束：本机 Next 缓存已更新 region=${region} save_seconds=${elapsed_seconds} size=$(du -h "$cache_archive" | awk '{print $1}')"
}

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
  --exclude="frontend/.next" \
  --exclude="frontend/out" \
  --exclude="velalink/node_modules" \
  --exclude="velalink/.next" \
  --exclude="velalink/out" \
  --exclude="velalink/target" \
  --exclude="velalink/crates/*/target" \
  -C "$REPO_ROOT" \
  -cf - frontend velalink | tar -C "$FRONTEND_GUARD_ROOT" -xf -

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
echo "frontend 约束：运行 release matrix / static route guard 单测"
echo "目的：防止 Pages / EdgeOne 发布矩阵与 Next static export 约束回归"
echo "============================================================"
"$PNPM_BIN" test \
  scripts/release-matrix.test.ts \
  scripts/frontend-artifact.test.ts \
  scripts/build-release-artifacts.test.ts \
  scripts/release-cloudflare-from-artifact.test.ts \
  scripts/release-edgeone-from-artifact.test.ts

echo "============================================================"
echo "frontend 约束：运行国内/国际 Next static export 打包"
echo "目的：MR 阶段真实验证 bundler、动态 import 与区域化编译；跳过图片优化以控制 checker 成本"
echo "============================================================"
rm -rf out
if [[ ! -x "$FRONTEND_GUARD_DIR/node_modules/.bin/next" ]]; then
  echo "frontend 约束：隔离工作目录缺少本地 next 可执行文件" >&2
  echo "处理：重新执行 frozen install 后再次检查，避免共享 runner 并发清理 node_modules 导致误报" >&2
  "$PNPM_BIN" install --frozen-lockfile
fi
if [[ ! -x "$FRONTEND_GUARD_DIR/node_modules/.bin/next" ]]; then
  echo "frontend 约束：本地 next 仍不可用" >&2
  exit 1
fi
initialize_frontend_next_cache

rm -rf .next out
restore_frontend_next_cache cn
cn_build_status=0
NEXT_PUBLIC_AUTH_API_BASE_URL=https://api.lightvela.ai VITE_AUTH_API_BASE_URL=https://api.lightvela.ai "$PNPM_BIN" build:cn || cn_build_status=$?
if [[ "$cn_build_status" -ne 0 && "$FRONTEND_NEXT_CACHE_RESTORED" -eq 1 ]]; then
  echo "frontend 约束：国内构建在缓存命中后失败，清空 .next 冷构建重试一次" >&2
  rm -rf .next out
  cn_build_status=0
  NEXT_PUBLIC_AUTH_API_BASE_URL=https://api.lightvela.ai VITE_AUTH_API_BASE_URL=https://api.lightvela.ai "$PNPM_BIN" build:cn || cn_build_status=$?
fi
if [[ "$cn_build_status" -ne 0 ]]; then
  exit "$cn_build_status"
fi
save_frontend_next_cache cn

rm -rf .next out
restore_frontend_next_cache global
global_build_status=0
NEXT_PUBLIC_AUTH_API_BASE_URL=https://lightclaw.tech VITE_AUTH_API_BASE_URL=https://lightclaw.tech "$PNPM_BIN" build:global || global_build_status=$?
if [[ "$global_build_status" -ne 0 && "$FRONTEND_NEXT_CACHE_RESTORED" -eq 1 ]]; then
  echo "frontend 约束：国际构建在缓存命中后失败，清空 .next 冷构建重试一次" >&2
  rm -rf .next out
  global_build_status=0
  NEXT_PUBLIC_AUTH_API_BASE_URL=https://lightclaw.tech VITE_AUTH_API_BASE_URL=https://lightclaw.tech "$PNPM_BIN" build:global || global_build_status=$?
fi
if [[ "$global_build_status" -ne 0 ]]; then
  exit "$global_build_status"
fi
save_frontend_next_cache global

echo "frontend 约束：全部通过"
