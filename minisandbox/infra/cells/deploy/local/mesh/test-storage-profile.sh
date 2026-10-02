#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

profile=${MESH_DIR}/storage-profiles/local-workers.json
temporary=$(mktemp -d)
cleanup() { rm -rf -- "${temporary}"; }
trap cleanup EXIT

# shellcheck source=storage-profile.sh
source "${MESH_DIR}/storage-profile.sh"
[[ ${RIVET_LOCAL_STORAGE_PROFILE_ID} == local-workers-v1 ]]
[[ ${RIVET_LOCAL_FDB_SUFFIX} == -storage-v1 ]]
[[ ${RIVET_LOCAL_COLD_BUCKET_A} == local-runtime-a-cold-v1 ]]
[[ ${RIVET_LOCAL_COLD_OBJECT_LAYOUT} == cold/v2 ]]
[[ ${RIVET_LOCAL_COLD_GC_ENABLED} == false ]]
[[ ${RIVET_LOCAL_COLD_GC_DRY_RUN} == true ]]
[[ ${RIVET_LOCAL_COLD_GC_MAX_OBJECTS_PER_BATCH} == 100 ]]

(
	unset RIVET_LOCAL_STORAGE_PROFILE_ID RIVET_LOCAL_STORAGE_CONTEXT
	# shellcheck source=storage-context.sh
	source "${MESH_DIR}/storage-context.sh"
	[[ ${RIVET_LOCAL_STORAGE_CONTEXT} == profile ]]
	[[ ${RIVET_LOCAL_STORAGE_PROFILE_ID} == local-workers-v1 ]]
	[[ ${RIVET_LOCAL_COLD_MAX_OBJECT_SIZE_BYTES} == 4194304 ]]
) || die "default storage context did not load the canonical StorageProfile"

reject_context() {
	local name=$1 context=$2 identity=${3:-}
	if (
		export RIVET_LOCAL_STORAGE_CONTEXT=${context}
		export RIVET_LOCAL_STORAGE_PROFILE_ID=${identity}
		# shellcheck source=storage-context.sh
		source "${MESH_DIR}/storage-context.sh"
	) >/dev/null 2>&1; then
		die "invalid storage context was accepted: ${name}"
	fi
}

reject_context unknown-mode legacy local-workers-v1
reject_context anonymous-qualification qualification
reject_context product-as-qualification qualification local-workers-v1
(
	export RIVET_LOCAL_STORAGE_CONTEXT=qualification
	export RIVET_LOCAL_STORAGE_PROFILE_ID=local-cold-gc-qualification
	# shellcheck source=storage-context.sh
	source "${MESH_DIR}/storage-context.sh"
	[[ ${RIVET_LOCAL_STORAGE_CONTEXT} == qualification ]]
) || die "explicit qualification storage context was rejected"

reject_profile() {
	local name=$1 filter=$2 candidate
	candidate=${temporary}/${name}.json
	jq "${filter}" "${profile}" >"${candidate}"
	if (
		export RIVET_LOCAL_STORAGE_PROFILE_FILE=${candidate}
		# shellcheck source=storage-profile.sh
		source "${MESH_DIR}/storage-profile.sh"
	) >/dev/null 2>&1; then
		die "invalid StorageProfile was accepted: ${name}"
	fi
}

reject_profile split-fdb '.cells["local-runtime-b"].fdb_cluster = "local-runtime-b-other"'
reject_profile shared-bucket '.cells["local-runtime-b"].cold_bucket = .cells["local-runtime-a"].cold_bucket'
reject_profile wrong-layout '.cold_store.object_layout = "cold/v3"'
reject_profile oversized-object '.cold_store.max_object_size_bytes = 8388608'
reject_profile grace-shorter-than-recovery '.cold_gc.grace_period_ms = 1000'
reject_profile unbounded-delete-concurrency '.cold_gc.max_delete_concurrency = 0'
reject_profile oversized-delete-batch '.cold_gc.max_objects_per_batch = 101'
reject_profile inverted-delete-backoff '.cold_gc.retry.initial_backoff_ms = 2000 | .cold_gc.retry.max_backoff_ms = 1000'

staged=${temporary}/enabled-dry-run.json
jq '.cold_gc.enabled = true | .cold_gc.dry_run = true' "${profile}" >"${staged}"
(
	export RIVET_LOCAL_STORAGE_PROFILE_FILE=${staged}
	# shellcheck source=storage-profile.sh
	source "${MESH_DIR}/storage-profile.sh"
	[[ ${RIVET_LOCAL_COLD_GC_ENABLED} == true ]]
	[[ ${RIVET_LOCAL_COLD_GC_DRY_RUN} == true ]]
) || die "enabled dry-run StorageProfile was rejected"

log "StorageProfile accepted the canonical identity and rejected partial-path mutations"
