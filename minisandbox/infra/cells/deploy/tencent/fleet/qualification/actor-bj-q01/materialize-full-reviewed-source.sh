#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || { echo "Usage: materialize-full-reviewed-source.sh BUNDLE RECEIPT" >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=${ACTOR_BUILD_PYTHON:-python3.11}
verifier=${ACTOR_SOURCE_BUNDLE_VERIFIER:-$script_dir/../../runtime/verify-full-source-bundle.py}
command -v "$python" >/dev/null || {
	echo "reviewed source verification requires the qualified Python 3.11 runtime" >&2
	exit 2
}
"$python" -c 'import sys; assert sys.version_info[:2] == (3, 11)' || {
	echo "ACTOR_BUILD_PYTHON must identify Python 3.11" >&2
	exit 2
}
bundle=$(readlink -e "$1")
receipt=$(readlink -e "$2")
[[ -f $bundle && -f $receipt ]] || { echo "invalid full source inputs" >&2; exit 2; }
[[ $verifier == /* && -f $verifier && ! -L $verifier ]] || {
	echo "ACTOR_SOURCE_BUNDLE_VERIFIER must name an absolute non-symlink regular file" >&2
	exit 2
}
identity=$("$python" "$verifier" --bundle "$bundle" --receipt "$receipt")
IFS=$'\t' read -r revision manifest_sha <<<"$identity"
[[ $revision =~ ^[0-9a-f]{40}$ && $manifest_sha =~ ^[0-9a-f]{64}$ ]] || { echo "invalid full source receipt identity" >&2; exit 2; }
install -d -m 0755 /var/lib/actor-build/deploy
target=/var/lib/actor-build/deploy/q01-src-${revision}-${manifest_sha}
if [[ -e $target ]]; then
	[[ -d $target && $(tr -d '[:space:]' <"$target/.actor-source/SOURCE_REVISION") == "$revision" ]]
	[[ $(sha256sum "$target/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$manifest_sha" ]]
	printf 'reviewed_full_source=%s existing=true\n' "$target"
	exit 0
fi

staging=$(mktemp -d /var/lib/actor-build/deploy/q01-full-staging.XXXXXX)
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT INT TERM
"$python" - "$bundle" "$staging" <<'PY'
import os, sys, tarfile
from pathlib import PurePosixPath
bundle, destination = sys.argv[1:]
with tarfile.open(bundle, "r:gz") as archive:
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not (member.isdir() or member.isfile() or member.issym()):
            raise SystemExit("unsafe full source member: {!r}".format(member.name))
        if member.issym():
            link = PurePosixPath(member.linkname)
            if link.is_absolute():
                raise SystemExit("absolute source symlink: {!r}".format(member.name))
            depth = 0
            for part in path.parent.parts + link.parts:
                if part in ("", "."):
                    continue
                if part == "..":
                    depth -= 1
                else:
                    depth += 1
                if depth < 0:
                    raise SystemExit("escaping source symlink: {!r}".format(member.name))
    archive.extractall(destination)
PY
[[ $(tr -d '[:space:]' <"$staging/.actor-source/SOURCE_REVISION") == "$revision" ]]
manifest=$staging/.actor-source/RELEASE_SHA256SUMS
[[ $(sha256sum "$manifest" | cut -d' ' -f1) == "$manifest_sha" ]]
(
	cd "$staging"
	python_shim=$(mktemp -d)
	trap 'rm -rf -- "$python_shim"' EXIT
	ln -s "$(command -v "$python")" "$python_shim/python3"
	export PATH="$python_shim:$PATH"
	sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null
	find . -type f ! -path './.actor-source/*' -printf '%P\n' | LC_ALL=C sort >.actor-source/actual-files
	sed 's/^[0-9a-f]\{64\}  //' .actor-source/RELEASE_SHA256SUMS | LC_ALL=C sort >.actor-source/manifest-files
	cmp .actor-source/actual-files .actor-source/manifest-files
	test "$(wc -l <.actor-source/manifest-files | tr -d ' ')" = "$(tr -d ' ' <.actor-source/FILE_COUNT)"
	infra/cells/deploy/tencent/fleet/verify-manifests.sh >/dev/null
	rm -rf -- "$python_shim"
	trap - EXIT
)
rm -f "$staging/.actor-source/actual-files" "$staging/.actor-source/manifest-files"
chmod -R a-w "$staging"
mv "$staging" "$target"
trap - EXIT INT TERM
printf 'reviewed_full_source=%s existing=false\n' "$target"
