#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
goarch="${GOARCH:-amd64}"
src="${SRC_ROOTFS_IMAGE:-$repo_root/assets/rootfs/images/plucky-${goarch}-minroot-256m-compat.img}"
dst="${DST_ROOTFS_IMAGE:-$repo_root/assets/rootfs/images/opencloudos-${goarch}-package-2g.img}"
dst_size="${DST_ROOTFS_SIZE:-2G}"
image="${WISP_OPENCLOUDOS_IMAGE:-opencloudos/opencloudos9-microdnf:latest}"
packages="${WISP_ROOTFS_PACKAGES:-microdnf rpm dnf python3 ca-certificates gcc gcc-c++ make}"

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
  -e WISP_ROOTFS_PACKAGES="$packages" \
  "$image" sh -ceu '
    microdnf -y --nodocs install util-linux e2fsprogs tar gzip coreutils findutils >/dev/null

    src="$SRC_ROOTFS_IMAGE"
    dst="$DST_ROOTFS_IMAGE"
    dst_size="$DST_ROOTFS_SIZE"
    mnt_src=/tmp/wisp-src-rootfs
    mnt_dst=/tmp/wisp-dst-rootfs
    src_loop=""
    dst_loop=""

    configure_opencloudos_repos() {
      root="$1"
      mkdir -p "$root/etc/yum.repos.d"
      cat >"$root/etc/yum.repos.d/OpenCloudOS.repo" <<'"'"'REPO'"'"'
[BaseOS]
name=BaseOS $releasever - $basearch
baseurl=http://mirrors.tencentyun.com/opencloudos/$releasever/BaseOS/$basearch/os/
        http://mirrors.tencent.com/opencloudos/$releasever/BaseOS/$basearch/os/
        https://mirrors.opencloudos.tech/opencloudos/$releasever/BaseOS/$basearch/os/
repo_gpgcheck=0
gpgcheck=1
enabled=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-OpenCloudOS-9

[AppStream]
name=AppStream $releasever - $basearch
baseurl=http://mirrors.tencentyun.com/opencloudos/$releasever/AppStream/$basearch/os/
        http://mirrors.tencent.com/opencloudos/$releasever/AppStream/$basearch/os/
        https://mirrors.opencloudos.tech/opencloudos/$releasever/AppStream/$basearch/os/
repo_gpgcheck=0
gpgcheck=1
enabled=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-OpenCloudOS-9

[extras]
name=extras $releasever - $basearch
baseurl=http://mirrors.tencentyun.com/opencloudos/$releasever/extras/$basearch/os/
        http://mirrors.tencent.com/opencloudos/$releasever/extras/$basearch/os/
        https://mirrors.opencloudos.tech/opencloudos/$releasever/extras/$basearch/os/
repo_gpgcheck=0
gpgcheck=1
enabled=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-OpenCloudOS-9
REPO
    }

    cleanup() {
      set +e
      mountpoint -q "$mnt_src" && umount "$mnt_src"
      mountpoint -q "$mnt_dst" && umount "$mnt_dst"
      [ -n "$src_loop" ] && losetup -d "$src_loop"
      [ -n "$dst_loop" ] && losetup -d "$dst_loop"
    }
    trap cleanup EXIT

    rm -f "$dst"
    truncate -s "$dst_size" "$dst"
    mke2fs -F -t ext4 -m 0 -J size=64 -E stride=1024,stripe-width=1024 -O sparse_super2,^64bit,^metadata_csum "$dst" >/dev/null

    mkdir -p "$mnt_src" "$mnt_dst"
    src_loop="$(losetup --find --show -r "$src")"
    dst_loop="$(losetup --find --show "$dst")"
    mount -o ro "$src_loop" "$mnt_src"
    mount "$dst_loop" "$mnt_dst"
    (cd "$mnt_src" && tar --xattrs --acls --numeric-owner -cpf - .) | (cd "$mnt_dst" && tar --xattrs --acls --numeric-owner -xpf -)
    configure_opencloudos_repos "$mnt_dst"

    # Use the builder repos to install a real package-management userland into
    # the target rootfs. The source image keeps OpenCloudOS repo files but is
    # intentionally too small to include rpm/dnf itself.
    configure_opencloudos_repos ""
    microdnf -y --nodocs \
      --installroot="$mnt_dst" \
      --config=/etc/dnf/dnf.conf \
      --noplugins \
      --releasever=9.4 \
      --setopt=cachedir=/tmp/wisp-rootfs-microdnf-cache \
      --setopt=reposdir=/etc/yum.repos.d \
      --setopt=varsdir=/etc/dnf/vars \
      --setopt=install_weak_deps=0 \
      install $WISP_ROOTFS_PACKAGES

    configure_opencloudos_repos "$mnt_dst"
    chroot "$mnt_dst" /bin/sh -lc "command -v microdnf; command -v rpm; command -v gcc; gcc --version | head -1"
    sync
  '

echo "$dst"
