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
tar_bin="${TAR_BIN:-tar}"
package_with_docker="${WISP_PACKAGE_WITH_DOCKER:-0}"
build_with_docker="${WISP_BUILD_WITH_DOCKER:-$package_with_docker}"
go_image="${WISP_GO_IMAGE:-golang:1.25-bookworm}"
package_erofs="${WISP_PACKAGE_EROFS:-0}"
erofs_image="${WISP_EROFS_IMAGE:-alpine:3.23}"
erofs_apk_repository="${WISP_EROFS_APK_REPOSITORY:-https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.23}"

rm -rf "$stage"
mkdir -p "$stage/bin" "$stage/assets/bin/crun" "$stage/assets/bin/e2fsprogs" "$stage/assets/bin/tini" "$stage/assets/rootfs/images" "$stage/juicefs/hack" "$stage/config" "$stage/scripts"

copy_sparse() {
  local src="$1"
  local dst="$2"
  if cp --sparse=always "$src" "$dst" >/dev/null 2>&1; then
    return 0
  fi
  cp "$src" "$dst"
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
if [[ -d "$e2fsprogs_source" ]]; then
  cp -R "$e2fsprogs_source/." "$stage/assets/bin/e2fsprogs/"
fi
if [[ -f "$tini_source" ]]; then
  cp "$tini_source" "$stage/assets/bin/tini/tini"
fi
copy_sparse "$rootfs_image" "$stage/assets/rootfs/images/plucky-${goarch}.img"
cp "$repo_root/juicefs/hack/smount.sh" "$stage/juicefs/hack/"
cp "$repo_root/juicefs/hack/sformat.sh" "$stage/juicefs/hack/"
cp "$repo_root/config.jsonnet.example" "$stage/config/config.jsonnet.example"
cp "$repo_root/packaging/install.sh" "$stage/scripts/install.sh"
cp "$repo_root/packaging/README.md" "$stage/README.md"

chmod +x \
  "$stage/scripts/install.sh" \
  "$stage/bin/"* \
  "$stage/juicefs/hack/"*.sh

mkdir -p "$out_dir"
if [[ "$package_with_docker" == "1" ]]; then
  set +e
  docker run --rm --platform "linux/$goarch" -v "$repo_root:/src" -w /src \
    debian:bookworm-slim tar --sparse --warning=no-file-changed -C dist-release -czf "dist-release/$pkg.tar.gz" "$pkg"
  tar_status=$?
  set -e
  if [[ "$tar_status" -ne 0 ]]; then
    if [[ "$tar_status" -ne 1 || ! -s "$out_dir/$pkg.tar.gz" ]]; then
      exit "$tar_status"
    fi
    "$tar_bin" -tzf "$out_dir/$pkg.tar.gz" >/dev/null
  fi
else
  tar_args=(-C "$out_dir" -czf "$out_dir/$pkg.tar.gz" "$pkg")
  if "$tar_bin" --version 2>/dev/null | grep -qi 'GNU tar'; then
    tar_args=(--sparse "${tar_args[@]}")
  fi
  "$tar_bin" "${tar_args[@]}"
fi

erofs_out=""
if [[ "$package_erofs" == "1" ]]; then
  erofs_out="$out_dir/$pkg.erofs"
  rm -f "$erofs_out"
  docker run --rm --platform "linux/$goarch" \
    -v "$out_dir:/dist" \
    "$erofs_image" sh -ceu '
      printf "%s\n%s\n" "'"$erofs_apk_repository"'/main" "'"$erofs_apk_repository"'/community" > /etc/apk/repositories
      apk add --no-cache erofs-utils >/dev/null
      mkfs.erofs -zlz4hc,9 "/dist/'"$pkg"'.erofs" "/dist/'"$pkg"'" >/dev/null
    '
fi

echo "$out_dir/$pkg.tar.gz"
if [[ -n "$erofs_out" ]]; then
  echo "$erofs_out"
fi
