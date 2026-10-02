#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in base64 jq kubectl; do
	require_command "${command}"
done

identity_snapshot() {
	local managed works claims cells
	managed=$(kubectl_for "${HUB_KUBECONFIG}" get managedclusters -o json)
	works=$(kubectl_for "${HUB_KUBECONFIG}" get manifestworks -A -o json)
	claims=$(kubectl_for "${HUB_KUBECONFIG}" get rivetcellclaims -A -o json 2>/dev/null || printf '{"items":[]}')
	cells=$(kubectl_for "${HUB_KUBECONFIG}" get rivetcells -A -o json 2>/dev/null || printf '{"items":[]}')
	jq -cn --argjson managed "${managed}" --argjson works "${works}" \
		--argjson claims "${claims}" --argjson cells "${cells}" \
		'{managed:[$managed.items[]|{name:.metadata.name,uid:.metadata.uid}]|sort_by(.name),works:[$works.items[]|{namespace:.metadata.namespace,name:.metadata.name,uid:.metadata.uid}]|sort_by(.namespace,.name),claims:[$claims.items[]|{namespace:.metadata.namespace,name:.metadata.name,uid:.metadata.uid}]|sort_by(.namespace,.name),cells:[$cells.items[]|{namespace:.metadata.namespace,name:.metadata.name,uid:.metadata.uid}]|sort_by(.namespace,.name)}'
}

agent_pod_snapshot() {
	local kubeconfig=$1
	kubectl_for "${kubeconfig}" -n open-cluster-management-agent get pods -o json | \
		jq -c '[.items[] | {name:.metadata.name,uid:.metadata.uid}] | sort_by(.name)'
}

wait_for_agent_reload() {
	local cluster=$1
	local kubeconfig=$2
	local before=$3
	local deadline=$((SECONDS + 180))
	while [[ $(agent_pod_snapshot "${kubeconfig}") == "${before}" ]]; do
		(( SECONDS < deadline )) || die "${cluster} OCM agents did not reload the repaired endpoint"
		sleep 2
	done
}

identity_before=$(identity_snapshot)
runtime_a_pods_before=$(agent_pod_snapshot "${RUNTIME_A_KUBECONFIG}")
runtime_b_pods_before=$(agent_pod_snapshot "${RUNTIME_B_KUBECONFIG}")

set_secret_endpoint() {
	local kubeconfig=$1
	local secret=$2
	local endpoint=$3
	local encoded patch
	encoded=$(kubectl_for "${kubeconfig}" -n open-cluster-management-agent get secret "${secret}" \
		-o jsonpath='{.data.kubeconfig}' | base64 --decode | \
		sed -E "s#^([[:space:]]*server:)[[:space:]].*#\\1 ${endpoint}#" | base64 -w0)
	patch=$(jq -cn --arg kubeconfig "${encoded}" '{data:{kubeconfig:$kubeconfig}}')
	kubectl_for "${kubeconfig}" -n open-cluster-management-agent patch secret "${secret}" \
		--type=merge -p "${patch}" >/dev/null
}

recover() {
	repair_runtime_hub_endpoint runtime-a "${RUNTIME_A_KUBECONFIG}" || true
	repair_runtime_hub_endpoint runtime-b "${RUNTIME_B_KUBECONFIG}" || true
}
trap recover EXIT

log "injecting the legacy ephemeral-IP failure into both spoke kubeconfigs"
for kubeconfig in "${RUNTIME_A_KUBECONFIG}" "${RUNTIME_B_KUBECONFIG}"; do
	for secret in bootstrap-hub-kubeconfig hub-kubeconfig-secret; do
		set_secret_endpoint "${kubeconfig}" "${secret}" https://192.0.2.1:6443
	done
done

recover
wait_for_agent_reload runtime-a "${RUNTIME_A_KUBECONFIG}" "${runtime_a_pods_before}"
wait_for_agent_reload runtime-b "${RUNTIME_B_KUBECONFIG}" "${runtime_b_pods_before}"
for entry in "runtime-a:${RUNTIME_A_KUBECONFIG}" "runtime-b:${RUNTIME_B_KUBECONFIG}"; do
	cluster=${entry%%:*}
	kubeconfig=${entry#*:}
	kubectl_for "${kubeconfig}" -n open-cluster-management-agent rollout status \
		deployment/klusterlet-registration-agent --timeout=3m >/dev/null
	kubectl_for "${kubeconfig}" -n open-cluster-management-agent rollout status \
		deployment/klusterlet-work-agent --timeout=3m >/dev/null
	kubectl_for "${HUB_KUBECONFIG}" wait managedcluster "${cluster}" \
		--for=condition=ManagedClusterConditionAvailable --timeout=5m >/dev/null
	for secret in bootstrap-hub-kubeconfig hub-kubeconfig-secret; do
		[[ $(hub_kubeconfig_server "${kubeconfig}" "${secret}") == "${HUB_INTERNAL_ENDPOINT}" ]] || \
			die "${cluster}/${secret} did not converge to the stable endpoint"
	done
done

identity_after=$(identity_snapshot)
[[ ${identity_after} == "${identity_before}" ]] || \
	die "endpoint repair replaced a ManagedCluster, ManifestWork, Claim, or Cell identity"

"${MESH_DIR}/verify.sh" >/dev/null

trap - EXIT
log "hub endpoint recovery E2E passed without replacing durable mesh identity"
