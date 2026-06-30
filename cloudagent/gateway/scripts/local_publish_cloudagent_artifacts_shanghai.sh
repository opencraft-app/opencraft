#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
CALLER_DIR="$(pwd)"
cd "$ROOT_DIR"

usage() {
  cat >&2 <<'EOF'
Usage:
  cloudagent/gateway/scripts/local_publish_cloudagent_artifacts_shanghai.sh [options]

Options:
  --env-file PATH       Load release secrets from PATH before publishing.
  --arches LIST         Build and publish artifact arches, for example "amd64 arm64".
  --dry-run             Build/sign locally but do not upload to COS.
  --wisp-package PATH   Use an existing Wisp package artifact instead of building one.
  --help                Show this help.

Required credentials can come from the env file, process environment, or
runner-local files:
  CLOUDAGENT_AGENT_COS_SECRET_ID
  CLOUDAGENT_AGENT_COS_SECRET_KEY
  CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64

Default runner-local fallback files:
  /etc/lightclaw-ci/tencentcloud_secret_id
  /etc/lightclaw-ci/tencentcloud_secret_key
  /etc/lightclaw-ci/cloudagent_agent_release_ed25519_seed_b64

Example env file:
  CLOUDAGENT_AGENT_COS_SECRET_ID=AKID...
  CLOUDAGENT_AGENT_COS_SECRET_KEY=...
  CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64=...

Example:
  cloudagent/gateway/scripts/local_publish_cloudagent_artifacts_shanghai.sh \
    --env-file /path/to/cloudagent-release.env

Dry-run example:
  cloudagent/gateway/scripts/local_publish_cloudagent_artifacts_shanghai.sh \
    --env-file /path/to/cloudagent-release.env \
    --dry-run \
    --wisp-package /tmp/wisp-linux-amd64-test.erofs
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  fi
}

is_unexpanded_setting() {
  case "$1" in
    *'${{'*'}}'*) return 0 ;;
    *) return 1 ;;
  esac
}

first_env() {
  local name value
  for name in "$@"; do
    value="${!name:-}"
    if [ -n "$value" ] && ! is_unexpanded_setting "$value"; then
      printf '%s\n' "$value"
      return 0
    fi
  done
  return 1
}

first_file_value() {
  local path value
  for path in "$@"; do
    if [ -n "$path" ] && [ -f "$path" ]; then
      value="$(tr -d '\r\n' <"$path")"
      if [ -n "$value" ]; then
        printf '%s\n' "$value"
        return 0
      fi
    fi
  done
  return 1
}

require_secret() {
  local label="$1"
  local value="$2"
  if [ -z "$value" ]; then
    printf 'missing required secret: %s\n' "$label" >&2
    printf 'provide it in --env-file, exported env, or /etc/lightclaw-ci fallback files\n' >&2
    exit 2
  fi
}

ENV_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      if [ "$#" -lt 2 ]; then
        printf 'missing value for --env-file\n' >&2
        exit 2
      fi
      ENV_FILE="$2"
      shift 2
      ;;
    --dry-run)
      export CLOUDAGENT_ARTIFACTS_DRY_RUN=1
      shift
      ;;
    --arches)
      if [ "$#" -lt 2 ]; then
        printf 'missing value for --arches\n' >&2
        exit 2
      fi
      export CLOUDAGENT_ARTIFACT_ARCHES="$2"
      shift 2
      ;;
    --wisp-package)
      if [ "$#" -lt 2 ]; then
        printf 'missing value for --wisp-package\n' >&2
        exit 2
      fi
      case "$2" in
        /*) export CLOUDAGENT_WISP_PACKAGE_ARTIFACT="$2" ;;
        *) export CLOUDAGENT_WISP_PACKAGE_ARTIFACT="$CALLER_DIR/$2" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -n "$ENV_FILE" ]; then
  case "$ENV_FILE" in
    /*) ;;
    *) ENV_FILE="$CALLER_DIR/$ENV_FILE" ;;
  esac
  if [ ! -f "$ENV_FILE" ]; then
    printf 'env file does not exist: %s\n' "$ENV_FILE" >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

require_cmd bash
require_cmd docker
require_cmd make
require_cmd python3
require_cmd curl
require_cmd shasum

export CLOUDAGENT_AGENT_COS_BUCKET="${CLOUDAGENT_AGENT_COS_BUCKET:-cloudagent-sidecar-shanghai-1388575217}"
export CLOUDAGENT_AGENT_COS_REGION="${CLOUDAGENT_AGENT_COS_REGION:-ap-shanghai}"
export CLOUDAGENT_AGENT_COS_OBJECT_PREFIX="${CLOUDAGENT_AGENT_COS_OBJECT_PREFIX:-/agent-sidecar/releases}"
export CLOUDAGENT_AGENT_VERSION_PREFIX="${CLOUDAGENT_AGENT_VERSION_PREFIX:-cloudagent.v1}"
export CLOUDAGENT_WISP_COS_OBJECT_PREFIX="${CLOUDAGENT_WISP_COS_OBJECT_PREFIX:-/workspace/releases}"
export CLOUDAGENT_WORKSPACE_VERSION_PREFIX="${CLOUDAGENT_WORKSPACE_VERSION_PREFIX:-wisp.v1}"

if [ "$CLOUDAGENT_AGENT_COS_REGION" != "ap-shanghai" ] && [ "${CLOUDAGENT_AGENT_COS_ALLOW_NON_SHANGHAI:-0}" != "1" ]; then
  printf 'refuse to publish outside Shanghai COS: CLOUDAGENT_AGENT_COS_REGION=%s\n' "$CLOUDAGENT_AGENT_COS_REGION" >&2
  exit 2
fi

COS_SECRET_ID="$(first_env CLOUDAGENT_AGENT_COS_SECRET_ID COS_SECRETID COS_SECRET_ID TENCENTCLOUD_SECRET_ID AWS_ACCESS_KEY_ID || true)"
COS_SECRET_KEY="$(first_env CLOUDAGENT_AGENT_COS_SECRET_KEY COS_SECRETKEY COS_SECRET_KEY TENCENTCLOUD_SECRET_KEY AWS_SECRET_ACCESS_KEY || true)"
SIGNING_SEED="$(first_env CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64 || true)"

if [ -z "$COS_SECRET_ID" ]; then
  COS_SECRET_ID="$(first_file_value "${CLOUDAGENT_AGENT_COS_SECRET_ID_FILE:-}" /etc/lightclaw-ci/tencentcloud_secret_id || true)"
fi
if [ -z "$COS_SECRET_KEY" ]; then
  COS_SECRET_KEY="$(first_file_value "${CLOUDAGENT_AGENT_COS_SECRET_KEY_FILE:-}" /etc/lightclaw-ci/tencentcloud_secret_key || true)"
fi
if [ -z "$SIGNING_SEED" ]; then
  SIGNING_SEED="$(first_file_value "${CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64_FILE:-}" /etc/lightclaw-ci/cloudagent_agent_release_ed25519_seed_b64 || true)"
fi

require_secret CLOUDAGENT_AGENT_COS_SECRET_ID "$COS_SECRET_ID"
require_secret CLOUDAGENT_AGENT_COS_SECRET_KEY "$COS_SECRET_KEY"
require_secret CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64 "$SIGNING_SEED"

export CLOUDAGENT_AGENT_COS_SECRET_ID="$COS_SECRET_ID"
export CLOUDAGENT_AGENT_COS_SECRET_KEY="$COS_SECRET_KEY"
export CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64="$SIGNING_SEED"

printf '[cloudagent-local-publish] repo=%s\n' "$REPO_ROOT" >&2
printf '[cloudagent-local-publish] bucket=%s region=%s\n' "$CLOUDAGENT_AGENT_COS_BUCKET" "$CLOUDAGENT_AGENT_COS_REGION" >&2
printf '[cloudagent-local-publish] agent_prefix=%s workspace_prefix=%s\n' "$CLOUDAGENT_AGENT_COS_OBJECT_PREFIX" "$CLOUDAGENT_WISP_COS_OBJECT_PREFIX" >&2
printf '[cloudagent-local-publish] arches=%s\n' "${CLOUDAGENT_ARTIFACT_ARCHES:-${CLOUDAGENT_AGENT_GOARCH:-${LINUX_GOARCH:-amd64}}}" >&2
if [ "${CLOUDAGENT_ARTIFACTS_DRY_RUN:-0}" = "1" ]; then
  printf '[cloudagent-local-publish] dry_run=1\n' >&2
fi
if [ -n "${CLOUDAGENT_WISP_PACKAGE_ARTIFACT:-}" ]; then
  printf '[cloudagent-local-publish] wisp_package_artifact=%s\n' "$CLOUDAGENT_WISP_PACKAGE_ARTIFACT" >&2
fi

"$ROOT_DIR/scripts/ci_publish_cloudagent_artifacts_shanghai.sh"
