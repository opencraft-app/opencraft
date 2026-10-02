#!/bin/sh

set -eu

bench_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$bench_root/../.." && pwd)
base_image="$repo_root/target/pvm-linux/debian-trixie-20260713-x86_64.erofs"
mkfs="$repo_root/target/pvm-linux/erofs-utils-build/mkfs/mkfs.erofs"
fsck="$repo_root/target/pvm-linux/erofs-utils-build/fsck/fsck.erofs"
build_root="$bench_root/build"
output="$build_root/debian-socket-bench.erofs"

test -f "$base_image"
test -x "$mkfs"
test -x "$fsck"
mkdir -p "$build_root"

staging=$(mktemp -d "$build_root/rootfs.XXXXXX")
cleanup() {
  rm -rf -- "$staging"
}
trap cleanup EXIT HUP INT TERM

"$fsck" --extract="$staging" "$base_image"
cc -O2 -static -pthread -std=c17 -Wall -Wextra -Werror \
  "$bench_root/guest/socket-bench.c" -o "$build_root/socket-bench"
install -d -m 0755 "$staging/opt/mssockbench"
install -m 0755 "$build_root/socket-bench" \
  "$staging/sbin/minisandbox-init"
install -m 0755 "$build_root/socket-bench" \
  "$staging/opt/mssockbench/socket-bench"

chroot "$staging" /usr/bin/dpkg-query -W -f='${binary:Package}\t${Version}\n' \
  | LC_ALL=C sort >"$build_root/packages.txt"
"$mkfs" \
  -d1 -b4096 -T0 --all-time --ignore-mtime --all-root \
  --fsalignblks=512 -L mssockbench \
  -U 00000000-0000-0000-0000-000000000000 \
  "$output" "$staging"
"$fsck" "$output"
sha256sum "$output" "$build_root/socket-bench" "$build_root/packages.txt"
