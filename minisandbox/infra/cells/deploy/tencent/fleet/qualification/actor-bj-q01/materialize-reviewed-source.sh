#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 4 ]] || {
	echo "Usage: materialize-reviewed-source.sh BASE_SOURCE BUNDLE SOURCE_REVISION MANIFEST_SHA256" >&2
	exit 2
}
base=$(readlink -e "$1")
bundle=$(readlink -e "$2")
source_revision=$3
manifest_sha=$4
[[ $base =~ ^/var/lib/actor-build/deploy/q01-src-([0-9a-f]{40})-([0-9a-f]{64})$ && -d $base ]] || {
	echo "base source has no immutable q01 identity" >&2
	exit 2
}
base_revision=${BASH_REMATCH[1]}
[[ -f $bundle && $source_revision =~ ^[0-9a-f]{40}$ && $manifest_sha =~ ^[0-9a-f]{64}$ ]] || {
	echo "bundle or destination identity is invalid" >&2
	exit 2
}
target=/var/lib/actor-build/deploy/q01-src-${source_revision}-${manifest_sha}
if [[ -e $target ]]; then
	[[ -d $target && $(tr -d '[:space:]' <"$target/.actor-source/SOURCE_REVISION") == "$source_revision" ]]
	[[ $(sha256sum "$target/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$manifest_sha" ]]
	printf 'reviewed_source=%s existing=true\n' "$target"
	exit 0
fi

staging=$(mktemp -d /var/lib/actor-build/deploy/q01-src-staging.XXXXXX)
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT INT TERM

# Never clone compiler output from the immutable source input. This is also
# substantially cheaper than accidentally copying a multi-GiB Cargo cache for
# every small source promotion.
tar -C "$base" --exclude='./target' -cf - . | tar -C "$staging" -xf -
[[ ! -e $staging/target ]] || { echo "source staging inherited a root target directory" >&2; exit 1; }
chmod -R u+w "$staging"
env \
	RIVET_SOURCE_BUNDLE="$bundle" \
	RIVET_SOURCE_DIR="$staging" \
	RIVET_BASE_REVISION="$base_revision" \
	RIVET_SOURCE_REVISION="$source_revision" \
	"$base/infra/cells/deploy/tencent/fleet/runtime/apply-source-delta.sh"
[[ $(sha256sum "$staging/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$manifest_sha" ]]
mv "$staging" "$target"
trap - EXIT INT TERM
printf 'reviewed_source=%s existing=false\n' "$target"
