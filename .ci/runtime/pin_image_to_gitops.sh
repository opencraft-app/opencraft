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
GATE_IMAGE_STATUS="unknown"
GATE_DB_STATUS="unknown"

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

load_release_gate_plan() {
  local db_status="$1"
  local gate_env_file
  gate_env_file="$(mktemp)"
  python3 "$RUNTIME_COMMAND_DIR/plan_release_gates.py" \
    --repo-root "$REPO_ROOT" \
    --service "$BUNDLE_SERVICE" \
    --env "$ENV_NAME" \
    --source-sha "$SOURCE_REF" \
    --image "$IMAGE" \
    --pin-targets "$SERVICE_ARG" \
    --db-status "$db_status" \
    --format dotenv > "$gate_env_file"
  # shellcheck disable=SC1090
  source "$gate_env_file"
  rm -f "$gate_env_file"
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

run_release_gate() {
  load_release_gate_plan "$GATE_DB_STATUS"

  echo "============================================================"
  echo "GitOps 发布门禁：DB-aware release gate"
  echo "DB contract：mode=${GATE_DB_MODE} migration_changed=${GATE_MIGRATION_CHANGED}"
  echo "DB job：required=${GATE_REQUIRES_DB_JOB} service=${GATE_DB_JOB_SERVICE} operation=${GATE_DB_JOB_OPERATION}"
  echo "DB readiness：required=${GATE_REQUIRES_DB_READINESS} supported=${GATE_READINESS_SUPPORTED} status=${GATE_DB_STATUS}"
  echo "依赖变更：${GATE_RELEASE_DEPENDENCY_CHANGED} dependencies=${GATE_RELEASE_DEPENDENCIES}"
  echo "自动合并允许：${GATE_AUTO_MERGE_ALLOWED}"
  echo "Argo sync 策略：${GATE_ARGO_SYNC} auto_sync_allowed=${GATE_AUTO_SYNC_ALLOWED}"
  echo "人工动作："
  json_array_to_bullets "$GATE_MANUAL_ACTIONS"
  echo "============================================================"

  case "$ENV_NAME" in
    beijing-sandbox|beijing-sandbox-2)
      if [[ "$GATE_RELEASE_DEPENDENCY_CHANGED" == "true" ]]; then
        echo "同批依赖服务发生变更；北京自动发布停止，避免无序自动 sync。" >&2
        exit 1
      fi
      if [[ "$GATE_REQUIRES_DB_READINESS" == "true" ]]; then
        ci_ensure_db_job_tools
        if [[ "$GATE_READINESS_SUPPORTED" != "true" ]]; then
          echo "DB readiness contract 不支持自动校验；停止自动发布。" >&2
          exit 1
        fi
        if [[ "$GATE_REQUIRES_DB_JOB" == "true" ]]; then
          db_job_args=(
            --service "$GATE_DB_JOB_SERVICE"
            --operation "$GATE_DB_JOB_OPERATION"
            --env "$ENV_NAME"
            --revision "$SOURCE_REF"
            --apply
            --wait
          )
          if [[ -n "$GATE_DB_JOB_IMAGE_OVERRIDE" ]]; then
            db_job_args+=(--image-override "$GATE_DB_JOB_IMAGE_OVERRIDE")
          fi
          echo "GitOps 发布门禁：先执行受控 DB job"
          python3 "$REPO_ROOT/scripts/run_gitops_db_job.py" "${db_job_args[@]}"
        fi
        echo "GitOps 发布门禁：执行 DB readiness 只读校验"
        python3 "$RUNTIME_COMMAND_DIR/verify_db_contract.py" \
          --repo-root "$REPO_ROOT" \
          --service "$BUNDLE_SERVICE" \
          --env "$ENV_NAME" \
          --apply \
          --wait
        GATE_DB_STATUS="passed"
        load_release_gate_plan "$GATE_DB_STATUS"
      fi
      if [[ "$GATE_AUTO_MERGE_ALLOWED" != "true" ]]; then
        echo "北京自动发布门禁未通过；不创建可自动合并的 GitOps MR。" >&2
        exit 1
      fi
      ;;
    shprod)
      echo "上海生产策略：GitOps MR 可进入待同步状态；Argo sync 保持人工执行。"
      if [[ "$GATE_REQUIRES_DB_READINESS" == "true" ]]; then
        ci_ensure_db_job_tools
        if [[ "$GATE_READINESS_SUPPORTED" != "true" ]]; then
          echo "DB readiness contract 不支持自动校验；停止进入上海生产待同步状态。" >&2
          exit 1
        fi
        echo "GitOps 待同步门禁：执行上海生产 DB readiness 只读校验"
        python3 "$RUNTIME_COMMAND_DIR/verify_db_contract.py" \
          --repo-root "$REPO_ROOT" \
          --service "$BUNDLE_SERVICE" \
          --env "$ENV_NAME" \
          --apply \
          --wait
        GATE_DB_STATUS="passed"
        load_release_gate_plan "$GATE_DB_STATUS"
      fi
      ;;
    *)
      echo "非自动环境：只创建 GitOps MR，不自动 Argo sync。"
      ;;
  esac
}

run_image_gate() {
  local image_gate_file

  echo "============================================================"
  echo "GitOps 发布门禁：校验目标镜像是否已存在"
  echo "目标环境：${ENV_NAME}"
  echo "目标镜像：${IMAGE}"
  echo "说明：GitOps pin 只能写入已存在于镜像仓库的 tag；缺失时停止 promote，避免 Argo 拉取 ImagePullBackOff。"
  echo "============================================================"

  ci_set_registry_credentials "$ENV_NAME"
  image_gate_file="$(mktemp)"
  if ! python3 "$RUNTIME_COMMAND_DIR/verify_image_exists.py" \
    --image "$IMAGE" \
    --format dotenv > "$image_gate_file"; then
    rm -f "$image_gate_file"
    echo "镜像存在性门禁失败；不会写 GitOps pin，也不会创建 promote MR。" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$image_gate_file"
  rm -f "$image_gate_file"

  if [[ "${IMAGE_EXISTS:-false}" != "true" ]]; then
    echo "镜像存在性门禁失败；verify_image_exists.py 未确认所有镜像存在。" >&2
    exit 1
  fi
  GATE_IMAGE_STATUS="passed"

  echo "============================================================"
  echo "GitOps 发布门禁：镜像存在性校验通过"
  echo "镜像清单：${IMAGE_REFS_JSON:-[]}"
  echo "============================================================"
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
RUNTIME_COMMAND_DIR="$bootstrap_dir/.ci/runtime/commands"
run_image_gate
run_release_gate

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
if [[ "$ENV_NAME" == "shprod" ]]; then
  echo "GitOps 待同步意图：准备把镜像 desired state 推进到 ${ENV_DISPLAY_NAME}"
else
  echo "GitOps 发布意图：准备把镜像推进到 ${ENV_DISPLAY_NAME}"
fi
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

COMMIT_BODY="$(cat <<EOF
Release-bundle: ${BUNDLE_SERVICE}
Release-target-env: ${ENV_NAME}
Release-pin-targets: ${SERVICE_ARG}
Release-image: ${IMAGE}
Release-gate-image-status: ${GATE_IMAGE_STATUS}
Release-gate-db-status: ${GATE_DB_STATUS}
Release-gate-db-readiness-required: ${GATE_REQUIRES_DB_READINESS}
Release-gate-auto-merge: ${GATE_AUTO_MERGE_ALLOWED}
Release-gate-auto-sync: ${GATE_AUTO_SYNC_ALLOWED}
Release-gate-argo-sync: ${GATE_ARGO_SYNC}
Release-gate-dependency-changed: ${GATE_RELEASE_DEPENDENCY_CHANGED}
Source-revision: ${SOURCE_REF}
EOF
)"
if [[ "$ENV_NAME" == "shprod" ]]; then
  COMMIT_TITLE="进入${ENV_DISPLAY_NAME}待同步状态：${SERVICE_ARG}"
  MR_TITLE="进入${ENV_DISPLAY_NAME}待同步状态：${SERVICE_ARG}"
  MR_DESCRIPTION_HEADER="自动化 GitOps 待同步变更。"
else
  COMMIT_TITLE="发布到${ENV_DISPLAY_NAME}：${SERVICE_ARG}"
  MR_TITLE="发布到${ENV_DISPLAY_NAME}：${SERVICE_ARG}"
  MR_DESCRIPTION_HEADER="自动化 GitOps 发布。"
fi

git -C "$REPO_ROOT" commit -m "$COMMIT_TITLE" -m "$COMMIT_BODY"
git -C "$REPO_ROOT" push --force-with-lease -u "$REMOTE_NAME" "$PROMOTE_BRANCH"

MR_GATE_ACTIONS="$(json_array_to_bullets "$GATE_MANUAL_ACTIONS")"
MR_DESCRIPTION="$(cat <<EOF
$MR_DESCRIPTION_HEADER

- 环境：$ENV_DISPLAY_NAME ($ENV_NAME)
- 服务：$SERVICE_ARG
- 镜像：$IMAGE
- 源 revision：$SOURCE_REF
- 发布时间：$DEPLOYED_AT
- 源分支：$PROMOTE_BRANCH
- 目标分支：$GITOPS_BRANCH
- 镜像存在性：$GATE_IMAGE_STATUS
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
- 源 revision：$SOURCE_REF
- promote 分支：$PROMOTE_BRANCH
- 镜像存在性：$GATE_IMAGE_STATUS
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
