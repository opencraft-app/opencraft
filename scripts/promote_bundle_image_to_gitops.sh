#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <bundle-service> <pin-targets-csv> <target-env> <source-sha>" >&2
  exit 1
fi

BUNDLE_SERVICE="$1"
PIN_TARGETS="$2"
TARGET_ENV="$3"
SOURCE_SHA="$4"

if [[ -z "$SOURCE_SHA" ]]; then
  echo "missing source sha" >&2
  exit 1
fi

SHORT_SHA="${SOURCE_SHA:0:12}"
TAG="${BUNDLE_SERVICE}-${SHORT_SHA}"

eval "$(python3 "$REPO_ROOT/scripts/resolve_release_bundle.py" \
  --service "$BUNDLE_SERVICE" \
  --env "$TARGET_ENV" \
  --tag "$TAG" \
  --format dotenv)"

bash "$REPO_ROOT/scripts/pin_image_to_gitops.sh" "$PIN_TARGETS" "$TARGET_ENV" "$BUILD_IMAGE"
