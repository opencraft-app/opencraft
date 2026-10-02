#!/usr/bin/env bash
set -euo pipefail

COLD_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${COLD_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=../mesh/storage-profile.sh
source "${MESH_DIR}/storage-profile.sh"

for command in base64 curl jq kubectl python3 sha256sum; do require_command "${command}"; done
cluster_exists "${HUB_CLUSTER}" || die "cluster ${HUB_CLUSTER} is missing"

state_dir=${MESH_STATE_DIR}/runtime-cold-tier
mkdir -p "${state_dir}"
chmod 0700 "${state_dir}"
port=$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)
forward_pid=
stop_forward() {
	if [[ -n ${forward_pid} ]]; then
		kill "${forward_pid}" >/dev/null 2>&1 || true
		wait "${forward_pid}" >/dev/null 2>&1 || true
		forward_pid=
	fi
}
start_forward() {
	stop_forward
	kubectl_for "${HUB_KUBECONFIG}" -n runtime-cold-tier-system port-forward \
		service/runtime-cold-tier "${port}:8080" >"${state_dir}/port-forward.log" 2>&1 &
	forward_pid=$!
	for _ in $(seq 1 80); do
		if curl -fsS --max-time 1 "http://127.0.0.1:${port}/__health" >/dev/null 2>&1; then return; fi
		kill -0 "${forward_pid}" >/dev/null 2>&1 || die "cold-tier port-forward exited"
		sleep 0.25
	done
	die "cold-tier port-forward did not become ready"
}
trap stop_forward EXIT
start_forward

deployment=$(kubectl_for "${HUB_KUBECONFIG}" -n runtime-cold-tier-system get deployment \
	runtime-cold-tier -o json)
expected_buckets="${RIVET_LOCAL_COLD_BUCKET_A},${RIVET_LOCAL_COLD_BUCKET_B}"
if [[ -n ${RIVET_LOCAL_COLD_QUALIFICATION_BUCKET:-} ]]; then
	expected_buckets+=",${RIVET_LOCAL_COLD_QUALIFICATION_BUCKET}"
fi
jq -e \
	--arg profile "${RIVET_LOCAL_STORAGE_PROFILE_ID}" \
	--arg buckets "${expected_buckets}" \
	--arg maxObjectBytes "${RIVET_LOCAL_COLD_MAX_OBJECT_SIZE_BYTES}" '
	.spec.template.metadata.annotations["rivet.dev/storage-profile"] == $profile and
	([.spec.template.spec.containers[0].env[] | select(.name == "LOCAL_S3_BUCKETS") | .value] == [$buckets]) and
	([.spec.template.spec.containers[0].env[] | select(.name == "LOCAL_S3_MAX_OBJECT_BYTES") | .value] == [$maxObjectBytes])
' <<<"${deployment}" >/dev/null || die "cold-tier Deployment does not match StorageProfile"

base=http://127.0.0.1:${port}
admin_token=$(kubectl_for "${HUB_KUBECONFIG}" -n runtime-cold-tier-system get secret \
	runtime-cold-tier-admin -o jsonpath='{.data.token}' | base64 --decode)
[[ ${#admin_token} -ge 32 ]] || die "cold-tier admin token is missing or too short"
admin_header=(--header "X-Local-S3-Admin-Token: ${admin_token}")
run_id=$(date +%s%N)
key=qualification/${run_id}/shared
corrupt_key=qualification/${run_id}/corrupt
value_a="runtime-a-${run_id}"
value_b="runtime-b-${run_id}"
bucket_a=${RIVET_LOCAL_COLD_BUCKET_A:-local-runtime-a-cold}
bucket_b=${RIVET_LOCAL_COLD_BUCKET_B:-local-runtime-b-cold}

put() { curl -fsS --max-time 5 -X PUT --data-binary "$3" "${base}/$1/$2" -o /dev/null; }
get() { curl -fsS --max-time 5 "${base}/$1/$2"; }
delete_object() { curl -fsS --max-time 5 -X DELETE "${base}/$1/$2" -o /dev/null; }

put "${bucket_a}" "${key}" "${value_a}"
put "${bucket_b}" "${key}" "${value_b}"
[[ $(get "${bucket_a}" "${key}") == "${value_a}" ]] || die "runtime A cold object mismatch"
[[ $(get "${bucket_b}" "${key}") == "${value_b}" ]] || die "runtime B cold object mismatch"

put "${bucket_a}" "${key}" "${value_a}"
immutable_status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' -X PUT \
	--data-binary "different-${value_a}" "${base}/${bucket_a}/${key}")
[[ ${immutable_status} == 409 ]] || die "immutable overwrite returned HTTP ${immutable_status}, expected 409"

unauthorized_status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "${base}/__admin/stats")
[[ ${unauthorized_status} == 403 ]] || die "cold-tier admin endpoint returned HTTP ${unauthorized_status} without its token"
curl -fsS --max-time 5 "${admin_header[@]}" -X PUT \
	"${base}/__admin/fault?operation=get&status=503" -o /dev/null
fault_status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
	"${base}/${bucket_a}/${key}")
[[ ${fault_status} == 503 ]] || die "fault injection returned HTTP ${fault_status}, expected 503"
curl -fsS --max-time 5 "${admin_header[@]}" -X DELETE \
	"${base}/__admin/fault?operation=get" -o /dev/null
[[ $(get "${bucket_a}" "${key}") == "${value_a}" ]] || die "object did not recover after fault removal"

put "${bucket_a}" "${corrupt_key}" "integrity-${run_id}"
curl -fsS --max-time 5 "${admin_header[@]}" -X POST \
	"${base}/__admin/corrupt?bucket=${bucket_a}&key=${corrupt_key}" -o /dev/null
corrupt_status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
	"${base}/${bucket_a}/${corrupt_key}")
[[ ${corrupt_status} == 500 ]] || die "corrupt object returned HTTP ${corrupt_status}, expected 500"

stats_before=$(curl -fsS --max-time 5 "${admin_header[@]}" "${base}/__admin/stats")
jq -e --arg bucketA "${bucket_a}" --arg bucketB "${bucket_b}" \
	'.buckets[$bucketA].objects >= 2 and .buckets[$bucketB].objects >= 1' \
	<<<"${stats_before}" >/dev/null || die "cold-tier bucket inventory is incomplete"

stop_forward
kubectl_for "${HUB_KUBECONFIG}" -n runtime-cold-tier-system rollout restart \
	deployment/runtime-cold-tier >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n runtime-cold-tier-system rollout status \
	deployment/runtime-cold-tier --timeout=3m >/dev/null
start_forward
[[ $(get "${bucket_a}" "${key}") == "${value_a}" ]] || die "runtime A object did not survive restart"
[[ $(get "${bucket_b}" "${key}") == "${value_b}" ]] || die "runtime B object did not survive restart"

delete_object "${bucket_a}" "${key}"
delete_object "${bucket_b}" "${key}"
delete_object "${bucket_a}" "${corrupt_key}"
log "local cold tier passed isolation, immutability, failure injection, hash validation, and restart persistence"
