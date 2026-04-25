#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
TCR_USERNAME="${TCR_USERNAME:-100045199955}"
TCR_BEIJING_PASSWORD_FILE="${TCR_BEIJING_PASSWORD_FILE:-/etc/lightclaw-ci/tcr_beijing_password}"
TCR_SHPROD_PASSWORD_FILE="${TCR_SHPROD_PASSWORD_FILE:-/etc/lightclaw-ci/tcr_shprod_password}"

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

read_secret_value() {
  python3 -c 'import sys; print(sys.stdin.read().strip())'
}

fingerprint_secret() {
  python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.read().encode()).hexdigest()[:12])'
}

load_registry_password() {
  local env_name="$1"
  local password_var=""
  local password_file=""

  case "$env_name" in
    beijing-sandbox)
      password_var="${TCR_BEIJING_PASSWORD:-}"
      password_file="$TCR_BEIJING_PASSWORD_FILE"
      ;;
    shprod)
      password_var="${TCR_SHPROD_PASSWORD:-}"
      password_file="$TCR_SHPROD_PASSWORD_FILE"
      ;;
    *)
      return 1
      ;;
  esac

  if [[ -r "$password_file" ]]; then
    printf '%s' "$(read_secret_value < "$password_file")"
    return 0
  fi

  if [[ -n "$password_var" ]]; then
    printf '%s' "$password_var" | read_secret_value
    return 0
  fi

  return 1
}

set_registry_credentials() {
  local env_name="$1"
  local raw_password=""
  local password=""
  local source="none"
  unset REGISTRY_USERNAME REGISTRY_PASSWORD
  unset REGISTRY_PASSWORD_SOURCE

  if raw_password="$(load_registry_password "$env_name")"; then
    password="$(printf '%s' "$raw_password" | read_secret_value)"
    case "$env_name" in
      beijing-sandbox)
        if [[ -r "$TCR_BEIJING_PASSWORD_FILE" ]]; then
          source="file:$TCR_BEIJING_PASSWORD_FILE"
        else
          source="env:TCR_BEIJING_PASSWORD"
        fi
        ;;
      shprod)
        if [[ -r "$TCR_SHPROD_PASSWORD_FILE" ]]; then
          source="file:$TCR_SHPROD_PASSWORD_FILE"
        else
          source="env:TCR_SHPROD_PASSWORD"
        fi
        ;;
    esac
    export REGISTRY_USERNAME="$TCR_USERNAME"
    export REGISTRY_PASSWORD="$password"
    export REGISTRY_PASSWORD_SOURCE="$source"
    echo "registry credentials for $env_name loaded from $source (username=$REGISTRY_USERNAME, raw_password_len=${#raw_password}, password_len=${#REGISTRY_PASSWORD}, password_trimmed=$([[ \"$raw_password\" == \"$password\" ]] && echo no || echo yes), password_fingerprint=$(printf '%s' \"$password\" | fingerprint_secret))"
    return 0
  fi

  echo "registry credentials for $env_name are not configured; push is expected to fail" >&2
  return 1
}

for ENV_NAME in "${ENVS[@]}"; do
  set_registry_credentials "$ENV_NAME"
  image_output_file="$(mktemp)"
  python3 "$REPO_ROOT/scripts/build-release-image.py" \
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

DEPLOYED_AT="$DEPLOYED_AT" bash "$REPO_ROOT/scripts/pin_image_to_gitops.sh" "$PIN_TARGETS" "$AUTO_PIN_ENV" "$AUTO_IMAGE"
