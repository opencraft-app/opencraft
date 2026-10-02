#!/usr/bin/env bash
set -euo pipefail

E2E_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${E2E_DIR}/.." && pwd)
# shellcheck source=../lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=../storage-profile.sh
source "${MESH_DIR}/storage-profile.sh"

for command in cargo curl docker flock jq k3d kubectl python3; do require_command "${command}"; done
cluster_exists "${RUNTIME_A_CLUSTER}" || die "cluster ${RUNTIME_A_CLUSTER} is missing"
cluster_exists "${HUB_CLUSTER}" || die "cluster ${HUB_CLUSTER} is missing"

mkdir -p -- "${MESH_STATE_DIR}/locks"
exec 9>"${MESH_STATE_DIR}/locks/cold-gc-physical-e2e.lock"
flock -n 9 || die "another cold-GC physical qualification is already running"

run_id=$(date -u +%Y%m%dT%H%M%SZ)
run_token=$(date -u +%m%d%H%M%S)
cell="lcgq-$(date -u +%H%M%S)"
fdb_suffix="-cold-gc-q-${run_token}"
fdb_cluster="local-runtime-a${fdb_suffix}"
bucket=local-cold-gc-qualification
receipt_dir=${LOCAL_COLD_GC_PHYSICAL_DIR:-${MESH_STATE_DIR}/receipts/cold-gc-physical/${run_id}}
image_file=${receipt_dir}/qualification-image
temporary=$(mktemp -d)
normal_render=${temporary}/normal.yaml
rendered=${temporary}/qualification.yaml
baseline=${receipt_dir}/bucket-baseline.json
mkdir -p -- "${receipt_dir}"

pod=
forward_pid=
s3_endpoint=
cleanup() {
	local status=$?
	set +e
	if [[ -n ${s3_endpoint} && -s ${baseline} ]]; then
		python3 "${E2E_DIR}/s3_inventory.py" delete-delta \
			--endpoint "${s3_endpoint}" --bucket "${bucket}" --baseline "${baseline}" \
			>"${receipt_dir}/cleanup-objects.json" 2>"${receipt_dir}/cleanup-objects.log"
	fi
	if [[ -n ${forward_pid} ]]; then
		kill "${forward_pid}" >/dev/null 2>&1
		wait "${forward_pid}" >/dev/null 2>&1
	fi
	if [[ -s ${rendered} ]]; then
		kubectl_for "${RUNTIME_A_KUBECONFIG}" delete -f "${rendered}" \
			--ignore-not-found --wait=false >/dev/null 2>&1
	fi
	kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system delete secret \
		"${cell}-runtime-auth" "${cell}-runtime-cos" --ignore-not-found >/dev/null 2>&1
	kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system delete foundationdbcluster \
		"${fdb_cluster}" --ignore-not-found --wait=false >/dev/null 2>&1
	kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system delete pvc \
		-l "foundationdb.org/fdb-cluster-name=${fdb_cluster}" --ignore-not-found --wait=false \
		>/dev/null 2>&1
	rm -rf -- "${temporary}"
	exit "${status}"
}
trap cleanup EXIT

log "building qualification-only Engine image"
RIVET_LOCAL_RUNTIME_ENGINE_FEATURES='rivet-engine/foundationdb,rivet-engine/test-faults' \
	RIVET_LOCAL_RUNTIME_IMAGE_FILE="${image_file}" \
	"${MESH_DIR}/build-real-runtime-image.sh" >"${receipt_dir}/build.log" 2>&1
runtime_image=$(<"${image_file}")

log "starting isolated local S3 bucket and FDB cluster"
RIVET_LOCAL_COLD_QUALIFICATION_BUCKET=${bucket} \
	"${CELLS_DIR}/deploy/local/runtime-cold-tier/up.sh" \
	>"${receipt_dir}/cold-tier-up.log" 2>&1
RIVET_LOCAL_STORAGE_CONTEXT=qualification \
	RIVET_LOCAL_STORAGE_PROFILE_ID=local-cold-gc-qualification \
	RIVET_LOCAL_FDB_SUFFIX=${fdb_suffix} RIVET_LOCAL_FDB_TARGETS=runtime-a \
	"${MESH_DIR}/install-real-fdb.sh" >"${receipt_dir}/fdb-up.log" 2>&1

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
python3 "${E2E_DIR}/s3_inventory.py" list --endpoint "${s3_endpoint}" --bucket "${bucket}" >"${baseline}"

log "rendering the isolated Engine deployment"
RIVET_LOCAL_COS_BUCKET=${bucket} \
	RIVET_LOCAL_COLD_ENDPOINT="http://k3d-${HUB_CLUSTER}-server-0:30082" \
	RIVET_LOCAL_COLD_REGION=local RIVET_LOCAL_COLD_ADDRESSING_STYLE=path \
	RIVET_LOCAL_COLD_RECOVERY_WINDOW_MS=86400000 \
	RIVET_LOCAL_FDB_CLUSTER=${fdb_cluster} \
	RIVET_LOCAL_BACKUP_FENCE_DOUBLE=qualification-only \
	python3 "${MESH_DIR}/real/render-runtime.py" \
		"${CELLS_DIR}/deploy/tencent/fleet/runtime/runtime.yaml" \
		"${CELLS_DIR}/deploy/tencent/fleet/runtime/nats.yaml" \
		local-runtime-a "${runtime_image}" ignored "${normal_render}"
python3 "${E2E_DIR}/render.py" "${normal_render}" "${cell}" "${fdb_cluster}" "${rendered}"

kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system create secret generic \
	"${cell}-runtime-auth" --from-literal=token=qualification-only \
	--dry-run=client -o yaml | kubectl_for "${RUNTIME_A_KUBECONFIG}" apply -f - >/dev/null
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system create secret generic \
	"${cell}-runtime-cos" \
	--from-literal=AWS_ACCESS_KEY_ID=qualification-only \
	--from-literal=AWS_SECRET_ACCESS_KEY=qualification-only \
	--dry-run=client -o yaml | kubectl_for "${RUNTIME_A_KUBECONFIG}" apply -f - >/dev/null
kubectl_for "${RUNTIME_A_KUBECONFIG}" apply -f "${rendered}" >/dev/null
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system rollout status \
	deployment/"${cell}-engine" --timeout=10m >"${receipt_dir}/engine-rollout.log"
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
	# The CLI initializes the normal runtime and emits structured startup logs before command JSON.
	# Keep receipts machine-readable without weakening the production command path under test.
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
	local target=$1 deadline=$((SECONDS + 180)) state started_ms
	started_ms=$(date +%s%3N)
	while ((SECONDS < deadline)); do
		state=$(peer GET "/depot/inspect/buckets/${bucket_id}/databases/${database_id}/bottomless-state")
		if jq -e --argjson target "${target}" \
			'.cold_ready == true and .compaction_root.cold_watermark_txid >= $target' \
			<<<"${state}" >/dev/null; then
			last_cold_wait_ms=$(( $(date +%s%3N) - started_ms ))
			return
		fi
		sleep 1
	done
	die "cold checkpoint did not settle through txid ${target}"
}

bucket_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
database_id="cold-gc-${run_token}"
log "creating two immutable cold generations through the real Depot data path"
engine_json depot execute --bucket-id "${bucket_id}" --database-id "${database_id}" --query \
	'CREATE TABLE payloads(id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, payload BLOB NOT NULL); WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<256) INSERT INTO payloads SELECT x,1,randomblob(3072) FROM seq;' \
	>"${receipt_dir}/write-generation-1.json"
state=$(peer GET "/depot/inspect/buckets/${bucket_id}/databases/${database_id}/bottomless-state")
branch_id=$(jq -er '.branch_id' <<<"${state}")
peer PUT "/depot/qualification/buckets/${bucket_id}/databases/${database_id}/shard-cache-policy" \
	'{"retention_ms":1}' >"${receipt_dir}/shard-cache-policy.json"
peer PUT "/depot/qualification/branches/${branch_id}/cold-delete-grace" \
	'{"grace_ms":0}' >"${receipt_dir}/qualification-grace.json"
checkpoint=$(peer POST "/depot/checkpoints/buckets/${bucket_id}/databases/${database_id}" \
	'{"force_reclaim":true}')
printf '%s\n' "${checkpoint}" >"${receipt_dir}/checkpoint-generation-1.json"
wait_cold "$(jq -er '.target_head_txid' <<<"${checkpoint}")"
cold_wait_generation_1_ms=${last_cold_wait_ms}

engine_json depot execute --bucket-id "${bucket_id}" --database-id "${database_id}" --query \
	'UPDATE payloads SET generation=2,payload=randomblob(3072);' \
	>"${receipt_dir}/write-generation-2.json"
checkpoint=$(peer POST "/depot/checkpoints/buckets/${bucket_id}/databases/${database_id}" \
	'{"force_reclaim":true}')
printf '%s\n' "${checkpoint}" >"${receipt_dir}/checkpoint-generation-2.json"
wait_cold "$(jq -er '.target_head_txid' <<<"${checkpoint}")"
cold_wait_generation_2_ms=${last_cold_wait_ms}

# Retirement deliberately cannot share the snapshot that only plans hot-shard eviction: the old
# hot row is the exact proof that protects the old cold ref. Trigger a fresh production reclaim
# snapshot after eviction has committed so this transition is deterministic rather than timer-led.
checkpoint=$(peer POST "/depot/checkpoints/buckets/${bucket_id}/databases/${database_id}" \
	'{"force_reclaim":true}')
printf '%s\n' "${checkpoint}" >"${receipt_dir}/checkpoint-retirement.json"

deadline=$((SECONDS + 180))
retired='{"rows":[]}'
while ((SECONDS < deadline)); do
	retired=$(peer GET "/depot/inspect/branches/${branch_id}/rows/retired-cold-objects?limit=100")
	if jq -e '.rows | length > 0' <<<"${retired}" >/dev/null; then break; fi
	sleep 1
done
jq -e '.rows | length > 0' <<<"${retired}" >/dev/null || \
	die "post-eviction reclaim did not retire an old cold object"
object_key=$(jq -er '.rows[0].decoded.object_key' <<<"${retired}")
printf '%s\n' "${retired}" >"${receipt_dir}/retired-before-fence.json"
python3 "${E2E_DIR}/s3_inventory.py" list --endpoint "${s3_endpoint}" --bucket "${bucket}" \
	>"${receipt_dir}/bucket-before-delete.json"
jq -e --arg key "${object_key}" 'index($key) != null' \
	"${receipt_dir}/bucket-before-delete.json" >/dev/null || die "retired object was absent before deletion"

log "proving policy enablement fails before the backup fence exists"
set +e
engine_cli depot cold-gc-policy-set --expected-revision 0 --state enabled \
	--confirm-irreversible-exact-key-deletion --grace-period-ms 1 \
	--max-delete-concurrency 1 --max-objects-per-batch 10 --retry-max-attempts 3 \
	--retry-initial-backoff-ms 10 --retry-max-backoff-ms 100 --dry-run \
	>"${receipt_dir}/enable-before-fence.log" 2>&1
before_fence_status=$?
set -e
[[ ${before_fence_status} != 0 ]] || die "ColdGcPolicy enabled without a backup fence"

log "advancing the backup proof and enabling exact-key physical deletion"
kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system exec "${pod}" -c engine -- \
	/opt/actor/bin/local-fdbbackup-double arm 18446744073709551615
engine_json depot backup-fence-controller-run-once >"${receipt_dir}/backup-fence-observation.json"
engine_json depot backup-fence-show >"${receipt_dir}/backup-fence.json"
engine_json depot cold-gc-policy-set --expected-revision 0 --state enabled \
	--confirm-irreversible-exact-key-deletion --grace-period-ms 1 \
	--max-delete-concurrency 1 --max-objects-per-batch 10 --retry-max-attempts 3 \
	--retry-initial-backoff-ms 10 --retry-max-backoff-ms 100 \
	>"${receipt_dir}/enabled-policy.json"

deadline=$((SECONDS + 180))
while ((SECONDS < deadline)); do
	python3 "${E2E_DIR}/s3_inventory.py" list --endpoint "${s3_endpoint}" --bucket "${bucket}" \
		>"${receipt_dir}/bucket-after-delete.json"
	if ! jq -e --arg key "${object_key}" 'index($key) != null' \
		"${receipt_dir}/bucket-after-delete.json" >/dev/null; then break; fi
	sleep 1
done
if jq -e --arg key "${object_key}" 'index($key) != null' \
	"${receipt_dir}/bucket-after-delete.json" >/dev/null; then
	die "retired object was not physically deleted"
fi
engine_json depot cold-delete-receipt-show --object-key "${object_key}" \
	>"${receipt_dir}/delete-receipt.json"
engine_json depot cold-storage-accounting-show >"${receipt_dir}/accounting.json"
engine_json depot cold-inventory-scan --page-limit 1000 >"${receipt_dir}/inventory.json"

jq -e '
	.authorization.minimum_restorable_version == 18446744073709551615 and
	.authorization.policy_revision == 1
' "${receipt_dir}/delete-receipt.json" >/dev/null
jq -e '.deleted_objects_total >= 1 and .deleted_bytes_total > 0 and .retired_objects == 0' \
	"${receipt_dir}/accounting.json" >/dev/null
jq -e --slurpfile ledger "${receipt_dir}/accounting.json" '
	.unknown_objects == 0 and .unknown_bytes == 0 and
	.deleted_but_present_objects == 0 and .deleted_but_present_bytes == 0 and
	.physical_objects == $ledger[0].live_objects and
	.physical_bytes == $ledger[0].live_bytes
' "${receipt_dir}/inventory.json" >/dev/null

jq -n \
	--arg schema rivet-local-cold-gc-physical-qualification/v1 \
	--arg runId "${run_id}" --arg cell "${cell}" --arg fdb "${fdb_cluster}" \
	--arg bucket "${bucket}" --arg branch "${branch_id}" --arg objectKey "${object_key}" \
	--argjson coldWaitGeneration1Ms "${cold_wait_generation_1_ms}" \
	--argjson coldWaitGeneration2Ms "${cold_wait_generation_2_ms}" \
	--slurpfile fence "${receipt_dir}/backup-fence.json" \
	--slurpfile policy "${receipt_dir}/enabled-policy.json" \
	--slurpfile deletion "${receipt_dir}/delete-receipt.json" \
	--slurpfile accounting "${receipt_dir}/accounting.json" \
	--slurpfile inventory "${receipt_dir}/inventory.json" \
	'{schema:$schema,run_id:$runId,verdict:"passed",isolation:{cell:$cell,fdb_cluster:$fdb,cold_bucket:$bucket},latency:{cold_settle_generation_1_ms:$coldWaitGeneration1Ms,cold_settle_generation_2_ms:$coldWaitGeneration2Ms},proof:{unfenced_enable_rejected:true,backup_fence:$fence[0],policy:$policy[0]},physical_delete:{branch_id:$branch,object_key:$objectKey,receipt:$deletion[0]},ledger:$accounting[0],inventory:$inventory[0]}' \
	>"${receipt_dir}/summary.json"

log "deployed Engine backup-fence and physical-delete qualification passed: ${receipt_dir}/summary.json"
