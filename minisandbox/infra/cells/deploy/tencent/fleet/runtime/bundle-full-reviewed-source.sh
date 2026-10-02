#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_dir=${RIVET_SOURCE_DIR:?RIVET_SOURCE_DIR must name the reviewed project tree}
source_revision=${RIVET_SOURCE_REVISION:?RIVET_SOURCE_REVISION must identify the release revision}
output=${RIVET_SOURCE_BUNDLE:?RIVET_SOURCE_BUNDLE must name the output tar.gz}
receipt=${RIVET_SOURCE_RECEIPT:?RIVET_SOURCE_RECEIPT must name the immutable receipt}
[[ $output == /* && $receipt == /* && $output != "$receipt" && $source_revision =~ ^[0-9a-f]{40}$ ]] || {
	echo "invalid full source identity/output" >&2
	exit 2
}
for command in git tar gzip sha256sum python3 cmp readlink; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
[[ -d $(dirname -- "$output") && -d $(dirname -- "$receipt") ]] || {
	echo "bundle and receipt parents must already exist" >&2
	exit 2
}
[[ -d $source_dir && ! -L $source_dir ]] || { echo "reviewed project tree must be a real directory" >&2; exit 2; }
source_dir=$(readlink -e "$source_dir")
repository_root=$(git -C "$source_dir" rev-parse --show-toplevel)
repository_root=$(readlink -e "$repository_root")
[[ $(git -C "$repository_root" cat-file -t "$source_revision") == commit ]]
repository_tree=$(git -C "$repository_root" rev-parse "$source_revision^{tree}")
project_path=$(python3 - "$repository_root" "$source_dir" <<'PY'
import os
import re
import sys

root, project = map(os.path.realpath, sys.argv[1:])
relative = os.path.relpath(project, root)
if relative == os.pardir or relative.startswith(os.pardir + os.sep):
    raise SystemExit("reviewed project tree is outside its Git repository")
project_path = "." if relative == "." else relative.replace(os.sep, "/")
if project_path != "." and any(
    not re.fullmatch(r"[A-Za-z0-9._-]+", part) or part in (".", "..")
    for part in project_path.split("/")
):
    raise SystemExit("reviewed project path contains unsupported components")
print(project_path)
PY
)
if [[ $project_path == . ]]; then
	project_tree=$repository_tree
	archive_treeish=$source_revision
else
	[[ $(git -C "$repository_root" cat-file -t "$source_revision:$project_path") == tree ]]
	project_tree=$(git -C "$repository_root" rev-parse "$source_revision:$project_path")
	archive_treeish=$source_revision:$project_path
fi
[[ $repository_tree =~ ^[0-9a-f]{40}$ && $project_tree =~ ^[0-9a-f]{40}$ ]]

temporary=$(mktemp -d /data/tmp/actor-full-source.XXXXXX)
bundle_temporary=$(mktemp "$(dirname -- "$output")/.actor-source-bundle.XXXXXX")
receipt_temporary=$(mktemp "$(dirname -- "$receipt")/.actor-source-receipt.XXXXXX")
cleanup() {
	rm -rf -- "$temporary"
	rm -f -- "$bundle_temporary" "$receipt_temporary"
}
trap cleanup EXIT INT TERM

mkdir -p "$temporary/tree/.actor-source"
git -C "$repository_root" archive --format=tar "$archive_treeish" | tar -C "$temporary/tree" -xf -
(
	cd "$temporary/tree"
	find . -type f ! -path './.actor-source/*' -printf '%P\n' | LC_ALL=C sort | \
		while IFS= read -r path; do sha256sum "$path"; done
) >"$temporary/tree/.actor-source/RELEASE_SHA256SUMS"
printf '%s\n' "$source_revision" >"$temporary/tree/.actor-source/SOURCE_REVISION"
file_count=$(wc -l <"$temporary/tree/.actor-source/RELEASE_SHA256SUMS" | tr -d ' ')
printf '%s\n' "$file_count" >"$temporary/tree/.actor-source/FILE_COUNT"
chmod 0755 "$temporary/tree/.actor-source"
chmod 0644 "$temporary/tree/.actor-source/RELEASE_SHA256SUMS" \
	"$temporary/tree/.actor-source/SOURCE_REVISION" \
	"$temporary/tree/.actor-source/FILE_COUNT"
manifest_sha=$(sha256sum "$temporary/tree/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)

# Canonical ownership, ordering and timestamps make the compressed artifact a
# function of the Git tree instead of the workstation and wall clock.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$temporary/tree" -cf - . | \
	gzip -n >"$bundle_temporary"
bundle_sha=$(sha256sum "$bundle_temporary" | cut -d' ' -f1)
bundle_bytes=$(wc -c <"$bundle_temporary" | tr -d ' ')

python3 - "$receipt_temporary" "$(basename -- "$output")" "$source_revision" "$repository_tree" \
	"$project_path" "$project_tree" "$file_count" "$manifest_sha" "$bundle_sha" "$bundle_bytes" <<'PY'
import json
import os
import sys

(
    path,
    name,
    revision,
    repository_tree,
    project_path,
    project_tree,
    file_count,
    manifest_sha,
    bundle_sha,
    bundle_bytes,
) = sys.argv[1:]
value = {
    "schema": "actor-reviewed-source-bundle/v2",
    "verdict": "passed",
    "source": {
        "revision": revision,
        "repositoryTree": repository_tree,
        "projectPath": project_path,
        "projectTree": project_tree,
    },
    "content": {"fileCount": int(file_count), "manifestSha256": manifest_sha},
    "bundle": {"name": name, "bytes": int(bundle_bytes), "sha256": bundle_sha},
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(value, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
PY

publish_exact() {
	local staged=$1 target=$2 kind=$3
	if [[ -e $target ]]; then
		[[ -f $target && ! -L $target ]] || { echo "$kind target is not a regular file: $target" >&2; exit 1; }
		cmp -s "$staged" "$target" || { echo "$kind target already exists with different content: $target" >&2; exit 1; }
		return
	fi
	# A hard link is an atomic create-without-replace operation. A crash after
	# publishing the bundle but before its receipt is restart-safe: the next run
	# rebuilds and compares the exact deterministic bytes before completing it.
	if ! ln "$staged" "$target" 2>/dev/null; then
		[[ -f $target && ! -L $target ]] && cmp -s "$staged" "$target" || {
			echo "unable to publish immutable $kind: $target" >&2
			exit 1
		}
	fi
}

publish_exact "$bundle_temporary" "$output" bundle
publish_exact "$receipt_temporary" "$receipt" receipt
python3 "$script_dir/verify-full-source-bundle.py" \
	--bundle "$output" --receipt "$receipt" --revision "$source_revision" >/dev/null
printf 'full_source_bundle=%s receipt=%s revision=%s project_path=%s project_tree=%s files=%s manifest_sha256=%s bundle_sha256=%s\n' \
	"$output" "$receipt" "$source_revision" "$project_path" "$project_tree" "$file_count" "$manifest_sha" "$bundle_sha"
