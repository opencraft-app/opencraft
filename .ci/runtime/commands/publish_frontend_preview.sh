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
FRONTEND_PREVIEW_NODE_MAX_OLD_SPACE_MB="${FRONTEND_PREVIEW_NODE_MAX_OLD_SPACE_MB:-6144}"
FRONTEND_PREVIEW_SOURCE_ROOT="$REPO_ROOT"
FRONTEND_PREVIEW_BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/frontend-preview-build.XXXXXX")"
FRONTEND_PREVIEW_WORKSPACE_ROOT="$FRONTEND_PREVIEW_BUILD_ROOT/workspaces"
FRONTEND_PREVIEW_ARTIFACT_ROOT="$FRONTEND_PREVIEW_BUILD_ROOT/artifacts"
FRONTEND_PREVIEW_CN_ARTIFACT_DIR="$FRONTEND_PREVIEW_ARTIFACT_ROOT/cn"
FRONTEND_PREVIEW_INTL_ARTIFACT_DIR="$FRONTEND_PREVIEW_ARTIFACT_ROOT/intl"

cleanup_frontend_preview_build() {
  ci_cleanup_sops_age_key || true
  rm -rf "$FRONTEND_PREVIEW_BUILD_ROOT"
}
trap cleanup_frontend_preview_build EXIT

mkdir -p "$FRONTEND_PREVIEW_WORKSPACE_ROOT" "$FRONTEND_PREVIEW_ARTIFACT_ROOT"
echo "frontend 预览源码快照：${FRONTEND_PREVIEW_SOURCE_ROOT}"
echo "frontend 预览构建根目录：${FRONTEND_PREVIEW_BUILD_ROOT}"
echo "frontend 预览 Node heap 上限：${FRONTEND_PREVIEW_NODE_MAX_OLD_SPACE_MB}MB"

resolve_preview_auth_api_base_url() {
  local branch="$1"
  local variant="$2"
  case "$branch" in
    playground/sandbox-bj-*|playground/sandbox-kr-*)
      local playground_env="${branch#playground/}"
      printf 'https://api-%s.lightclaw.tech' "$playground_env"
      ;;
    *)
      case "$variant" in
        intl)
          printf 'https://lightclaw.tech'
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
echo "预览构建类型：next"
case "$FRONTEND_PREVIEW_BRANCH" in
  playground/sandbox-bj-*|playground/sandbox-kr-*)
    export VITE_OAUTH_RELAY_ISSUER_BASE_URL="https://lightclaw.tech"
    echo "OAuth relay issuer base：${VITE_OAUTH_RELAY_ISSUER_BASE_URL}"
    ;;
  *)
    unset VITE_OAUTH_RELAY_ISSUER_BASE_URL
    echo "OAuth relay issuer base：disabled"
    ;;
esac

verify_frontend_preview_artifact() {
  local variant="$1"
  local artifact_dir="$2"
  local contaminated_css

  if [[ ! -d "$artifact_dir" ]] || [[ -z "$(find "$artifact_dir" -type f -print -quit)" ]]; then
    echo "frontend next artifact is missing or empty: variant=${variant} dir=${artifact_dir}" >&2
    return 1
  fi

  contaminated_css="$(grep -RIlE --include='*.css' 'self\.__next_f\.push|</script><script>' "$artifact_dir" 2>/dev/null || true)"
  if [[ -n "$contaminated_css" ]]; then
    echo "frontend next artifact contains serialized RSC markup in CSS: variant=${variant}" >&2
    printf '%s\n' "$contaminated_css" >&2
    return 1
  fi
}

build_next_preview_variant() {
  local variant="$1"
  local region="$2"
  local api_base="$3"
  local artifact_dir="$4"
  local workspace="$FRONTEND_PREVIEW_WORKSPACE_ROOT/$variant"
  local frontend_dir="$workspace/frontend"
  local inherited_node_options="${NODE_OPTIONS:-}"

  echo "准备 frontend next 独立工作区：variant=${variant} workspace=${workspace}"
  mkdir -p "$workspace"
  cp -a --reflink=auto "$FRONTEND_PREVIEW_SOURCE_ROOT/." "$workspace/"

  cd "$frontend_dir"
  rm -rf node_modules .next out out-cn out-global
  "$PNPM_BIN" install --frozen-lockfile

  echo "构建 frontend next 预览产物：variant=${variant} region=${region} artifact=${artifact_dir}"
  (
    export VITE_REGION="$region"
    export NEXT_PUBLIC_REGION="$region"
    export VITE_AUTH_API_BASE_URL="$api_base"
    export NEXT_PUBLIC_AUTH_API_BASE_URL="$api_base"
    export NEXT_WRITE_EDGEONE_BUILD_OUTPUT=0
    export NODE_OPTIONS="${inherited_node_options}${inherited_node_options:+ }--max-old-space-size=${FRONTEND_PREVIEW_NODE_MAX_OLD_SPACE_MB}"
    # Older source branches may still append preserve-next-preview-output.mjs
    # to build:next. Artifact ownership belongs to this orchestrator, so make
    # that legacy hook a no-op inside each isolated workspace.
    unset FRONTEND_PREVIEW_BRANCH FRONTEND_PREVIEW_SHA
    "$PNPM_BIN" run build:next
  )

  if [[ ! -d out ]]; then
    echo "frontend next build did not produce out/: variant=${variant}" >&2
    return 1
  fi
  verify_frontend_preview_artifact "$variant" out
  mv out "$artifact_dir"
  echo "frontend next 预览产物已冻结：variant=${variant} artifact=${artifact_dir}"
  cd "$FRONTEND_PREVIEW_SOURCE_ROOT"
  rm -rf "$workspace"
  echo "frontend next 临时工作区已释放：variant=${variant}"
}

build_next_preview() {
  echo "使用独立工作区顺序构建 frontend next 国内站和国际站产物"
  build_next_preview_variant cn cn "$PREVIEW_CN_AUTH_API_BASE_URL" "$FRONTEND_PREVIEW_CN_ARTIFACT_DIR"
  build_next_preview_variant intl global "$PREVIEW_INTL_AUTH_API_BASE_URL" "$FRONTEND_PREVIEW_INTL_ARTIFACT_DIR"
}

build_next_preview

cd "$FRONTEND_PREVIEW_SOURCE_ROOT"
if [[ -z "${STATICPAGES_UPLOAD_TOKEN:-}" ]] || ci_is_unexpanded_setting "$STATICPAGES_UPLOAD_TOKEN"; then
  echo "STATICPAGES_UPLOAD_TOKEN not provided by CI settings; decrypting GitOps StaticPages runtime secret"
  ci_ensure_sops
  ci_prepare_sops_age_key
  # ci_prepare_sops_age_key installs its own EXIT trap when it materializes a
  # temporary key. Restore the composite cleanup so both resources are owned.
  trap cleanup_frontend_preview_build EXIT
  STATICPAGES_UPLOAD_TOKEN="$(sops --decrypt --extract '["stringData"]["STATICPAGES_UPLOAD_TOKEN"]' argocd/secrets/beijing-sandbox/staticpages-runtime-secrets.sops.yaml | ci_read_secret_value)"
  export STATICPAGES_UPLOAD_TOKEN
  echo "STATICPAGES_UPLOAD_TOKEN source=argocd/secrets/beijing-sandbox/staticpages-runtime-secrets.sops.yaml fingerprint=$(printf '%s' "$STATICPAGES_UPLOAD_TOKEN" | ci_fingerprint_secret)"
else
  echo "STATICPAGES_UPLOAD_TOKEN source=ci-settings fingerprint=$(printf '%s' "$STATICPAGES_UPLOAD_TOKEN" | ci_fingerprint_secret)"
fi

echo "frontend 预览产物大小："
du -sh "$FRONTEND_PREVIEW_CN_ARTIFACT_DIR" "$FRONTEND_PREVIEW_INTL_ARTIFACT_DIR"

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

upload_staticpages_preview cn "$FRONTEND_PREVIEW_CN_ARTIFACT_DIR"
upload_staticpages_preview intl "$FRONTEND_PREVIEW_INTL_ARTIFACT_DIR"
