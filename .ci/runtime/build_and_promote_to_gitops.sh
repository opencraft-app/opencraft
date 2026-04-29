#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/.ci/init.sh"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <bundle-service> <pin-targets-csv> <build-envs-csv> <auto-pin-env-or-none>" >&2
  exit 1
fi

BUNDLE_SERVICE="$1"
PIN_TARGETS="$2"
BUILD_ENVS="$3"
AUTO_PIN_ENV="$4"

ci_require_commands git python3

SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
SOURCE_REF="$(git -C "$REPO_ROOT" rev-parse HEAD)"
TAG="${BUILD_TAG_OVERRIDE:-${BUNDLE_SERVICE}-${SHORT_SHA}}"

IFS=',' read -r -a ENVS <<<"$BUILD_ENVS"

declare -A BUILT_IMAGES=()

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
  BUILT_IMAGES["$ENV_NAME"]="$IMAGE"
  echo "built $BUNDLE_SERVICE for $ENV_NAME => $IMAGE"
done

if [[ "$AUTO_PIN_ENV" == "none" ]]; then
  exit 0
fi

AUTO_IMAGE="${BUILT_IMAGES[$AUTO_PIN_ENV]:-}"
if [[ -z "$AUTO_IMAGE" ]]; then
  echo "auto pin env $AUTO_PIN_ENV was not built" >&2
  exit 1
fi

DEPLOYED_AT="$DEPLOYED_AT" bash "$REPO_ROOT/.ci/runtime/pin_image_to_gitops.sh" "$BUNDLE_SERVICE" "$PIN_TARGETS" "$AUTO_PIN_ENV" "$AUTO_IMAGE" "$SOURCE_REF"
