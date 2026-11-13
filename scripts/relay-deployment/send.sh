#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_SHA:?Expected workflow source revision}"
: "${RELAY_SSH_HOST:?Configure the relay-production environment}"
: "${RELAY_SSH_KEY:?Configure the dedicated restricted deployment key}"
: "${RELAY_SSH_KNOWN_HOSTS:?Configure verified SSH host keys}"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 1
[[ "$RELAY_SSH_HOST" =~ ^[a-zA-Z0-9.-]+$ ]] || exit 1
archive="${1:?Artifact directory}/opencraft-relay-${GITHUB_SHA}.tgz"
digest="$(tr -d '\r\n' < "$archive.sha256")"
[[ "$digest" =~ ^[a-f0-9]{64}$ ]] || exit 1
printf '%s  %s\n' "$digest" "$archive" | sha256sum -c - >/dev/null
umask 077
key_dir="$(mktemp -d)"
trap 'rm -rf "$key_dir"' EXIT
printf '%s\n' "$RELAY_SSH_KEY" > "$key_dir/key"
printf '%s\n' "$RELAY_SSH_KNOWN_HOSTS" > "$key_dir/known_hosts"
unset RELAY_SSH_KEY RELAY_SSH_KNOWN_HOSTS
ssh -T -i "$key_dir/key" -o IdentitiesOnly=yes -o BatchMode=yes \
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$key_dir/known_hosts" \
  -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  "opencraft-deploy@$RELAY_SSH_HOST" "deploy $GITHUB_SHA $digest" < "$archive"
