#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
[[ $# == 1 ]] || { echo "Usage: bootstrap-runtime-rust-via-tat.sh REVIEWED_RUST_SYSROOT" >&2; exit 2; }
sysroot=$(readlink -e "$1")
[[ $("$sysroot/bin/rustc" --version) == 'rustc 1.96.0 (ac68faa20 2026-05-25)' ]]
[[ $("$sysroot/bin/cargo" --version) == cargo\ 1.96.0* ]]
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
instance=$(jq -er '.InstanceIdSet | select(length == 1) | .[0]' "$state_dir/bootstrap-node.json")
[[ ${TAT_INSTANCE_ID:-} == "$instance" ]]
temporary=$(mktemp -d /data/tmp/q01-rust-toolchain.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT INT TERM
# Only the reviewed toolchain is transferred. Cargo credentials and registry
# configuration are outside the sysroot and must never enter this archive.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$sysroot" -cf - bin lib libexec etc | gzip -n -1 >"$temporary/rust-1.96.0.tar.gz"
sha=$(sha256sum "$temporary/rust-1.96.0.tar.gz" | cut -d' ' -f1)
remote=/var/lib/actor-build/source/rust-1.96.0-${sha}.tar.gz
"$script_dir/relay-upload-to-builder.sh" "$temporary/rust-1.96.0.tar.gz" "$remote"
"$fleet_dir/tat/tat-run.sh" --name q01-install-pinned-runtime-rust --timeout 600 <<REMOTE
set -euo pipefail
test "\$(sha256sum '$remote' | cut -d' ' -f1)" = '$sha'
root=/data/build-cache/runtime-rust
target=\$root/1.96.0
install -d -m 0755 "\$root"
exec 9>"\$root/install.lock"
flock -n 9
if [[ -e \$target ]]; then
  test "\$(cat "\$target/.archive-sha256")" = '$sha'
else
  staging=\$(mktemp -d "\$root/staging.XXXXXX")
  trap 'rm -rf -- "\$staging"' EXIT
  tar --no-same-owner -xzf '$remote' -C "\$staging"
  test "\$("\$staging/bin/rustc" --version)" = 'rustc 1.96.0 (ac68faa20 2026-05-25)'
  "\$staging/bin/cargo" --version
  printf '%s\n' '$sha' >"\$staging/.archive-sha256"
  mv -T "\$staging" "\$target"
  trap - EXIT
fi
"\$target/bin/rustc" --version
"\$target/bin/cargo" --version
printf 'runtime_rust_bootstrap=passed version=1.96.0 archive_sha256=%s\n' '$sha'
REMOTE
