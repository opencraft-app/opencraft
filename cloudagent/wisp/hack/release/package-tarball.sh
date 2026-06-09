#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
go_root_bin="${GO:-go}"
juicefs_go="${JUICEFS_GO:-/tmp/go1.25/go/bin/go}"
if [[ ! -x "$juicefs_go" ]]; then
  juicefs_go="$go_root_bin"
fi
juicefs_tags="${JUICEFS_TAGS:-litestreamvfs vfs wispcli noltxdateparser noltxs3 noltxserver nocompress nopyroscope nodebugagent noconsul nometricsserver noprogress nousagereport noobjectencrypt novfsbackup nocos nos3 noks3 nogmsm nogateway nowebdav nobos nohdfs noibmcos noobs nooss noqingstore noqiniu nosftp noswift noazure nogs noufile nob2 nonfs nodragonfly nomysql nopg notikv nobadger noetcd nocifs noredis tos}"
juicefs_ldflags="${JUICEFS_LDFLAGS:--s -w -buildid=}"
wisp_ldflags="${WISP_LDFLAGS:--s -w -buildid=}"

goos="${GOOS:-$(go env GOOS)}"
goarch="${GOARCH:-$(go env GOARCH)}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
pkg="wisp-${goos}-${goarch}-${stamp}"
out_dir="$repo_root/dist-release"
stage="$out_dir/$pkg"
crun_source="${WISP_CRUN_BINARY:-$repo_root/assets/bin/crun/crun-${goarch}}"
e2fsprogs_source="${WISP_E2FSPROGS_DIR:-$repo_root/assets/bin/e2fsprogs/$goarch}"
tini_source="${WISP_TINI_BINARY:-$repo_root/assets/bin/tini/tini-${goarch}}"
rootfs_image="${WISP_ROOTFS_IMAGE:-$repo_root/assets/rootfs/images/plucky-${goarch}.img}"
rootfs_dir="${WISP_ROOTFS_DIR:-$repo_root/assets/rootfs/rootfs/alpine-${goarch}}"
blank_root_upper_enabled="${WISP_BLANK_ROOT_UPPER_TEMPLATE:-1}"
blank_root_upper_size="${WISP_BLANK_ROOT_UPPER_SIZE:-5G}"
tar_bin="${TAR_BIN:-tar}"
package_with_docker="${WISP_PACKAGE_WITH_DOCKER:-0}"
build_with_docker="${WISP_BUILD_WITH_DOCKER:-$package_with_docker}"
go_image="${WISP_GO_IMAGE:-golang:1.25-bookworm}"
package_erofs="${WISP_PACKAGE_EROFS:-0}"
package_tar_gz="${WISP_PACKAGE_TAR_GZ:-1}"
flatten_rootfs="${WISP_PACKAGE_FLATTEN_ROOTFS:-$package_erofs}"
erofs_image="${WISP_EROFS_IMAGE:-alpine:3.23}"
erofs_apk_repository="${WISP_EROFS_APK_REPOSITORY:-https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.23}"
erofs_compression="${WISP_EROFS_COMPRESSION:-lz4}"

if [[ "$package_erofs" != "1" && "$package_tar_gz" != "1" ]]; then
  echo "at least one package format must be enabled: WISP_PACKAGE_EROFS=1 or WISP_PACKAGE_TAR_GZ=1" >&2
  exit 2
fi

rm -rf "$stage"
mkdir -p "$stage/bin" "$stage/assets/bin/crun" "$stage/assets/bin/e2fsprogs" "$stage/assets/bin/tini" "$stage/assets/rootfs/images" "$stage/assets/rootfs/rootfs" "$stage/assets/rootfs/blank-ext4" "$stage/juicefs/hack" "$stage/config" "$stage/scripts"

copy_sparse() {
  local src="$1"
  local dst="$2"
  if cp --sparse=always "$src" "$dst" >/dev/null 2>&1; then
    return 0
  fi
  cp "$src" "$dst"
}

make_blank_root_upper_template() {
  local dir="$stage/assets/rootfs/blank-ext4"
  local img="$dir/root-upper-default.img"
  local out="$dir/root-upper-default.sparse"
  if [[ "$blank_root_upper_enabled" != "1" ]]; then
    return 0
  fi
  rm -f "$img" "$out" "$dir/root-upper-default.tar"
  if command -v mke2fs >/dev/null 2>&1 && command -v truncate >/dev/null 2>&1; then
    truncate -s "$blank_root_upper_size" "$img"
    mke2fs -F -t ext4 -m 0 -J size=16 -E stride=1024,stripe-width=1024,lazy_itable_init=1,lazy_journal_init=1,assume_storage_prezeroed=1 -O sparse_super2,^64bit,^metadata_csum "$img" >/dev/null
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm --platform "linux/$goarch" -v "$stage:/stage" debian:bookworm-slim bash -ceu '
      command -v mke2fs >/dev/null 2>&1 || {
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends e2fsprogs coreutils >/dev/null
      }
      cd /stage/assets/rootfs/blank-ext4
      truncate -s "'"$blank_root_upper_size"'" root-upper-default.img
      mke2fs -F -t ext4 -m 0 -J size=16 -E stride=1024,stripe-width=1024,lazy_itable_init=1,lazy_journal_init=1,assume_storage_prezeroed=1 -O sparse_super2,^64bit,^metadata_csum root-upper-default.img >/dev/null
    '
  else
    echo "cannot create blank root-upper template: mke2fs/truncate or docker is required" >&2
    exit 2
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "cannot create sparse root-upper template: python3 is required" >&2
    exit 2
  fi
  python3 - "$img" "$out" <<'PY'
import json
import os
import sys

src, dst = sys.argv[1], sys.argv[2]
size = os.path.getsize(src)
extents = []
with open(src, "rb") as f:
    offset = 0
    while offset < size:
        try:
            data = os.lseek(f.fileno(), offset, os.SEEK_DATA)
        except OSError:
            break
        try:
            hole = os.lseek(f.fileno(), data, os.SEEK_HOLE)
        except OSError:
            hole = size
        if hole > size:
            hole = size
        extents.append((data, hole - data))
        offset = hole

with open(src, "rb") as f, open(dst, "wb") as out:
    out.write(b"WISP_SPARSE_ROOT_UPPER_V1\n")
    out.write(json.dumps({
        "size": size,
        "extents": [{"offset": o, "length": n} for o, n in extents],
        "meta": {"source": "blank-ext4"},
    }, separators=(",", ":")).encode("utf-8"))
    out.write(b"\n")
    for offset, length in extents:
        f.seek(offset)
        remaining = length
        while remaining:
            chunk = f.read(min(1024 * 1024, remaining))
            if not chunk:
                raise RuntimeError("unexpected EOF while reading sparse extent")
            out.write(chunk)
            remaining -= len(chunk)
PY
  rm -f "$img"
  printf "%s\n" "$blank_root_upper_size" > "$dir/root-upper-default.size"
}

if [[ "$build_with_docker" == "1" ]]; then
  stage_rel="dist-release/$pkg"
  docker run --rm --platform "linux/$goarch" \
    -v "$repo_root:/src" \
    -v "$repo_root/.tmp/go-build-cache:/root/.cache/go-build" \
    -v "$repo_root/.tmp/go-mod-cache:/go/pkg/mod" \
    -e GOOS="$goos" \
    -e GOARCH="$goarch" \
    -e JUICEFS_TAGS="$juicefs_tags" \
    -e JUICEFS_LDFLAGS="$juicefs_ldflags" \
    -e WISP_LDFLAGS="$wisp_ldflags" \
    "$go_image" bash -ceu '
      cd /src
      go build -trimpath -ldflags "$WISP_LDFLAGS" -o "/src/'"$stage_rel"'/bin/wisp" ./cmd/wisp
      go build -trimpath -ldflags "$WISP_LDFLAGS" -o "/src/'"$stage_rel"'/bin/wispclient" ./cmd/wispclient
      go build -trimpath -ldflags "$WISP_LDFLAGS" -o "/src/'"$stage_rel"'/bin/wispenv" ./cmd/wispenv
      go build -trimpath -ldflags "$WISP_LDFLAGS" -o "/src/'"$stage_rel"'/bin/wisp-fs-agent" ./cmd/wisp-fs-agent
      cd /src/juicefs
      go build -trimpath -tags "$JUICEFS_TAGS" -ldflags "$JUICEFS_LDFLAGS" -o "/src/'"$stage_rel"'/bin/juicefs-smount" ./
    '
else
  (
    cd "$repo_root"
    go build -trimpath -ldflags "$wisp_ldflags" -o "$stage/bin/wisp" ./cmd/wisp
    go build -trimpath -ldflags "$wisp_ldflags" -o "$stage/bin/wispclient" ./cmd/wispclient
    go build -trimpath -ldflags "$wisp_ldflags" -o "$stage/bin/wispenv" ./cmd/wispenv
    go build -trimpath -ldflags "$wisp_ldflags" -o "$stage/bin/wisp-fs-agent" ./cmd/wisp-fs-agent
  )

  (
    cd "$repo_root/juicefs"
    "$juicefs_go" build -trimpath -tags "$juicefs_tags" -ldflags "$juicefs_ldflags" -o "$stage/bin/juicefs-smount" ./
  )
fi

cp "$crun_source" "$stage/assets/bin/crun/crun-${goarch}"
if [[ ! -x "$e2fsprogs_source/bin/mke2fs" || ! -x "$e2fsprogs_source/bin/e2fsck" ]]; then
  echo "missing packaged e2fsprogs; expected executable mke2fs/e2fsck under $e2fsprogs_source/bin" >&2
  exit 2
fi
cp -R "$e2fsprogs_source/." "$stage/assets/bin/e2fsprogs/"
if [[ -f "$tini_source" ]]; then
  cp "$tini_source" "$stage/assets/bin/tini/tini"
fi
make_blank_root_upper_template
if [[ "$flatten_rootfs" == "1" ]]; then
  if [[ ! -d "$rootfs_dir" ]]; then
    echo "missing WISP_ROOTFS_DIR for flattened package: $rootfs_dir" >&2
    exit 2
  fi
  cp -R "$rootfs_dir/." "$stage/assets/rootfs/rootfs/"
else
  copy_sparse "$rootfs_image" "$stage/assets/rootfs/images/plucky-${goarch}.img"
fi
cp "$repo_root/juicefs/hack/smount.sh" "$stage/juicefs/hack/"
cp "$repo_root/juicefs/hack/sformat.sh" "$stage/juicefs/hack/"
cp "$repo_root/packaging/config.single-host-smh.jsonnet.example" "$stage/config/config.jsonnet.example"
cp "$repo_root/packaging/install.sh" "$stage/scripts/install.sh"
cp "$repo_root/packaging/README.md" "$stage/README.md"

chmod +x \
  "$stage/scripts/install.sh" \
  "$stage/bin/"* \
  "$stage/juicefs/hack/"*.sh

# EROFS preserves directory permissions exactly. The package is mounted by
# root, then consumed by the sandbox user, so every package directory must be
# traversable without relying on root privileges.
chmod -R a+rX "$stage"

mkdir -p "$out_dir"
tar_out=""
if [[ "$package_tar_gz" == "1" ]]; then
  tar_out="$out_dir/$pkg.tar.gz"
  if [[ "$package_with_docker" == "1" ]]; then
    set +e
    docker run --rm --platform "linux/$goarch" -v "$repo_root:/src" -w /src \
      debian:bookworm-slim tar --sparse --warning=no-file-changed -C dist-release -czf "dist-release/$pkg.tar.gz" "$pkg"
    tar_status=$?
    set -e
    if [[ "$tar_status" -ne 0 ]]; then
      if [[ "$tar_status" -ne 1 || ! -s "$tar_out" ]]; then
        exit "$tar_status"
      fi
      "$tar_bin" -tzf "$tar_out" >/dev/null
    fi
  else
    tar_args=(-C "$out_dir" -czf "$tar_out" "$pkg")
    if "$tar_bin" --version 2>/dev/null | grep -qi 'GNU tar'; then
      tar_args=(--sparse "${tar_args[@]}")
    fi
    "$tar_bin" "${tar_args[@]}"
  fi
fi

erofs_out=""
if [[ "$package_erofs" == "1" ]]; then
  erofs_out="$out_dir/$pkg.erofs"
  rm -f "$erofs_out"
  docker run --rm --platform "linux/$goarch" \
    -v "$out_dir:/dist" \
    -e WISP_EROFS_COMPRESSION="$erofs_compression" \
    "$erofs_image" sh -ceu '
      printf "%s\n%s\n" "'"$erofs_apk_repository"'/main" "'"$erofs_apk_repository"'/community" > /etc/apk/repositories
      apk add --no-cache erofs-utils >/dev/null
      chmod -R a+rX "/dist/'"$pkg"'"
      mkfs.erofs -z"$WISP_EROFS_COMPRESSION" "/dist/'"$pkg"'.erofs" "/dist/'"$pkg"'" >/dev/null
    '
fi

if [[ -n "$tar_out" ]]; then
  echo "$tar_out"
fi
if [[ -n "$erofs_out" ]]; then
  echo "$erofs_out"
fi
