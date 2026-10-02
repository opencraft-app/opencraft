#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in kubectl jq; do require_command "${command}"; done

prometheus=actor-observability-prometheus
prometheus_stopped=false
hub_proxy='/api/v1/namespaces/mesh-observability/services/http:actor-mesh-observability-prometheus:9090/proxy'

recover_prometheus() {
	if [[ ${prometheus_stopped} == true ]]; then
		log "recovering runtime-b Prometheus after interrupted test"
		kubectl_for "${RUNTIME_B_KUBECONFIG}" -n observability patch prometheus "${prometheus}" \
			--type=merge -p '{"spec":{"replicas":1}}' >/dev/null || true
	fi
}
trap recover_prometheus EXIT

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

prometheus_has_no_pods() {
	[[ $(kubectl_for "${RUNTIME_B_KUBECONFIG}" -n observability get pod \
		-l app.kubernetes.io/name=prometheus -o json | jq '.items | length') == 0 ]]
}

prometheus_ready() {
	[[ $(kubectl_for "${RUNTIME_B_KUBECONFIG}" -n observability get pod \
		-l app.kubernetes.io/name=prometheus -o json | \
		jq '[.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length') -ge 1 ]]
}

target_health_is() {
	local expected=$1
	local targets
	targets=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${hub_proxy}/api/v1/targets")
	[[ $(jq -r '.data.activeTargets[] | select(.labels.cluster == "runtime-b" and .labels.federation == "actor-cell") | .health' <<<"${targets}") == "${expected}" ]]
}

target_down() { target_health_is down; }
target_up() { target_health_is up; }

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

runtime_b_observed_at() {
	kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcell -o json | \
		jq -er '.items[] | select(.spec.managementCluster == "runtime-b") | .status.reportObservedAt'
}

runtime_b_environment_observed_at() {
	kubectl_for "${HUB_KUBECONFIG}" get rivetenvironmentreport local-runtime-b \
		-o jsonpath='{.spec.observedAt}'
}

environment_advanced() {
	[[ $(runtime_b_environment_observed_at) > "${stopped_environment_observed}" ]]
}

wait_for_evidence_quiescence() {
	local deadline=$((SECONDS + 120))
	local stable_since=${SECONDS}
	local last_cell last_environment current_cell current_environment
	last_cell=$(runtime_b_observed_at)
	last_environment=$(runtime_b_environment_observed_at)
	while (( SECONDS < deadline )); do
		sleep 2
		current_cell=$(runtime_b_observed_at)
		current_environment=$(runtime_b_environment_observed_at)
		if [[ ${current_cell} != "${last_cell}" || ${current_environment} != "${last_environment}" ]]; then
			last_cell=${current_cell}
			last_environment=${current_environment}
			stable_since=${SECONDS}
			continue
		fi
		if (( SECONDS - stable_since >= 20 )); then
			stopped_cell_observed=${last_cell}
			stopped_environment_observed=${last_environment}
			return 0
		fi
	done
	die "Cell/environment evidence did not quiesce after federation target went down"
}

federated_inventory_ready() {
	local query inventory
	query='actor_fleet%3Acell_inventory%20and%20%28time%28%29%20-%20actor_fleet%3Acell_heartbeat_seconds%20%3C%2060%29'
	inventory=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${hub_proxy}/api/v1/query?query=${query}")
	[[ $(jq -r '[.data.result[].metric.cluster] | sort | join(",")' <<<"${inventory}") == runtime-a,runtime-b ]]
}

identity_snapshot() {
	local claims works cells
	claims=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcellclaim -o json)
	works=$(kubectl_for "${HUB_KUBECONFIG}" get manifestwork -A -o json)
	cells=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcell -o json)
	jq -cn --argjson claims "${claims}" --argjson works "${works}" --argjson cells "${cells}" \
		'{claims:[$claims.items[]|{name:.metadata.name,uid:.metadata.uid,provider:.status.providerRef,workUID:.status.workRef.uid,logicalUID:.status.cellRef.uid,spokeUID:.status.spokeCellRef.uid}]|sort_by(.name),works:[$works.items[]|select(.metadata.name!="local-mesh-smoke")|{namespace:.metadata.namespace,name:.metadata.name,uid:.metadata.uid}]|sort_by(.namespace),cells:[$cells.items[]|{name:.metadata.name,uid:.metadata.uid}]|sort_by(.name)}'
}

"${MESH_DIR}/verify-federated-placement.sh"
before=$(identity_snapshot)

log "stopping runtime-b Prometheus while Kubernetes, OCM, and the Cell evidence process remain online"
kubectl_for "${RUNTIME_B_KUBECONFIG}" -n observability patch prometheus "${prometheus}" \
	--type=merge -p '{"spec":{"replicas":0}}' >/dev/null
prometheus_stopped=true
wait_until prometheus_has_no_pods 180 "runtime-b Prometheus Pod to stop"
wait_until target_down 120 "runtime-b federation target to become down"
wait_for_evidence_quiescence
wait_until pool_closed 120 "monitoring-backed Cell evidence to expire and close admission"

stalled_observed=$(runtime_b_observed_at)
[[ ${stalled_observed} == "${stopped_cell_observed}" ]] || die "Cell evidence advanced without Prometheus"
[[ $(runtime_b_environment_observed_at) == "${stopped_environment_observed}" ]] || die "environment evidence advanced after federation target went down"
[[ $(identity_snapshot) == "${before}" ]] || die "Prometheus outage changed durable placement identities"

log "restoring runtime-b Prometheus"
kubectl_for "${RUNTIME_B_KUBECONFIG}" -n observability patch prometheus "${prometheus}" \
	--type=merge -p '{"spec":{"replicas":1}}' >/dev/null
prometheus_stopped=false
wait_until prometheus_ready 300 "runtime-b Prometheus Pod to become Ready"
wait_until target_up 120 "runtime-b federation target to recover"
wait_until pool_open 120 "fresh monitoring-backed Watch feedback to reopen admission"
wait_until environment_advanced 120 "fresh federated environment evidence to resume"
wait_until federated_inventory_ready 120 "Hub recording rules to converge after Prometheus recovery"

after_observed=$(runtime_b_observed_at)
[[ ${after_observed} > "${stopped_cell_observed}" ]] || die "Cell evidence did not advance after Prometheus recovery"
environment_advanced || die "environment evidence did not advance after Prometheus recovery"
[[ $(identity_snapshot) == "${before}" ]] || die "Prometheus recovery changed durable placement identities"

"${MESH_DIR}/verify-federated-placement.sh"
log "Prometheus outage E2E passed: monitoring loss failed closed and recovered without identity drift"
