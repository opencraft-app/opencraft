#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
goarch="${GOARCH:-amd64}"
out="${DST_ROOTFS_DIR:-$repo_root/assets/rootfs/rootfs/alpine-$goarch}"
rootfs_url="${ALPINE_ROOTFS_URL:-}"
apk_repository="${ALPINE_APK_REPOSITORY:-https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.23}"
builder_image="${WISP_ROOTFS_DIR_BUILDER_IMAGE:-alpine:3.23}"

case "$goarch" in
  amd64)
    platform="linux/amd64"
    rootfs_url="${rootfs_url:-https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86_64/alpine-minirootfs-3.23.4-x86_64.tar.gz}"
    ;;
  arm64)
    platform="linux/arm64"
    rootfs_url="${rootfs_url:-https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/aarch64/alpine-minirootfs-3.23.4-aarch64.tar.gz}"
    ;;
  *) echo "unsupported GOARCH for alpine rootfs: $goarch" >&2; exit 2 ;;
esac

rm -rf "$out"
mkdir -p "$out"

docker run --rm --platform "$platform" \
  -v "$out:/rootfs" \
  -e ROOTFS_URL="$rootfs_url" \
  -e APK_REPOSITORY="$apk_repository" \
  "$builder_image" sh -ceu '
    apk add --no-cache ca-certificates tar gzip >/dev/null
    mkdir -p /work
    wget -qO /work/rootfs.tar.gz "$ROOTFS_URL"
    tar -xzf /work/rootfs.tar.gz -C /rootfs
    printf "%s\n%s\n" "$APK_REPOSITORY/main" "$APK_REPOSITORY/community" > /rootfs/etc/apk/repositories
    apk --root /rootfs --initdb --no-cache \
      --repository "$APK_REPOSITORY/main" \
      --repository "$APK_REPOSITORY/community" \
      add \
        ca-certificates gcompat libc6-compat tzdata \
        bash coreutils findutils grep sed gawk \
        curl wget jq git openssl \
        tar gzip xz zstd unzip \
        procps-ng iproute2 bind-tools \
        >/dev/null
    mkdir -p /rootfs/proc /rootfs/dev/pts /rootfs/dev/shm /rootfs/dev/mqueue /rootfs/sys/fs/cgroup /rootfs/run /rootfs/mnt /rootfs/tmp /rootfs/var/lib/docker /rootfs/root /rootfs/home/root
    chmod 1777 /rootfs/tmp
    cp /etc/resolv.conf /rootfs/etc/resolv.conf
    rm -f /rootfs/etc/mtab
    ln -s /proc/mounts /rootfs/etc/mtab
    if [ ! -e /rootfs/lib64/ld-linux-x86-64.so.2 ] && [ -e /rootfs/lib/ld-linux-x86-64.so.2 ]; then
      mkdir -p /rootfs/lib64
      ln -s ../lib/ld-linux-x86-64.so.2 /rootfs/lib64/ld-linux-x86-64.so.2
    fi
    touch /rootfs/.wisp-base-ready
  '

python3 - "$out" <<'PY'
import os
import sys

root = os.path.abspath(sys.argv[1])
for current, dirs, files in os.walk(root):
    for name in dirs + files:
        path = os.path.join(current, name)
        if not os.path.islink(path):
            continue
        target = os.readlink(path)
        if not target.startswith("/"):
            continue
        absolute_target = os.path.join(root, target.lstrip("/"))
        relative_target = os.path.relpath(absolute_target, os.path.dirname(path))
        os.unlink(path)
        os.symlink(relative_target, path)
mtab = os.path.join(root, "etc", "mtab")
if os.path.islink(mtab):
    os.unlink(mtab)
    with open(mtab, "w", encoding="utf-8") as fh:
        fh.write("")
PY

test -f "$out/.wisp-base-ready"
echo "$out"
