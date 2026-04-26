#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_NAME="${REMOTE_NAME:-origin}"
REMOTE_URL="${REMOTE_URL:-}"
GITOPS_BRANCH="${GITOPS_BRANCH:-gitops}"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
COMMITTER_NAME="${COMMITTER_NAME:-skipzhang}"
COMMITTER_EMAIL="${COMMITTER_EMAIL:-skipzhang@tencent.com}"
GITOPS_PROJECT_ID="${GITOPS_PROJECT_ID:-1731878}"
GITOPS_REPO_PATH="${GITOPS_REPO_PATH:-wisp/mono2}"
GIT_WOA_API_BASE="${GIT_WOA_API_BASE:-https://git.woa.com/api/v3}"
GIT_WOA_PRIVATE_TOKEN_FILE="${GIT_WOA_PRIVATE_TOKEN_FILE:-/etc/lightclaw-ci/git_woa_private_token}"
GITOPS_AUTO_MERGE_ENVS="${GITOPS_AUTO_MERGE_ENVS:-beijing-sandbox}"
BOOTSTRAP_FILES=(
  "scripts/update_image_pin.py"
  "scripts/gitops_merge_request.py"
  "scripts/gitops_cleanup_source_branch.py"
  ".ci/gitops-promotion.yml"
)

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <service[,service2,...]> <env> <image>" >&2
  exit 1
fi

SERVICE_ARG="$1"
ENV_NAME="$2"
IMAGE="$3"

for cmd in git python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required tool: $cmd" >&2
    exit 1
  fi
done

read_secret_value() {
  python3 -c 'import sys; print(sys.stdin.read().strip())'
}

load_git_woa_private_token() {
  if [[ -r "$GIT_WOA_PRIVATE_TOKEN_FILE" ]]; then
    read_secret_value < "$GIT_WOA_PRIVATE_TOKEN_FILE"
    return 0
  fi

  if [[ -n "${GIT_WOA_PRIVATE_TOKEN:-}" ]]; then
    printf '%s' "$GIT_WOA_PRIVATE_TOKEN" | read_secret_value
    return 0
  fi

  return 1
}

sanitize_branch_component() {
  printf '%s' "$1" | tr ',:/' '-' | tr -cs '[:alnum:]._-' '-'
}

should_auto_merge_env() {
  local needle="$1"
  IFS=',' read -r -a envs <<<"$GITOPS_AUTO_MERGE_ENVS"
  for env in "${envs[@]}"; do
    if [[ "$env" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
  echo "repository has uncommitted changes; refuse to rewrite branch state" >&2
  exit 1
fi

if ! GIT_WOA_PRIVATE_TOKEN_VALUE="$(load_git_woa_private_token)"; then
  echo "missing Git WOA private token; set GIT_WOA_PRIVATE_TOKEN or provide $GIT_WOA_PRIVATE_TOKEN_FILE" >&2
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

git -C "$REPO_ROOT" checkout -B "$PROMOTE_BRANCH" "$REMOTE_NAME/$GITOPS_BRANCH"
git -C "$REPO_ROOT" config user.name "$COMMITTER_NAME"
git -C "$REPO_ROOT" config user.email "$COMMITTER_EMAIL"

for bootstrap_file in "${BOOTSTRAP_FILES[@]}"; do
  mkdir -p "$REPO_ROOT/$(dirname "$bootstrap_file")"
  cp "$bootstrap_dir/$bootstrap_file" "$REPO_ROOT/$bootstrap_file"
  git -C "$REPO_ROOT" add "$bootstrap_file"
done

IFS=',' read -r -a SERVICES <<<"$SERVICE_ARG"

for SERVICE in "${SERVICES[@]}"; do
  python3 "$REPO_ROOT/scripts/update_image_pin.py" \
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

git -C "$REPO_ROOT" commit -m "Promote $SERVICE_ARG to $ENV_NAME via gitops"
git -C "$REPO_ROOT" push --force-with-lease -u "$REMOTE_NAME" "$PROMOTE_BRANCH"

MR_TITLE="Promote $SERVICE_ARG to $ENV_NAME via gitops"
MR_DESCRIPTION="$(cat <<EOF
Automated GitOps promotion.

- env: $ENV_NAME
- services: $SERVICE_ARG
- image: $IMAGE
- deployed_at: $DEPLOYED_AT
- source_branch: $PROMOTE_BRANCH
- target_branch: $GITOPS_BRANCH
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

if should_auto_merge_env "$ENV_NAME"; then
  MR_ARGS+=(--auto-merge)
fi

python3 "$REPO_ROOT/scripts/gitops_merge_request.py" "${MR_ARGS[@]}"
