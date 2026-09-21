#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
source "$SCRIPT_DIR/../init.sh"
ci_export_gongfeng_defaults

if [[ $# -ne 5 ]]; then
  echo "usage: $0 <foundation|runtime> <source-sha> <image@digest> <im-sdk-app-id> <im-admin-user-id>" >&2
  exit 1
fi

PHASE="$1"
SOURCE_SHA="$2"
IMAGE="$3"
IM_SDK_APP_ID="$4"
IM_ADMIN_USER_ID="$5"
ENV_NAME="beijing-sandbox"
GITOPS_BRANCH="${GITOPS_BRANCH:-gitops}"
REMOTE_URL="${REMOTE_URL:-$(ci_gitops_remote_url)}"
REMOTE_NAME="collaboration-gitops-target"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
COMMITTER_NAME="${COMMITTER_NAME:-skipzhang}"
COMMITTER_EMAIL="${COMMITTER_EMAIL:-skipzhang@tencent.com}"
SECRET_REL="argocd/secrets/${ENV_NAME}/collaboration-runtime-secrets.sops.yaml"
GATEWAY_SECRET_REL="argocd/secrets/${ENV_NAME}/collaboration-gateway-token.sops.yaml"

case "$PHASE" in
  foundation | runtime) ;;
  *)
    echo "phase must be foundation or runtime" >&2
    exit 1
    ;;
esac

ci_require_commands git python3
if ! git -C "$REPO_ROOT" cat-file -e "${SOURCE_SHA}^{commit}"; then
  echo "source sha is not available: $SOURCE_SHA" >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/$SECRET_REL" ]]; then
  echo "encrypted Collaboration SOPS artifact is missing" >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/$GATEWAY_SECRET_REL" ]]; then
  echo "encrypted Collaboration gateway bridge SOPS artifact is missing" >&2
  exit 1
fi
if ! GIT_WOA_PRIVATE_TOKEN_VALUE="$(ci_load_git_woa_private_token)"; then
  echo "missing Git WOA private token" >&2
  exit 1
fi

if git -C "$REPO_ROOT" remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  git -C "$REPO_ROOT" remote set-url "$REMOTE_NAME" "$REMOTE_URL"
else
  git -C "$REPO_ROOT" remote add "$REMOTE_NAME" "$REMOTE_URL"
fi
git -C "$REPO_ROOT" fetch "$REMOTE_NAME" "+refs/heads/${GITOPS_BRANCH}:refs/remotes/${REMOTE_NAME}/${GITOPS_BRANCH}"

WORKTREE_ROOT="$(mktemp -d)"
WORKTREE="$WORKTREE_ROOT/repo"
cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rmdir "$WORKTREE_ROOT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

SHORT_SHA="${SOURCE_SHA:0:12}"
BRANCH="bootstrap-${ENV_NAME}-collaboration-${PHASE}-${SHORT_SHA}"
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "$REMOTE_NAME/$GITOPS_BRANCH"
git -C "$WORKTREE" checkout -B "$BRANCH"

python3 "$SCRIPT_DIR/commands/project_release_bundle.py" \
  --repo-root "$WORKTREE" \
  --service collaboration \
  --env "$ENV_NAME" \
  --source-ref "$SOURCE_SHA"

mkdir -p "$WORKTREE/$(dirname "$SECRET_REL")"
cp "$REPO_ROOT/$SECRET_REL" "$WORKTREE/$SECRET_REL"
cp "$REPO_ROOT/$GATEWAY_SECRET_REL" "$WORKTREE/$GATEWAY_SECRET_REL"
python3 "$SCRIPT_DIR/commands/project_collaboration_bootstrap.py" \
  --repo-root "$WORKTREE" \
  --phase "$PHASE" \
  --image "$IMAGE" \
  --sdk-app-id "$IM_SDK_APP_ID" \
  --im-admin-user-id "$IM_ADMIN_USER_ID" \
  --deployed-at "$DEPLOYED_AT"

git -C "$WORKTREE" add \
  "argocd/catalogs/candidates/${ENV_NAME}/collaboration-foundation.yaml" \
  "argocd/catalogs/candidates/${ENV_NAME}/collaboration.yaml" \
  "argocd/catalogs/sandbox/${ENV_NAME}/collaboration.yaml" \
  "argocd/services/collaboration" \
  "$SECRET_REL" \
  "$GATEWAY_SECRET_REL" \
  "collaboration/k8s/base" \
  "scripts/ssm_manifest.collaboration.${ENV_NAME}.yaml"

if git -C "$WORKTREE" diff --cached --quiet; then
  echo "Collaboration ${PHASE} projection has no GitOps changes"
  exit 0
fi

git -C "$WORKTREE" config user.name "$COMMITTER_NAME"
git -C "$WORKTREE" config user.email "$COMMITTER_EMAIL"
COMMIT_TITLE="初始化北京测试 Collaboration ${PHASE}"
git -C "$WORKTREE" commit -m "$COMMIT_TITLE" -m "Collaboration-bootstrap-phase: ${PHASE}
Release-source-revision: ${SOURCE_SHA}
Release-image: ${IMAGE}
Release-target-env: ${ENV_NAME}"

if ! git -C "$REPO_ROOT" fetch "$REMOTE_NAME" "+refs/heads/${BRANCH}:refs/remotes/${REMOTE_NAME}/${BRANCH}" >/dev/null 2>&1; then
  git -C "$REPO_ROOT" update-ref -d "refs/remotes/${REMOTE_NAME}/${BRANCH}" >/dev/null 2>&1 || true
fi
git -C "$WORKTREE" push --force-with-lease -u "$REMOTE_NAME" "$BRANCH"

MR_TITLE="初始化北京测试 Collaboration ${PHASE}"
MR_DESCRIPTION="自动化 Collaboration 北京 ${PHASE} GitOps 变更。

- 环境：${ENV_NAME}
- 阶段：${PHASE}
- source revision：${SOURCE_SHA}
- image：${IMAGE}
- 分支：${BRANCH}
- 目标：${GITOPS_BRANCH}
- 自动合并：否

foundation 只创建 Namespace、ServiceAccount 和加密 Secret；runtime 必须在 foundation 收敛且 MySQL migrate/status/verify 通过后生成。"

python3 "$SCRIPT_DIR/commands/gitops_merge_request.py" \
  --api-base "$GIT_WOA_API_BASE" \
  --project-id "$GITOPS_PROJECT_ID" \
  --private-token "$GIT_WOA_PRIVATE_TOKEN_VALUE" \
  --repo-path "$GITOPS_REPO_PATH" \
  --source-branch "$BRANCH" \
  --target-branch "$GITOPS_BRANCH" \
  --title "$MR_TITLE" \
  --description "$MR_DESCRIPTION" \
  --remove-source-branch \
  --format dotenv
