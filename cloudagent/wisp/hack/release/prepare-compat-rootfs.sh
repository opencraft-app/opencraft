#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
goarch="${GOARCH:-amd64}"
src="${SRC_ROOTFS_IMAGE:-$repo_root/assets/rootfs/images/plucky-${goarch}-minroot-256m.img}"
dst="${DST_ROOTFS_IMAGE:-$repo_root/assets/rootfs/images/plucky-${goarch}-minroot-256m-compat.img}"
dst_size="${DST_ROOTFS_SIZE:-384M}"
image="${WISP_GO_IMAGE:-golang:1.25-bookworm}"

if [[ ! -f "$src" ]]; then
  echo "source rootfs image not found: $src" >&2
  exit 1
fi

mkdir -p "$(dirname "$dst")"

docker run --rm --privileged --platform "linux/$goarch" \
  -v "$repo_root:/src" \
  -e SRC_ROOTFS_IMAGE="/src/${src#$repo_root/}" \
  -e DST_ROOTFS_IMAGE="/src/${dst#$repo_root/}" \
  -e DST_ROOTFS_SIZE="$dst_size" \
  "$image" bash -ceu '
    src="$SRC_ROOTFS_IMAGE"
    dst="$DST_ROOTFS_IMAGE"
    dst_size="$DST_ROOTFS_SIZE"
    mnt_src=/tmp/wisp-src-rootfs
    mnt_dst=/tmp/wisp-dst-rootfs
    src_loop=""
    dst_loop=""

    cleanup() {
      set +e
      mountpoint -q "$mnt_src" && umount "$mnt_src"
      mountpoint -q "$mnt_dst" && umount "$mnt_dst"
      [[ -n "$src_loop" ]] && losetup -d "$src_loop"
      [[ -n "$dst_loop" ]] && losetup -d "$dst_loop"
    }
    trap cleanup EXIT

    rm -f "$dst"
    truncate -s "$dst_size" "$dst"
    mke2fs -F -t ext4 -m 0 -J size=32 -E stride=1024,stripe-width=1024 -O sparse_super2,^64bit,^metadata_csum "$dst" >/dev/null

    mkdir -p "$mnt_src" "$mnt_dst"
    src_loop="$(losetup --find --show -r "$src")"
    dst_loop="$(losetup --find --show "$dst")"
    mount -o ro "$src_loop" "$mnt_src"
    mount "$dst_loop" "$mnt_dst"
    (cd "$mnt_src" && tar --xattrs --acls --numeric-owner -cpf - .) | (cd "$mnt_dst" && tar --xattrs --acls --numeric-owner -xpf -)
    sync
  '

echo "$dst"
