#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
upload_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# This is a trusted, root-owned local file. Do not commit registry credentials.
source "$upload_root/.env"
: "${UPLOAD_SINCE:?Set an explicit start time to avoid uploading historical releases}"
: "${REGISTRY_REPOSITORY:?Set an explicit destination repository}"
[[ "$REGISTRY_REPOSITORY" =~ ^[a-z0-9][a-z0-9.:-]*/[a-z0-9._/-]+$ ]] || { echo "Invalid registry repository" >&2; exit 1; }
upload_state="${UPLOAD_STATE:-/var/lib/opencraft-registry-upload}"
mkdir -p "$upload_state/docker-config"
exec 9>"$upload_state/upload.lock"
flock -n 9 || exit 0
export DOCKER_CONFIG="$upload_state/docker-config"
if [[ -n "${REGISTRY_PASSWORD:-}" ]]; then
  printf '%s' "$REGISTRY_PASSWORD" | docker login "${REGISTRY_REPOSITORY%%/*}" \
    --username "${REGISTRY_USERNAME:?Set REGISTRY_USERNAME}" --password-stdin >/dev/null
fi
unset REGISTRY_PASSWORD REGISTRY_USERNAME
exec "${OPENCRAFT_NODE:-/usr/bin/node}" "$upload_root/upload-fast-releases.mjs" \
  "${RELEASE_STATE:-/opt/opencraft-docker/fast-release-state}" "$upload_state" "$UPLOAD_SINCE" "$REGISTRY_REPOSITORY"
