#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUDAGENT_DIR="$(cd "$ROOT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib/load_env.sh"
load_cloudagent_env "$ROOT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  fi
}

require_cmd cargo
require_cmd openssl

ENV_FILE="${CLOUDAGENT_SIGNING_ENV_FILE:-${CLOUDAGENT_ENV_FILE:-$ROOT_DIR/.env}}"
SIGNING_KEY_ID="${CLOUDAGENT_AGENT_SIGNING_KEY_ID:-cloudagent-agent-release-v1}"
SEED_B64="${CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64:-}"
FORCE="${CLOUDAGENT_AGENT_SIGNING_KEY_FORCE:-0}"

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod go-rwx "$ENV_FILE" 2>/dev/null || true

if [ -n "$SEED_B64" ] && [ "$FORCE" != "1" ]; then
  printf '[signing-key] reuse existing CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64 from %s\n' "$ENV_FILE" >&2
else
  SEED_B64="$(openssl rand -base64 32)"
  {
    printf '\n# CloudAgent signed sidecar release key. Do not commit or print this seed.\n'
    printf 'CLOUDAGENT_AGENT_SIGNING_KEY_ID=%s\n' "$SIGNING_KEY_ID"
    printf 'CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64=%s\n' "$SEED_B64"
  } >>"$ENV_FILE"
  printf '[signing-key] wrote new private signing seed to %s\n' "$ENV_FILE" >&2
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
printf 'cloudagent signing key probe\n' >"$tmpdir/artifact"

PUBLIC_KEY_B64="$(
  CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64="$SEED_B64" \
    cargo run --quiet \
      --manifest-path "$CLOUDAGENT_DIR/agent-loader/Cargo.toml" \
      --bin cloudagent-agent-sign \
      -- \
      --key-id "$SIGNING_KEY_ID" \
      --artifact "$tmpdir/artifact" \
      --output "$tmpdir/artifact.sig"
)"

printf '[signing-key] key_id=%s\n' "$SIGNING_KEY_ID" >&2
printf '[signing-key] public_key_b64=%s\n' "$PUBLIC_KEY_B64" >&2
printf '[signing-key] trusted_keys_json={"keys":{"%s":"%s"}}\n' "$SIGNING_KEY_ID" "$PUBLIC_KEY_B64" >&2
printf '{"keys":{"%s":"%s"}}\n' "$SIGNING_KEY_ID" "$PUBLIC_KEY_B64"
