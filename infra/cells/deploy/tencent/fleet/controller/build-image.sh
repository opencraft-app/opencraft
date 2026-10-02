#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}
[[ $TMPDIR == /* ]] || { echo "TMPDIR must be absolute" >&2; exit 2; }
if [[ ! -e $TMPDIR ]]; then install -d -m 1777 "$TMPDIR"; fi
[[ -d $TMPDIR && -w $TMPDIR ]] || { echo "TMPDIR is not writable: $TMPDIR" >&2; exit 2; }

source_dir=${ACTOR_SOURCE_DIR:?ACTOR_SOURCE_DIR must name the reviewed source tree}
image_tag=${ACTOR_FLEET_CONTROLLER_IMAGE_TAG:?ACTOR_FLEET_CONTROLLER_IMAGE_TAG must be an immutable release tag}
auth_file=${REGISTRY_AUTH_FILE:-}
build_base=${ACTOR_FLEET_BUILD_BASE:?ACTOR_FLEET_BUILD_BASE must pin base-golang by digest}
runtime_base=${ACTOR_FLEET_RUNTIME_BASE:?ACTOR_FLEET_RUNTIME_BASE must pin base-distroless by digest}
python=${PYTHON:-python3}

source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
source_revision=${ACTOR_SOURCE_REVISION:-}
source_manifest=${ACTOR_SOURCE_MANIFEST_FILE:-}
[[ -n $source_revision || ! -s $source_dir/.actor-source/SOURCE_REVISION ]] || source_revision=$(tr -d '[:space:]' <"$source_dir/.actor-source/SOURCE_REVISION")
[[ -n $source_manifest || ! -s $source_dir/.actor-source/RELEASE_SHA256SUMS ]] || source_manifest="$source_dir/.actor-source/RELEASE_SHA256SUMS"
[[ -n $source_manifest ]] || { echo "reviewed source manifest is unavailable" >&2; exit 2; }
source_manifest=$(CDPATH= cd -- "$(dirname -- "$source_manifest")" && pwd)/$(basename -- "$source_manifest")
cells_dir=$source_dir/infra/cells
dockerfile=$cells_dir/Dockerfile.actor-fleet-controller

[[ $image_tag != *@* && $image_tag == *:* ]] || {
	echo "ACTOR_FLEET_CONTROLLER_IMAGE_TAG must be a tagged image, not a digest" >&2
	exit 2
}
[[ $source_revision =~ ^[0-9a-f]{40}$ ]] || {
	echo "ACTOR_SOURCE_REVISION or .actor-source/SOURCE_REVISION must be a full Git commit" >&2
	exit 2
}
[[ $build_base =~ /actor-fleet/base-golang@sha256:[0-9a-f]{64}$ && \
	$runtime_base =~ /actor-fleet/base-distroless@sha256:[0-9a-f]{64}$ ]] || {
	echo "controller bases must use their exact digest-pinned product repositories" >&2
	exit 2
}
for command in buildah "$python" sha256sum; do
	command -v "$command" >/dev/null 2>&1 || {
		echo "required command not found: $command" >&2
		exit 1
	}
done
"$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 7) else 1)' || {
	echo "PYTHON must select Python 3.7 or newer" >&2
	exit 2
}
[[ -f $dockerfile && -s $source_manifest ]] || {
	echo "reviewed Dockerfile or source manifest is missing" >&2
	exit 1
}
[[ -n $auth_file && -f $auth_file ]] || {
	echo "REGISTRY_AUTH_FILE must name a protected auth file for private build bases" >&2
	exit 1
}

cd "$source_dir"
sha256sum --check "$source_manifest" >/dev/null
manifest_sha=$(sha256sum "$source_manifest" | cut -d' ' -f1)
go_mod_sha=$(sha256sum "$cells_dir/go.mod" | cut -d' ' -f1)
go_sum_sha=$(sha256sum "$cells_dir/go.sum" | cut -d' ' -f1)
# A digest pin proves which dependency image was selected, while these labels
# prove that it was built from this source tree's exact module graph.  Avoid a
# source-code hash constant here: that constant becomes stale at the same time
# as go.mod and can only report the problem, whereas the signed build input is
# the dependency-base image itself.
build_base_id=$(buildah pull --quiet --authfile "$auth_file" "$build_base")
[[ $build_base_id =~ ^([0-9a-f]{64}|sha256:[0-9a-f]{64})$ ]] || {
	echo "unable to resolve the pinned dependency base" >&2
	exit 1
}
buildah inspect "$build_base_id" | "$python" -c '
import json
import sys

image = json.load(sys.stdin)
labels = image.get("Docker", {}).get("config", {}).get("Labels", {})
expected = {
    "fleet.actor.dev/go-mod-sha256": sys.argv[1],
    "fleet.actor.dev/go-sum-sha256": sys.argv[2],
}
for key, value in expected.items():
    if labels.get(key) != value:
        raise SystemExit(
            "go.mod/go.sum changed without rebuilding the pinned dependency base: " + key
        )
' "$go_mod_sha" "$go_sum_sha"

buildah bud \
	--authfile "$auth_file" \
	--build-arg "ACTOR_FLEET_BUILD_IMAGE=$build_base" \
	--build-arg "ACTOR_FLEET_RUNTIME_IMAGE=$runtime_base" \
	--build-arg "SOURCE_REVISION=$source_revision" \
	--build-arg "SOURCE_MANIFEST_SHA256=$manifest_sha" \
	--label "org.opencontainers.image.revision=$source_revision" \
	--label "fleet.actor.dev/source-manifest-sha256=$manifest_sha" \
	--label "fleet.actor.dev/build-base=$build_base" \
	--label "fleet.actor.dev/runtime-base=$runtime_base" \
	-t "$image_tag" -f "$dockerfile" "$cells_dir"

buildah inspect "$image_tag" | "$python" -c '
import json
import sys

image = json.load(sys.stdin)
labels = image.get("Docker", {}).get("config", {}).get("Labels", {})
expected = {
    "org.opencontainers.image.revision": sys.argv[1],
    "fleet.actor.dev/source-manifest-sha256": sys.argv[2],
    "fleet.actor.dev/build-base": sys.argv[3],
    "fleet.actor.dev/runtime-base": sys.argv[4],
}
for key, value in expected.items():
    if labels.get(key) != value:
        raise SystemExit(f"built image label mismatch: {key}")
' "$source_revision" "$manifest_sha" "$build_base" "$runtime_base"

if [[ ${ACTOR_PUSH_IMAGE:-1} == 1 ]]; then
	digest_file=$(mktemp)
	cleanup() { rm -f -- "$digest_file"; }
	trap cleanup EXIT INT TERM
	buildah push --authfile "$auth_file" --digestfile "$digest_file" \
		"$image_tag" "docker://$image_tag"
	digest=$(tr -d '[:space:]' <"$digest_file")
	[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || {
		echo "registry returned an invalid digest: $digest" >&2
		exit 1
	}
	registry_ref="${image_tag%:*}@$digest"
	: "${ACTOR_PRODUCT_BUILD_RECEIPT:?ACTOR_PRODUCT_BUILD_RECEIPT is required when pushing}"
	"$python" "$script_dir/../gitops/image-seed/record-product-image.py" \
		--repository actor-fleet-controller \
		--ref "$registry_ref" \
		--source-revision "$source_revision" \
		--source-manifest-digest "sha256:$manifest_sha" \
		--dependency "base-golang=$build_base" \
		--dependency "base-distroless=$runtime_base" \
		--registry-auth-file "$auth_file" \
		--output "$ACTOR_PRODUCT_BUILD_RECEIPT"
	printf '%s\n' "$registry_ref"
else
	printf '%s\n' "$image_tag"
fi

printf 'source_revision=%s source_manifest_sha256=%s\n' "$source_revision" "$manifest_sha"
