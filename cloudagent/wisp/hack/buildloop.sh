#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSET_DIR="$ROOT_DIR/assets/rootfs"
DOWNLOAD_DIR="$ASSET_DIR/downloads"
IMAGE_DIR="$ASSET_DIR/images"
BUILD_ROOT="${BUILD_ROOT:-/tmp/wisp-rootfs-build}"
IMAGE_SIZE="${IMAGE_SIZE:-8G}"
WISP_USER="${WISP_USER:-wisp}"
WISP_UID="${WISP_UID:-1001}"
WISP_GID="${WISP_GID:-1001}"
WISP_SHELL="${WISP_SHELL:-/bin/bash}"

declare -A URLS=(
  [amd64]="https://cloud-images.ubuntu.com/releases/plucky/release/ubuntu-25.04-server-cloudimg-amd64-root.tar.xz"
  [arm64]="https://cloud-images.ubuntu.com/releases/plucky/release/ubuntu-25.04-server-cloudimg-arm64-root.tar.xz"
)

case "$(uname -m)" in
  x86_64) HOST_ARCH="amd64" ;;
  aarch64|arm64) HOST_ARCH="arm64" ;;
  *)
    echo "unsupported host architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd tar
require_cmd truncate
require_cmd mkfs.ext4
require_cmd losetup
require_cmd mount
require_cmd umount
require_cmd mountpoint

if [[ "${EUID}" -ne 0 ]]; then
  echo "buildloop.sh must run as root" >&2
  exit 1
fi

mkdir -p "$DOWNLOAD_DIR" "$IMAGE_DIR"

download() {
  local arch="$1"
  local url="${URLS[$arch]}"
  local dest="$DOWNLOAD_DIR/rootfs-$arch.tar.xz"
  if [[ -s "$dest" ]]; then
    echo "cached tarball: $dest"
    return
  fi
  echo "downloading $arch rootfs: $url"
  curl -fL --retry 3 --retry-delay 2 -o "$dest.tmp" "$url"
  mv "$dest.tmp" "$dest"
}

build_image() {
  local arch="$1"
  local tarball="$DOWNLOAD_DIR/rootfs-$arch.tar.xz"
  local image="$IMAGE_DIR/plucky-$arch.img"
  local mount_dir="$BUILD_ROOT/mnt-$arch"
  local loop_dev=""

  echo "building loop image: $image"
  mkdir -p "$BUILD_ROOT"
  rm -rf "$mount_dir"
  mkdir -p "$mount_dir"
  rm -f "$image"

  truncate -s "$IMAGE_SIZE" "$image"
  mke2fs -F -t ext4 -m 0 -J size=128 -E stride=1024,stripe-width=1024 -O sparse_super2,^64bit,^metadata_csum "$image" >/dev/null

  loop_dev="$(losetup --find --show "$image")"
  cleanup_loop() {
    if mountpoint -q "$mount_dir"; then
      umount "$mount_dir"
    fi
    if [[ -n "$loop_dev" ]]; then
      losetup -d "$loop_dev"
    fi
    rm -rf "$mount_dir"
  }
  trap cleanup_loop RETURN

  mount "$loop_dev" "$mount_dir"
  tar -xJf "$tarball" -C "$mount_dir"
  prebake_wisp_base "$mount_dir"
  sync
}

append_if_missing() {
  local path="$1"
  local prefix="$2"
  local line="$3"
  touch "$path"
  if ! grep -q "^$prefix" "$path"; then
    printf '%s\n' "$line" >> "$path"
  fi
}

prebake_wisp_base() {
  local root="$1"
  local shadow_days
  shadow_days="$(( $(date +%s) / 86400 ))"

  mkdir -p \
    "$root/home/$WISP_USER" \
    "$root/proc" \
    "$root/dev/pts" \
    "$root/dev/shm" \
    "$root/dev/mqueue" \
    "$root/sys/fs/cgroup" \
    "$root/run" \
    "$root/mnt" \
    "$root/tmp" \
    "$root/var/lib/docker"

  rm -f "$root/etc/mtab"
  ln -s /proc/mounts "$root/etc/mtab"

  append_if_missing "$root/etc/passwd" "$WISP_USER:" "$WISP_USER:x:$WISP_UID:$WISP_GID:Wisp User:/home/$WISP_USER:$WISP_SHELL"
  append_if_missing "$root/etc/group" "$WISP_USER:" "$WISP_USER:x:$WISP_GID:"
  append_if_missing "$root/etc/shadow" "$WISP_USER:" "$WISP_USER::$shadow_days:0:99999:7:::"
  chmod 640 "$root/etc/shadow"
  touch "$root/.wisp-base-ready"
}

IFS=' ' read -r -a ROOTFS_ARCHES <<< "${WISP_ROOTFS_ARCHES:-amd64 arm64}"

for arch in "${ROOTFS_ARCHES[@]}"; do
  if [[ -z "${URLS[$arch]:-}" ]]; then
    echo "unsupported rootfs architecture: $arch" >&2
    exit 1
  fi
  download "$arch"
done

for arch in "${ROOTFS_ARCHES[@]}"; do
  build_image "$arch"
done

echo
echo "loop image ready:"
echo "  host arch: $HOST_ARCH"
for arch in "${ROOTFS_ARCHES[@]}"; do
  echo "  $arch image: $IMAGE_DIR/plucky-$arch.img"
done
