#!/usr/bin/env bash
set -euo pipefail

source_dir=${RIVET_SOURCE_DIR:?RIVET_SOURCE_DIR must name the reviewed jj source tree}
base_revision=${RIVET_REVIEW_BASE_REVISION:?RIVET_REVIEW_BASE_REVISION must identify the reviewed baseline}
source_revision=${RIVET_SOURCE_REVISION:?RIVET_SOURCE_REVISION must identify the release revision}
output=${RIVET_SOURCE_MANIFEST_FILE:?RIVET_SOURCE_MANIFEST_FILE must name the output manifest}

for command in jj sha256sum mktemp mv; do
	command -v "$command" >/dev/null 2>&1 || { echo "missing command: $command" >&2; exit 1; }
done
[[ $output == /* ]] || { echo "RIVET_SOURCE_MANIFEST_FILE must be an absolute path" >&2; exit 2; }

temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT

cd "$source_dir"
base_commit=$(jj log --no-graph -r "$base_revision" -T 'commit_id')
source_commit=$(jj log --no-graph -r "$source_revision" -T 'commit_id')
[[ $base_commit =~ ^[0-9a-f]{40}$ && $source_commit =~ ^[0-9a-f]{40}$ ]] || {
	echo "source revisions must each resolve to one full commit ID" >&2
	exit 1
}
jj diff --from "$base_commit" --to "$source_commit" --summary >"$temporary/summary"
if grep -Eq '^D ' "$temporary/summary"; then
	echo "reviewed source contains deletions; build from a fresh full source tree" >&2
	exit 1
fi
jj diff --from "$base_commit" --to "$source_commit" --name-only >"$temporary/files"
[[ -s $temporary/files ]] || { echo "reviewed source manifest would be empty" >&2; exit 1; }

while IFS= read -r path; do
	[[ -f $path ]] || { echo "reviewed source file is missing: $path" >&2; exit 1; }
	sha256sum "$path"
done <"$temporary/files" >"$temporary/SHA256SUMS"

mkdir -p "$(dirname "$output")"
mv "$temporary/SHA256SUMS" "$output"
printf 'manifest=%s files=%s sha256=%s\n' \
	"$output" "$(wc -l <"$output" | tr -d ' ')" "$(sha256sum "$output" | cut -d' ' -f1)"
