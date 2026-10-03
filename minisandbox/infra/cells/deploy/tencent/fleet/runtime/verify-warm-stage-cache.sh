#!/usr/bin/env bash
# Prove an existing physical workerd workspace has the reviewed compiler inputs.
set -euo pipefail
[[ $# == 4 ]] || { echo 'Usage: verify-warm-stage-cache.sh SOURCE CACHE_ROOT FORK_COMMIT FORK_TREE' >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_dir=$1
cache_root=$2
commit=$3
tree=$4
[[ $source_dir == /* && $cache_root == /data/* && $commit =~ ^[0-9a-f]{40}$ && $tree =~ ^[0-9a-f]{40}$ ]] || {
	echo 'invalid warm workerd workspace identity' >&2
	exit 2
}
[[ -d $cache_root && ! -L $cache_root && -d $cache_root/workerd-fdb/.git && ! -L $cache_root/workerd-fdb && -L $cache_root/rivet-history ]] || {
	echo 'warm workerd workspace must contain a real checkout and its existing source link' >&2
	exit 2
}
[[ $(readlink -e "$cache_root") == "$cache_root" ]] || { echo 'warm workerd cache path must be canonical' >&2; exit 2; }
[[ $(git -C "$cache_root/workerd-fdb" rev-parse HEAD) == "$commit" && $(git -C "$cache_root/workerd-fdb" rev-parse 'HEAD^{tree}') == "$tree" ]] || {
	echo 'warm workerd checkout does not match the locked fork' >&2
	exit 1
}
[[ -z $(git -C "$cache_root/workerd-fdb" status --porcelain) ]] || {
	echo 'warm workerd checkout is dirty' >&2
	exit 1
}
cache_source=$(readlink -e "$cache_root/rivet-history")
[[ -d $cache_source ]] || { echo 'warm workerd source link is unavailable' >&2; exit 1; }
python3 "$script_dir/verify-stage-reuse-inputs.py" "$cache_source" "$source_dir" \
	infra/cells/deploy/tencent/fleet/runtime/toolchains.lock.json \
	infra/cells/deploy/tencent/init-workerd-pool.sh \
	infra/cells/deploy/tencent/fleet/runtime/runtime-stage.lock.json \
	runtimes/workerd/workerd-fdb.bundle \
	runtimes/workerd/workerd-fdb.lock \
	runtimes/workerd/host/workerd/config-depot.capnp
