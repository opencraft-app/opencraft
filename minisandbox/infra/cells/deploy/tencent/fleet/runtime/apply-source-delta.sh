#!/usr/bin/env bash
set -euo pipefail

if [[ ${ACTOR_SOURCE_APPLIER_STAGED:-0} != 1 ]]; then
	staged_applier=$(mktemp)
	install -m 0700 "$0" "$staged_applier"
	exec env ACTOR_SOURCE_APPLIER_STAGED=1 \
		ACTOR_SOURCE_APPLIER_STAGED_PATH="$staged_applier" "$staged_applier" "$@"
fi
staged_applier=${ACTOR_SOURCE_APPLIER_STAGED_PATH:?staged applier path is required}
temporary=
cleanup() {
	if [[ -n $temporary ]]; then rm -rf -- "$temporary"; fi
	rm -f -- "$staged_applier"
}
trap cleanup EXIT INT TERM

bundle=${RIVET_SOURCE_BUNDLE:?RIVET_SOURCE_BUNDLE must name the reviewed tar.gz}
source_dir=${RIVET_SOURCE_DIR:?RIVET_SOURCE_DIR must name the builder source tree}
base_revision=${RIVET_BASE_REVISION:?RIVET_BASE_REVISION must identify the builder base tree}
source_revision=${RIVET_SOURCE_REVISION:?RIVET_SOURCE_REVISION must identify the release revision}
[[ -f $bundle && -d $source_dir ]] || { echo "source bundle or target tree is missing" >&2; exit 1; }
[[ $base_revision =~ ^[0-9a-f]{40}$ && $source_revision =~ ^[0-9a-f]{40}$ ]] || {
	echo "builder base and source revisions must be full commit IDs" >&2
	exit 2
}
[[ -s $source_dir/.actor-source/SOURCE_REVISION && \
	-s $source_dir/.actor-source/RELEASE_SHA256SUMS ]] || {
	echo "builder base tree has no verified source identity" >&2
	exit 1
}
actual_base_revision=$(tr -d '[:space:]' <"$source_dir/.actor-source/SOURCE_REVISION")
[[ $actual_base_revision == "$base_revision" ]] || {
	echo "builder base identity mismatch: expected $base_revision, found $actual_base_revision" >&2
	exit 1
}
(
	cd "$source_dir"
	sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null
) || {
	echo "builder base tree no longer matches its reviewed release manifest" >&2
	exit 1
}

temporary=$(mktemp -d)
python3 - "$bundle" "$temporary" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath

bundle, destination = sys.argv[1:]
with tarfile.open(bundle, "r:gz") as archive:
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not (member.isdir() or member.isfile()):
            raise SystemExit("unsafe source bundle member: %r" % member.name)
    archive.extractall(destination)
PY
[[ $(cat "$temporary/.actor-source/BASE_REVISION") == "$base_revision" ]]
[[ $(cat "$temporary/.actor-source/SOURCE_REVISION") == "$source_revision" ]]
[[ -s $temporary/.actor-source/RELEASE_SHA256SUMS ]]
(
	cd "$temporary"
	sha256sum --check .actor-source/SHA256SUMS
)
# Verify the complete release closure against the prospective overlay before
# touching the builder tree: a path present in the delta wins, all other paths
# must match the reviewed base tree.
python3 - "$temporary" "$source_dir" "$temporary/.actor-source/RELEASE_SHA256SUMS" <<'PY'
import hashlib, os, sys
from pathlib import Path, PurePosixPath

delta, base, manifest = map(Path, sys.argv[1:])
seen = set()
for raw in manifest.read_text().splitlines():
    digest, marker_path = raw.split("  ", 1)
    path = PurePosixPath(marker_path)
    if (len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest)
            or path.is_absolute() or ".." in path.parts or marker_path in seen):
        raise SystemExit("invalid release manifest entry: %r" % raw)
    seen.add(marker_path)
    candidate = delta / marker_path
    if not candidate.is_file():
        candidate = base / marker_path
    if not candidate.is_file():
        raise SystemExit("release manifest path is missing: %s" % marker_path)
    actual = hashlib.sha256(candidate.read_bytes()).hexdigest()
    if actual != digest:
        raise SystemExit("release manifest mismatch: %s" % marker_path)
if not seen:
    raise SystemExit("release manifest is empty")
PY
cp -a "$temporary"/. "$source_dir"/
(
	cd "$source_dir"
	sha256sum --check .actor-source/SHA256SUMS >/dev/null
	# A complete release manifest contains the entire source tree. Printing one
	# success line per file can exceed TAT's output budget and turn a valid
	# promotion into a transport-level failure; the exit status is the evidence.
	sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null
)
echo "source delta applied and verified: $(cat "$source_dir/.actor-source/FILE_COUNT") files"
