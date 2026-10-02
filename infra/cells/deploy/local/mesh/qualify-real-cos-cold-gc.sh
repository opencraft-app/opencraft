#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"
for command in cargo jq stat; do require_command "${command}"; done

profile_file=${RIVET_TENCENT_COS_GC_STORAGE_PROFILE:-}
[[ -n ${profile_file} && -f ${profile_file} ]] || \
	die "RIVET_TENCENT_COS_GC_STORAGE_PROFILE must name a dedicated qualification StorageProfile"
credential_file=${RIVET_TENCENT_COS_CREDENTIAL_FILE:-${MESH_STATE_DIR}/tencent-cos-root.env}
[[ -f ${credential_file} ]] || die "Tencent COS credential file is missing: ${credential_file}"
[[ $(stat -c '%a' "${credential_file}") == 600 ]] || die "COS credential file must have mode 0600"

profile=$(jq -ce '
  select(
    .schema == "rivet-storage-profile/v1" and
    .environment == "qualification" and
    .cold_store.kind == "s3" and
    .cold_store.object_layout == "cold/v2" and
    .cold_gc.enabled == true and
    .cold_gc.dry_run == false and
    (.cells["qualification-a"].cold_bucket |
      test("^[a-z0-9][a-z0-9.-]+[a-z0-9]$") and (contains("REPLACE") | not))
  )
' "${profile_file}") || die "invalid or non-dedicated COS GC qualification StorageProfile"
profile_id=$(jq -er '.id' <<<"${profile}")
bucket=$(jq -er '.cells["qualification-a"].cold_bucket' <<<"${profile}")
endpoint=$(jq -er '.cold_store.endpoint' <<<"${profile}")
region=$(jq -er '.region' <<<"${profile}")
addressing=$(jq -er '.cold_store.addressing_style' <<<"${profile}")
[[ ${addressing} == virtual_hosted ]] || die "Tencent COS qualification must use virtual_hosted addressing"

set -a
# shellcheck disable=SC1090
source "${credential_file}"
set +a
export RIVET_TEST_S3_ENDPOINT=${endpoint}
export RIVET_TEST_S3_REGION=${region}
export RIVET_TEST_S3_BUCKET=${bucket}
export RIVET_TEST_S3_ADDRESSING_STYLE=virtual

run_id=$(date -u +%Y%m%dT%H%M%SZ)
receipt_dir=${REAL_COS_COLD_GC_QUALIFICATION_DIR:-${MESH_STATE_DIR}/receipts/real-cos-cold-gc/${run_id}}
mkdir -p -- "${receipt_dir}"
declare -A cases=(
	[exact-delete]=s3_workflow_publishes_reclaims_and_refills_by_exact_key
	[upload-publish-response-loss]=s3_upload_and_publish_response_loss_replay_by_exact_key
	[concurrent-branch-isolation]=concurrent_s3_cold_recovery_keeps_actor_branches_isolated
)
for name in exact-delete upload-publish-response-loss concurrent-branch-isolation; do
	cargo test --manifest-path Cargo.toml -p depot --test cold_workflow_publish \
		--features test-faults "${cases[${name}]}" \
		>"${receipt_dir}/${name}.log" 2>&1
done
jq -n \
	--arg schema rivet-real-cos-cold-gc/v1 \
	--arg profile "${profile_id}" \
	--arg bucket "${bucket}" \
	'{schema:$schema,storage_profile:$profile,bucket:$bucket,verdict:"passed",exact_key_delete:true,upload_publish_response_loss:true,concurrent_branch_isolation:true,default_changed:false}' \
	>"${receipt_dir}/summary.json"
log "real Tencent COS cold GC qualification passed: ${receipt_dir}/summary.json"
