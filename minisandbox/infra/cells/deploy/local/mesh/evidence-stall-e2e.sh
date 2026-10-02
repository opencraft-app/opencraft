#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in kubectl jq; do require_command "${command}"; done

simulator=local-cell-evidence-simulator
simulator_stopped=false

recover_simulator() {
	if [[ ${simulator_stopped} == true ]]; then
		log "recovering runtime-b evidence simulator after interrupted test"
		kubectl_for "${RUNTIME_B_KUBECONFIG}" -n actor-fleet-system scale \
			deployment/${simulator} --replicas=1 >/dev/null || true
	fi
}
trap recover_simulator EXIT

wait_until() {
	local predicate=$1
	local timeout=$2
	local description=$3
	local deadline=$((SECONDS + timeout))
	while (( SECONDS < deadline )); do
		if "${predicate}"; then return; fi
		sleep 2
	done
	die "timed out waiting for ${description}"
}

pool_closed() {
	[[ $(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get shardpool local-mesh \
		-o jsonpath='{.status.admissionOpen}') == false ]]
}

pool_open() {
	local pool
	pool=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get shardpool local-mesh -o json)
	[[ $(jq -r '.status.admissionOpen' <<<"${pool}") == true && \
		$(jq -r '.status.readyCells' <<<"${pool}") == 2 ]]
}

runtime_b_target_up() {
	local proxy='/api/v1/namespaces/mesh-observability/services/http:actor-mesh-observability-prometheus:9090/proxy'
	local targets
	targets=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${proxy}/api/v1/targets")
	[[ $(jq -r '.data.activeTargets[] | select(.labels.cluster == "runtime-b" and .labels.federation == "actor-cell") | .health' <<<"${targets}") == up ]]
}

simulator_has_no_pods() {
	[[ $(kubectl_for "${RUNTIME_B_KUBECONFIG}" -n actor-fleet-system get pod \
		-l app.kubernetes.io/name=${simulator} -o json | jq '.items | length') == 0 ]]
}

identity_snapshot() {
	local claims works cells
	claims=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcellclaim -o json)
	works=$(kubectl_for "${HUB_KUBECONFIG}" get manifestwork -A -o json)
	cells=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcell -o json)
	jq -cn --argjson claims "${claims}" --argjson works "${works}" --argjson cells "${cells}" \
		'{claims:[$claims.items[]|{name:.metadata.name,uid:.metadata.uid,provider:.status.providerRef,workUID:.status.workRef.uid,logicalUID:.status.cellRef.uid,spokeUID:.status.spokeCellRef.uid}]|sort_by(.name),works:[$works.items[]|select(.metadata.name!="local-mesh-smoke")|{namespace:.metadata.namespace,name:.metadata.name,uid:.metadata.uid}]|sort_by(.namespace),cells:[$cells.items[]|{name:.metadata.name,uid:.metadata.uid}]|sort_by(.name)}'
}

runtime_b_observed_at() {
	kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcell -o json | \
		jq -er '.items[] | select(.spec.managementCluster == "runtime-b") | .status.reportObservedAt'
}

"${MESH_DIR}/verify-federated-placement.sh"
before=$(identity_snapshot)
before_observed=$(runtime_b_observed_at)

log "stopping only runtime-b Cell evidence production while its API, OCM, and Prometheus stay online"
kubectl_for "${RUNTIME_B_KUBECONFIG}" -n actor-fleet-system scale \
	deployment/${simulator} --replicas=0 >/dev/null
simulator_stopped=true
wait_until simulator_has_no_pods 120 "runtime-b evidence producer to stop"

wait_until pool_closed 120 "stale Cell evidence to close Pool admission"
runtime_b_target_up || die "federation target went down; test did not isolate an evidence stall"
stalled_observed=$(runtime_b_observed_at)
[[ ${stalled_observed} == "${before_observed}" ]] || die "runtime-b evidence advanced while its producer was stopped"
[[ $(identity_snapshot) == "${before}" ]] || die "evidence stall changed durable placement identities"

log "restarting runtime-b evidence production"
kubectl_for "${RUNTIME_B_KUBECONFIG}" -n actor-fleet-system scale \
	deployment/${simulator} --replicas=1 >/dev/null
simulator_stopped=false
kubectl_for "${RUNTIME_B_KUBECONFIG}" -n actor-fleet-system rollout status \
	deployment/${simulator} --timeout=2m >/dev/null
wait_until pool_open 120 "fresh Watch feedback to reopen Pool admission"

after_observed=$(runtime_b_observed_at)
[[ ${after_observed} > "${before_observed}" ]] || die "runtime-b evidence did not advance after recovery"
[[ $(identity_snapshot) == "${before}" ]] || die "evidence recovery changed durable placement identities"

"${MESH_DIR}/verify-federated-placement.sh"
log "evidence-stall E2E passed: fresh-evidence fencing failed closed and recovered without identity drift"
