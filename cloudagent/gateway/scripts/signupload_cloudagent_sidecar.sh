#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUDAGENT_DIR="$(cd "$ROOT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib/load_env.sh"
load_cloudagent_env "$ROOT_DIR"

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    printf 'missing required env: %s\n' "$name" >&2
    exit 2
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  fi
}

cos_config_value() {
  local key="$1"
  awk -F '=' -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      value = $2
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "$COSCMD_CONFIG"
}

COSCMD_BIN="${COSCMD_BIN:-coscmd}"
COSCMD_CONFIG="${COSCMD_CONFIG:-/tmp/cos-agent-sidecar.conf}"
COS_OBJECT_PREFIX="${COS_OBJECT_PREFIX:-/agent-sidecar/$(date +%Y%m%d)}"
SIDECAR_LOCAL_PATH="${GATEWAY_AGENT_SIDECAR_BINARY:-$ROOT_DIR/dist/cloudagent-sidecar-linux-amd64}"
SIDECAR_BASENAME="${CLOUDAGENT_SIDECAR_BASENAME:-cloudagent-sidecar-linux-amd64}"
SIGNING_KEY_ID="${CLOUDAGENT_AGENT_SIGNING_KEY_ID:-cloudagent-agent-release-v1}"
AGENT_VERSION_PREFIX="${CLOUDAGENT_AGENT_VERSION_PREFIX:-cloudagent.v1}"
REGISTRY_FILE="${CLOUDAGENT_AGENT_REGISTRY_FILE:-/tmp/cloudagent-agent-version-registry.json}"
URL_FILE="${GATEWAY_AGENT_SIDECAR_URL_FILE:-/tmp/agent-sidecar-url.clean}"
SHA_FILE="${GATEWAY_AGENT_SIDECAR_SHA256_FILE:-/tmp/agent-sidecar-sha256.clean}"
SIG_URL_FILE="${GATEWAY_AGENT_SIDECAR_SIG_URL_FILE:-/tmp/agent-sidecar-sig-url.clean}"
DRY_RUN="${CLOUDAGENT_SIGNUPLOAD_DRY_RUN:-0}"

require_cmd "$COSCMD_BIN"
require_cmd cargo
require_cmd make
require_cmd shasum

if [ ! -f "$COSCMD_CONFIG" ]; then
  printf 'missing COSCMD_CONFIG file: %s\n' "$COSCMD_CONFIG" >&2
  exit 2
fi

if [ ! -f "$SIDECAR_LOCAL_PATH" ]; then
  printf '[signupload] build sidecar: make cloudagent-sidecar-linux\n' >&2
  make cloudagent-sidecar-linux >&2
fi
if [ ! -f "$SIDECAR_LOCAL_PATH" ]; then
  printf 'missing sidecar binary after build: %s\n' "$SIDECAR_LOCAL_PATH" >&2
  exit 2
fi

COS_BUCKET="${COS_BUCKET:-$(cos_config_value bucket)}"
COS_REGION="${COS_REGION:-$(cos_config_value region)}"
require_env COS_BUCKET
require_env COS_REGION

SIDECAR_SHA="$(shasum -a 256 "$SIDECAR_LOCAL_PATH" | awk '{print $1}')"
SIDECAR_OBJECT="${COS_OBJECT_PREFIX%/}/${SIDECAR_BASENAME}-${SIDECAR_SHA:0:12}"
SIDECAR_SIG_LOCAL_PATH="${SIDECAR_LOCAL_PATH}.sig"
SIDECAR_SIG_OBJECT="${SIDECAR_OBJECT}.sig"
PUBLIC_BASE_URL="${COS_PUBLIC_BASE_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com}"
PUBLIC_URL="${PUBLIC_BASE_URL%/}/${SIDECAR_OBJECT#/}"
PUBLIC_SIG_URL="${PUBLIC_BASE_URL%/}/${SIDECAR_SIG_OBJECT#/}"
AGENT_VERSION="${CLOUDAGENT_AGENT_VERSION:-${AGENT_VERSION_PREFIX}-${SIDECAR_SHA:0:12}}"

sign_args=(
  run --quiet
  --manifest-path "$CLOUDAGENT_DIR/agent-loader/Cargo.toml"
  --bin cloudagent-agent-sign
  --
  --key-id "$SIGNING_KEY_ID"
  --artifact "$SIDECAR_LOCAL_PATH"
  --output "$SIDECAR_SIG_LOCAL_PATH"
)
if [ -n "${CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_FILE:-}" ]; then
  sign_args+=(--seed-file "$CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_FILE")
fi

printf '[signupload] sign %s -> %s key_id=%s\n' "$SIDECAR_LOCAL_PATH" "$SIDECAR_SIG_LOCAL_PATH" "$SIGNING_KEY_ID" >&2
PUBLIC_KEY_B64="$(cargo "${sign_args[@]}")"

if [ "$DRY_RUN" = "1" ]; then
  printf '[signupload] dry-run enabled; skip COS upload and HEAD checks\n' >&2
else
  printf '[signupload] upload %s -> %s\n' "$SIDECAR_LOCAL_PATH" "$SIDECAR_OBJECT" >&2
  "$COSCMD_BIN" -c "$COSCMD_CONFIG" upload -f -y "$SIDECAR_LOCAL_PATH" "$SIDECAR_OBJECT" >&2
  printf '[signupload] upload %s -> %s\n' "$SIDECAR_SIG_LOCAL_PATH" "$SIDECAR_SIG_OBJECT" >&2
  "$COSCMD_BIN" -c "$COSCMD_CONFIG" upload -f -y "$SIDECAR_SIG_LOCAL_PATH" "$SIDECAR_SIG_OBJECT" >&2

  printf '[signupload] set public-read -> %s\n' "$SIDECAR_OBJECT" >&2
  "$COSCMD_BIN" -c "$COSCMD_CONFIG" putobjectacl "$SIDECAR_OBJECT" --grant-read anyone >&2
  printf '[signupload] set public-read -> %s\n' "$SIDECAR_SIG_OBJECT" >&2
  "$COSCMD_BIN" -c "$COSCMD_CONFIG" putobjectacl "$SIDECAR_SIG_OBJECT" --grant-read anyone >&2

  if command -v curl >/dev/null 2>&1; then
    curl -fsSI --connect-timeout 10 --max-time 30 "$PUBLIC_URL" >/dev/null
    curl -fsSI --connect-timeout 10 --max-time 30 "$PUBLIC_SIG_URL" >/dev/null
  fi
fi

mkdir -p "$(dirname "$URL_FILE")" "$(dirname "$SHA_FILE")" "$(dirname "$SIG_URL_FILE")" "$(dirname "$REGISTRY_FILE")"
printf '%s\n' "$PUBLIC_URL" >"$URL_FILE"
printf '%s\n' "$SIDECAR_SHA" >"$SHA_FILE"
printf '%s\n' "$PUBLIC_SIG_URL" >"$SIG_URL_FILE"

python3 - "$REGISTRY_FILE" "$AGENT_VERSION" "$PUBLIC_URL" "$SIDECAR_SHA" "$PUBLIC_SIG_URL" "$SIGNING_KEY_ID" <<'PY'
import json
import sys

path, version, url, sha256, sig_url, key_id = sys.argv[1:]
entry = {
    version: {
        "sidecar_url": url,
        "sidecar_sha256": sha256,
        "sidecar_sig_url": sig_url,
        "signing_key_id": key_id,
    }
}
raw = json.dumps(entry, indent=2, sort_keys=True)
with open(path, "w", encoding="utf-8") as fh:
    fh.write(raw + "\n")
print(raw)
PY

printf '[signupload] public_key_b64=%s\n' "$PUBLIC_KEY_B64" >&2
printf '[signupload] trusted_keys_json={"keys":{"%s":"%s"}}\n' "$SIGNING_KEY_ID" "$PUBLIC_KEY_B64" >&2
printf '[signupload] registry_file=%s\n' "$REGISTRY_FILE" >&2
