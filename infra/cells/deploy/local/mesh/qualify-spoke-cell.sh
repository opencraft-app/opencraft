#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

[[ $# -eq 1 ]] || die "usage: $0 <runtime-a|runtime-b>"
cluster=$1
if [[ ${cluster} == runtime-a ]]; then
	kubeconfig=${RUNTIME_A_KUBECONFIG}
elif [[ ${cluster} == runtime-b ]]; then
	kubeconfig=${RUNTIME_B_KUBECONFIG}
else
	die "unknown runtime ${cluster}"
fi

deadline=$((SECONDS + 180))
cell=
while (( SECONDS < deadline )); do
	cells=$(kubectl_for "${kubeconfig}" -n actor-fleet-system get rivetcell -o json)
	count=$(jq '.items | length' <<<"${cells}")
	if [[ ${count} == 1 ]]; then
		cell=$(jq -r '.items[0].metadata.name' <<<"${cells}")
		break
	fi
	(( count == 0 )) || die "expected one spoke Cell in ${cluster}, found ${count}"
	sleep 2
done
[[ -n ${cell} ]] || die "timed out waiting for spoke Cell in ${cluster}"
generation=$(kubectl_for "${kubeconfig}" -n actor-fleet-system get rivetcell "${cell}" -o jsonpath='{.metadata.generation}')
observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
patch=$(jq -cn --arg observedAt "${observed_at}" --argjson generation "${generation}" '{status:{observedGeneration:$generation,phase:"Ready",readyForPlacement:true,capacityRisk:"Normal",scaleOutEpoch:0,placementCount:0,pendingReservations:0,reportObservedAt:$observedAt,scaleInEvidenceReady:false,placementUtilizationPercent:0,runtimeUtilizationPercent:0,fdbWriteUtilizationPercent:0,activeWriters:0,inFlightCommits:0,migrationBacklog:0,compactionBacklog:0,gcBacklog:0,reconciliationBacklog:0,retirementProofVerified:false,retirementProofReady:false,fdbOperatorReady:true}}')
kubectl_for "${kubeconfig}" -n actor-fleet-system patch rivetcell "${cell}" --subresource=status --type=merge -p "${patch}" >/dev/null
log "qualified simulated spoke Cell ${cluster}/${cell}; OCM feedback remains real"
