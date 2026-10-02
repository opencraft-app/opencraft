#!/usr/bin/env bash
set -euo pipefail

STACK_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
LOCAL_DIR=$(cd -- "${STACK_DIR}/.." && pwd)
MESH_DIR=${LOCAL_DIR}/mesh
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=../mesh/storage-profile.sh
source "${MESH_DIR}/storage-profile.sh"

for command in jq kubectl; do require_command "${command}"; done

"${MESH_DIR}/verify.sh"
"${MESH_DIR}/verify-federated-placement.sh"
"${LOCAL_DIR}/runtime-cold-tier/verify.sh"
"${MESH_DIR}/verify-real-fdb.sh"

verify_runtime() {
	local kubeconfig=$1 cell=$2 bucket=$3 fdb_config=$4
	local config configmap deployment hosts engine_pod runner_configs
	configmap=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get configmap \
		"${cell}-runtime-config" -o json)
	jq -e --arg profile "${RIVET_LOCAL_STORAGE_PROFILE_ID}" \
		'.metadata.annotations["rivet.dev/storage-profile"] == $profile' \
		<<<"${configmap}" >/dev/null || die "${cell} runtime ConfigMap has the wrong StorageProfile"
	config=$(jq -er '.data["config.jsonc"]' <<<"${configmap}")
	jq -e \
		--arg endpoint "${RIVET_LOCAL_COLD_ENDPOINT}" \
		--arg bucket "${bucket}" \
		--arg region "${RIVET_LOCAL_COLD_REGION}" \
		--arg addressingStyle "${RIVET_LOCAL_COLD_ADDRESSING_STYLE}" \
		--argjson maxObjectSize "${RIVET_LOCAL_COLD_MAX_OBJECT_SIZE_BYTES}" \
		--argjson recoveryWindow "${RIVET_LOCAL_COLD_RECOVERY_WINDOW_MS}" '
		.sqlite.workflow_cold_storage.s3 as $s3 |
		$s3.endpoint == $endpoint and $s3.bucket == $bucket and
		$s3.region == $region and $s3.addressing_style == $addressingStyle and
		$s3.max_object_size_bytes == $maxObjectSize and
		$s3.recovery_window_ms == $recoveryWindow
	' <<<"${config}" >/dev/null || die "${cell} does not use the persistent local cold tier"
	deployment=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get deployment "${cell}-engine" -o json)
	jq -e --arg fdb "${fdb_config}" '
		.spec.replicas == 1 and .status.readyReplicas == 1 and
		([.spec.template.spec.volumes[] | select(.name == "fdb-config") | .configMap.name] == [$fdb])
	' <<<"${deployment}" >/dev/null || die "${cell} Engine is not Ready on ${fdb_config}"
	hosts=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get statefulset "${cell}-runtime-hosts" -o json)
	jq -e '.spec.replicas == 1 and .status.readyReplicas == 1' <<<"${hosts}" >/dev/null || \
		die "${cell} workerd Host is not Ready"
	engine_pod=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get pod \
		-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=engine" \
		-o jsonpath='{.items[0].metadata.name}')
	runner_configs=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system exec "${engine_pod}" -- \
		/usr/bin/curl --fail --silent --show-error \
		'http://127.0.0.1:6421/runner-configs?namespace=default')
	jq -e '.runner_configs.workerd.normal | type == "object"' <<<"${runner_configs}" >/dev/null || \
		die "${cell} new FDB is missing the workerd runner config"
}

verify_runtime "${RUNTIME_A_KUBECONFIG}" local-runtime-a \
	"${RIVET_LOCAL_COLD_BUCKET_A}" "${RIVET_LOCAL_FDB_CLUSTER_A}-config"
verify_runtime "${RUNTIME_B_KUBECONFIG}" local-runtime-b \
	"${RIVET_LOCAL_COLD_BUCKET_B}" "${RIVET_LOCAL_FDB_CLUSTER_B}-config"

verify_stateless() {
	local kubeconfig=$1 cell=$2
	local deployment service secret
	deployment=$(kubectl_for "${kubeconfig}" -n actor-stateless-system get deployment \
		"${cell}-stateless-executor" -o json)
	jq -e '
		.spec.replicas == 1 and .status.readyReplicas == 1 and
		.spec.template.spec.nodeSelector == {"rivet.dev/compute":"true"} and
		([.spec.template.spec.containers[].name] | sort) == ["executor", "workerd"]
	' <<<"${deployment}" >/dev/null || die "${cell} stateless executor is not Ready"
	service=$(kubectl_for "${kubeconfig}" -n actor-stateless-system get service \
		"${cell}-stateless-executor" -o json)
	jq -e '.spec.type == "NodePort" and .spec.ports[0].port == 19084 and .spec.ports[0].nodePort == 30484' \
		<<<"${service}" >/dev/null || die "${cell} stateless executor endpoint differs"
	secret=$(kubectl_for "${kubeconfig}" -n actor-stateless-system get secret \
		"${cell}-stateless-auth" -o json)
	jq -e '
		[.data["executor-token"], .data["object-router-token"], .data["workerd-token"]] as $tokens |
		($tokens | length) == 3 and ($tokens | unique | length) == 3 and all($tokens[]; length > 40)
	' <<<"${secret}" >/dev/null || die "${cell} stateless capabilities are missing or duplicated"
}

verify_stateless "${RUNTIME_A_KUBECONFIG}" local-runtime-a
verify_stateless "${RUNTIME_B_KUBECONFIG}" local-runtime-b

registry=$(kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system get deployment worker-registry -o json)
jq -e '.spec.replicas == 3 and .status.readyReplicas == 3' <<<"${registry}" >/dev/null || \
	die "Worker Registry does not have three Ready replicas"
"${LOCAL_DIR}/workers-api/verify.sh"
"${LOCAL_DIR}/ingress/verify.sh"
log "local Workers stack passed topology, cold-tier fault, persistence, stateless execution, and public API gates"
