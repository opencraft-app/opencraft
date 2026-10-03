#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
product_python=${ACTOR_BUILD_PYTHON:-python3}
command -v "$product_python" >/dev/null || { echo "product receipt Python is unavailable: $product_python" >&2; exit 2; }
"$product_python" -c 'import sys; assert sys.version_info >= (3, 8)'

export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}
[[ $TMPDIR == /* ]] || { echo "TMPDIR must be absolute" >&2; exit 2; }
if [[ ! -e $TMPDIR ]]; then install -d -m 1777 "$TMPDIR"; fi
[[ -d $TMPDIR && -w $TMPDIR ]] || { echo "TMPDIR is not writable: $TMPDIR" >&2; exit 2; }

source_dir=${RIVET_SOURCE_DIR:?RIVET_SOURCE_DIR must name the reviewed Rivet source tree}
stage_dir=${RIVET_STAGE_DIR:?RIVET_STAGE_DIR must name the runtime image staging directory}
image_tag=${RIVET_RUNTIME_IMAGE_TAG:?RIVET_RUNTIME_IMAGE_TAG must be an immutable release tag}
runtime_config=${RIVET_RUNTIME_CONFIG_FILE:?RIVET_RUNTIME_CONFIG_FILE must name the rendered production config}
base_image=${RIVET_RUNTIME_BASE_IMAGE:?RIVET_RUNTIME_BASE_IMAGE must name the mirrored runtime OS base by digest}
[[ $base_image =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
	echo "runtime OS base must be pinned by sha256 digest" >&2
	exit 2
}
stage_receipt=${RIVET_STAGE_RECEIPT:?RIVET_STAGE_RECEIPT must name the immutable stage receipt}
auth_file=${REGISTRY_AUTH_FILE:-}
source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
source_revision=${RIVET_SOURCE_REVISION:-}
source_manifest=${RIVET_SOURCE_MANIFEST_FILE:-}
[[ -n $source_revision || ! -s $source_dir/.actor-source/SOURCE_REVISION ]] || source_revision=$(tr -d '[:space:]' <"$source_dir/.actor-source/SOURCE_REVISION")
[[ -n $source_manifest || ! -s $source_dir/.actor-source/RELEASE_SHA256SUMS ]] || source_manifest="$source_dir/.actor-source/RELEASE_SHA256SUMS"
[[ -n $source_manifest ]] || { echo "reviewed source manifest is unavailable" >&2; exit 2; }
runtime_config=$(CDPATH= cd -- "$(dirname -- "$runtime_config")" && pwd)/$(basename -- "$runtime_config")
source_manifest=$(CDPATH= cd -- "$(dirname -- "$source_manifest")" && pwd)/$(basename -- "$source_manifest")
cargo_target_dir=${RIVET_CARGO_TARGET_DIR:-/data/build-cache/rivet-runtime-cargo-target}
[[ $cargo_target_dir == /* ]] || { echo "RIVET_CARGO_TARGET_DIR must be absolute" >&2; exit 2; }
install -d -m 0755 "$cargo_target_dir"
cargo_target_dir=$(CDPATH= cd -- "$cargo_target_dir" && pwd)
case "$cargo_target_dir/" in
"$source_dir"/*)
	echo "Cargo target directory must be outside the immutable source tree" >&2
	exit 2
	;;
esac
export CARGO_TARGET_DIR=$cargo_target_dir

# RivetError's proc macro emits an error catalogue while compiling.  Its
# historical default is below the workspace source tree, which is deliberately
# a read-only bind mount on the production builder.  Keep all compiler output,
# including this catalogue, inside the bounded Cargo target instead of
# weakening the reviewed-source boundary.
export RIVET_ERROR_OUTPUT_DIR="$cargo_target_dir/rivet-error-docs"
install -d -m 0755 "$RIVET_ERROR_OUTPUT_DIR"

[[ $image_tag != *@* && $image_tag == *:* ]] || {
	echo "RIVET_RUNTIME_IMAGE_TAG must be a tagged image, not a digest" >&2
	exit 2
}
[[ $source_revision =~ ^[0-9a-f]{40}$ ]] || {
	echo "RIVET_SOURCE_REVISION or .actor-source/SOURCE_REVISION must be a full commit ID" >&2
	exit 2
}
for command in cargo buildah findmnt getconf install jq sha256sum; do
	command -v "$command" >/dev/null 2>&1 || {
		echo "required command not found: $command" >&2
		exit 1
	}
done

# Paths alone do not establish disk isolation. Check the actual Buildah store
# and every large writable output before pulling an image or compiling.
graph_root=$(buildah info | jq -er '.store.GraphRoot | select(type == "string" and startswith("/"))')
"$product_python" "$script_dir/verify-builder-storage.py" \
	--bulk-path /data --bulk-path /var/lib/actor-build --bulk-path "$graph_root" \
	--bulk-path "$stage_dir" --bulk-path "$cargo_target_dir" --bulk-path "$TMPDIR"

# Engine and Host dynamically link glibc (and Engine loads libfdb_c.so). Build
# them only on the same libc ABI as the digest-pinned runtime base. Without
# this early gate a newer workstation can spend minutes in fat LTO and produce
# an ELF that only fails when the final container self-check starts.
base_from_args=()
if [[ -n $auth_file ]]; then
	[[ -f $auth_file ]] || { echo "registry auth file is missing: $auth_file" >&2; exit 1; }
	base_from_args+=(--authfile "$auth_file")
fi
base_abi_container=$(buildah from "${base_from_args[@]}" "$base_image")
cleanup_base_abi() {
	buildah rm "$base_abi_container" >/dev/null 2>&1 || true
}
trap cleanup_base_abi EXIT
builder_glibc=$(getconf GNU_LIBC_VERSION)
runtime_glibc=$(buildah run "$base_abi_container" -- getconf GNU_LIBC_VERSION)
[[ $builder_glibc =~ ^glibc\ [0-9]+\.[0-9]+$ && $runtime_glibc =~ ^glibc\ [0-9]+\.[0-9]+$ ]] || {
	echo "unable to determine builder/runtime glibc ABI" >&2
	exit 1
}
[[ $builder_glibc == "$runtime_glibc" ]] || {
	echo "builder glibc ABI ($builder_glibc) differs from runtime base ($runtime_glibc)" >&2
	exit 1
}
cleanup_base_abi
trap - EXIT

[[ -s $runtime_config ]] || {
	echo "rendered production config is missing or empty: $runtime_config" >&2
	exit 1
}
[[ -f $stage_receipt ]] || { echo "runtime stage receipt is missing: $stage_receipt" >&2; exit 1; }
[[ -s $source_manifest ]] || {
	echo "reviewed source manifest is missing or empty: $source_manifest" >&2
	exit 1
}
[[ -f $source_dir/infra/cells/deploy/tencent/fleet/runtime/Dockerfile ]] || {
	echo "runtime Dockerfile is missing from reviewed source: $source_dir" >&2
	exit 1
}
install -m 0644 "$source_dir/infra/cells/deploy/tencent/fleet/runtime/Dockerfile" "$stage_dir/Dockerfile"
for artifact in Dockerfile workerd init-workerd-pool config-depot.capnp libfdb_c.so STAGE_SHA256SUMS; do
	[[ -f $stage_dir/$artifact ]] || {
		echo "staging artifact is missing: $stage_dir/$artifact" >&2
		exit 1
	}
done
stage_artifacts_digest=$(sha256sum "$stage_dir/STAGE_SHA256SUMS" | cut -d' ' -f1)
jq -e --arg revision "$source_revision" \
	--arg manifest "sha256:$(sha256sum "$source_manifest" | cut -d' ' -f1)" \
	--arg artifacts "sha256:$stage_artifacts_digest" \
	'.schema == "actor-runtime-stage/v1" and .verdict == "passed" and .sourceRevision == $revision and .sourceManifestDigest == $manifest and .artifactsDigest == $artifacts' \
	"$stage_receipt" >/dev/null || { echo "runtime stage receipt does not bind these artifacts and source" >&2; exit 1; }
install -m 0644 "$stage_receipt" "$stage_dir/runtime-stage-receipt.json"

export LIBRARY_PATH="$stage_dir${LIBRARY_PATH:+:$LIBRARY_PATH}"
export LD_LIBRARY_PATH="$stage_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cd "$source_dir"
sha256sum --check "$source_manifest" >/dev/null
cargo build --locked --release -p rivet-engine --features foundationdb
cargo build --locked --release -p rivet-workerd-host

# Run the Host against the exact staged workerd, not merely against mocked
# transports. These process tests exercise immutable Worker loading, stateless
# dispatch and the capability-bound Durable Object wrapper before the digest
# can enter the runtime image inventory.
env -u WORKERD_DEPOT_BIN WORKERD_BIN="$stage_dir/workerd" \
	cargo test --locked --release -p rivet-workerd-host --test workerd_process

install -m 0755 "$CARGO_TARGET_DIR/release/rivet-engine" "$stage_dir/rivet-engine"
install -m 0755 "$CARGO_TARGET_DIR/release/rivet-workerd-host" "$stage_dir/rivet-workerd-host"
install -m 0644 runtimes/workerd/host/workerd/worker.js "$stage_dir/worker.js"
install -m 0644 runtimes/workerd/host/workerd/stateless-worker.js "$stage_dir/stateless-worker.js"
install -m 0644 runtimes/workerd/host/workerd/config-stateless.capnp "$stage_dir/config-stateless.capnp"
printf '%s\n' "$source_revision" >"$stage_dir/source-revision"
sha256sum "$source_manifest" | cut -d' ' -f1 >"$stage_dir/source-manifest-sha256"

# Exercise the exact staged workerd binary against the WorkerLoader methods used by the
# trusted Host. A source revision or OCI label cannot detect a stale binary copied into staging.
"$stage_dir/workerd" test \
	--experimental \
	--no-verbose \
	--compat-date=2026-08-14 \
	runtimes/workerd/host/workerd/worker-loader-abi-test.wd-test

# This is the cheapest release-compatibility gate: the exact freshly built
# Engine must deserialize and validate the exact config that will be applied.
"$stage_dir/rivet-engine" --config "$runtime_config" config show >/dev/null

cd "$stage_dir"
engine_sha=$(sha256sum rivet-engine | cut -d' ' -f1)
host_sha=$(sha256sum rivet-workerd-host | cut -d' ' -f1)
workerd_sha=$(sha256sum workerd | cut -d' ' -f1)
worker_js_sha=$(sha256sum worker.js | cut -d' ' -f1)
stateless_worker_js_sha=$(sha256sum stateless-worker.js | cut -d' ' -f1)
stage_receipt_sha=$(sha256sum runtime-stage-receipt.json | cut -d' ' -f1)
sha256sum rivet-engine rivet-workerd-host workerd worker.js stateless-worker.js \
	config-depot.capnp config-stateless.capnp source-revision \
	source-manifest-sha256 libfdb_c.so STAGE_SHA256SUMS runtime-stage-receipt.json \
	init-workerd-pool >SHA256SUMS

buildah bud \
	--build-arg "RUNTIME_BASE_IMAGE=$base_image" \
	--label "fleet.actor.dev/runtime-base-image=$base_image" \
	--label "org.opencontainers.image.revision=$source_revision" \
	--label "fleet.actor.dev/source-revision=$source_revision" \
	--label "fleet.actor.dev/source-manifest-sha256=$(cat source-manifest-sha256)" \
	--label "fleet.actor.dev/engine-sha256=$engine_sha" \
	--label "fleet.actor.dev/workerd-host-sha256=$host_sha" \
	--label "fleet.actor.dev/workerd-sha256=$workerd_sha" \
	--label "fleet.actor.dev/worker-js-sha256=$worker_js_sha" \
	--label "fleet.actor.dev/stateless-worker-js-sha256=$stateless_worker_js_sha" \
	--label "fleet.actor.dev/runtime-stage-receipt-sha256=$stage_receipt_sha" \
	-t "$image_tag" .

validation_container=$(buildah from "$image_tag")
cleanup_validation() {
	buildah rm "$validation_container" >/dev/null 2>&1 || true
}
trap cleanup_validation EXIT
buildah copy --chown 4059:4059 "$validation_container" "$runtime_config" /tmp/production-config.jsonc >/dev/null
buildah run "$validation_container" -- /bin/sh -eu -c \
	'test "$(cat /opt/actor/share/source-revision)" = "$1"' sh "$source_revision"
buildah run "$validation_container" -- /bin/sh -eu -c \
	'test "$(cat /opt/actor/share/source-manifest-sha256)" = "$1"' sh "$(cat source-manifest-sha256)"
buildah run "$validation_container" -- /opt/actor/bin/rivet-engine \
	--config /tmp/production-config.jsonc config show >/dev/null
cleanup_validation
trap - EXIT

if [[ ${RIVET_PUSH_IMAGE:-1} == 1 ]]; then
	[[ -n $auth_file && -f $auth_file ]] || {
		echo "REGISTRY_AUTH_FILE must name a temporary protected auth file when pushing" >&2
		exit 1
	}
	digest_file=$(mktemp)
	cleanup() {
		rm -f -- "$digest_file"
	}
	trap cleanup EXIT
	buildah push --authfile "$auth_file" --digestfile "$digest_file" "$image_tag" "docker://$image_tag"
	digest=$(tr -d '[:space:]' <"$digest_file")
	[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || {
		echo "registry returned an invalid digest: $digest" >&2
		exit 1
	}
	image_repository=${image_tag%:*}
	registry_ref="$image_repository@$digest"
	: "${ACTOR_PRODUCT_BUILD_RECEIPT:?ACTOR_PRODUCT_BUILD_RECEIPT is required when pushing}"
	"$product_python" "$script_dir/../gitops/image-seed/record-product-image.py" \
		--repository rivet-runtime \
		--ref "$registry_ref" \
		--source-revision "$source_revision" \
		--source-manifest-digest "sha256:$(cat source-manifest-sha256)" \
		--dependency "runtime-base=$base_image" \
		--registry-auth-file "$auth_file" \
		--output "$ACTOR_PRODUCT_BUILD_RECEIPT"
	printf '%s\n' "$registry_ref"
else
	printf '%s\n' "$image_tag"
fi

cat SHA256SUMS
