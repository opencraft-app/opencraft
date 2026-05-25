#!/usr/bin/env bash
set -euo pipefail

COMMAND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_DIR="$(cd "$COMMAND_DIR/../.." && pwd)"

source "$CI_DIR/init.sh"
ci_init_repo_root
ci_tune_staticpages_upload_tcp
ci_ensure_node
ci_ensure_pnpm

FRONTEND_PREVIEW_BRANCH="${FRONTEND_PREVIEW_BRANCH:?FRONTEND_PREVIEW_BRANCH is required}"
FRONTEND_PREVIEW_SHA="${FRONTEND_PREVIEW_SHA:?FRONTEND_PREVIEW_SHA is required}"
STATICPAGES_API_URL="${STATICPAGES_API_URL:?STATICPAGES_API_URL is required}"

resolve_preview_auth_api_base_url() {
  local branch="$1"
  local variant="$2"
  case "$branch" in
    playground/sandbox-bj-*)
      local playground_env="${branch#playground/}"
      printf 'https://api-%s.lightclaw.tech' "$playground_env"
      ;;
    *)
      case "$variant" in
        intl)
          printf 'https://api.lightvela.ai'
          ;;
        cn)
          printf 'https://lightclaw.tech'
          ;;
        *)
          echo "unsupported frontend preview variant for API base: ${variant}" >&2
          return 1
          ;;
      esac
      ;;
  esac
}

PREVIEW_CN_AUTH_API_BASE_URL="$(resolve_preview_auth_api_base_url "$FRONTEND_PREVIEW_BRANCH" cn)"
PREVIEW_INTL_AUTH_API_BASE_URL="$(resolve_preview_auth_api_base_url "$FRONTEND_PREVIEW_BRANCH" intl)"
echo "预览 API base：cn=${PREVIEW_CN_AUTH_API_BASE_URL}"
echo "预览 API base：intl=${PREVIEW_INTL_AUTH_API_BASE_URL}"
case "$FRONTEND_PREVIEW_BRANCH" in
  playground/sandbox-bj-*)
    export VITE_OAUTH_RELAY_ISSUER_BASE_URL="https://lightclaw.tech"
    echo "OAuth relay issuer base：${VITE_OAUTH_RELAY_ISSUER_BASE_URL}"
    ;;
  *)
    unset VITE_OAUTH_RELAY_ISSUER_BASE_URL
    echo "OAuth relay issuer base：disabled"
    ;;
esac

cd "$REPO_ROOT/frontend"
rm -rf node_modules dist-cn dist-global
"$PNPM_BIN" install --frozen-lockfile
"$PNPM_BIN" exec tsc -b

echo "并发构建 frontend 国内站和国际站产物"
echo "frontend 分支预览跳过 asset optimize；生产构建链路不受影响"
(
  export VITE_AUTH_API_BASE_URL="$PREVIEW_CN_AUTH_API_BASE_URL"
  "$PNPM_BIN" exec vite build --mode cn --outDir dist-cn
) &
build_cn_pid=$!
(
  export VITE_AUTH_API_BASE_URL="$PREVIEW_INTL_AUTH_API_BASE_URL"
  "$PNPM_BIN" exec vite build --mode global --outDir dist-global
) &
build_global_pid=$!

build_failed=0
wait "$build_cn_pid" || build_failed=1
wait "$build_global_pid" || build_failed=1
if [[ "$build_failed" -ne 0 ]]; then
  echo "frontend 国内站或国际站构建失败" >&2
  exit 1
fi

cd "$REPO_ROOT"
if [[ -z "${STATICPAGES_UPLOAD_TOKEN:-}" ]] || ci_is_unexpanded_setting "$STATICPAGES_UPLOAD_TOKEN"; then
  echo "STATICPAGES_UPLOAD_TOKEN not provided by CI settings; decrypting GitOps StaticPages runtime secret"
  ci_ensure_sops
  ci_prepare_sops_age_key
  STATICPAGES_UPLOAD_TOKEN="$(sops --decrypt --extract '["stringData"]["STATICPAGES_UPLOAD_TOKEN"]' argocd/secrets/beijing-sandbox/staticpages-runtime-secrets.sops.yaml | ci_read_secret_value)"
  export STATICPAGES_UPLOAD_TOKEN
  echo "STATICPAGES_UPLOAD_TOKEN source=argocd/secrets/beijing-sandbox/staticpages-runtime-secrets.sops.yaml fingerprint=$(printf '%s' "$STATICPAGES_UPLOAD_TOKEN" | ci_fingerprint_secret)"
else
  echo "STATICPAGES_UPLOAD_TOKEN source=ci-settings fingerprint=$(printf '%s' "$STATICPAGES_UPLOAD_TOKEN" | ci_fingerprint_secret)"
fi

echo "frontend 预览产物大小："
du -sh frontend/dist-cn frontend/dist-global

staticpages_upload_timeout_seconds=1800
staticpages_upload_max_attempts=3
echo "顺序上传 frontend 国内站和国际站 StaticPages 预览，避免并发更新 StaticPages index"
echo "StaticPages 上传客户端超时：${staticpages_upload_timeout_seconds}s"
echo "StaticPages 上传最大尝试次数：${staticpages_upload_max_attempts}"

upload_staticpages_preview() {
  local variant="$1"
  local artifact_dir="$2"
  local attempt status sleep_seconds

  for attempt in $(seq 1 "$staticpages_upload_max_attempts"); do
    echo "============================================================"
    echo "StaticPages 上传开始：variant=${variant} attempt=${attempt}/${staticpages_upload_max_attempts}"
    echo "产物目录：${artifact_dir}"
    echo "============================================================"
    if python3 "$CI_DIR/runtime/commands/upload_staticpages_preview.py" \
      --artifact-dir "$artifact_dir" \
      --api-url "$STATICPAGES_API_URL" \
      --repository wisp/mono2 \
      --source-branch "$FRONTEND_PREVIEW_BRANCH" \
      --variant "$variant" \
      --sha "$FRONTEND_PREVIEW_SHA" \
      --timeout-seconds "$staticpages_upload_timeout_seconds"; then
      echo "StaticPages 上传成功：variant=${variant} attempt=${attempt}/${staticpages_upload_max_attempts}"
      return 0
    fi

    status=$?
    echo "StaticPages 上传失败：variant=${variant} attempt=${attempt}/${staticpages_upload_max_attempts} status=${status}" >&2
    if [[ "$attempt" -ge "$staticpages_upload_max_attempts" ]]; then
      return "$status"
    fi
    sleep_seconds=$((attempt * 15))
    echo "StaticPages 上传重试等待：${sleep_seconds}s"
    sleep "$sleep_seconds"
  done
}

upload_staticpages_preview cn frontend/dist-cn
upload_staticpages_preview intl frontend/dist-global
