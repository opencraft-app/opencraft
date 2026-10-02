#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in kubectl jq; do require_command "${command}"; done

control_plane_deadline=$((SECONDS + 90))
while true; do
	claims=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcellclaim -o json)
	pool=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get shardpool local-mesh -o json)
	if [[ $(jq '[.items[] | select(.status.phase == "Bound")] | length' <<<"${claims}") == 2 && \
		$(jq -r '[.items[] | .status.placementDecision.targetClusterRef.name] | sort | join(",")' <<<"${claims}") == runtime-a,runtime-b && \
		$(jq -r '.status.readyCells' <<<"${pool}") == 2 && \
		$(jq -r '.status.admissionOpen' <<<"${pool}") == true ]]; then
		break
	fi
	(( SECONDS < control_plane_deadline )) || die "Claims and Pool did not converge to two pinned Bound Claims and two admission-ready Cells"
	sleep 2
done

kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-controller-system wait \
	deployment/local-environment-reporter --for=condition=Available --timeout=2m >/dev/null

for cluster in runtime-a runtime-b; do
	if [[ ${cluster} == runtime-a ]]; then kubeconfig=${RUNTIME_A_KUBECONFIG}; else kubeconfig=${RUNTIME_B_KUBECONFIG}; fi
	work=$(kubectl_for "${HUB_KUBECONFIG}" -n "${cluster}" get manifestwork -o json | jq -er '.items[] | select(.metadata.name != "local-mesh-smoke") | .metadata.name')
	kubectl_for "${HUB_KUBECONFIG}" -n "${cluster}" wait manifestwork "${work}" \
		--for=condition=Applied --timeout=2m >/dev/null
	scrape_type=$(kubectl_for "${HUB_KUBECONFIG}" -n "${cluster}" get manifestwork "${work}" -o jsonpath='{.spec.manifestConfigs[0].feedbackScrapeType}')
	[[ ${scrape_type} == Watch ]] || die "${cluster} Cell feedback is not watch-driven"
	kubectl_for "${kubeconfig}" -n actor-fleet-system wait deployment local-cell-evidence-simulator \
		--for=condition=Available --timeout=2m >/dev/null
	report_deadline=$((SECONDS + 90))
	while true; do
		report=$(kubectl_for "${HUB_KUBECONFIG}" get rivetenvironmentreport "local-${cluster}" -o json)
		evidence=$(jq -r '.metadata.annotations["local.fleet.actor.dev/evidence"]' <<<"${report}")
		if [[ ( ${evidence} == prometheus-ready-nodes=* || ${evidence} == hub-federated-prometheus ) && \
			$(jq 'now - (.spec.observedAt | fromdateiso8601) < 45' <<<"${report}") == true ]]; then
			break
		fi
		(( SECONDS < report_deadline )) || die "${cluster} environment report did not converge to fresh Prometheus evidence"
		sleep 2
	done
done

prometheus_proxy='/api/v1/namespaces/mesh-observability/services/http:actor-mesh-observability-prometheus:9090/proxy'
targets_deadline=$((SECONDS + 90))
while true; do
	targets=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${prometheus_proxy}/api/v1/targets")
	if [[ $(jq '[.data.activeTargets[] | select(.labels.federation == "actor-cell" and .health == "up")] | length' <<<"${targets}") == 2 ]]; then
		break
	fi
	(( SECONDS < targets_deadline )) || die "both federation targets are not healthy"
	sleep 2
done

query='actor_fleet%3Acell_inventory%20and%20%28time%28%29%20-%20actor_fleet%3Acell_heartbeat_seconds%20%3C%2060%29'
inventory_deadline=$((SECONDS + 90))
while true; do
	inventory=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${prometheus_proxy}/api/v1/query?query=${query}")
	if [[ $(jq -r '[.data.result[].metric.cluster] | sort | join(",")' <<<"${inventory}") == runtime-a,runtime-b ]]; then
		break
	fi
	(( SECONDS < inventory_deadline )) || die "fresh federated inventory is not exactly one Cell per runtime"
	sleep 2
done

kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability get configmap actor-mesh-overview-dashboard >/dev/null
log "federated placement verified: two healthy scrape targets, two fresh Cells, two Bound Claims, Grafana dashboard present"
