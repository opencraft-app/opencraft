#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}
[[ $TMPDIR == /* ]] || { echo "TMPDIR must be absolute" >&2; exit 2; }
[[ -d $TMPDIR ]] || install -d -m 1777 "$TMPDIR"

source_dir=${ACTOR_SOURCE_DIR:?ACTOR_SOURCE_DIR must name the reviewed source tree}
image_tag=${WORKERS_API_IMAGE_TAG:?WORKERS_API_IMAGE_TAG must be an immutable release tag}
auth_file=${REGISTRY_AUTH_FILE:?REGISTRY_AUTH_FILE must name protected registry credentials}
build_base=${WORKERS_API_BUILD_BASE:?WORKERS_API_BUILD_BASE must pin base-golang by digest}
runtime_base=${WORKERS_API_RUNTIME_BASE:?WORKERS_API_RUNTIME_BASE must pin base-distroless by digest}
python=${PYTHON:-python3}

source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
source_revision=${ACTOR_SOURCE_REVISION:-}
source_manifest=${ACTOR_SOURCE_MANIFEST_FILE:-}
[[ -n $source_revision || ! -s $source_dir/.actor-source/SOURCE_REVISION ]] || source_revision=$(tr -d '[:space:]' <"$source_dir/.actor-source/SOURCE_REVISION")
[[ -n $source_manifest || ! -s $source_dir/.actor-source/RELEASE_SHA256SUMS ]] || source_manifest="$source_dir/.actor-source/RELEASE_SHA256SUMS"
[[ $image_tag != *@* && $image_tag == *:* ]] || { echo "WORKERS_API_IMAGE_TAG must be a release tag" >&2; exit 2; }
[[ $source_revision =~ ^[0-9a-f]{40}$ && -s $source_manifest && -f $auth_file ]] || { echo "Workers API build identity is incomplete" >&2; exit 2; }
[[ $build_base =~ /actor-fleet/base-golang@sha256:[0-9a-f]{64}$ && $runtime_base =~ /actor-fleet/base-distroless@sha256:[0-9a-f]{64}$ ]] || { echo "Workers API bases must use their exact digest-pinned product repositories" >&2; exit 2; }
for command in buildah "$python" sha256sum; do command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }; done
"$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 7) else 1)' || {
	echo "PYTHON must select Python 3.7 or newer" >&2
	exit 2
}

cd "$source_dir"
sha256sum --check "$source_manifest" >/dev/null
manifest_sha=$(sha256sum "$source_manifest" | cut -d' ' -f1)
buildah bud --authfile "$auth_file" \
	--build-arg "WORKERS_API_BUILD_IMAGE=$build_base" \
	--build-arg "WORKERS_API_RUNTIME_IMAGE=$runtime_base" \
	--label "org.opencontainers.image.revision=$source_revision" \
	--label "fleet.actor.dev/source-manifest-sha256=$manifest_sha" \
	--label "fleet.actor.dev/build-base=$build_base" \
	--label "fleet.actor.dev/runtime-base=$runtime_base" \
	-t "$image_tag" -f infra/cells/Dockerfile.workers-api infra/cells

buildah inspect "$image_tag" | "$python" -c '
import json,sys
labels=json.load(sys.stdin).get("Docker",{}).get("config",{}).get("Labels",{})
expected={"org.opencontainers.image.revision":sys.argv[1],"fleet.actor.dev/source-manifest-sha256":sys.argv[2],"fleet.actor.dev/build-base":sys.argv[3],"fleet.actor.dev/runtime-base":sys.argv[4]}
for key,value in expected.items():
    if labels.get(key) != value: raise SystemExit("built image label mismatch: " + key)
' "$source_revision" "$manifest_sha" "$build_base" "$runtime_base"

digest_file=$(mktemp "$TMPDIR/workers-api-registry-digest.XXXXXX")
cleanup() { rm -f -- "$digest_file"; }
trap cleanup EXIT INT TERM
buildah push --authfile "$auth_file" --digestfile "$digest_file" "$image_tag" "docker://$image_tag"
digest=$(tr -d '[:space:]' <"$digest_file")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "registry returned an invalid digest" >&2; exit 1; }
registry_ref="${image_tag%:*}@$digest"
: "${ACTOR_PRODUCT_BUILD_RECEIPT:?ACTOR_PRODUCT_BUILD_RECEIPT is required}"
"$python" "$script_dir/../gitops/image-seed/record-product-image.py" \
	--repository workers-api \
	--ref "$registry_ref" \
	--source-revision "$source_revision" \
	--source-manifest-digest "sha256:$manifest_sha" \
	--dependency "base-golang=$build_base" \
	--dependency "base-distroless=$runtime_base" \
	--registry-auth-file "$auth_file" \
	--output "$ACTOR_PRODUCT_BUILD_RECEIPT"
printf '%s\n' "$registry_ref"
printf 'source_revision=%s source_manifest_sha256=%s\n' "$source_revision" "$manifest_sha"
