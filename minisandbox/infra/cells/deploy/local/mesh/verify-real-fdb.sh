#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in kubectl jq; do require_command "${command}"; done
fdb_suffix=${RIVET_LOCAL_FDB_SUFFIX:-}
fdb_targets=${RIVET_LOCAL_FDB_TARGETS:-runtime-a,runtime-b}

verify_one() {
	local cluster=$1 kubeconfig=$2
	local cell_name="local-${cluster}${fdb_suffix}"
	local deadline=$((SECONDS + ${REAL_FDB_TIMEOUT_SECONDS:-900})) cluster_json
	while (( SECONDS < deadline )); do
		cluster_json=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get foundationdbcluster "${cell_name}" -o json)
		if [[ $(jq -r '.status.health.available // false' <<<"${cluster_json}") == true && \
			$(jq -r '.status.health.fullReplication // false' <<<"${cluster_json}") == true && \
			$(jq -r '.status.generations.reconciled // 0' <<<"${cluster_json}") == $(jq -r '.metadata.generation' <<<"${cluster_json}") ]]; then
			if [[ -n ${RIVET_LOCAL_STORAGE_PROFILE_ID:-} ]]; then
				jq -e --arg profile "${RIVET_LOCAL_STORAGE_PROFILE_ID}" \
					'.metadata.annotations["rivet.dev/storage-profile"] == $profile' \
					<<<"${cluster_json}" >/dev/null || die "${cell_name} has the wrong StorageProfile"
			fi
			jq -e '.spec.processes.general.podTemplate.spec.nodeSelector == {"rivet.dev/control":"true"}' \
				<<<"${cluster_json}" >/dev/null || die "${cell_name} is not pinned to control nodes"
			kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get configmap "${cell_name}-config" \
				-o jsonpath='{.data.cluster-file}' | grep -Eq '^[^:@]+:[^@]+@[^:]+:[0-9]+$' || die "${cell_name} has no usable cluster file"
			local pod pod_nodes value response
			pod_nodes=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get pod \
				-l "foundationdb.org/fdb-cluster-name=${cell_name}" \
				-o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}')
			while IFS= read -r node; do
				[[ -n ${node} ]] || continue
				[[ $(kubectl_for "${kubeconfig}" get node "${node}" -o jsonpath='{.metadata.labels.rivet\.dev/control}') == true ]] || \
					die "${cell_name} FDB process escaped the control-node isolation contract: ${node}"
			done <<<"${pod_nodes}"
			pod=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get pod \
				-l "foundationdb.org/fdb-cluster-name=${cell_name}" -o jsonpath='{.items[0].metadata.name}')
			value="${cell_name}-$(date +%s%N)"
			response=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system exec "${pod}" -c foundationdb -- \
				fdbcli --exec "writemode on; set local_real_smoke ${value}; get local_real_smoke; clear local_real_smoke")
			grep -Fq "${value}" <<<"${response}" || die "${cell_name} real FDB write/read transaction failed"
			log "${cell_name} is available, fully replicated, reconciled, and passed a real FDB transaction"
			return
		fi
		sleep 5
	done
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get foundationdbcluster "${cell_name}" -o yaml >&2 || true
	die "${cell_name} did not become healthy within the bounded timeout"
}

IFS=',' read -r -a targets <<<"${fdb_targets}"
for target in "${targets[@]}"; do
	case ${target} in
		runtime-a) verify_one runtime-a "${RUNTIME_A_KUBECONFIG}" ;;
		runtime-b) verify_one runtime-b "${RUNTIME_B_KUBECONFIG}" ;;
		*) die "RIVET_LOCAL_FDB_TARGETS contains unsupported target: ${target}" ;;
	esac
done
