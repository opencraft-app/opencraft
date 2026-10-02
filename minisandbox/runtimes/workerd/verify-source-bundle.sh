#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
workspace_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
lock_file=$script_dir/workerd-fdb.lock
bundle_file=$script_dir/workerd-fdb.bundle

read_lock() {
	awk -F'"' -v key="$1" '$1 ~ ("^" key) { print $2 }' "$lock_file"
}

commit=$(read_lock fork_commit)
tree=$(read_lock fork_tree)
tag=$(read_lock receipt_tag)
bundle_sha=$(read_lock bundle_sha256)

[[ $commit =~ ^[0-9a-f]{40}$ && $tree =~ ^[0-9a-f]{40}$ ]]
[[ $bundle_sha =~ ^[0-9a-f]{64}$ && -n $tag ]]
printf '%s  %s\n' "$bundle_sha" "$bundle_file" | sha256sum --check --status

temporary=$(mktemp -d /data/tmp/workerd-source-bundle.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

# `git bundle verify` requires a repository even though it only validates the
# supplied bundle.  A reviewed source archive and a jj working copy
# intentionally have no `.git` directory, so never inherit repository state
# from the caller.  The empty bare repository makes this verifier usable on a
# genuinely blank rebuild host and keeps the check independent of any old
# workspace metadata.
git init --quiet --bare "$temporary/verify.git"
verification=$(git -C "$temporary/verify.git" bundle verify "$bundle_file" 2>&1)
grep -Fq 'The bundle records a complete history.' <<<"$verification" || {
	echo "workerd source bundle is thin and cannot rebuild without its upstream" >&2
	exit 1
}

RIVET_WORKERD_SOURCE=$temporary/source "$script_dir/setup-fork.sh" >/dev/null
[[ $(git -C "$temporary/source" rev-parse HEAD) == "$commit" ]]
[[ $(git -C "$temporary/source" rev-parse 'HEAD^{tree}') == "$tree" ]]
[[ $(git -C "$temporary/source" rev-list -n 1 "$tag") == "$commit" ]]

# A successful clean clone from the tracked bundle is the authority. The
# informational upstream remote is not contacted and is not a rebuild input.
[[ $(git -C "$temporary/source" remote get-url origin) == "$bundle_file" ]]

printf 'workerd_source_bundle=passed commit=%s tree=%s sha256=%s workspace=%s\n' \
	"$commit" "$tree" "$bundle_sha" "$workspace_root"
