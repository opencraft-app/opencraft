#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}
[[ $TMPDIR == /* ]] || { echo "TMPDIR must be absolute" >&2; exit 2; }
[[ -d $TMPDIR ]] || install -d -m 1777 "$TMPDIR"
[[ -w $TMPDIR ]] || { echo "TMPDIR is not writable: $TMPDIR" >&2; exit 2; }

source_dir=${ACTOR_SOURCE_DIR:?ACTOR_SOURCE_DIR must name the reviewed source tree}
image_tag=${ACTOR_RELEASE_HOOK_IMAGE_TAG:?ACTOR_RELEASE_HOOK_IMAGE_TAG must be an immutable release tag}
auth_file=${REGISTRY_AUTH_FILE:?REGISTRY_AUTH_FILE must name protected registry credentials}
base_image=${ACTOR_RELEASE_HOOK_BASE:?ACTOR_RELEASE_HOOK_BASE must pin base-tencentcloud-cli by digest}

source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
source_revision=${ACTOR_SOURCE_REVISION:-}
source_manifest=${ACTOR_SOURCE_MANIFEST_FILE:-}
[[ -n $source_revision || ! -s $source_dir/.actor-source/SOURCE_REVISION ]] || \
	source_revision=$(tr -d '[:space:]' <"$source_dir/.actor-source/SOURCE_REVISION")
[[ -n $source_manifest || ! -s $source_dir/.actor-source/RELEASE_SHA256SUMS ]] || \
	source_manifest="$source_dir/.actor-source/RELEASE_SHA256SUMS"

[[ $image_tag != *@* && $image_tag == *:* ]] || { echo "release Hook image must be a tag" >&2; exit 2; }
[[ $source_revision =~ ^[0-9a-f]{40}$ ]] || { echo "source revision must be a full Git commit" >&2; exit 2; }
[[ -s $source_manifest && -f $auth_file ]] || { echo "reviewed source identity or registry auth is missing" >&2; exit 2; }
[[ $base_image =~ /actor-fleet/base-tencentcloud-cli@sha256:[0-9a-f]{64}$ ]] || { echo "release Hook base must use its exact digest-pinned product repository" >&2; exit 2; }
product_python=${ACTOR_BUILD_PYTHON:-python3}
for command in buildah "$product_python" sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
"$product_python" -c 'import sys; assert sys.version_info >= (3, 11)' || {
	echo "ACTOR_BUILD_PYTHON must identify Python 3.11 or newer" >&2
	exit 2
}

cd "$source_dir"
sha256sum --check "$source_manifest" >/dev/null
manifest_sha=$(sha256sum "$source_manifest" | cut -d' ' -f1)
dockerfile=infra/cells/deploy/tencent/fleet/gitops/Dockerfile.release-hook
[[ -s $dockerfile ]] || { echo "release Hook Dockerfile is missing" >&2; exit 1; }

buildah bud --authfile "$auth_file" \
	--build-arg "RELEASE_HOOK_BASE=$base_image" \
	--label "org.opencontainers.image.revision=$source_revision" \
	--label "fleet.actor.dev/source-manifest-sha256=$manifest_sha" \
	--label "fleet.actor.dev/base-image=$base_image" \
	-t "$image_tag" -f "$dockerfile" .

buildah inspect "$image_tag" | "$product_python" -c '
import json,sys
labels=json.load(sys.stdin).get("Docker",{}).get("config",{}).get("Labels",{})
expected={"org.opencontainers.image.revision":sys.argv[1],"fleet.actor.dev/source-manifest-sha256":sys.argv[2],"fleet.actor.dev/base-image":sys.argv[3]}
for key,value in expected.items():
    if labels.get(key) != value: raise SystemExit("built image label mismatch: " + key)
' "$source_revision" "$manifest_sha" "$base_image"

digest_file=$(mktemp "$TMPDIR/release-hook-registry-digest.XXXXXX")
cleanup() { rm -f -- "$digest_file"; }
trap cleanup EXIT INT TERM
buildah push --authfile "$auth_file" --digestfile "$digest_file" "$image_tag" "docker://$image_tag"
digest=$(tr -d '[:space:]' <"$digest_file")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "registry returned an invalid digest" >&2; exit 1; }
registry_ref="${image_tag%:*}@$digest"
: "${ACTOR_PRODUCT_BUILD_RECEIPT:?ACTOR_PRODUCT_BUILD_RECEIPT is required}"
"$product_python" "$script_dir/image-seed/record-product-image.py" \
	--repository release-hook \
	--ref "$registry_ref" \
	--source-revision "$source_revision" \
	--source-manifest-digest "sha256:$manifest_sha" \
	--dependency "base-tencentcloud-cli=$base_image" \
	--registry-auth-file "$auth_file" \
	--output "$ACTOR_PRODUCT_BUILD_RECEIPT"
printf '%s\n' "$registry_ref"
printf 'source_revision=%s source_manifest_sha256=%s base_image=%s\n' \
	"$source_revision" "$manifest_sha" "$base_image"
