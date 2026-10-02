#!/usr/bin/env bash
set -euo pipefail

# Materialize historical source only as a read-only Runtime-stage comparison
# baseline. Unlike reviewed release source, this tree is never promotable and
# is not required to satisfy policy checks introduced after it was released.
[[ $# -eq 2 ]] || { echo "Usage: materialize-runtime-baseline-source.sh BUNDLE RECEIPT" >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=${ACTOR_BUILD_PYTHON:-python3.11}
command -v "$python" >/dev/null || { echo "runtime baseline verification requires Python 3.11" >&2; exit 2; }
"$python" -c 'import sys; assert sys.version_info[:2] == (3, 11)'
bundle=$(readlink -e "$1")
receipt=$(readlink -e "$2")
[[ -f $bundle && -f $receipt ]] || { echo "invalid runtime baseline inputs" >&2; exit 2; }
identity=$("$python" "$script_dir/verify-full-source-bundle.py" --bundle "$bundle" --receipt "$receipt")
IFS=$'\t' read -r revision manifest_sha <<<"$identity"
[[ $revision =~ ^[0-9a-f]{40}$ && $manifest_sha =~ ^[0-9a-f]{64}$ ]]

root=/var/lib/actor-build/runtime-baselines
target=$root/runtime-base-${revision}-${manifest_sha}
install -d -m 0755 "$root"
if [[ -e $target ]]; then
	[[ -d $target && ! -L $target ]]
	[[ $(tr -d '[:space:]' <"$target/.actor-source/SOURCE_REVISION") == "$revision" ]]
	[[ $(sha256sum "$target/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$manifest_sha" ]]
	printf 'runtime_baseline_source=%s existing=true\n' "$target"
	exit 0
fi

staging=$(mktemp -d "$root/.runtime-base-staging.XXXXXX")
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT INT TERM
"$python" - "$bundle" "$staging" <<'PY'
import sys
import tarfile
from pathlib import PurePosixPath

bundle, destination = sys.argv[1:]
with tarfile.open(bundle, "r:gz") as archive:
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not (
            member.isdir() or member.isfile() or member.issym()
        ):
            raise SystemExit("unsafe runtime baseline member: {!r}".format(member.name))
        if member.issym():
            link = PurePosixPath(member.linkname)
            if link.is_absolute():
                raise SystemExit("absolute runtime baseline symlink: {!r}".format(member.name))
            depth = 0
            for part in path.parent.parts + link.parts:
                if part in ("", "."):
                    continue
                depth += -1 if part == ".." else 1
                if depth < 0:
                    raise SystemExit("escaping runtime baseline symlink: {!r}".format(member.name))
    archive.extractall(destination)
PY
[[ $(tr -d '[:space:]' <"$staging/.actor-source/SOURCE_REVISION") == "$revision" ]]
manifest=$staging/.actor-source/RELEASE_SHA256SUMS
[[ $(sha256sum "$manifest" | cut -d' ' -f1) == "$manifest_sha" ]]
(
	cd "$staging"
	sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null
	find . -type f ! -path './.actor-source/*' -printf '%P\n' | LC_ALL=C sort >.actor-source/actual-files
	sed 's/^[0-9a-f]\{64\}  //' .actor-source/RELEASE_SHA256SUMS | LC_ALL=C sort >.actor-source/manifest-files
	cmp .actor-source/actual-files .actor-source/manifest-files
	test "$(wc -l <.actor-source/manifest-files | tr -d ' ')" = "$(tr -d ' ' <.actor-source/FILE_COUNT)"
)
rm -f "$staging/.actor-source/actual-files" "$staging/.actor-source/manifest-files"
chmod -R a-w "$staging"
mv "$staging" "$target"
trap - EXIT INT TERM
printf 'runtime_baseline_source=%s existing=false\n' "$target"
