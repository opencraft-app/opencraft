#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/.ci/init.sh"
REMOTE_NAME="${REMOTE_NAME:-origin}"
REMOTE_URL="${REMOTE_URL:-}"
GITOPS_BRANCH="${GITOPS_BRANCH:-gitops}"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
COMMITTER_NAME="${COMMITTER_NAME:-skipzhang}"
COMMITTER_EMAIL="${COMMITTER_EMAIL:-skipzhang@tencent.com}"
ci_export_gongfeng_defaults
GITOPS_AUTO_MERGE_ENVS="${GITOPS_AUTO_MERGE_ENVS:-beijing-sandbox}"
BOOTSTRAP_FILES=(
  ".ci/gitops-promotion.yml"
)

if [[ $# -ne 5 ]]; then
  echo "usage: $0 <bundle-service> <service[,service2,...]> <env> <image> <source-ref>" >&2
  exit 1
fi

BUNDLE_SERVICE="$1"
SERVICE_ARG="$2"
ENV_NAME="$3"
IMAGE="$4"
SOURCE_REF="$5"

ci_require_commands git python3

sanitize_branch_component() {
  printf '%s' "$1" | tr ',:/' '-' | tr -cs '[:alnum:]._-' '-'
}

env_display_name() {
  case "$1" in
    beijing-sandbox) printf '北京测试' ;;
    beijing-sandbox-2) printf '北京测试2' ;;
    shprod) printf '上海正式' ;;
    sgprod) printf '新加坡正式' ;;
    *) printf '%s' "$1" ;;
  esac
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

for bootstrap_file in "${BOOTSTRAP_FILES[@]}"; do
  if [[ ! -f "$REPO_ROOT/$bootstrap_file" ]]; then
    echo "missing bootstrap file: $bootstrap_file" >&2
    exit 1
  fi
  mkdir -p "$bootstrap_dir/$(dirname "$bootstrap_file")"
  cp "$REPO_ROOT/$bootstrap_file" "$bootstrap_dir/$bootstrap_file"
done

mkdir -p "$bootstrap_dir/.ci"
cp -R "$REPO_ROOT/.ci/runtime" "$bootstrap_dir/.ci/runtime"
RUNTIME_COMMAND_DIR="$bootstrap_dir/.ci/runtime/harness_ci/commands"

if [[ -n "$REMOTE_URL" ]]; then
  REMOTE_NAME="gitops-target"
  if git -C "$REPO_ROOT" remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
    git -C "$REPO_ROOT" remote set-url "$REMOTE_NAME" "$REMOTE_URL"
  else
    git -C "$REPO_ROOT" remote add "$REMOTE_NAME" "$REMOTE_URL"
  fi
fi

git -C "$REPO_ROOT" fetch "$REMOTE_NAME" "$GITOPS_BRANCH"

IMAGE_TAG="${IMAGE##*:}"
SERVICE_SLUG="$(sanitize_branch_component "$SERVICE_ARG")"
PROMOTE_BRANCH="promote-$(sanitize_branch_component "$ENV_NAME")-${SERVICE_SLUG}-$(sanitize_branch_component "$IMAGE_TAG")"
ENV_DISPLAY_NAME="$(env_display_name "$ENV_NAME")"

echo "============================================================"
echo "GitOps 发布意图：准备把镜像推进到 ${ENV_DISPLAY_NAME}"
echo "发布 bundle：${BUNDLE_SERVICE}"
echo "目标服务：${SERVICE_ARG}"
echo "目标环境：${ENV_DISPLAY_NAME} (${ENV_NAME})"
echo "目标镜像：${IMAGE}"
echo "源代码 revision：${SOURCE_REF}"
echo "GitOps 目标分支：${GITOPS_BRANCH}"
echo "promote 分支：${PROMOTE_BRANCH}"
echo "执行说明：先从 master runtime 临时副本投影发布子集，再更新 image pin 并创建/复用 MR"
echo "============================================================"

git -C "$REPO_ROOT" checkout -B "$PROMOTE_BRANCH" "$REMOTE_NAME/$GITOPS_BRANCH"
git -C "$REPO_ROOT" config user.name "$COMMITTER_NAME"
git -C "$REPO_ROOT" config user.email "$COMMITTER_EMAIL"

for bootstrap_file in "${BOOTSTRAP_FILES[@]}"; do
  mkdir -p "$REPO_ROOT/$(dirname "$bootstrap_file")"
  cp "$bootstrap_dir/$bootstrap_file" "$REPO_ROOT/$bootstrap_file"
  git -C "$REPO_ROOT" add "$bootstrap_file"
done

python3 "$RUNTIME_COMMAND_DIR/project_release_bundle.py" \
  --repo-root "$REPO_ROOT" \
  --service "$BUNDLE_SERVICE" \
  --env "$ENV_NAME" \
  --source-ref "$SOURCE_REF"

IFS=',' read -r -a SERVICES <<<"$SERVICE_ARG"

for SERVICE in "${SERVICES[@]}"; do
  echo "GitOps 发布进度：更新 ${SERVICE}/${ENV_NAME} 的镜像 pin"
  python3 "$RUNTIME_COMMAND_DIR/update_image_pin.py" \
    --repo-root "$REPO_ROOT" \
    --service "$SERVICE" \
    --env "$ENV_NAME" \
    --image "$IMAGE" \
    --deployed-at "$DEPLOYED_AT"
  git -C "$REPO_ROOT" add "argocd/services/$SERVICE/$ENV_NAME"
done

if git -C "$REPO_ROOT" diff --cached --quiet; then
  echo "no gitops pin changes detected"
  exit 0
fi

git -C "$REPO_ROOT" commit -m "发布到${ENV_DISPLAY_NAME}：${SERVICE_ARG}"
git -C "$REPO_ROOT" push --force-with-lease -u "$REMOTE_NAME" "$PROMOTE_BRANCH"

MR_TITLE="发布到${ENV_DISPLAY_NAME}：${SERVICE_ARG}"
MR_DESCRIPTION="$(cat <<EOF
自动化 GitOps 发布。

- 环境：$ENV_DISPLAY_NAME ($ENV_NAME)
- 服务：$SERVICE_ARG
- 镜像：$IMAGE
- 源 revision：$SOURCE_REF
- 发布时间：$DEPLOYED_AT
- 源分支：$PROMOTE_BRANCH
- 目标分支：$GITOPS_BRANCH
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
  --remove-source-branch
  --format dotenv
)

mr_output="$(
  python3 "$RUNTIME_COMMAND_DIR/gitops_merge_request.py" "${MR_ARGS[@]}"
)"
printf '%s\n' "$mr_output"
eval "$mr_output"

if [[ -n "${MR_ID:-}" ]]; then
  MR_NOTE_BODY="$(cat <<EOF
自动发布进度：镜像构建与 GitOps 投影完成。

- 环境：$ENV_DISPLAY_NAME ($ENV_NAME)
- 服务：$SERVICE_ARG
- 镜像：$IMAGE
- 源 revision：$SOURCE_REF
- promote 分支：$PROMOTE_BRANCH
- 下一阶段：等待 GitOps MR 合并
EOF
)"
  python3 "$RUNTIME_COMMAND_DIR/gitops_merge_request_note.py" \
    --api-base "$GIT_WOA_API_BASE" \
    --project-id "$GITOPS_PROJECT_ID" \
    --private-token "$GIT_WOA_PRIVATE_TOKEN_VALUE" \
    --mr-id "$MR_ID" \
    --body "$MR_NOTE_BODY"
fi
