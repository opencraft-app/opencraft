#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

window=${STEADY_STATE_WINDOW_SECONDS:-50}
[[ ${window} =~ ^[0-9]+$ && ${window} -ge 20 ]] || die "STEADY_STATE_WINDOW_SECONDS must be at least 20"

cell_timestamps() {
	kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcell -o json | \
		jq -c '[.items[] | {cluster:.spec.managementCluster,observedAt:.status.reportObservedAt}] | sort_by(.cluster)'
}

environment_timestamps() {
	kubectl_for "${HUB_KUBECONFIG}" get rivetenvironmentreport -o json | \
		jq -c '[.items[] | {cluster:.spec.managedClusterRef.name,observedAt:.spec.observedAt}] | sort_by(.cluster)'
}

"${MESH_DIR}/verify-federated-placement.sh"
before_cells=$(cell_timestamps)
before_environments=$(environment_timestamps)
log "observing Watch-driven Cell and federated environment evidence for ${window}s"
sleep "${window}"
after_cells=$(cell_timestamps)
after_environments=$(environment_timestamps)
for cluster in runtime-a runtime-b; do
	old=$(jq -r --arg cluster "${cluster}" '.[] | select(.cluster == $cluster) | .observedAt' <<<"${before_cells}")
	new=$(jq -r --arg cluster "${cluster}" '.[] | select(.cluster == $cluster) | .observedAt' <<<"${after_cells}")
	[[ ${new} > "${old}" ]] || die "${cluster} Cell evidence did not advance: ${old} -> ${new}"
	old=$(jq -r --arg cluster "${cluster}" '.[] | select(.cluster == $cluster) | .observedAt' <<<"${before_environments}")
	new=$(jq -r --arg cluster "${cluster}" '.[] | select(.cluster == $cluster) | .observedAt' <<<"${after_environments}")
	[[ ${new} > "${old}" ]] || die "${cluster} environment evidence did not advance: ${old} -> ${new}"
done
"${MESH_DIR}/verify-federated-placement.sh"
log "steady-state E2E passed: Cell and environment timestamps advanced and admission remained open"
