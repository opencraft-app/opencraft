#!/usr/bin/env bash

# Loads one complete local storage identity. Individual FDB/COS environment
# overrides are intentionally unsupported: changing only one half can strand
# authoritative FDB refs or bind an Engine to the wrong cold store.
require_command jq
storage_profile_file=${RIVET_LOCAL_STORAGE_PROFILE_FILE:-${MESH_DIR}/storage-profiles/local-workers.json}
[[ -f ${storage_profile_file} ]] || die "StorageProfile does not exist: ${storage_profile_file}"

storage_profile=$(jq -ce '
  . as $profile |
  (
    .schema == "rivet-storage-profile/v1" and
    (.id | type == "string" and length > 0) and
    (.environment | type == "string" and length > 0) and
    (.region | type == "string" and length > 0) and
    .cold_store.kind == "s3" and
    (.cold_store.endpoint | type == "string" and test("^https?://")) and
    (.cold_store.addressing_style == "path" or .cold_store.addressing_style == "virtual_hosted") and
    .cold_store.object_layout == "cold/v2" and
    (.cold_store.max_object_size_bytes | type == "number" and . > 0 and . <= 4194304) and
    (.cold_store.recovery_window_ms | type == "number" and . > 0) and
    (.cold_gc.enabled | type == "boolean") and
    (.cold_gc.dry_run | type == "boolean") and
    (.cold_gc.grace_period_ms | type == "number" and . >= $profile.cold_store.recovery_window_ms) and
    (.cold_gc.max_delete_concurrency | type == "number" and . >= 1 and . <= 256 and floor == .) and
    (.cold_gc.max_objects_per_batch | type == "number" and . >= 1 and . <= 100 and floor == .) and
    (.cold_gc.retry.max_attempts | type == "number" and . >= 1 and . <= 32 and floor == .) and
    (.cold_gc.retry.initial_backoff_ms | type == "number" and . >= 1) and
    (.cold_gc.retry.max_backoff_ms | type == "number" and . >= $profile.cold_gc.retry.initial_backoff_ms and . <= 300000) and
    (["local-runtime-a", "local-runtime-b"] | all(
      . as $cell |
      ($profile.cells[$cell].fdb_cluster | type == "string" and length > 0) and
      ($profile.cells[$cell].cold_bucket | type == "string" and length > 0)
    ))
  ) as $valid |
  if $valid then $profile else error("invalid StorageProfile") end
' "${storage_profile_file}" 2>/dev/null) || \
	die "invalid StorageProfile: ${storage_profile_file}"
RIVET_LOCAL_STORAGE_PROFILE_ID=$(jq -er '.id' <<<"${storage_profile}")
RIVET_LOCAL_COLD_REGION=$(jq -er '.region' <<<"${storage_profile}")
RIVET_LOCAL_COLD_ENDPOINT=$(jq -er '.cold_store.endpoint' <<<"${storage_profile}")
RIVET_LOCAL_COLD_ADDRESSING_STYLE=$(jq -er '.cold_store.addressing_style' <<<"${storage_profile}")
RIVET_LOCAL_COLD_OBJECT_LAYOUT=$(jq -er '.cold_store.object_layout' <<<"${storage_profile}")
RIVET_LOCAL_COLD_MAX_OBJECT_SIZE_BYTES=$(jq -er '.cold_store.max_object_size_bytes' <<<"${storage_profile}")
RIVET_LOCAL_COLD_RECOVERY_WINDOW_MS=$(jq -er '.cold_store.recovery_window_ms' <<<"${storage_profile}")
RIVET_LOCAL_COLD_GC_ENABLED=$(jq -r '.cold_gc.enabled' <<<"${storage_profile}")
RIVET_LOCAL_COLD_GC_GRACE_PERIOD_MS=$(jq -er '.cold_gc.grace_period_ms' <<<"${storage_profile}")
RIVET_LOCAL_COLD_GC_MAX_DELETE_CONCURRENCY=$(jq -er '.cold_gc.max_delete_concurrency' <<<"${storage_profile}")
RIVET_LOCAL_COLD_GC_MAX_OBJECTS_PER_BATCH=$(jq -er '.cold_gc.max_objects_per_batch' <<<"${storage_profile}")
RIVET_LOCAL_COLD_GC_RETRY_MAX_ATTEMPTS=$(jq -er '.cold_gc.retry.max_attempts' <<<"${storage_profile}")
RIVET_LOCAL_COLD_GC_RETRY_INITIAL_BACKOFF_MS=$(jq -er '.cold_gc.retry.initial_backoff_ms' <<<"${storage_profile}")
RIVET_LOCAL_COLD_GC_RETRY_MAX_BACKOFF_MS=$(jq -er '.cold_gc.retry.max_backoff_ms' <<<"${storage_profile}")
RIVET_LOCAL_COLD_GC_DRY_RUN=$(jq -r '.cold_gc.dry_run' <<<"${storage_profile}")
RIVET_LOCAL_FDB_CLUSTER_A=$(jq -er '.cells["local-runtime-a"].fdb_cluster' <<<"${storage_profile}")
RIVET_LOCAL_FDB_CLUSTER_B=$(jq -er '.cells["local-runtime-b"].fdb_cluster' <<<"${storage_profile}")
RIVET_LOCAL_COLD_BUCKET_A=$(jq -er '.cells["local-runtime-a"].cold_bucket' <<<"${storage_profile}")
RIVET_LOCAL_COLD_BUCKET_B=$(jq -er '.cells["local-runtime-b"].cold_bucket' <<<"${storage_profile}")

[[ ${RIVET_LOCAL_FDB_CLUSTER_A} == local-runtime-a-* ]] || \
	die "StorageProfile runtime A FDB must begin with local-runtime-a-"
RIVET_LOCAL_FDB_SUFFIX=${RIVET_LOCAL_FDB_CLUSTER_A#local-runtime-a}
[[ ${RIVET_LOCAL_FDB_CLUSTER_B} == "local-runtime-b${RIVET_LOCAL_FDB_SUFFIX}" ]] || \
	die "StorageProfile A/B FDB clusters must use the same suffix"
for bucket in "${RIVET_LOCAL_COLD_BUCKET_A}" "${RIVET_LOCAL_COLD_BUCKET_B}"; do
	[[ ${bucket} =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || \
		die "StorageProfile contains invalid S3 bucket name: ${bucket}"
done
[[ ${RIVET_LOCAL_COLD_BUCKET_A} != "${RIVET_LOCAL_COLD_BUCKET_B}" ]] || \
	die "StorageProfile A/B cold buckets must differ"

export RIVET_LOCAL_STORAGE_PROFILE_ID RIVET_LOCAL_FDB_SUFFIX
export RIVET_LOCAL_FDB_CLUSTER_A RIVET_LOCAL_FDB_CLUSTER_B
export RIVET_LOCAL_COLD_BUCKET_A RIVET_LOCAL_COLD_BUCKET_B
export RIVET_LOCAL_COLD_REGION RIVET_LOCAL_COLD_ENDPOINT RIVET_LOCAL_COLD_ADDRESSING_STYLE
export RIVET_LOCAL_COLD_OBJECT_LAYOUT RIVET_LOCAL_COLD_MAX_OBJECT_SIZE_BYTES
export RIVET_LOCAL_COLD_RECOVERY_WINDOW_MS
export RIVET_LOCAL_COLD_GC_ENABLED RIVET_LOCAL_COLD_GC_GRACE_PERIOD_MS
export RIVET_LOCAL_COLD_GC_MAX_DELETE_CONCURRENCY RIVET_LOCAL_COLD_GC_MAX_OBJECTS_PER_BATCH
export RIVET_LOCAL_COLD_GC_RETRY_MAX_ATTEMPTS RIVET_LOCAL_COLD_GC_RETRY_INITIAL_BACKOFF_MS
export RIVET_LOCAL_COLD_GC_RETRY_MAX_BACKOFF_MS RIVET_LOCAL_COLD_GC_DRY_RUN
