#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
RUNTIME_COMMAND_DIR="${RUNTIME_COMMAND_DIR:-$SCRIPT_DIR/commands}"
PIN_SCRIPT="${PIN_SCRIPT_OVERRIDE:-$SCRIPT_DIR/pin_image_to_gitops.sh}"

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <bundle-service> <pin-targets-csv> <target-envs-csv> <source-sha>" >&2
  exit 1
fi

BUNDLE_SERVICE="$1"
PIN_TARGETS="$2"
TARGET_ENV="$3"
SOURCE_SHA="$4"

if [[ -z "$SOURCE_SHA" ]]; then
  SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  echo "source sha not provided; default to HEAD=$SOURCE_SHA"
fi

CI_RUNTIME_REF="${CI_RUNTIME_REF:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '%s' "$SOURCE_SHA")}"
CI_RUNTIME_COMMIT="${CI_RUNTIME_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf '%s' "$SOURCE_SHA")}"
export CI_RUNTIME_REF CI_RUNTIME_COMMIT

SHORT_SHA="${SOURCE_SHA:0:12}"
TAG="${BUNDLE_SERVICE}-${SHORT_SHA}"

IFS=',' read -r -a TARGET_ENVS <<<"$TARGET_ENV"
PROMOTED_COUNT=0
PROMOTION_WORKTREE_ROOT="$(mktemp -d)"
PROMOTION_WORKTREES=()

cleanup_promotion_worktrees() {
  local worktree
  for worktree in "${PROMOTION_WORKTREES[@]}"; do
    git -C "$REPO_ROOT" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  done
  rmdir "$PROMOTION_WORKTREE_ROOT" >/dev/null 2>&1 || true
}
trap cleanup_promotion_worktrees EXIT

for ENV_NAME in "${TARGET_ENVS[@]}"; do
  ENV_NAME="$(printf '%s' "$ENV_NAME" | xargs)"
  if [[ -z "$ENV_NAME" ]]; then
    continue
  fi

  RESOLVE_OUTPUT="$(
    python3 "$RUNTIME_COMMAND_DIR/resolve_release_bundle.py" \
      --service "$BUNDLE_SERVICE" \
      --env "$ENV_NAME" \
      --tag "$TAG" \
      --format dotenv
  )" || {
    echo "failed to resolve release bundle for service ${BUNDLE_SERVICE} env ${ENV_NAME}" >&2
    exit 1
  }

  unset BUILD_SERVICE BUILD_ENV BUILD_TAG BUILD_DOCKERFILE BUILD_CONTEXT BUILD_IMAGE_REPO BUILD_IMAGE BUILD_IMAGES_JSON
  eval "$RESOLVE_OUTPUT"
  if [[ -z "${BUILD_IMAGE:-}" ]]; then
    echo "release bundle resolver did not emit BUILD_IMAGE for service ${BUNDLE_SERVICE} env ${ENV_NAME}" >&2
    exit 1
  fi

  ENV_WORKTREE="$PROMOTION_WORKTREE_ROOT/${PROMOTED_COUNT}-${ENV_NAME}"
  git -C "$REPO_ROOT" worktree add --detach "$ENV_WORKTREE" "$SOURCE_SHA"
  PROMOTION_WORKTREES+=("$ENV_WORKTREE")
  REPO_ROOT="$ENV_WORKTREE" bash "$PIN_SCRIPT" "$BUNDLE_SERVICE" "$PIN_TARGETS" "$ENV_NAME" "$BUILD_IMAGE" "$SOURCE_SHA"
  PROMOTED_COUNT=$((PROMOTED_COUNT + 1))
done

if [[ "$PROMOTED_COUNT" -eq 0 ]]; then
  echo "target env list is empty" >&2
  exit 1
fi
