#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/.ci/init.sh"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
PIN_SCRIPT="${PIN_SCRIPT_OVERRIDE:-$REPO_ROOT/.ci/runtime/pin_image_to_gitops.sh}"

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <bundle-service> <pin-targets-csv> <build-envs-csv> <auto-pin-envs-csv-or-none>" >&2
  exit 1
fi

BUNDLE_SERVICE="$1"
PIN_TARGETS="$2"
BUILD_ENVS="$3"
AUTO_PIN_ENVS="$4"

ci_require_commands git python3

SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
SOURCE_REF="$(git -C "$REPO_ROOT" rev-parse HEAD)"
TAG="${BUILD_TAG_OVERRIDE:-${BUNDLE_SERVICE}-${SHORT_SHA}}"

IFS=',' read -r -a ENVS <<<"$BUILD_ENVS"

BUILT_IMAGE_DIR="$(mktemp -d)"
cleanup_built_image_dir() {
  rm -rf "$BUILT_IMAGE_DIR"
}
trap cleanup_built_image_dir EXIT

for ENV_NAME in "${ENVS[@]}"; do
  ci_set_registry_credentials "$ENV_NAME"
  image_output_file="$(mktemp)"
  python3 "$REPO_ROOT/.ci/runtime/commands/build_release_image.py" \
    --service "$BUNDLE_SERVICE" \
    --env "$ENV_NAME" \
    --tag "$TAG" \
    --push \
    --image-output-file "$image_output_file"
  IMAGE="$(<"$image_output_file")"
  rm -f "$image_output_file"
  printf '%s\n' "$IMAGE" > "$BUILT_IMAGE_DIR/$ENV_NAME"
  echo "built $BUNDLE_SERVICE for $ENV_NAME => $IMAGE"
done

print_manual_promote_hints() {
  local has_hint=0
  local color_reset=$'\033[0m'
  local color_title=$'\033[1;36m'
  local color_key=$'\033[1;33m'
  local color_cmd=$'\033[1;32m'

  for ENV_NAME in "${ENVS[@]}"; do
    ENV_NAME="$(printf '%s' "$ENV_NAME" | xargs)"
    if [[ -z "$ENV_NAME" ]]; then
      continue
    fi
    local image_file="$BUILT_IMAGE_DIR/$ENV_NAME"
    if [[ ! -s "$image_file" ]]; then
      continue
    fi
    local image
    image="$(<"$image_file")"
    if [[ "$has_hint" -eq 0 ]]; then
      echo
      echo "${color_title}============================================================${color_reset}"
      echo "${color_title}发布产物已生成：可复制下面参数手动 promote${color_reset}"
      echo "${color_title}============================================================${color_reset}"
      has_hint=1
    fi
    echo "${color_key}服务:${color_reset} ${BUNDLE_SERVICE}"
    echo "${color_key}目标环境:${color_reset} ${ENV_NAME}"
    echo "${color_key}SOURCE_SHA:${color_reset} ${SOURCE_REF}"
    echo "${color_key}镜像 tag:${color_reset} ${TAG}"
    echo "${color_key}镜像:${color_reset} ${image}"
    echo "${color_key}手动触发参数:${color_reset} PIPELINE_MODE=promote TARGET_ENV=${ENV_NAME} SOURCE_SHA=${SOURCE_REF}"
    echo "${color_cmd}一键本地命令:${color_reset} REMOTE_URL=\"\$(ci_gitops_remote_url)\" GITOPS_BRANCH=gitops bash .ci/runtime/promote_bundle_image_to_gitops.sh ${BUNDLE_SERVICE} ${PIN_TARGETS} ${ENV_NAME} ${SOURCE_REF}"
    echo "${color_title}------------------------------------------------------------${color_reset}"
  done
}

print_manual_promote_hints

if [[ "$AUTO_PIN_ENVS" == "none" ]]; then
  exit 0
fi

IFS=',' read -r -a AUTO_ENVS <<<"$AUTO_PIN_ENVS"
for AUTO_PIN_ENV in "${AUTO_ENVS[@]}"; do
  AUTO_PIN_ENV="$(printf '%s' "$AUTO_PIN_ENV" | xargs)"
  if [[ -z "$AUTO_PIN_ENV" ]]; then
    continue
  fi
  AUTO_IMAGE_FILE="$BUILT_IMAGE_DIR/$AUTO_PIN_ENV"
  if [[ ! -s "$AUTO_IMAGE_FILE" ]]; then
    echo "auto pin env $AUTO_PIN_ENV was not built" >&2
    exit 1
  fi
  AUTO_IMAGE="$(<"$AUTO_IMAGE_FILE")"

  DEPLOYED_AT="$DEPLOYED_AT" bash "$PIN_SCRIPT" "$BUNDLE_SERVICE" "$PIN_TARGETS" "$AUTO_PIN_ENV" "$AUTO_IMAGE" "$SOURCE_REF"
done
