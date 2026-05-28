#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
goarch="${GOARCH:-amd64}"
dst="${WISP_E2FSPROGS_DIR:-$repo_root/assets/bin/e2fsprogs/$goarch}"
image="${WISP_E2FSPROGS_IMAGE:-debian:bookworm-slim}"
apt_mirror="${WISP_APT_MIRROR:-}"

case "$goarch" in
  amd64) platform_arch="amd64" ;;
  arm64) platform_arch="arm64" ;;
  *) echo "unsupported GOARCH for e2fsprogs package: $goarch" >&2; exit 2 ;;
esac

rm -rf "$dst"
mkdir -p "$dst"

docker run --rm --platform "linux/$platform_arch" \
  -v "$dst:/out" \
  -e APT_MIRROR="$apt_mirror" \
  "$image" bash -ceu '
    if [[ -n "${APT_MIRROR:-}" ]]; then
      sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g; s|http://security.debian.org/debian-security|${APT_MIRROR}-security|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true
      sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g; s|http://security.debian.org/debian-security|${APT_MIRROR}-security|g" /etc/apt/sources.list 2>/dev/null || true
    fi
    apt-get update >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends e2fsprogs util-linux >/dev/null
    mkdir -p /out/bin /out/lib
    cp /sbin/mke2fs /sbin/e2fsck /out/bin/
    ldd /sbin/mke2fs /sbin/e2fsck \
      | awk '"'"'/=> \// { print $(NF-1) } /^\// { print $1 }'"'"' \
      | sort -u \
      | while read -r lib; do
          case "$lib" in
            /lib*/ld-linux-*|/lib*/libc.so*|/usr/lib*/libc.so*) continue ;;
          esac
          [[ -f "$lib" ]] || continue
          cp -L "$lib" /out/lib/
        done
    chmod +x /out/bin/mke2fs /out/bin/e2fsck
  '

test -x "$dst/bin/mke2fs"
test -x "$dst/bin/e2fsck"
echo "$dst"
