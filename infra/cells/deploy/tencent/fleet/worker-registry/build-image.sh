#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
product_python=${ACTOR_BUILD_PYTHON:-python3}
command -v "$product_python" >/dev/null || { echo "product receipt Python is unavailable: $product_python" >&2; exit 2; }
"$product_python" -c 'import sys; assert sys.version_info >= (3, 7)'
fdb_lock=$script_dir/foundationdb-client.lock.json
fdb_client=${WORKER_REGISTRY_FDB_CLIENT_DEB:?WORKER_REGISTRY_FDB_CLIENT_DEB must name the pinned FDB client package}
export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}
[[ $TMPDIR == /* ]] || { echo "TMPDIR must be absolute" >&2; exit 2; }
[[ -d $TMPDIR ]] || install -d -m 1777 "$TMPDIR"

source_dir=${ACTOR_SOURCE_DIR:?ACTOR_SOURCE_DIR must name the reviewed source tree}
image_tag=${WORKER_REGISTRY_IMAGE_TAG:?WORKER_REGISTRY_IMAGE_TAG must be an immutable release tag}
build_base=${WORKER_REGISTRY_BUILD_BASE:?WORKER_REGISTRY_BUILD_BASE must pin base-golang by digest}
runtime_base=${WORKER_REGISTRY_RUNTIME_BASE:?WORKER_REGISTRY_RUNTIME_BASE must pin base-distroless by digest}
auth_file=${REGISTRY_AUTH_FILE:?REGISTRY_AUTH_FILE must name protected registry credentials}
: "${ACTOR_PRODUCT_BUILD_RECEIPT:?ACTOR_PRODUCT_BUILD_RECEIPT is required}"

source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
source_revision=${ACTOR_SOURCE_REVISION:-}
source_manifest=${ACTOR_SOURCE_MANIFEST_FILE:-}
[[ -n $source_revision || ! -s $source_dir/.actor-source/SOURCE_REVISION ]] || \
	source_revision=$(tr -d '[:space:]' <"$source_dir/.actor-source/SOURCE_REVISION")
[[ -n $source_manifest || ! -s $source_dir/.actor-source/RELEASE_SHA256SUMS ]] || \
	source_manifest="$source_dir/.actor-source/RELEASE_SHA256SUMS"

[[ $image_tag != *@* && $image_tag == *:* ]] || { echo "Worker Registry image must use a release tag" >&2; exit 2; }
[[ $source_revision =~ ^[0-9a-f]{40}$ && -s $source_manifest && -f $auth_file ]] || {
	echo "Worker Registry build identity is incomplete" >&2
	exit 2
}
[[ $build_base =~ /actor-fleet/base-golang@sha256:[0-9a-f]{64}$ && \
	$runtime_base =~ /actor-fleet/base-distroless@sha256:[0-9a-f]{64}$ ]] || {
	echo "Worker Registry bases must use their exact digest-pinned product repositories" >&2
	exit 2
}
for command in buildah jq sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
fdb_client=$(readlink -e "$fdb_client")
[[ -f $fdb_client && ! -L $fdb_client && -f $fdb_lock ]] || {
	echo "pinned FDB client package or lock is unavailable" >&2
	exit 2
}
jq -e '
  keys == ["packageSha256","schemaVersion","url","version"] and
  .schemaVersion == 1 and .version == "7.3.79" and
  .packageSha256 == "52cc22565c42e7eb60c08f395a0626483735c311be0d80b7c035ac8e328e2fff" and
  .url == "https://github.com/apple/foundationdb/releases/download/7.3.79/foundationdb-clients_7.3.79-1_amd64.deb"
' "$fdb_lock" >/dev/null || { echo "Worker Registry FDB client lock is invalid" >&2; exit 1; }
[[ $(sha256sum "$fdb_client" | cut -d' ' -f1) == $(jq -r .packageSha256 "$fdb_lock") ]] || {
	echo "Worker Registry FDB client package differs from the lock" >&2
	exit 1
}

cd "$source_dir"
sha256sum --check "$source_manifest" >/dev/null
manifest_sha=$(sha256sum "$source_manifest" | cut -d' ' -f1)
build_context=$(mktemp -d "$TMPDIR/worker-registry-context.XXXXXX")
digest_file=
cleanup() {
	rm -rf -- "$build_context"
	[[ -z $digest_file ]] || rm -f -- "$digest_file"
}
trap cleanup EXIT INT TERM
install -d -m 0755 "$build_context/cmd" "$build_context/internal"
install -m 0644 infra/cells/go.mod infra/cells/go.sum "$build_context/"
cp -a -- infra/cells/cmd/worker-registry "$build_context/cmd/"
cp -a -- infra/cells/internal/workerregistry "$build_context/internal/"
install -m 0644 infra/cells/Dockerfile.worker-registry "$build_context/Dockerfile"
install -m 0644 "$fdb_client" "$build_context/foundationdb-clients_7.3.79-1_amd64.deb"
buildah bud --authfile "$auth_file" \
	--build-arg "WORKER_REGISTRY_BUILD_IMAGE=$build_base" \
	--build-arg "WORKER_REGISTRY_RUNTIME_IMAGE=$runtime_base" \
	--label "org.opencontainers.image.revision=$source_revision" \
	--label "fleet.actor.dev/source-manifest-sha256=$manifest_sha" \
	--label "fleet.actor.dev/build-base=$build_base" \
	--label "fleet.actor.dev/runtime-base=$runtime_base" \
	-t "$image_tag" -f "$build_context/Dockerfile" "$build_context"

digest_file=$(mktemp "$TMPDIR/worker-registry-digest.XXXXXX")
buildah push --authfile "$auth_file" --digestfile "$digest_file" "$image_tag" "docker://$image_tag"
digest=$(tr -d '[:space:]' <"$digest_file")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "registry returned an invalid digest" >&2; exit 1; }
registry_ref="${image_tag%:*}@$digest"
"$product_python" "$script_dir/../gitops/image-seed/record-product-image.py" \
	--repository worker-registry \
	--ref "$registry_ref" \
	--source-revision "$source_revision" \
	--source-manifest-digest "sha256:$manifest_sha" \
	--dependency "base-golang=$build_base" \
	--dependency "base-distroless=$runtime_base" \
	--registry-auth-file "$auth_file" \
	--output "$ACTOR_PRODUCT_BUILD_RECEIPT"
printf '%s\n' "$registry_ref"
