#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
product_python=${ACTOR_BUILD_PYTHON:-python3}
command -v "$product_python" >/dev/null || { echo "product receipt Python is unavailable: $product_python" >&2; exit 2; }
"$product_python" -c 'import sys; assert sys.version_info >= (3, 7)'

export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}
[[ $TMPDIR == /* ]] || { echo "TMPDIR must be absolute" >&2; exit 2; }
[[ -d $TMPDIR ]] || install -d -m 1777 "$TMPDIR"

source_dir=${ACTOR_SOURCE_DIR:?ACTOR_SOURCE_DIR must name the reviewed source tree}
image_tag=${ACTOR_LOADGEN_IMAGE_TAG:?ACTOR_LOADGEN_IMAGE_TAG must be an immutable release tag}
auth_file=${REGISTRY_AUTH_FILE:?REGISTRY_AUTH_FILE must name the private registry credentials}
base_image=${ACTOR_LOADGEN_BASE:?ACTOR_LOADGEN_BASE must pin base-golang by digest}

source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
source_revision=${ACTOR_SOURCE_REVISION:-}
source_manifest=${ACTOR_SOURCE_MANIFEST_FILE:-}
[[ -n $source_revision || ! -s $source_dir/.actor-source/SOURCE_REVISION ]] || source_revision=$(tr -d '[:space:]' <"$source_dir/.actor-source/SOURCE_REVISION")
[[ -n $source_manifest || ! -s $source_dir/.actor-source/RELEASE_SHA256SUMS ]] || source_manifest="$source_dir/.actor-source/RELEASE_SHA256SUMS"
[[ -n $source_manifest ]] || { echo "reviewed source manifest is unavailable" >&2; exit 2; }
source_manifest=$(CDPATH= cd -- "$(dirname -- "$source_manifest")" && pwd)/$(basename -- "$source_manifest")
[[ $image_tag != *@* && $image_tag == *:* ]] || { echo "image must use a release tag before push" >&2; exit 2; }
[[ $source_revision =~ ^[0-9a-f]{40}$ && -s $source_manifest && -f $auth_file ]] || {
	echo "loadgen build identity is incomplete" >&2
	exit 2
}
[[ $base_image =~ /actor-fleet/base-golang@sha256:[0-9a-f]{64}$ ]] || {
	echo "loadgen base must use the exact digest-pinned base-golang repository" >&2
	exit 2
}
for command in buildah sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

cd "$source_dir"
sha256sum --check "$source_manifest" >/dev/null
manifest_sha=$(sha256sum "$source_manifest" | cut -d' ' -f1)
buildah bud --authfile "$auth_file" \
	--build-arg "ACTOR_LOADGEN_BASE_IMAGE=$base_image" \
	--build-arg "SOURCE_REVISION=$source_revision" \
	--build-arg "SOURCE_MANIFEST_SHA256=$manifest_sha" \
	--label "fleet.actor.dev/source-revision=$source_revision" \
	--label "org.opencontainers.image.revision=$source_revision" \
	--label "fleet.actor.dev/source-manifest-sha256=$manifest_sha" \
	-t "$image_tag" -f infra/cells/deploy/tencent/fleet/loadgen/Dockerfile infra/cells

digest_file=$(mktemp "$TMPDIR/actor-loadgen-registry-digest.XXXXXX")
cleanup() { rm -f -- "$digest_file"; }
trap cleanup EXIT INT TERM
buildah push --authfile "$auth_file" --digestfile "$digest_file" "$image_tag" "docker://$image_tag"
digest=$(tr -d '[:space:]' <"$digest_file")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "registry returned an invalid digest" >&2; exit 1; }
registry_ref="${image_tag%:*}@$digest"
: "${ACTOR_PRODUCT_BUILD_RECEIPT:?ACTOR_PRODUCT_BUILD_RECEIPT is required}"
"$product_python" "$script_dir/../gitops/image-seed/record-product-image.py" \
	--repository actor-loadgen \
	--ref "$registry_ref" \
	--source-revision "$source_revision" \
	--source-manifest-digest "sha256:$manifest_sha" \
	--dependency "base-golang=$base_image" \
	--registry-auth-file "$auth_file" \
	--output "$ACTOR_PRODUCT_BUILD_RECEIPT"
printf '%s\n' "$registry_ref"
printf 'source_revision=%s source_manifest_sha256=%s\n' "$source_revision" "$manifest_sha"
