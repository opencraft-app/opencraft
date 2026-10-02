#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
[[ $# == 1 ]] || { echo "Usage: bootstrap-runtime-vendor-via-tat.sh REVIEWED_SOURCE_ROOT" >&2; exit 2; }
source_root=$(readlink -e "$1")
test -f "$source_root/Cargo.lock"
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
instance=$(jq -er '.InstanceIdSet | select(length == 1) | .[0]' "$state_dir/bootstrap-node.json")
[[ ${TAT_INSTANCE_ID:-} == "$instance" ]]
lock_sha=$(sha256sum "$source_root/Cargo.lock" | cut -d' ' -f1)
temporary=$(mktemp -d /data/tmp/q01-runtime-vendor.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT INT TERM
mkdir "$temporary/payload"
(cd "$source_root" && cargo vendor --offline --locked "$temporary/payload/vendor") \
  >"$temporary/source-config.toml" 2>"$temporary/vendor.log" || {
  tail -30 "$temporary/vendor.log" >&2
  exit 1
}
# This workspace currently uses only registry dependencies. Refuse silently
# dropping source replacements if a future lockfile adds Git dependencies.
test "$(grep -c '^\[source\.' "$temporary/source-config.toml")" = 2
test "$(sha256sum "$source_root/Cargo.lock" | cut -d' ' -f1)" = "$lock_sha"
install -m 0644 "$source_root/Cargo.lock" "$temporary/payload/Cargo.lock"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$temporary/payload" -cf - . | gzip -n -1 >"$temporary/vendor.tar.gz"
sha=$(sha256sum "$temporary/vendor.tar.gz" | cut -d' ' -f1)
remote=/var/lib/actor-build/source/runtime-vendor-${sha}.tar.gz
"$script_dir/relay-upload-to-builder.sh" "$temporary/vendor.tar.gz" "$remote"
"$fleet_dir/tat/tat-run.sh" --name q01-install-runtime-vendor --timeout 600 <<REMOTE
set -euo pipefail
test "\$(sha256sum '$remote' | cut -d' ' -f1)" = '$sha'
root=/data/build-cache/runtime-vendor
target=\$root/$lock_sha
install -d -m 0755 "\$root"
exec 9>"\$root/install.lock"
flock -n 9
if [[ -e \$target ]]; then
  test "\$(cat "\$target/.archive-sha256")" = '$sha'
else
  staging=\$(mktemp -d "\$root/staging.XXXXXX")
  trap 'rm -rf -- "\$staging"' EXIT
  tar --no-same-owner -xzf '$remote' -C "\$staging"
  test "\$(sha256sum "\$staging/Cargo.lock" | cut -d' ' -f1)" = '$lock_sha'
  printf '%s\n' '$sha' >"\$staging/.archive-sha256"
  mv -T "\$staging" "\$target"
  trap - EXIT
fi
printf 'runtime_vendor_bootstrap=passed lock_sha256=%s archive_sha256=%s\n' '$lock_sha' '$sha'
REMOTE
