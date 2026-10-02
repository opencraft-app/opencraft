#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in docker k3d kubectl jq; do require_command "${command}"; done

prometheus_proxy='/api/v1/namespaces/mesh-observability/services/http:actor-mesh-observability-prometheus:9090/proxy'
runtime_b_stopped=false

recover_runtime_b() {
	if [[ ${runtime_b_stopped} == true ]]; then
		log "recovering ${RUNTIME_B_CLUSTER} after interrupted failure test"
		k3d cluster start "${RUNTIME_B_CLUSTER}" >/dev/null || true
	fi
}
trap recover_runtime_b EXIT

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

target_b_down() {
	local targets
	targets=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${prometheus_proxy}/api/v1/targets")
	[[ $(jq -r '.data.activeTargets[] | select(.labels.cluster == "runtime-b" and .labels.federation == "actor-cell") | .health' <<<"${targets}") == down ]]
}

target_b_up() {
	local targets
	targets=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${prometheus_proxy}/api/v1/targets")
	[[ $(jq -r '.data.activeTargets[] | select(.labels.cluster == "runtime-b" and .labels.federation == "actor-cell") | .health' <<<"${targets}") == up ]]
}

runtime_b_unavailable() {
	local status
	status=$(kubectl_for "${HUB_KUBECONFIG}" get managedcluster runtime-b -o json | jq -r '.status.conditions[] | select(.type == "ManagedClusterConditionAvailable") | .status')
	[[ ${status} == Unknown || ${status} == False ]]
}

runtime_b_available() {
	[[ $(kubectl_for "${HUB_KUBECONFIG}" get managedcluster runtime-b -o json | jq -r '.status.conditions[] | select(.type == "ManagedClusterConditionAvailable") | .status') == True ]]
}

pool_closed() {
	[[ $(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get shardpool local-mesh -o jsonpath='{.status.admissionOpen}') == false ]]
}

pool_open() {
	local pool
	pool=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get shardpool local-mesh -o json)
	[[ $(jq -r '.status.admissionOpen' <<<"${pool}") == true && $(jq -r '.status.readyCells' <<<"${pool}") == 2 ]]
}

refresh_all_evidence() {
	"${MESH_DIR}/refresh-spoke-feedback.sh" runtime-a
	"${MESH_DIR}/refresh-spoke-feedback.sh" runtime-b
	"${MESH_DIR}/sync-environment-report.sh" runtime-a 0
	"${MESH_DIR}/sync-environment-report.sh" runtime-b 0
	wait_until pool_open 90 "Pool admission to reopen from fresh evidence"
}

identity_snapshot() {
	local hub_claims hub_works managed spoke_a spoke_b
	hub_claims=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcellclaim -o json)
	hub_works=$(kubectl_for "${HUB_KUBECONFIG}" get manifestwork -A -o json)
	managed=$(kubectl_for "${HUB_KUBECONFIG}" get managedcluster runtime-a runtime-b -o json)
	spoke_a=$(kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fleet-system get rivetcell -o json)
	spoke_b=$(kubectl_for "${RUNTIME_B_KUBECONFIG}" -n actor-fleet-system get rivetcell -o json)
	jq -cn \
		--argjson claims "${hub_claims}" --argjson works "${hub_works}" --argjson managed "${managed}" \
		--argjson spokeA "${spoke_a}" --argjson spokeB "${spoke_b}" \
		'{managed:[$managed.items[]|{name:.metadata.name,uid:.metadata.uid}]|sort_by(.name),claims:[$claims.items[]|{name:.metadata.name,uid:.metadata.uid,target:.status.placementDecision.targetClusterRef.name,targetGeneration:.status.placementDecision.targetClusterRef.generation,provider:.status.providerRef,workUID:.status.workRef.uid,logicalUID:.status.cellRef.uid,spokeUID:.status.spokeCellRef.uid}]|sort_by(.name),works:[$works.items[]|select(.metadata.name!="local-mesh-smoke")|{namespace:.metadata.namespace,name:.metadata.name,uid:.metadata.uid}]|sort_by(.namespace),spokes:([$spokeA.items[],$spokeB.items[]]|map({cluster:.spec.managementCluster,name:.metadata.name,uid:.metadata.uid})|sort_by(.cluster))}'
}

refresh_all_evidence
"${MESH_DIR}/verify-federated-placement.sh"
before=$(identity_snapshot)

log "restarting the Hub fleet controller"
kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-controller-system delete pod \
	-l app.kubernetes.io/name=actor-fleet-controller --wait=false >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-controller-system rollout status \
	deployment/actor-fleet-controller --timeout=3m >/dev/null
sleep 5
after_controller_restart=$(identity_snapshot)
[[ ${after_controller_restart} == "${before}" ]] || die "controller restart changed durable placement identities"

log "stopping ${RUNTIME_B_CLUSTER} to create a real spoke and federation outage"
k3d cluster stop "${RUNTIME_B_CLUSTER}" >/dev/null
runtime_b_stopped=true
wait_until target_b_down 90 "runtime-b federation target to become down"
wait_until pool_closed 120 "stale spoke evidence to close Pool admission"
# OCM intentionally grants several missed lease renewals; its default hub
# health transition is about five minutes, much slower than our 45-second
# admission freshness fence.
wait_until runtime_b_unavailable 360 "runtime-b ManagedCluster lease to become unavailable"

during=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcellclaim -o json)
[[ $(jq '.items | length' <<<"${during}") == 2 ]] || die "spoke outage created or removed a Claim"
[[ $(jq '[.items[] | select(.status.phase == "Bound")] | length' <<<"${during}") == 2 ]] || die "spoke outage rewrote durable Claim binding"

log "starting ${RUNTIME_B_CLUSTER} and requiring identity-preserving recovery"
k3d cluster start "${RUNTIME_B_CLUSTER}" >/dev/null
runtime_b_stopped=false
kubectl_for "${RUNTIME_B_KUBECONFIG}" wait node --all --for=condition=Ready --timeout=5m >/dev/null
wait_until runtime_b_available 360 "runtime-b ManagedCluster to recover"
wait_until target_b_up 120 "runtime-b federation target to recover"
refresh_all_evidence
after=$(identity_snapshot)
[[ ${after} == "${before}" ]] || die "spoke recovery changed ManagedCluster, Claim, Work, logical Cell, or spoke Cell identity"

"${MESH_DIR}/verify-federated-placement.sh"
log "failure recovery E2E passed: outage closed admission and recovery preserved every durable identity"
