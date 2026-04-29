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
  python3 "$REPO_ROOT/.ci/runtime/harness_ci/commands/build_release_image.py" \
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
