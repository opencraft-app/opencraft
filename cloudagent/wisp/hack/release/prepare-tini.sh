#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
goarch="${GOARCH:-amd64}"
image="${WISP_GO_IMAGE:-debian:bookworm-slim}"
out="${WISP_TINI_BINARY:-$repo_root/assets/bin/tini/tini-${goarch}}"

mkdir -p "$(dirname "$out")"

docker run --rm --platform "linux/$goarch" \
  -v "$repo_root:/src" \
  -e OUT="/src/${out#$repo_root/}" \
  "$image" bash -ceu '
    apt-get update >/dev/null
    apt-get install -y --no-install-recommends tini ca-certificates >/dev/null
    cp /usr/bin/tini "$OUT"
    chmod 0755 "$OUT"
  '

echo "$out"
