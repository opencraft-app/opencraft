#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

usage() {
  cat <<'EOF'
Usage:
  scripts/update-sandbox-pool-image.sh <image-id> [pool-id ...]

Examples:
  scripts/update-sandbox-pool-image.sh img-xxxxxxxx
  scripts/update-sandbox-pool-image.sh img-xxxxxxxx pool-c3
  scripts/update-sandbox-pool-image.sh img-xxxxxxxx pool-c2 pool-c3 pool-c4 pool-c5

Environment:
  SANDBOX_API_BASE       Default: http://sandbox-api.sandbox.svc.cluster.local/internal
  MARK_CLEAN_AS_DRY      Default: true
  POOL_PATCH_INTERVAL_SECONDS
                         Default: 20. Sleep between pool patches.
  ENV_FILE               Optional .env file path. Default: <repo>/.env
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

IMAGE_ID="${1:-}"
shift || true
API_BASE="${SANDBOX_API_BASE:-http://sandbox-api.sandbox.svc.cluster.local/internal}"
MARK_CLEAN_AS_DRY="${MARK_CLEAN_AS_DRY:-true}"
POOL_PATCH_INTERVAL_SECONDS="${POOL_PATCH_INTERVAL_SECONDS:-20}"

if [[ -z "${IMAGE_ID}" ]]; then
  echo "missing image id" >&2
  usage >&2
  exit 1
fi

if [[ ! "${IMAGE_ID}" =~ ^img-[A-Za-z0-9]+$ ]]; then
  echo "image id must look like img-xxxx, got: ${IMAGE_ID}" >&2
  exit 1
fi

list_pool_ids() {
  local response
  response="$(curl -fsS "${API_BASE%/}/pools")"
  if command -v jq >/dev/null 2>&1; then
    jq -r '.[].id' <<<"${response}"
    return
  fi
  python3 - <<'PY' <<<"${response}"
import json, sys
for item in json.load(sys.stdin):
    print(item["id"])
PY
}

patch_pool() {
  local pool_id="$1"
  local patch_url body
  patch_url="${API_BASE%/}/pools/${pool_id}"
  body="$(printf '{"base_image":"%s","mark_clean_as_dry":%s}' "${IMAGE_ID}" "${MARK_CLEAN_AS_DRY}")"

  echo "patching pool image"
  echo "  api:   ${patch_url}"
  echo "  pool:  ${pool_id}"
  echo "  image: ${IMAGE_ID}"
  echo "  dry:   ${MARK_CLEAN_AS_DRY}"

  if command -v jq >/dev/null 2>&1; then
    curl -fsS -X PATCH "${patch_url}" \
      -H 'Content-Type: application/json' \
      -d "${body}" | jq .
  else
    curl -fsS -X PATCH "${patch_url}" \
      -H 'Content-Type: application/json' \
      -d "${body}"
    printf '\n'
  fi
}

patch_pools() {
  local first=1
  local id
  for id in "$@"; do
    if [[ "${first}" -eq 0 && "${POOL_PATCH_INTERVAL_SECONDS}" != "0" ]]; then
      echo "waiting ${POOL_PATCH_INTERVAL_SECONDS}s before next pool"
      sleep "${POOL_PATCH_INTERVAL_SECONDS}"
    fi
    first=0
    patch_pool "${id}"
  done
}

if [[ "$#" -gt 0 ]]; then
  patch_pools "$@"
  exit 0
fi

mapfile -t POOL_IDS < <(list_pool_ids)
if [[ "${#POOL_IDS[@]}" -eq 0 ]]; then
  echo "no pools found from ${API_BASE%/}/pools" >&2
  exit 1
fi

echo "patching all pools: ${POOL_IDS[*]}"
patch_pools "${POOL_IDS[@]}"
