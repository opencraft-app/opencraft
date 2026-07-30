#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
goarch="${GOARCH:-amd64}"
alpine_version="${ALPINE_VERSION:-3.20}"
image_size="${IMAGE_SIZE:-512M}"
out="${DST_ROOTFS_IMAGE:-$repo_root/assets/rootfs/images/alpine-${goarch}.img}"
rootfs_url="${ALPINE_ROOTFS_URL:-}"
apk_repository="${ALPINE_APK_REPOSITORY:-https://mirrors.tencent.com/alpine/v3.23}"
builder_image="${WISP_ROOTFS_BUILDER_IMAGE:-golang:1.25-bookworm}"
tmp="${TMPDIR:-/tmp}/wisp-alpine-rootfs-$$"

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

cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

mkdir -p "$tmp" "$(dirname "$out")"

curl -fsSL --retry 3 --retry-delay 1 "$rootfs_url" -o "$tmp/rootfs.tar.gz"

docker run --rm --privileged --platform "$platform" \
  -v "$tmp:/work" \
  -v "$(dirname "$out"):/out" \
  "$builder_image" bash -ceu '
    out="/out/'"$(basename "$out")"'"
    img="/work/alpine-rootfs.img"
    mnt="/mnt/wisp-rootfs"
    cleanup() {
      set +e
      umount "$mnt/proc" >/dev/null 2>&1
      umount "$mnt/dev" >/dev/null 2>&1
      umount "$mnt/sys" >/dev/null 2>&1
      umount "$mnt" >/dev/null 2>&1
    }
    trap cleanup EXIT
    rm -f "$out"
    rm -f "$img"
    truncate -s "'"$image_size"'" "$img"
    mke2fs -F -t ext4 -m 0 -J size=32 -O sparse_super2,^64bit,^metadata_csum "$img" >/dev/null
    mkdir -p "$mnt"
    mount -o loop "$img" "$mnt"
    tar -xzf /work/rootfs.tar.gz -C "$mnt"
    mkdir -p "$mnt/proc" "$mnt/dev/pts" "$mnt/dev/shm" "$mnt/dev/mqueue" "$mnt/sys/fs/cgroup" "$mnt/run" "$mnt/mnt" "$mnt/tmp" "$mnt/var/lib/docker" "$mnt/root" "$mnt/home/root"
    chmod 1777 "$mnt/tmp"
    cp /etc/resolv.conf "$mnt/etc/resolv.conf"
    mount -t proc proc "$mnt/proc"
    mount --rbind /dev "$mnt/dev"
    mount --rbind /sys "$mnt/sys"
    printf "%s\n%s\n" "'"$apk_repository"'/main" "'"$apk_repository"'/community" > "$mnt/etc/apk/repositories"
    chroot "$mnt" /bin/sh -lc "apk add --no-cache \
        ca-certificates gcompat libc6-compat tzdata \
        bash coreutils findutils grep sed gawk \
        curl wget jq git openssl \
        tar gzip xz zstd unzip \
        procps-ng iproute2 bind-tools \
      && update-ca-certificates"
    umount "$mnt/proc"
    umount -l "$mnt/dev"
    umount -l "$mnt/sys"
    rm -f "$mnt/etc/mtab"
    ln -s /proc/mounts "$mnt/etc/mtab"
    if [ ! -e "$mnt/lib64/ld-linux-x86-64.so.2" ] && [ -e "$mnt/lib/ld-linux-x86-64.so.2" ]; then
      mkdir -p "$mnt/lib64"
      ln -s ../lib/ld-linux-x86-64.so.2 "$mnt/lib64/ld-linux-x86-64.so.2"
    fi
    touch "$mnt/.wisp-base-ready"
    sync
    umount "$mnt"
    dd if="$img" of="$out" bs=16M status=none conv=fsync
  '

echo "$out"
