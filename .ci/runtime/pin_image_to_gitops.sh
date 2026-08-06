#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
CI_INIT_SCRIPT="${CI_INIT_SCRIPT:-$SCRIPT_DIR/../init.sh}"
source "$CI_INIT_SCRIPT"
REMOTE_NAME="${REMOTE_NAME:-origin}"
REMOTE_URL="${REMOTE_URL:-}"
GITOPS_BRANCH="${GITOPS_BRANCH:-gitops}"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
COMMITTER_NAME="${COMMITTER_NAME:-skipzhang}"
COMMITTER_EMAIL="${COMMITTER_EMAIL:-skipzhang@tencent.com}"
ci_export_gongfeng_defaults
GITOPS_AUTO_MERGE_ENVS="${GITOPS_AUTO_MERGE_ENVS:-beijing-sandbox}"

if [[ $# -ne 5 ]]; then
  echo "usage: $0 <bundle-service> <service[,service2,...]> <env> <image> <source-ref>" >&2
  exit 1
fi

BUNDLE_SERVICE="$1"
SERVICE_ARG="$2"
ENV_NAME="$3"
IMAGE="$4"
SOURCE_REF="$5"
GATE_IMAGE_STATUS="unknown"
GATE_IMAGE_PIN_PAYLOAD=""
GATE_IMAGE_DIGESTS_JSON="{}"
GATE_CONFIG_STATUS="unknown"
GATE_DB_STATUS="unknown"
PIN_IMAGE="$IMAGE"
RELEASE_RUNTIME_REF="${CI_RUNTIME_REF:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)}"
RELEASE_RUNTIME_COMMIT="${CI_RUNTIME_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"

ci_require_commands git python3

sanitize_branch_component() {
  printf '%s' "$1" | tr ',:/' '-' | tr -cs '[:alnum:]._-' '-'
}

env_display_name() {
  case "$1" in
    beijing-sandbox) printf '北京测试' ;;
    beijing-sandbox-2) printf '北京测试2' ;;
    devcloud-dep) printf 'DevCloud dep' ;;
    beijing-llmgateway) printf '北京 LLMGateway 测试' ;;
    sandbox-bj-*) printf '北京 Playground %s' "$1" ;;
    sandbox-kr-*) printf '韩国 Playground %s' "$1" ;;
    sandbox-jp-*) printf '东京 Playground %s' "$1" ;;
    shprod) printf '上海正式' ;;
    sgprod) printf '新加坡正式' ;;
    tkexgz) printf 'TKEx 广州内网' ;;
    tkexsg) printf 'TKEx 新加坡内网' ;;
    *) printf '%s' "$1" ;;
  esac
}

json_array_to_bullets() {
  python3 - "$1" <<'PY'
import json
import sys

items = json.loads(sys.argv[1] or "[]")
if not items:
    print("- 无")
else:
    for item in items:
        print(f"- {item}")
PY
}

green_log() {
  printf '\033[32m%s\033[0m\n' "$*"
}

gitops_skip_notice() {
  local reason="$1"

  green_log "============================================================"
  green_log "GitOps promote 跳过：${reason}"
  green_log "目标服务：${SERVICE_ARG}"
  green_log "目标环境：${ENV_DISPLAY_NAME} (${ENV_NAME})"
  green_log "目标镜像：${IMAGE}"
  green_log "GitOps pin 镜像：${PIN_IMAGE}"
  green_log "源代码 revision：${SOURCE_REF}"
  green_log "promote 分支：${PROMOTE_BRANCH}"
  green_log "处理结果：不会创建 GitOps promote MR，也不会触发 Argo sync。"
  green_log "============================================================"
}

validate_gate_env_file() {
  local path="$1"
  python3 - "$path" <<'PY'
from pathlib import Path
import sys

allowed = {
    "GATE_IMAGE_STATUS",
    "GATE_IMAGE_PIN_PAYLOAD",
    "GATE_IMAGE_DIGESTS_JSON",
    "GATE_CONFIG_STATUS",
    "GATE_DB_STATUS",
    "GATE_REQUIRES_DB_READINESS",
    "GATE_AUTO_MERGE_ALLOWED",
    "GATE_AUTO_SYNC_ALLOWED",
    "GATE_ARGO_SYNC",
    "GATE_RELEASE_DEPENDENCY_CHANGED",
    "GATE_MANUAL_ACTIONS",
}

path = Path(sys.argv[1])
bad_lines = []
for line_number, line in enumerate(path.read_text().splitlines(), start=1):
    if not line.strip():
        continue
    key = line.split("=", 1)[0]
    if key not in allowed:
        bad_lines.append(f"{line_number}: {line}")

if bad_lines:
    print("GitOps 发布门禁结果包含非 dotenv 输出；不会 source 执行。", file=sys.stderr)
    for line in bad_lines[:20]:
        print(line, file=sys.stderr)
    sys.exit(1)
PY
}

refresh_promote_remote_tracking() {
  local remote_ref="refs/remotes/${REMOTE_NAME}/${PROMOTE_BRANCH}"
  if git -C "$REPO_ROOT" fetch "$REMOTE_NAME" "+refs/heads/${PROMOTE_BRANCH}:${remote_ref}" >/dev/null 2>&1; then
    echo "GitOps 发布进度：已刷新远端 promote 分支引用 ${REMOTE_NAME}/${PROMOTE_BRANCH}"
    return 0
  fi

  git -C "$REPO_ROOT" update-ref -d "$remote_ref" >/dev/null 2>&1 || true
  echo "GitOps 发布进度：远端 promote 分支暂不存在，将创建 ${PROMOTE_BRANCH}"
}

project_and_pin_gitops_state() {
  local target_repo_root="$1"
  local add_to_git="${2:-false}"
  local service
  local services

  python3 "$RUNTIME_COMMAND_DIR/project_release_bundle.py" \
    --repo-root "$target_repo_root" \
    --service "$BUNDLE_SERVICE" \
    --env "$ENV_NAME" \
    --source-ref "$SOURCE_REF"

  IFS=',' read -r -a services <<<"$SERVICE_ARG"
  for service in "${services[@]}"; do
    echo "GitOps 发布进度：更新 ${service}/${ENV_NAME} 的镜像 pin"
    python3 "$RUNTIME_COMMAND_DIR/update_image_pin.py" \
      --repo-root "$target_repo_root" \
      --service "$service" \
      --env "$ENV_NAME" \
      --image "$PIN_IMAGE" \
      --deployed-at "$DEPLOYED_AT"
    if [[ "$add_to_git" == "true" ]]; then
      git -C "$target_repo_root" add "argocd/services/$service/$ENV_NAME"
    fi
  done
}

run_release_gates() {
  local gate_env_file
  gate_env_file="$(mktemp)"
  if ! python3 "$RUNTIME_COMMAND_DIR/run_release_gates.py" \
    --repo-root "$REPO_ROOT" \
    --runtime-command-dir "$RUNTIME_COMMAND_DIR" \
    --bundle-service "$BUNDLE_SERVICE" \
    --pin-targets "$SERVICE_ARG" \
    --env "$ENV_NAME" \
    --image "$IMAGE" \
    --source-ref "$SOURCE_REF" \
    --deployed-at "$DEPLOYED_AT" \
    --remote-name "$REMOTE_NAME" \
    --gitops-branch "$GITOPS_BRANCH" \
    --format dotenv > "$gate_env_file"; then
    rm -f "$gate_env_file"
    echo "GitOps 发布门禁失败；不会创建 promote MR。" >&2
    exit 1
  fi
  if ! validate_gate_env_file "$gate_env_file"; then
    rm -f "$gate_env_file"
    echo "GitOps 发布门禁结果不可加载；不会创建 promote MR。" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  if ! source "$gate_env_file"; then
    rm -f "$gate_env_file"
    echo "GitOps 发布门禁结果不可加载；不会创建 promote MR。" >&2
    exit 1
  fi
  PIN_IMAGE="${GATE_IMAGE_PIN_PAYLOAD:-$IMAGE}"
  rm -f "$gate_env_file"
}

if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
  echo "repository has uncommitted changes; refuse to rewrite branch state" >&2
  exit 1
fi

if ! GIT_WOA_PRIVATE_TOKEN_VALUE="$(ci_load_git_woa_private_token)"; then
  echo "missing Git WOA private token; set GIT_WOA_PRIVATE_TOKEN or provide ${GIT_WOA_PRIVATE_TOKEN_FILE:-/etc/lightclaw-ci/git_woa_private_token}" >&2
  exit 1
fi

bootstrap_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$bootstrap_dir"
}
trap cleanup EXIT

mkdir -p "$bootstrap_dir/.ci"
rm -rf "$bootstrap_dir/.ci/runtime"
runtime_source_ci_dir="$(cd "$SCRIPT_DIR/.." && pwd)"
runtime_snapshot="$(ci_create_runtime_snapshot "$runtime_source_ci_dir")"
rm -rf "$bootstrap_dir"
bootstrap_dir="$runtime_snapshot"
RUNTIME_COMMAND_DIR="$bootstrap_dir/.ci/runtime/commands"

if [[ -n "$REMOTE_URL" ]]; then
  REMOTE_NAME="gitops-target"
  if git -C "$REPO_ROOT" remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
    git -C "$REPO_ROOT" remote set-url "$REMOTE_NAME" "$REMOTE_URL"
  else
    git -C "$REPO_ROOT" remote add "$REMOTE_NAME" "$REMOTE_URL"
  fi
fi

git -C "$REPO_ROOT" fetch "$REMOTE_NAME" "$GITOPS_BRANCH"
run_release_gates

IMAGE_TAG="${IMAGE##*:}"
SOURCE_SHORT="${SOURCE_REF:0:12}"
SERVICE_SLUG="$(sanitize_branch_component "$SERVICE_ARG")"
PROMOTE_BRANCH="promote-$(sanitize_branch_component "$ENV_NAME")-${SERVICE_SLUG}-$(sanitize_branch_component "$IMAGE_TAG")"
ENV_DISPLAY_NAME="$(env_display_name "$ENV_NAME")"
RELEASE_ID="${ENV_NAME}/${SERVICE_ARG}/${SOURCE_SHORT}/${IMAGE_TAG}"

echo "============================================================"
if [[ "$ENV_NAME" == "shprod" || "$ENV_NAME" == "sgprod" ]]; then
  echo "GitOps 待同步意图：准备把镜像 desired state 推进到 ${ENV_DISPLAY_NAME}"
else
  echo "GitOps 发布意图：准备把镜像推进到 ${ENV_DISPLAY_NAME}"
fi
echo "发布 bundle：${BUNDLE_SERVICE}"
echo "目标服务：${SERVICE_ARG}"
echo "目标环境：${ENV_DISPLAY_NAME} (${ENV_NAME})"
echo "目标镜像：${IMAGE}"
echo "GitOps pin 镜像：${PIN_IMAGE}"
echo "源代码 revision：${SOURCE_REF}"
echo "Release ID：${RELEASE_ID}"
echo "Runtime：${RELEASE_RUNTIME_REF} (${RELEASE_RUNTIME_COMMIT})"
echo "GitOps 目标分支：${GITOPS_BRANCH}"
echo "promote 分支：${PROMOTE_BRANCH}"
echo "执行说明：先从 master runtime 临时副本投影发布子集，再更新 image pin 并创建/复用 MR"
echo "============================================================"

git -C "$REPO_ROOT" checkout -B "$PROMOTE_BRANCH" "$REMOTE_NAME/$GITOPS_BRANCH"
git -C "$REPO_ROOT" config user.name "$COMMITTER_NAME"
git -C "$REPO_ROOT" config user.email "$COMMITTER_EMAIL"

project_and_pin_gitops_state "$REPO_ROOT" true

deployed_at_only_diff="$(python3 "$RUNTIME_COMMAND_DIR/detect_deployed_at_only_diff.py" --repo-root "$REPO_ROOT")"
if [[ "$deployed_at_only_diff" == "true" ]]; then
  gitops_skip_notice "仅 *_DEPLOYED_AT 时间戳变化，镜像 pin 与 deploy-facing 配置未变化。"
  git -C "$REPO_ROOT" reset --hard "$REMOTE_NAME/$GITOPS_BRANCH" >/dev/null
  exit 0
fi

if git -C "$REPO_ROOT" diff --cached --quiet; then
  gitops_skip_notice "投影后没有 GitOps staged diff。"
  exit 0
fi

COMMIT_BODY="$(cat <<EOF
Release-id: ${RELEASE_ID}
Release-created-at: ${DEPLOYED_AT}
Release-source-branch: ${PROMOTE_BRANCH}
Release-runtime-ref: ${RELEASE_RUNTIME_REF}
Release-runtime-commit: ${RELEASE_RUNTIME_COMMIT}
Release-bundle: ${BUNDLE_SERVICE}
Release-target-env: ${ENV_NAME}
Release-pin-targets: ${SERVICE_ARG}
Release-image: ${IMAGE}
Release-image-pin: ${PIN_IMAGE}
Release-image-digests: ${GATE_IMAGE_DIGESTS_JSON}
Release-gate-image-status: ${GATE_IMAGE_STATUS}
Release-gate-config-status: ${GATE_CONFIG_STATUS}
Release-gate-db-status: ${GATE_DB_STATUS}
Release-gate-db-readiness-required: ${GATE_REQUIRES_DB_READINESS}
Release-gate-auto-merge: ${GATE_AUTO_MERGE_ALLOWED}
Release-gate-auto-sync: ${GATE_AUTO_SYNC_ALLOWED}
Release-gate-argo-sync: ${GATE_ARGO_SYNC}
Release-gate-dependency-changed: ${GATE_RELEASE_DEPENDENCY_CHANGED}
Source-revision: ${SOURCE_REF}
EOF
)"
if [[ "$ENV_NAME" == "shprod" || "$ENV_NAME" == "sgprod" ]]; then
  COMMIT_TITLE="进入${ENV_DISPLAY_NAME}待同步状态：${SERVICE_ARG}"
  MR_TITLE="进入${ENV_DISPLAY_NAME}待同步状态：${SERVICE_ARG}"
  MR_DESCRIPTION_HEADER="自动化 GitOps 待同步变更。"
else
  COMMIT_TITLE="发布到${ENV_DISPLAY_NAME}：${SERVICE_ARG}"
  MR_TITLE="发布到${ENV_DISPLAY_NAME}：${SERVICE_ARG}"
  MR_DESCRIPTION_HEADER="自动化 GitOps 发布。"
fi

git -C "$REPO_ROOT" commit -m "$COMMIT_TITLE" -m "$COMMIT_BODY"
refresh_promote_remote_tracking
git -C "$REPO_ROOT" push --force-with-lease -u "$REMOTE_NAME" "$PROMOTE_BRANCH"

MR_GATE_ACTIONS="$(json_array_to_bullets "$GATE_MANUAL_ACTIONS")"
MR_DESCRIPTION="$(cat <<EOF
$MR_DESCRIPTION_HEADER

- 环境：$ENV_DISPLAY_NAME ($ENV_NAME)
- 服务：$SERVICE_ARG
- 镜像：$IMAGE
- GitOps pin：$PIN_IMAGE
- 源 revision：$SOURCE_REF
- 发布时间：$DEPLOYED_AT
- 源分支：$PROMOTE_BRANCH
- 目标分支：$GITOPS_BRANCH
- 镜像存在性：$GATE_IMAGE_STATUS
- 镜像 digest：$GATE_IMAGE_DIGESTS_JSON
- 配置契约：$GATE_CONFIG_STATUS
- DB readiness：required=$GATE_REQUIRES_DB_READINESS status=$GATE_DB_STATUS
- 自动合并允许：$GATE_AUTO_MERGE_ALLOWED
- Argo sync：$GATE_ARGO_SYNC

人工动作：
$MR_GATE_ACTIONS
EOF
)"

MR_ARGS=(
  --api-base "$GIT_WOA_API_BASE"
  --project-id "$GITOPS_PROJECT_ID"
  --private-token "$GIT_WOA_PRIVATE_TOKEN_VALUE"
  --repo-path "$GITOPS_REPO_PATH"
  --source-branch "$PROMOTE_BRANCH"
  --target-branch "$GITOPS_BRANCH"
  --title "$MR_TITLE"
  --description "$MR_DESCRIPTION"
  --format dotenv
)

case "$ENV_NAME" in
  shprod)
    echo "GitOps 待同步策略：${ENV_DISPLAY_NAME} promote 分支不随 MR 合并自动删除，避免分支删除事件触发空 checkout"
    ;;
  *)
    MR_ARGS+=(--remove-source-branch)
    ;;
esac

mr_output="$(
  python3 "$RUNTIME_COMMAND_DIR/gitops_merge_request.py" "${MR_ARGS[@]}"
)"
printf '%s\n' "$mr_output"
eval "$mr_output"

if [[ -n "${MR_ID:-}" ]]; then
  NEXT_STAGE="等待 GitOps MR 合并"
  NOTE_HEADLINE="自动发布进度：镜像构建与 GitOps 投影完成。"
  if [[ "$ENV_NAME" == "shprod" && "$GATE_AUTO_MERGE_ALLOWED" == "true" ]]; then
    NOTE_HEADLINE="GitOps 进度：镜像构建与 GitOps 投影完成，等待人工 Argo sync。"
    NEXT_STAGE="等待 GitOps MR 自动合并；合并后进入待同步状态，Argo sync 由人工执行"
  elif [[ "$GATE_AUTO_MERGE_ALLOWED" != "true" ]]; then
    NEXT_STAGE="发布门禁未满足；不自动合并，按人工动作处理后重试"
  fi
  MR_NOTE_BODY="$(cat <<EOF
$NOTE_HEADLINE

- 环境：$ENV_DISPLAY_NAME ($ENV_NAME)
- 服务：$SERVICE_ARG
- 镜像：$IMAGE
- GitOps pin：$PIN_IMAGE
- 源 revision：$SOURCE_REF
- promote 分支：$PROMOTE_BRANCH
- 镜像存在性：$GATE_IMAGE_STATUS
- 镜像 digest：$GATE_IMAGE_DIGESTS_JSON
- 配置契约：$GATE_CONFIG_STATUS
- DB readiness：required=$GATE_REQUIRES_DB_READINESS status=$GATE_DB_STATUS
- 自动合并允许：$GATE_AUTO_MERGE_ALLOWED
- Argo sync：$GATE_ARGO_SYNC
- 下一阶段：$NEXT_STAGE

人工动作：
$MR_GATE_ACTIONS
EOF
)"
  python3 "$RUNTIME_COMMAND_DIR/gitops_merge_request_note.py" \
    --api-base "$GIT_WOA_API_BASE" \
    --project-id "$GITOPS_PROJECT_ID" \
    --private-token "$GIT_WOA_PRIVATE_TOKEN_VALUE" \
    --mr-id "$MR_ID" \
    --body "$MR_NOTE_BODY"
fi
