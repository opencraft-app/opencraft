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

"${MESH_DIR}/qualify-spoke-cell.sh" "${cluster}"
cell=$(kubectl_for "${kubeconfig}" -n actor-fleet-system get rivetcell -o json | jq -er '.items | if length == 1 then .[0].metadata.name else error("expected exactly one spoke Cell") end')
observed_at=$(kubectl_for "${kubeconfig}" -n actor-fleet-system get rivetcell "${cell}" -o jsonpath='{.status.reportObservedAt}')
work=$(kubectl_for "${HUB_KUBECONFIG}" -n "${cluster}" get manifestwork -o json | jq -er '.items[] | select(.metadata.name != "local-mesh-smoke") | .metadata.name')

# A recovered OCM work agent can need more than two minutes to re-establish its
# watches and publish status feedback even after ManagedClusterAvailable is
# True. Keep this bounded, but do not confuse that legitimate convergence lag
# with lost feedback.
deadline=$((SECONDS + ${OCM_FEEDBACK_TIMEOUT_SECONDS:-240}))
while (( SECONDS < deadline )); do
	kubectl_for "${HUB_KUBECONFIG}" -n "${cluster}" annotate manifestwork "${work}" \
		"local.fleet.actor.dev/feedback-request=$(date +%s%N)" --overwrite >/dev/null
	sleep 2
	feedback=$(kubectl_for "${HUB_KUBECONFIG}" -n "${cluster}" get manifestwork "${work}" -o json | \
		jq -r '.status.resourceStatus.manifests[0].statusFeedback.values[]? | select(.name == "reportObservedAt") | .fieldValue.string')
	hub_observed=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcell "${cell}" -o jsonpath='{.status.reportObservedAt}')
	if [[ ${feedback} == "${observed_at}" && ${hub_observed} == "${observed_at}" ]]; then
		log "OCM feedback converged for ${cluster}/${cell} at ${observed_at}"
		exit 0
	fi
done
die "OCM feedback for ${cluster}/${cell} did not converge to ${observed_at}"
