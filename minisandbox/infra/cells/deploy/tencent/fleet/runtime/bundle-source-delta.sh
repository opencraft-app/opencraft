#!/usr/bin/env bash
set -euo pipefail

source_dir=${RIVET_SOURCE_DIR:?RIVET_SOURCE_DIR must name the reviewed jj source tree}
base_revision=${RIVET_BASE_REVISION:?RIVET_BASE_REVISION must identify the builder base tree}
source_revision=${RIVET_SOURCE_REVISION:?RIVET_SOURCE_REVISION must identify the release revision}
output=${RIVET_SOURCE_BUNDLE:?RIVET_SOURCE_BUNDLE must name the output tar.gz}
release_manifest=${RIVET_SOURCE_MANIFEST_FILE:?RIVET_SOURCE_MANIFEST_FILE must name the complete reviewed release manifest}
# Prevent macOS tar from adding LIBARCHIVE xattr headers that Linux builders
# ignore noisily. The source contract is content hashes, not host metadata.
export COPYFILE_DISABLE=1
for command in jj tar sha256sum python3; do
	command -v "$command" >/dev/null 2>&1 || { echo "missing command: $command" >&2; exit 1; }
done
[[ $output == /* ]] || { echo "RIVET_SOURCE_BUNDLE must be an absolute path" >&2; exit 2; }
release_manifest=$(CDPATH= cd -- "$(dirname -- "$release_manifest")" && pwd)/$(basename -- "$release_manifest")
[[ -s $release_manifest ]] || { echo "complete reviewed release manifest is missing" >&2; exit 2; }

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
	echo "source delta contains deletions; create a fresh full source tree instead of an overlay" >&2
	exit 1
fi
jj diff --from "$base_commit" --to "$source_commit" --name-only >"$temporary/files"
[[ -s $temporary/files ]] || { echo "source delta is empty" >&2; exit 1; }
sha256sum --check "$release_manifest" >/dev/null
python3 - "$temporary/files" <<'PY'
import sys
from pathlib import PurePosixPath
for raw in open(sys.argv[1]):
    path = raw.rstrip("\n")
    parsed = PurePosixPath(path)
    if not path or parsed.is_absolute() or ".." in parsed.parts:
        raise SystemExit(f"unsafe delta path: {path!r}")
PY
mkdir -p "$temporary/payload/.actor-source"
tar -cf - -T "$temporary/files" | tar -xf - -C "$temporary/payload"
(
	cd "$temporary/payload"
	while IFS= read -r path; do sha256sum "$path"; done <"$temporary/files"
) >"$temporary/payload/.actor-source/SHA256SUMS"
printf '%s\n' "$base_commit" >"$temporary/payload/.actor-source/BASE_REVISION"
printf '%s\n' "$source_commit" >"$temporary/payload/.actor-source/SOURCE_REVISION"
printf '%s\n' "$(wc -l <"$temporary/files" | tr -d ' ')" >"$temporary/payload/.actor-source/FILE_COUNT"
install -m 0644 "$release_manifest" "$temporary/payload/.actor-source/RELEASE_SHA256SUMS"
tar -czf "$output" -C "$temporary/payload" .
printf 'bundle=%s files=%s sha256=%s manifest_sha256=%s\n' \
	"$output" "$(cat "$temporary/payload/.actor-source/FILE_COUNT")" \
	"$(sha256sum "$output" | cut -d' ' -f1)" \
	"$(sha256sum "$temporary/payload/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)"
