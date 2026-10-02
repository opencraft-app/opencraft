#!/usr/bin/env bash
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Re-attest immutable workerd/FDB stage artifacts from a digest-pinned Runtime
# when every source input that can affect those artifacts is byte-for-byte and
# mode-for-mode identical. This avoids rebuilding V8 for Engine-only releases.
source_dir=${RIVET_SOURCE_DIR:?RIVET_SOURCE_DIR is required}
base_source_dir=${RIVET_BASE_SOURCE_DIR:?RIVET_BASE_SOURCE_DIR is required}
stage_dir=${RIVET_STAGE_DIR:?RIVET_STAGE_DIR is required}
stage_receipt=${RIVET_STAGE_RECEIPT:?RIVET_STAGE_RECEIPT is required}
base_runtime=${RIVET_BASE_RUNTIME_IMAGE:?RIVET_BASE_RUNTIME_IMAGE is required}
auth_file=${REGISTRY_AUTH_FILE:-}

[[ $source_dir == /* && $base_source_dir == /* && $stage_dir == /* && $stage_receipt == /* ]] || {
	echo "runtime stage reuse paths must be absolute" >&2
	exit 2
}
[[ $base_runtime =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
	echo "base Runtime must be pinned by sha256 digest" >&2
	exit 2
}
[[ -d $source_dir && -d $base_source_dir && -d $stage_dir && ! -e $stage_receipt ]] || {
	echo "runtime stage reuse inputs or new receipt path are invalid" >&2
	exit 2
}
[[ -z $(find "$stage_dir" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
	echo "runtime stage reuse target must be empty" >&2
	exit 2
}
for command in buildah cargo jq python3 readelf sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
base_source_dir=$(CDPATH= cd -- "$base_source_dir" && pwd)
source_revision=$(tr -d '[:space:]' <"$source_dir/.actor-source/SOURCE_REVISION")
base_revision=$(tr -d '[:space:]' <"$base_source_dir/.actor-source/SOURCE_REVISION")
source_manifest="$source_dir/.actor-source/RELEASE_SHA256SUMS"
base_manifest="$base_source_dir/.actor-source/RELEASE_SHA256SUMS"
source_manifest_sha=$(sha256sum "$source_manifest" | cut -d' ' -f1)
base_manifest_sha=$(sha256sum "$base_manifest" | cut -d' ' -f1)
[[ $source_revision =~ ^[0-9a-f]{40}$ && $base_revision =~ ^[0-9a-f]{40}$ ]]
(cd "$source_dir" && sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null)
(cd "$base_source_dir" && sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null)

stage_inputs=(
	# These are the complete content-defining inputs to prepare-stage.sh's four
	# artifacts, plus the local Rust closure resolved below. The stage
	# orchestration and source-bundle verifier are excluded:
	# they can change cache layout or validation without changing output bytes.
	# workerd's actual compiler recipe lives inside the content-addressed source
	# bundle, while the exact Zig/Bazel and FDB identities are locked here.
	# runtimes/workerd/host is compiled later by build-image.sh and must not
	# force a multi-hour V8 rebuild when only the Rust Host changes.
	infra/cells/deploy/tencent/fleet/runtime/toolchains.lock.json
	infra/cells/deploy/tencent/init-workerd-pool.sh
	infra/cells/deploy/tencent/fleet/runtime/runtime-stage.lock.json
	runtimes/workerd/workerd-fdb.bundle
	runtimes/workerd/workerd-fdb.lock
	runtimes/workerd/host/workerd/config-depot.capnp
)
stage_inputs_digest=$(python3 "$script_dir/verify-stage-reuse-inputs.py" \
	"$base_source_dir" "$source_dir" "${stage_inputs[@]}")
[[ $stage_inputs_digest =~ ^[0-9a-f]{64}$ ]]

from_args=()
if [[ -n $auth_file ]]; then
	[[ -f $auth_file ]] || { echo "registry auth file is missing" >&2; exit 1; }
	from_args+=(--authfile "$auth_file")
fi
container=$(buildah from "${from_args[@]}" "$base_runtime")
mounted=
cleanup() {
	[[ -z $mounted ]] || buildah unmount "$container" >/dev/null 2>&1 || true
	buildah rm "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
inspect=$(buildah inspect "$container")
label() {
	jq -er --arg key "$1" '.Docker.config.Labels[$key] // empty' <<<"$inspect"
}
[[ $(label fleet.actor.dev/source-revision) == "$base_revision" ]]
[[ $(label fleet.actor.dev/source-manifest-sha256) == "$base_manifest_sha" ]]
mounted=$(buildah mount "$container")
[[ $(sha256sum "$mounted/opt/actor/bin/workerd" | cut -d' ' -f1) == "$(label fleet.actor.dev/workerd-sha256)" ]]
install -m 0755 "$mounted/opt/actor/bin/workerd" "$stage_dir/workerd"
install -m 0755 "$mounted/opt/actor/bin/init-workerd-pool" "$stage_dir/init-workerd-pool"
install -m 0644 "$mounted/opt/actor/share/config-depot.capnp" "$stage_dir/config-depot.capnp"
install -m 0755 "$mounted/usr/local/lib/libfdb_c.so" "$stage_dir/libfdb_c.so"
buildah unmount "$container" >/dev/null
mounted=
buildah rm "$container" >/dev/null
trap - EXIT INT TERM

if readelf -l "$stage_dir/workerd" | grep -q INTERP || readelf -d "$stage_dir/workerd" 2>/dev/null | grep -q '(NEEDED)'; then
	echo "reused workerd is not static" >&2
	exit 1
fi
(cd "$stage_dir" && sha256sum workerd init-workerd-pool config-depot.capnp libfdb_c.so >STAGE_SHA256SUMS)
workerd_commit=$(awk -F'"' '$1 ~ /^fork_commit/ { print $2 }' "$source_dir/runtimes/workerd/workerd-fdb.lock")
fdb_digest=$(jq -er '.foundationdbClient.sha256 | select(test("^[0-9a-f]{64}$"))' \
	"$source_dir/infra/cells/deploy/tencent/fleet/runtime/runtime-stage.lock.json")
artifacts_digest=$(sha256sum "$stage_dir/STAGE_SHA256SUMS" | cut -d' ' -f1)

receipt_staged=$(mktemp "$(dirname -- "$stage_receipt")/.runtime-stage-reuse.XXXXXX")
cleanup_receipt() { rm -f -- "$receipt_staged"; }
trap cleanup_receipt EXIT
jq -n \
	--arg source_revision "$source_revision" \
	--arg source_manifest "sha256:$source_manifest_sha" \
	--arg workerd_commit "$workerd_commit" \
	--arg fdb_digest "sha256:$fdb_digest" \
	--arg artifacts "sha256:$artifacts_digest" \
	--arg base_runtime "$base_runtime" \
	--arg base_revision "$base_revision" \
	--arg base_manifest "sha256:$base_manifest_sha" \
	--arg stage_inputs "sha256:$stage_inputs_digest" \
	'{schema:"actor-runtime-stage/v1",verdict:"passed",mode:"verified-base-runtime-reuse",
	  sourceRevision:$source_revision,sourceManifestDigest:$source_manifest,
	  workerdCommit:$workerd_commit,foundationdbClientDigest:$fdb_digest,
	  toolchainReceiptDigest:null,buildJobs:0,artifactsDigest:$artifacts,
	  reuse:{baseRuntimeImage:$base_runtime,baseSourceRevision:$base_revision,
	    baseSourceManifestDigest:$base_manifest,stageInputsDigest:$stage_inputs}}' >"$receipt_staged"
ln "$receipt_staged" "$stage_receipt"
rm -f -- "$receipt_staged"
trap - EXIT
printf 'runtime_stage_reuse=passed base_revision=%s source_revision=%s stage_inputs_sha256=%s receipt=%s\n' \
	"$base_revision" "$source_revision" "$stage_inputs_digest" "$stage_receipt"
