#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_NAME="${REMOTE_NAME:-origin}"
REMOTE_URL="${REMOTE_URL:-}"
GITOPS_BRANCH="${GITOPS_BRANCH:-gitops}"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
COMMITTER_NAME="${COMMITTER_NAME:-skipzhang}"
COMMITTER_EMAIL="${COMMITTER_EMAIL:-skipzhang@tencent.com}"

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

if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
  echo "repository has uncommitted changes; refuse to rewrite branch state" >&2
  exit 1
fi

if [[ -n "$REMOTE_URL" ]]; then
  REMOTE_NAME="gitops-target"
  if git -C "$REPO_ROOT" remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
    git -C "$REPO_ROOT" remote set-url "$REMOTE_NAME" "$REMOTE_URL"
  else
    git -C "$REPO_ROOT" remote add "$REMOTE_NAME" "$REMOTE_URL"
  fi
fi

git -C "$REPO_ROOT" fetch "$REMOTE_NAME" "$GITOPS_BRANCH"
git -C "$REPO_ROOT" checkout -B "$GITOPS_BRANCH" "$REMOTE_NAME/$GITOPS_BRANCH"
git -C "$REPO_ROOT" config user.name "$COMMITTER_NAME"
git -C "$REPO_ROOT" config user.email "$COMMITTER_EMAIL"

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
git -C "$REPO_ROOT" push "$REMOTE_NAME" "$GITOPS_BRANCH"
