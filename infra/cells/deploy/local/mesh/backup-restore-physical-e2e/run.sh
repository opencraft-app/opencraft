#!/usr/bin/env bash
set -euo pipefail

E2E_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${E2E_DIR}/.." && pwd)
PHYSICAL_E2E_DIR=${MESH_DIR}/cold-gc-physical-e2e
# shellcheck source=../lib.sh
source "${MESH_DIR}/lib.sh"

for command in curl docker flock jq k3d kubectl python3 stat; do require_command "${command}"; done
cluster_exists "${RUNTIME_A_CLUSTER}" || die "cluster ${RUNTIME_A_CLUSTER} is missing"
cluster_exists "${HUB_CLUSTER}" || die "cluster ${HUB_CLUSTER} is missing"

mkdir -p -- "${MESH_STATE_DIR}/locks"
exec 9>"${MESH_STATE_DIR}/locks/cold-gc-physical-e2e.lock"
flock -n 9 || die "another cold-storage physical qualification is already running"

run_id=$(date -u +%Y%m%dT%H%M%SZ)
run_token=$(date -u +%m%d%H%M%S)
cell="brq-$(date -u +%H%M%S)"
source_suffix="-backup-src-${run_token}"
restore_suffix="-backup-dst-${run_token}"
source_fdb="local-runtime-a${source_suffix}"
restore_fdb="local-runtime-a${restore_suffix}"
storage_profile_id=local-backup-restore-qualification
endpoint_kind=local-s3-double
bucket=local-backup-restore-qualification
cold_endpoint="http://k3d-${HUB_CLUSTER}-server-0:30082"
cold_region=local
cold_addressing=path
cold_recovery_window_ms=86400000
cold_gc_grace_period_ms=1
qualification_gc_grace_period_ms=1
cold_gc_max_delete_concurrency=1
cold_gc_max_objects_per_batch=10
cold_gc_retry_max_attempts=3
cold_gc_retry_initial_backoff_ms=10
cold_gc_retry_max_backoff_ms=100
inventory_args=(--addressing-style path --auth anonymous --region local)
credential_file=
real_cos=false
if [[ -n ${RIVET_BACKUP_RESTORE_STORAGE_PROFILE:-} ]]; then
	profile_file=${RIVET_BACKUP_RESTORE_STORAGE_PROFILE}
	[[ -f ${profile_file} ]] || die "backup/restore StorageProfile does not exist: ${profile_file}"
	profile=$(jq -ce '
    . as $profile |
    select(
      .schema == "rivet-storage-profile/v1" and
      (.id | type == "string" and test("backup-restore.*qualification")) and
      .environment == "qualification" and
      .region == "ap-beijing" and
      .cold_store.kind == "s3" and
      .cold_store.endpoint == "https://cos.ap-beijing.myqcloud.com" and
      .cold_store.addressing_style == "virtual_hosted" and
      .cold_store.object_layout == "cold/v2" and
      (.cold_store.max_object_size_bytes == 4194304) and
      (.cold_store.recovery_window_ms | type == "number" and
        . >= 86400000 and . <= 31536000000) and
      .cold_gc.enabled == true and .cold_gc.dry_run == false and
      (.cold_gc.grace_period_ms | type == "number") and
      ($profile.cold_gc.grace_period_ms >= $profile.cold_store.recovery_window_ms) and
      (.cold_gc.max_delete_concurrency | type == "number" and
        floor == . and . >= 1 and . <= 256) and
      (.cold_gc.max_objects_per_batch | type == "number" and
        floor == . and . >= 1 and . <= 100) and
      (.cold_gc.retry.max_attempts | type == "number" and
        floor == . and . >= 1 and . <= 32) and
      (.cold_gc.retry.initial_backoff_ms | type == "number" and . >= 1) and
      (.cold_gc.retry.max_backoff_ms | type == "number" and
        . >= $profile.cold_gc.retry.initial_backoff_ms and . <= 300000) and
      (.cells["qualification-a"].cold_bucket |
        test("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$") and
        contains("backup-restore") and contains("qualification"))
    )
  ' "${profile_file}") || die "invalid Beijing backup/restore qualification StorageProfile"
	storage_profile_id=$(jq -er '.id' <<<"${profile}")
	bucket=$(jq -er '.cells["qualification-a"].cold_bucket' <<<"${profile}")
	cold_endpoint=$(jq -er '.cold_store.endpoint' <<<"${profile}")
	cold_region=$(jq -er '.region' <<<"${profile}")
	cold_addressing=$(jq -er '.cold_store.addressing_style' <<<"${profile}")
	cold_recovery_window_ms=$(jq -er '.cold_store.recovery_window_ms' <<<"${profile}")
	cold_gc_grace_period_ms=$(jq -er '.cold_gc.grace_period_ms' <<<"${profile}")
	cold_gc_max_delete_concurrency=$(jq -er '.cold_gc.max_delete_concurrency' <<<"${profile}")
	cold_gc_max_objects_per_batch=$(jq -er '.cold_gc.max_objects_per_batch' <<<"${profile}")
	cold_gc_retry_max_attempts=$(jq -er '.cold_gc.retry.max_attempts' <<<"${profile}")
	cold_gc_retry_initial_backoff_ms=$(jq -er '.cold_gc.retry.initial_backoff_ms' <<<"${profile}")
	cold_gc_retry_max_backoff_ms=$(jq -er '.cold_gc.retry.max_backoff_ms' <<<"${profile}")
	credential_file=${RIVET_TENCENT_COS_CREDENTIAL_FILE:-${MESH_STATE_DIR}/tencent-cos-root.env}
	[[ -f ${credential_file} ]] || die "Tencent COS credential file is missing: ${credential_file}"
	[[ $(stat -c '%a' "${credential_file}") == 600 ]] || die "COS credential file must have mode 0600"
	endpoint_kind=tencent-cos
	inventory_args=(--addressing-style virtual --auth sigv4 --region "${cold_region}")
	real_cos=true
fi
backup_pvc="${cell}-fdbbackup"
backup_tag="backup-${run_token}"
backup_base=file:///var/lib/actor-runtime/fdbbackup/catalog
backup_url="${backup_base}/${backup_tag}"
receipt_dir=${LOCAL_BACKUP_RESTORE_PHYSICAL_DIR:-${MESH_STATE_DIR}/receipts/backup-restore-physical/${run_id}}
image_file=${receipt_dir}/qualification-image
temporary=$(mktemp -d)
source_normal=${temporary}/source-normal.yaml
source_selected=${temporary}/source-selected.yaml
source_rendered=${temporary}/source.yaml
restore_normal=${temporary}/restore-normal.yaml
restore_selected=${temporary}/restore-selected.yaml
restore_rendered=${temporary}/restore.yaml
restore_tools=${temporary}/restore-tools.yaml
baseline=${receipt_dir}/bucket-baseline.json
mkdir -p -- "${receipt_dir}"

pod=
forward_pid=
s3_endpoint=
cleanup_fdb() {
	local cluster=$1
	kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system delete foundationdbcluster \
		"${cluster}" --ignore-not-found --wait=false >/dev/null 2>&1
	kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system delete pvc \
		-l "foundationdb.org/fdb-cluster-name=${cluster}" --ignore-not-found --wait=false \
		>/dev/null 2>&1
}
cleanup() {
	local status=$?
	set +e
	if [[ -n ${s3_endpoint} && -s ${baseline} ]]; then
		python3 "${PHYSICAL_E2E_DIR}/s3_inventory.py" delete-delta \
			--endpoint "${s3_endpoint}" --bucket "${bucket}" --baseline "${baseline}" \
			"${inventory_args[@]}" \
			>"${receipt_dir}/cleanup-objects.json" 2>"${receipt_dir}/cleanup-objects.log"
	fi
	if [[ -n ${forward_pid} ]]; then
		kill "${forward_pid}" >/dev/null 2>&1
		wait "${forward_pid}" >/dev/null 2>&1
	fi
	kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system delete pod \
		"${cell}-restore-tools" --ignore-not-found --wait=false >/dev/null 2>&1
	for manifest in "${restore_rendered}" "${source_rendered}"; do
		if [[ -s ${manifest} ]]; then
			kubectl_for "${RUNTIME_A_KUBECONFIG}" delete -f "${manifest}" \
				--ignore-not-found --wait=false >/dev/null 2>&1
		fi
	done
	kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system delete secret \
		"${cell}-runtime-auth" "${cell}-runtime-cos" --ignore-not-found >/dev/null 2>&1
	cleanup_fdb "${source_fdb}"
	cleanup_fdb "${restore_fdb}"
	rm -rf -- "${temporary}"
	exit "${status}"
}
trap cleanup EXIT

render_engine() {
	local fdb_cluster=$1 normal=$2 selected=$3 output=$4
	RIVET_LOCAL_COS_BUCKET=${bucket} \
		RIVET_LOCAL_COLD_ENDPOINT=${cold_endpoint} \
		RIVET_LOCAL_COLD_REGION=${cold_region} RIVET_LOCAL_COLD_ADDRESSING_STYLE=${cold_addressing} \
		RIVET_LOCAL_COLD_RECOVERY_WINDOW_MS=${cold_recovery_window_ms} \
		RIVET_LOCAL_FDB_CLUSTER=${fdb_cluster} \
		python3 "${MESH_DIR}/real/render-runtime.py" \
			"${CELLS_DIR}/deploy/tencent/fleet/runtime/runtime.yaml" \
			"${CELLS_DIR}/deploy/tencent/fleet/runtime/nats.yaml" \
			local-runtime-a "${runtime_image}" ignored "${normal}"
	python3 "${PHYSICAL_E2E_DIR}/render.py" \
		"${normal}" "${cell}" "${fdb_cluster}" "${selected}"
	python3 "${E2E_DIR}/render.py" engine \
		"${selected}" "${cell}" "${backup_pvc}" "${backup_url}" "${output}"
}

log "building Engine image with pinned real fdbbackup"
RIVET_LOCAL_RUNTIME_ENGINE_FEATURES='rivet-engine/foundationdb,rivet-engine/test-faults' \
	RIVET_LOCAL_RUNTIME_IMAGE_FILE="${image_file}" \
	"${MESH_DIR}/build-real-runtime-image.sh" >"${receipt_dir}/build.log" 2>&1
runtime_image=$(<"${image_file}")

log "starting isolated ${endpoint_kind} bucket and source FDB cluster"
if [[ ${real_cos} == false ]]; then
	RIVET_LOCAL_COLD_QUALIFICATION_BUCKET=${bucket} \
		"${CELLS_DIR}/deploy/local/runtime-cold-tier/up.sh" \
		>"${receipt_dir}/cold-tier-up.log" 2>&1
fi
RIVET_LOCAL_STORAGE_CONTEXT=qualification \
	RIVET_LOCAL_STORAGE_PROFILE_ID=${storage_profile_id} \
	RIVET_LOCAL_FDB_SUFFIX=${source_suffix} RIVET_LOCAL_FDB_TARGETS=runtime-a \
	"${MESH_DIR}/install-real-fdb.sh" >"${receipt_dir}/source-fdb-up.log" 2>&1

if [[ ${real_cos} == false ]]; then
	s3_port=$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)
	kubectl_for "${HUB_KUBECONFIG}" -n runtime-cold-tier-system port-forward \
		service/runtime-cold-tier "${s3_port}:8080" >"${receipt_dir}/s3-port-forward.log" 2>&1 &
	forward_pid=$!
	s3_endpoint="http://127.0.0.1:${s3_port}"
	for _ in $(seq 1 80); do
		if curl -fsS --max-time 1 "${s3_endpoint}/__health" >/dev/null 2>&1; then break; fi
		kill -0 "${forward_pid}" >/dev/null 2>&1 || die "local S3 port-forward exited"
		sleep 0.25
	done
	curl -fsS --max-time 1 "${s3_endpoint}/__health" >/dev/null || die "local S3 port-forward is not ready"
else
	s3_endpoint=${cold_endpoint}
	set -a
	# shellcheck disable=SC1090
	source "${credential_file}"
	set +a
	[[ -n ${AWS_ACCESS_KEY_ID:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] || \
		die "COS credential file did not define both AWS credential variables"
fi
python3 "${PHYSICAL_E2E_DIR}/s3_inventory.py" list \
	--endpoint "${s3_endpoint}" --bucket "${bucket}" "${inventory_args[@]}" >"${baseline}"
if [[ ${real_cos} == true ]]; then
	jq -e 'length == 0' "${baseline}" >/dev/null || \
		die "dedicated Tencent COS qualification bucket must be empty before the run"
fi

render_engine "${source_fdb}" "${source_normal}" "${source_selected}" "${source_rendered}"
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system create secret generic \
	"${cell}-runtime-auth" --from-literal=token=qualification-only \
	--dry-run=client -o yaml | kubectl_for "${RUNTIME_A_KUBECONFIG}" apply -f - >/dev/null
cos_access_key=${AWS_ACCESS_KEY_ID:-qualification-only}
cos_secret_key=${AWS_SECRET_ACCESS_KEY:-qualification-only}
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system create secret generic \
	"${cell}-runtime-cos" \
	--from-literal="AWS_ACCESS_KEY_ID=${cos_access_key}" \
	--from-literal="AWS_SECRET_ACCESS_KEY=${cos_secret_key}" \
	--dry-run=client -o yaml | kubectl_for "${RUNTIME_A_KUBECONFIG}" apply -f - >/dev/null
kubectl_for "${RUNTIME_A_KUBECONFIG}" apply -f "${source_rendered}" >/dev/null
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system rollout status \
	deployment/"${cell}-engine" --timeout=10m >"${receipt_dir}/source-engine-rollout.log"
pod=$(kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system get pod \
	-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=engine" \
	-o jsonpath='{.items[0].metadata.name}')

engine_cli() {
	kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system exec "${pod}" -c engine -- \
		/opt/actor/bin/rivet-engine --config /etc/actor/runtime/config.jsonc "$@"
}
engine_json() {
	local raw=${temporary}/engine-cli-$RANDOM-$RANDOM.log
	if ! engine_cli "$@" >"${raw}"; then
		cat "${raw}" >&2
		return 1
	fi
	sed -n '/^{/,$p' "${raw}"
}
peer() {
	local method=$1 path=$2 body=${3:-}
	local arguments=(--fail --silent --show-error --request "${method}")
	if [[ -n ${body} ]]; then arguments+=(--header 'content-type: application/json' --data "${body}"); fi
	kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system exec "${pod}" -c engine -- \
		/usr/bin/curl "${arguments[@]}" "http://127.0.0.1:6421${path}"
}
wait_cold() {
	local target=$1 deadline=$((SECONDS + 240)) state
	while ((SECONDS < deadline)); do
		state=$(peer GET "/depot/inspect/buckets/${bucket_id}/databases/${database_id}/bottomless-state")
		if jq -e --argjson target "${target}" \
			'.cold_ready == true and .compaction_root.cold_watermark_txid >= $target' \
			<<<"${state}" >/dev/null; then return; fi
		sleep 1
	done
	die "cold checkpoint did not settle through txid ${target}"
}
force_checkpoint() {
	peer POST "/depot/checkpoints/buckets/${bucket_id}/databases/${database_id}" \
		'{"force_reclaim":true}'
}

bucket_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
database_id="backup-restore-${run_token}"
log "creating a retirement tombstone before the real FDB backup starts"
engine_json depot execute --bucket-id "${bucket_id}" --database-id "${database_id}" --query \
	'CREATE TABLE payloads(id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, payload BLOB NOT NULL); WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<256) INSERT INTO payloads SELECT x,1,randomblob(3072) FROM seq;' \
	>"${receipt_dir}/write-generation-1.json"
state=$(peer GET "/depot/inspect/buckets/${bucket_id}/databases/${database_id}/bottomless-state")
branch_id=$(jq -er '.branch_id' <<<"${state}")
peer PUT "/depot/qualification/buckets/${bucket_id}/databases/${database_id}/shard-cache-policy" \
	'{"retention_ms":1}' >"${receipt_dir}/shard-cache-policy.json"
peer PUT "/depot/qualification/branches/${branch_id}/cold-delete-grace" \
	'{"grace_ms":0}' >"${receipt_dir}/qualification-grace.json"
checkpoint=$(force_checkpoint)
printf '%s\n' "${checkpoint}" >"${receipt_dir}/checkpoint-generation-1.json"
wait_cold "$(jq -er '.target_head_txid' <<<"${checkpoint}")"

engine_json depot execute --bucket-id "${bucket_id}" --database-id "${database_id}" --query \
	'UPDATE payloads SET generation=2,payload=randomblob(3072);' \
	>"${receipt_dir}/write-generation-2.json"
checkpoint=$(force_checkpoint)
printf '%s\n' "${checkpoint}" >"${receipt_dir}/checkpoint-generation-2.json"
wait_cold "$(jq -er '.target_head_txid' <<<"${checkpoint}")"

# A checkpoint at the same head is idempotently coalesced and cannot guarantee a new manager
# snapshot after hot eviction. Advance only SQLite's user_version to create a real ordered barrier;
# application rows remain generation 2 while retirement receives a strictly newer head.
engine_json depot execute --bucket-id "${bucket_id}" --database-id "${database_id}" --query \
	'PRAGMA user_version=1;' >"${receipt_dir}/write-retirement-barrier.json"
checkpoint=$(force_checkpoint)
printf '%s\n' "${checkpoint}" >"${receipt_dir}/checkpoint-retirement.json"
wait_cold "$(jq -er '.target_head_txid' <<<"${checkpoint}")"

deadline=$((SECONDS + 180))
next_reclaim=${SECONDS}
retired='{"rows":[]}'
while ((SECONDS < deadline)); do
	retired=$(peer GET "/depot/inspect/branches/${branch_id}/rows/retired-cold-objects?limit=100")
	if jq -e '.rows | length > 0' <<<"${retired}" >/dev/null; then break; fi
	# One manager snapshot can evict the superseded hot shard, while only a later snapshot may
	# retire its cold reference. Keep driving the production checkpoint API until both ordered
	# transitions are observable instead of relying on a timer-led background pass.
	if ((SECONDS >= next_reclaim)); then
		attempt=$(force_checkpoint)
		printf '%s\n' "${attempt}" >>"${receipt_dir}/checkpoint-retirement-attempts.jsonl"
		next_reclaim=$((SECONDS + 5))
	fi
	sleep 1
done
jq -e '.rows | length > 0' <<<"${retired}" >/dev/null || die "old cold generation was not retired"
printf '%s\n' "${retired}" >"${receipt_dir}/retired-before-backup.json"
object_key=$(jq -er '.rows[0].decoded.object_key' <<<"${retired}")
tombstone_version=$(python3 - "${receipt_dir}/retired-before-backup.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))["rows"][0]["decoded"]["retired_versionstamp"]
print(int.from_bytes(bytes(value[:8]), "big"))
PY
)
python3 "${PHYSICAL_E2E_DIR}/s3_inventory.py" list \
	--endpoint "${s3_endpoint}" --bucket "${bucket}" "${inventory_args[@]}" \
	>"${receipt_dir}/bucket-before-backup.json"
jq -e --arg key "${object_key}" 'index($key) != null' \
	"${receipt_dir}/bucket-before-backup.json" >/dev/null || die "retired object is missing before backup"

log "starting real FoundationDB backup after tombstone version ${tombstone_version}"
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system exec "${pod}" \
	-c fdb-backup-agent -- /usr/bin/fdbbackup start \
	-C /etc/actor/runtime/fdb.cluster -d "${backup_url}" -t "${backup_tag}" -w \
	>"${receipt_dir}/fdbbackup-start.log"
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system exec "${pod}" \
	-c fdb-backup-agent -- /usr/bin/fdbbackup status \
	-C /etc/actor/runtime/fdb.cluster -t "${backup_tag}" \
	>"${receipt_dir}/fdbbackup-status.log"
backup_uid=$(sed -n 's/^BackupUID: //p' "${receipt_dir}/fdbbackup-status.log" | tail -1)
backup_generation_url=$(sed -n 's/^BackupURL: //p' "${receipt_dir}/fdbbackup-status.log" | tail -1)
[[ -n ${backup_uid} && -n ${backup_generation_url} ]] || \
	die "real FDB backup status omitted BackupUID or BackupURL"
[[ ${backup_generation_url} == "${backup_url}/"* ]] || \
	die "real FDB backup leaf escaped its dedicated base"

engine_json depot backup-fence-controller-run-once >"${receipt_dir}/backup-observation.json"
engine_json depot backup-fence-show >"${receipt_dir}/backup-fence.json"
minimum_restorable_version=$(jq -er '.minimum_restorable_version' "${receipt_dir}/backup-observation.json")
(( minimum_restorable_version > tombstone_version )) || \
	die "real backup restore floor did not advance beyond the retirement tombstone"

log "deleting the retired exact key under the real backup fence"
engine_json depot cold-gc-policy-set --expected-revision 0 --state enabled \
	--confirm-irreversible-exact-key-deletion --grace-period-ms "${qualification_gc_grace_period_ms}" \
	--max-delete-concurrency "${cold_gc_max_delete_concurrency}" \
	--max-objects-per-batch "${cold_gc_max_objects_per_batch}" \
	--retry-max-attempts "${cold_gc_retry_max_attempts}" \
	--retry-initial-backoff-ms "${cold_gc_retry_initial_backoff_ms}" \
	--retry-max-backoff-ms "${cold_gc_retry_max_backoff_ms}" \
	>"${receipt_dir}/enabled-policy-source.json"
deadline=$((SECONDS + 180))
while ((SECONDS < deadline)); do
	python3 "${PHYSICAL_E2E_DIR}/s3_inventory.py" list \
		--endpoint "${s3_endpoint}" --bucket "${bucket}" "${inventory_args[@]}" \
		>"${receipt_dir}/bucket-after-source-delete.json"
	if ! jq -e --arg key "${object_key}" 'index($key) != null' \
		"${receipt_dir}/bucket-after-source-delete.json" >/dev/null; then break; fi
	sleep 1
done
if jq -e --arg key "${object_key}" 'index($key) != null' \
	"${receipt_dir}/bucket-after-source-delete.json" >/dev/null; then
	die "backup-fenced source object was not physically deleted"
fi
engine_json depot cold-delete-receipt-show --object-key "${object_key}" \
	>"${receipt_dir}/source-delete-receipt.json"

log "destroying every source FDB process and disk"
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system scale \
	deployment/"${cell}-engine" --replicas=0 >/dev/null
deadline=$((SECONDS + 300))
while ((SECONDS < deadline)); do
	remaining=$(kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system get pod \
		-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=engine" \
		-o name 2>/dev/null || true)
	[[ -z ${remaining} ]] && break
	sleep 1
done
[[ -z ${remaining} ]] || die "source Engine pod survived scale-to-zero"
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system delete foundationdbcluster \
	"${source_fdb}" --ignore-not-found --wait=false >/dev/null
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system wait --for=delete \
	"foundationdbcluster/${source_fdb}" --timeout=5m >/dev/null
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system delete pvc \
	-l "foundationdb.org/fdb-cluster-name=${source_fdb}" --ignore-not-found --wait=false \
	>/dev/null
deadline=$((SECONDS + 180))
while ((SECONDS < deadline)); do
	remaining=$(kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system get pod,pvc \
		-l "foundationdb.org/fdb-cluster-name=${source_fdb}" -o name 2>/dev/null || true)
	[[ -z ${remaining} ]] && break
	sleep 1
done
[[ -z ${remaining} ]] || die "source FDB processes or disks survived destructive cleanup"
jq -n --arg cluster "${source_fdb}" \
	'{cluster:$cluster,cluster_deleted:true,processes_remaining:0,persistent_volumes_remaining:0}' \
	>"${receipt_dir}/source-destruction.json"

log "creating an empty destination FDB and restoring the oldest supported version"
RIVET_LOCAL_STORAGE_CONTEXT=qualification \
	RIVET_LOCAL_STORAGE_PROFILE_ID=${storage_profile_id} \
	RIVET_LOCAL_FDB_SUFFIX=${restore_suffix} RIVET_LOCAL_FDB_TARGETS=runtime-a \
	"${MESH_DIR}/install-real-fdb.sh" >"${receipt_dir}/restore-fdb-up.log" 2>&1
python3 "${E2E_DIR}/render.py" restore-tools \
	"${cell}" "${restore_fdb}" "${backup_pvc}" "${restore_tools}"
kubectl_for "${RUNTIME_A_KUBECONFIG}" apply -f "${restore_tools}" >/dev/null
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system wait --for=condition=Ready \
	"pod/${cell}-restore-tools" --timeout=5m >/dev/null
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system exec \
	"${cell}-restore-tools" -c fdb-backup-agent -- /usr/bin/fdbrestore start -w \
	-r "${backup_generation_url}" -v "${minimum_restorable_version}" \
	--dest-cluster-file /etc/actor/runtime/fdb.cluster -t "${backup_tag}-restore" \
	>"${receipt_dir}/fdbrestore.log"
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system delete pod \
	"${cell}-restore-tools" --wait=true >"${receipt_dir}/restore-tools-delete.log"

render_engine "${restore_fdb}" "${restore_normal}" "${restore_selected}" "${restore_rendered}"
kubectl_for "${RUNTIME_A_KUBECONFIG}" apply -f "${restore_rendered}" >/dev/null
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system rollout status \
	deployment/"${cell}-engine" --timeout=10m >"${receipt_dir}/restore-engine-rollout.log"
pod=$(kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system get pod \
	-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=engine" \
	-o jsonpath='{.items[0].metadata.name}')

log "verifying the oldest restored version has no live reference to the deleted key"
engine_json depot execute --bucket-id "${bucket_id}" --database-id "${database_id}" --query \
	'SELECT COUNT(*),MIN(generation),MAX(generation),SUM(length(payload)) FROM payloads;' \
	>"${receipt_dir}/restored-query.json"
jq -e '.rows == [[256,2,2,786432]]' "${receipt_dir}/restored-query.json" >/dev/null || \
	die "restored SQLite contents do not match generation 2"
restored_state=$(peer GET "/depot/inspect/buckets/${bucket_id}/databases/${database_id}/bottomless-state")
restored_branch_id=$(jq -er '.branch_id' <<<"${restored_state}")
[[ ${restored_branch_id} == "${branch_id}" ]] || die "restored branch identity drifted"
peer GET "/depot/inspect/branches/${branch_id}/rows/cold-shards?limit=100" \
	>"${receipt_dir}/restored-cold-refs.json"
jq -e --arg key "${object_key}" \
	'[.rows[].decoded.object_key] | index($key) == null and length > 0' \
	"${receipt_dir}/restored-cold-refs.json" >/dev/null || \
	die "oldest restored version contains a live ref to the physically deleted key"
peer GET "/depot/inspect/branches/${branch_id}/rows/retired-cold-objects?limit=100" \
	>"${receipt_dir}/restored-retired-before-replay.json"
jq -e --arg key "${object_key}" \
	'any(.rows[].decoded; .object_key == $key and .delete_state == "Retired")' \
	"${receipt_dir}/restored-retired-before-replay.json" >/dev/null || \
	die "oldest restored version did not preserve the non-live retirement tombstone"
python3 "${PHYSICAL_E2E_DIR}/s3_inventory.py" list \
	--endpoint "${s3_endpoint}" --bucket "${bucket}" "${inventory_args[@]}" \
	>"${receipt_dir}/restored-bucket-before-replay.json"
jq -e --arg key "${object_key}" 'index($key) == null' \
	"${receipt_dir}/restored-bucket-before-replay.json" >/dev/null || \
	die "physically deleted object reappeared during FDB restore"

log "replaying the restored retirement idempotently and reconciling its ledger"
engine_json depot backup-fence-controller-run-once >"${receipt_dir}/restored-backup-observation.json"
engine_json depot cold-gc-policy-set --expected-revision 0 --state enabled \
	--confirm-irreversible-exact-key-deletion --grace-period-ms "${qualification_gc_grace_period_ms}" \
	--max-delete-concurrency "${cold_gc_max_delete_concurrency}" \
	--max-objects-per-batch "${cold_gc_max_objects_per_batch}" \
	--retry-max-attempts "${cold_gc_retry_max_attempts}" \
	--retry-initial-backoff-ms "${cold_gc_retry_initial_backoff_ms}" \
	--retry-max-backoff-ms "${cold_gc_retry_max_backoff_ms}" \
	>"${receipt_dir}/enabled-policy-restored.json"
force_checkpoint >"${receipt_dir}/restored-reclaim-checkpoint.json"
deadline=$((SECONDS + 180))
while ((SECONDS < deadline)); do
	if engine_json depot cold-delete-receipt-show --object-key "${object_key}" \
		>"${receipt_dir}/restored-delete-receipt.json" 2>/dev/null; then break; fi
	sleep 1
done
[[ -s ${receipt_dir}/restored-delete-receipt.json ]] || \
	die "restored retirement did not converge to an idempotent delete receipt"
engine_json depot cold-storage-accounting-show >"${receipt_dir}/restored-accounting.json"
engine_json depot cold-inventory-scan --page-limit 1000 >"${receipt_dir}/restored-inventory.json"
jq -e '.retired_objects == 0 and .delete_issued_objects == 0 and .deleted_objects_total >= 1' \
	"${receipt_dir}/restored-accounting.json" >/dev/null
jq -e --slurpfile ledger "${receipt_dir}/restored-accounting.json" '
	.unknown_objects == 0 and .unknown_bytes == 0 and
	.deleted_but_present_objects == 0 and .deleted_but_present_bytes == 0 and
	.physical_objects == $ledger[0].live_objects and
	.physical_bytes == $ledger[0].live_bytes
' "${receipt_dir}/restored-inventory.json" >/dev/null

jq -n \
	--arg schema rivet-local-backup-restore-physical-qualification/v1 \
	--arg runId "${run_id}" --arg sourceFdb "${source_fdb}" --arg restoreFdb "${restore_fdb}" \
	--arg storageProfile "${storage_profile_id}" --arg endpointKind "${endpoint_kind}" \
	--arg bucket "${bucket}" --arg backupBaseUrl "${backup_url}" \
	--argjson declaredGraceMs "${cold_gc_grace_period_ms}" \
	--argjson qualificationGraceMs "${qualification_gc_grace_period_ms}" \
	--arg backupUrl "${backup_generation_url}" --arg backupUid "${backup_uid}" \
	--arg objectKey "${object_key}" --arg branchId "${branch_id}" \
	--argjson tombstoneVersion "${tombstone_version}" \
	--argjson minimumRestorableVersion "${minimum_restorable_version}" \
	--slurpfile sourceDestruction "${receipt_dir}/source-destruction.json" \
	--slurpfile sourceReceipt "${receipt_dir}/source-delete-receipt.json" \
	--slurpfile restoredQuery "${receipt_dir}/restored-query.json" \
	--slurpfile restoredReceipt "${receipt_dir}/restored-delete-receipt.json" \
	--slurpfile accounting "${receipt_dir}/restored-accounting.json" \
	--slurpfile inventory "${receipt_dir}/restored-inventory.json" \
	'{schema:$schema,run_id:$runId,verdict:"passed",storage_profile:$storageProfile,endpoint_kind:$endpointKind,policy:{declared_grace_period_ms:$declaredGraceMs,qualification_grace_period_ms:$qualificationGraceMs},isolation:{source_fdb:$sourceFdb,restore_fdb:$restoreFdb,cold_bucket:$bucket},backup:{base_url:$backupBaseUrl,url:$backupUrl,uid:$backupUid,tombstone_version:$tombstoneVersion,minimum_restorable_version:$minimumRestorableVersion,restored_exact_version:$minimumRestorableVersion},physical_delete:{branch_id:$branchId,object_key:$objectKey,source_receipt:$sourceReceipt[0],restored_idempotent_receipt:$restoredReceipt[0]},source_destruction:$sourceDestruction[0],restored_sqlite:$restoredQuery[0],restored_ledger:$accounting[0],restored_inventory:$inventory[0]}' \
	>"${receipt_dir}/summary.json"

log "real backup-fenced deletion and oldest-version restore passed: ${receipt_dir}/summary.json"
