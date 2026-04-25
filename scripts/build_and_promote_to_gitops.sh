#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
TCR_USERNAME="${TCR_USERNAME:-100045199955}"

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <bundle-service> <pin-targets-csv> <build-envs-csv> <auto-pin-env-or-none>" >&2
  exit 1
fi

BUNDLE_SERVICE="$1"
PIN_TARGETS="$2"
BUILD_ENVS="$3"
AUTO_PIN_ENV="$4"

for cmd in git python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required tool: $cmd" >&2
    exit 1
  fi
done

SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
TAG="${BUILD_TAG_OVERRIDE:-${BUNDLE_SERVICE}-${SHORT_SHA}}"

IFS=',' read -r -a ENVS <<<"$BUILD_ENVS"

declare -A BUILT_IMAGES=()

set_registry_credentials() {
  local env_name="$1"
  unset REGISTRY_USERNAME REGISTRY_PASSWORD
  case "$env_name" in
    beijing-sandbox)
      if [[ -n "${TCR_BEIJING_PASSWORD:-}" ]]; then
        export REGISTRY_USERNAME="$TCR_USERNAME"
        export REGISTRY_PASSWORD="$TCR_BEIJING_PASSWORD"
      fi
      ;;
    shprod)
      if [[ -n "${TCR_SHPROD_PASSWORD:-}" ]]; then
        export REGISTRY_USERNAME="$TCR_USERNAME"
        export REGISTRY_PASSWORD="$TCR_SHPROD_PASSWORD"
      fi
      ;;
  esac
}

for ENV_NAME in "${ENVS[@]}"; do
  set_registry_credentials "$ENV_NAME"
  IMAGE="$(python3 "$REPO_ROOT/scripts/build-release-image.py" --service "$BUNDLE_SERVICE" --env "$ENV_NAME" --tag "$TAG" --push | tail -n 1)"
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

DEPLOYED_AT="$DEPLOYED_AT" bash "$REPO_ROOT/scripts/pin_image_to_gitops.sh" "$PIN_TARGETS" "$AUTO_PIN_ENV" "$AUTO_IMAGE"
