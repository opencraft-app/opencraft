#!/usr/bin/env bash
set -euo pipefail

workspace_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
lock_file=$workspace_root/runtimes/workerd/workerd-fdb.lock
bundle_file=$workspace_root/runtimes/workerd/workerd-fdb.bundle
source_dir=${RIVET_WORKERD_SOURCE:-$workspace_root/third-party/workerd-fdb}
canonical_source_dir=$workspace_root/third-party/workerd-fdb
workspace_compat_link=$workspace_root/third-party/rivet-history

read_lock() {
	awk -F'"' -v key="$1" '$1 ~ ("^" key) { print $2 }' "$lock_file"
}

upstream_url=$(read_lock upstream_url)
fork_branch=$(read_lock fork_branch)
fork_commit=$(read_lock fork_commit)
fork_tree=$(read_lock fork_tree)
receipt_tag=$(read_lock receipt_tag)
bundle_sha256=$(read_lock bundle_sha256)

for value in "$upstream_url" "$fork_branch" "$fork_commit" "$fork_tree" "$receipt_tag" "$bundle_sha256"; do
	[[ -n "$value" ]] || { echo "incomplete workerd-fdb lock" >&2; exit 1; }
done
[[ "$source_dir" == /* ]] || { echo "RIVET_WORKERD_SOURCE must be absolute" >&2; exit 1; }
[[ -f "$bundle_file" ]] || { echo "missing workerd-fdb bundle: $bundle_file" >&2; exit 1; }
echo "$bundle_sha256  $bundle_file" | sha256sum --check --status || {
	echo "workerd-fdb bundle digest mismatch" >&2
	exit 1
}

if [[ ! -e "$source_dir" ]]; then
	mkdir -p -- "$(dirname -- "$source_dir")"
	# The tracked bundle contains complete history for the locked fork. A clean
	# rebuild must not silently turn GitHub or an old build-cache checkout into
	# an availability dependency.
	# The bundle intentionally exposes the fork branch rather than pretending
	# to own a repository-wide default branch, so clone without consulting a
	# remote HEAD and select the locked commit explicitly.
	git clone --no-checkout --no-local "$bundle_file" "$source_dir"
	git -C "$source_dir" switch --create "$fork_branch" "$fork_commit"
elif [[ ! -d "$source_dir/.git" ]]; then
	echo "workerd-fdb source path is not a Git checkout: $source_dir" >&2
	exit 1
fi

current_commit=$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)
if [[ "$current_commit" != "$fork_commit" ]]; then
	[[ -z $(git -C "$source_dir" status --porcelain) ]] || {
		echo "refusing to replace dirty workerd-fdb checkout: $source_dir" >&2
		exit 1
	}
	git -C "$source_dir" fetch "$bundle_file" HEAD
	git -C "$source_dir" switch --force-create "$fork_branch" "$fork_commit"
fi

tag_commit=$(git -C "$source_dir" rev-list -n 1 "$receipt_tag" 2>/dev/null || true)
if [[ "$tag_commit" != "$fork_commit" ]]; then
	git -C "$source_dir" fetch \
		"$bundle_file" "refs/tags/$receipt_tag:refs/tags/$receipt_tag"
fi

actual_tree=$(git -C "$source_dir" rev-parse 'HEAD^{tree}')
[[ "$actual_tree" == "$fork_tree" ]] || {
	echo "workerd-fdb tree mismatch: expected $fork_tree, got $actual_tree" >&2
	exit 1
}
actual_tag_commit=$(git -C "$source_dir" rev-list -n 1 "$receipt_tag")
[[ "$actual_tag_commit" == "$fork_commit" ]] || {
	echo "workerd-fdb receipt tag does not resolve to locked commit" >&2
	exit 1
}

# The independently versioned fork keeps its Cargo path dependencies pointed at
# a sibling checkout named `rivet-history`. In the canonical in-tree layout,
# expose this workspace through a deterministic, disposable compatibility link.
if [[ "$source_dir" == "$canonical_source_dir" ]]; then
	if [[ -L "$workspace_compat_link" ]]; then
		actual_workspace=$(readlink -f "$workspace_compat_link")
		[[ "$actual_workspace" == "$workspace_root" ]] || {
			echo "workerd workspace compatibility link points to $actual_workspace, expected $workspace_root" >&2
			exit 1
		}
	elif [[ -e "$workspace_compat_link" ]]; then
		echo "workerd workspace compatibility path is not a symlink: $workspace_compat_link" >&2
		exit 1
	else
		ln -s .. "$workspace_compat_link"
	fi
fi
printf '%s\n' "$source_dir"
