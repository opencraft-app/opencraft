#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
goarch="${GOARCH:-amd64}"
image="${WISP_GO_IMAGE:-debian:bookworm-slim}"
out="${WISP_TINI_BINARY:-$repo_root/assets/bin/tini/tini-${goarch}}"
apt_mirror="${WISP_APT_MIRROR:-}"

mkdir -p "$(dirname "$out")"

docker run --rm --platform "linux/$goarch" \
  -v "$repo_root:/src" \
  -e OUT="/src/${out#$repo_root/}" \
  -e APT_MIRROR="$apt_mirror" \
  "$image" bash -ceu '
    if [[ -n "${APT_MIRROR:-}" ]]; then
      sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g; s|http://security.debian.org/debian-security|${APT_MIRROR}-security|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true
      sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g; s|http://security.debian.org/debian-security|${APT_MIRROR}-security|g" /etc/apt/sources.list 2>/dev/null || true
    fi
    apt-get update >/dev/null
    apt-get install -y --no-install-recommends tini ca-certificates >/dev/null
    cp /usr/bin/tini "$OUT"
    chmod 0755 "$OUT"
  '

echo "$out"
