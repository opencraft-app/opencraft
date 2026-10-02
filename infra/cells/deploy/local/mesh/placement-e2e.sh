#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in kubectl jq; do require_command "${command}"; done

wait_for_count() {
	local counter=$1
	local expected=$2
	local description=$3
	local deadline=$((SECONDS + 300))
	while (( SECONDS < deadline )); do
		if [[ $("${counter}") == "${expected}" ]]; then return; fi
		sleep 2
	done
	die "timed out waiting for ${description}"
}

runtime_a_work_count() {
	kubectl_for "${HUB_KUBECONFIG}" -n runtime-a get manifestwork -o json | jq '[.items[] | select(.metadata.name != "local-mesh-smoke")] | length'
}

runtime_b_work_count() {
	kubectl_for "${HUB_KUBECONFIG}" -n runtime-b get manifestwork -o json | jq '[.items[] | select(.metadata.name != "local-mesh-smoke")] | length'
}

bound_claim_count() {
	kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcellclaim -o json | jq '[.items[] | select(.status.phase == "Bound")] | length'
}

if kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get shardpool local-mesh >/dev/null 2>&1; then
	existing_claims=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcellclaim -o json)
	if [[ $(jq '[.items[] | select(.status.phase == "Bound")] | length' <<<"${existing_claims}") == 2 ]] && \
		[[ $(jq -r '[.items[] | .status.placementDecision.targetClusterRef.name] | sort | join(",")' <<<"${existing_claims}") == runtime-a,runtime-b ]]; then
		"${MESH_DIR}/sync-environment-report.sh" runtime-a 0
		"${MESH_DIR}/sync-environment-report.sh" runtime-b 0
		kubectl_for "${HUB_KUBECONFIG}" apply -f "${MESH_DIR}/manifests/placement/hub-environment-reporter.yaml" >/dev/null
		kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-controller-system rollout status \
			deployment/local-environment-reporter --timeout=3m >/dev/null
		"${MESH_DIR}/verify-federated-placement.sh"
		log "placement E2E already converged: two Bound Claims remain pinned to runtime-a and runtime-b"
		exit 0
	fi
fi

"${MESH_DIR}/sync-environment-report.sh" runtime-a 1
"${MESH_DIR}/sync-environment-report.sh" runtime-b 1
for kubeconfig in "${RUNTIME_A_KUBECONFIG}" "${RUNTIME_B_KUBECONFIG}"; do
	kubectl_for "${kubeconfig}" create namespace actor-fleet-system --dry-run=client -o yaml | kubectl_for "${kubeconfig}" apply -f - >/dev/null
	kubectl_for "${kubeconfig}" apply -f "${MESH_DIR}/manifests/placement/spoke-work-rbac.yaml" >/dev/null
	kubectl_for "${kubeconfig}" apply -f "${MESH_DIR}/manifests/placement/spoke-cell-evidence-simulator.yaml" >/dev/null
done
kubectl_for "${HUB_KUBECONFIG}" apply -f "${MESH_DIR}/manifests/placement/fixture.yaml" >/dev/null

wait_for_count runtime_a_work_count 1 "first Work in runtime-a"
"${MESH_DIR}/sync-environment-report.sh" runtime-a 0
"${MESH_DIR}/refresh-spoke-feedback.sh" runtime-a
wait_for_count bound_claim_count 1 "first bound Claim"

wait_for_count runtime_b_work_count 1 "second Work in runtime-b"
"${MESH_DIR}/sync-environment-report.sh" runtime-b 0
"${MESH_DIR}/refresh-spoke-feedback.sh" runtime-b
wait_for_count bound_claim_count 2 "two bound Claims"

claims=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcellclaim -o json)
[[ $(jq '[.items[] | select(.status.phase == "Bound")] | length' <<<"${claims}") == 2 ]] || die "not all Claims are Bound"
[[ $(jq '[.items[] | .status.placementDecision.targetClusterRef.name] | sort | join(",")' <<<"${claims}") == runtime-a,runtime-b ]] || die "Claims were not distributed across both runtimes"

deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
	ready=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get shardpool local-mesh -o jsonpath='{.status.readyCells}')
	admission=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get shardpool local-mesh -o jsonpath='{.status.admissionOpen}')
	[[ ${ready} == 2 && ${admission} == true ]] && break
	sleep 2
done
[[ ${ready:-} == 2 && ${admission:-} == true ]] || die "Pool did not open admission with two Ready Cells"

kubectl_for "${HUB_KUBECONFIG}" apply -f "${MESH_DIR}/manifests/placement/hub-environment-reporter.yaml" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-controller-system rollout status \
	deployment/local-environment-reporter --timeout=3m >/dev/null
"${MESH_DIR}/verify-federated-placement.sh"
log "placement E2E passed: Prometheus evidence -> EnvironmentReport -> Pool -> Claims -> OCM Works -> two Ready Cells"
