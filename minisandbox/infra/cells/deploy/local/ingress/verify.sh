#!/usr/bin/env bash
set -euo pipefail

INGRESS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${INGRESS_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

for command in curl jq kubectl; do
	require_command "${command}"
done

STATE_DIR=${MESH_STATE_DIR}/local-ingress
BINDING_FILE=${STATE_DIR}/binding.json
stored_bind_address=127.0.0.1
stored_http_port=18080
if [[ -f ${BINDING_FILE} ]]; then
	stored_bind_address=$(jq -er '.address | select(type == "string" and length > 0)' "${BINDING_FILE}") || \
		die "invalid ingress address in ${BINDING_FILE}"
	stored_http_port=$(jq -er '.httpPort | select(type == "number" and floor == .)' "${BINDING_FILE}") || \
		die "invalid ingress port in ${BINDING_FILE}"
fi
LOCAL_INGRESS_BIND_ADDRESS=${RIVET_LOCAL_INGRESS_BIND_ADDRESS:-${stored_bind_address}}
LOCAL_INGRESS_HTTP_PORT=${RIVET_LOCAL_INGRESS_HTTP_PORT:-${stored_http_port}}
base_url="http://${LOCAL_INGRESS_BIND_ADDRESS}:${LOCAL_INGRESS_HTTP_PORT}"

kubectl_for "${HUB_KUBECONFIG}" -n local-ingress-system wait deployment/local-ingress \
	--for=condition=Available --timeout=2m >/dev/null
runtime_a_fdb=
runtime_b_fdb=
for entry in "${RUNTIME_A_KUBECONFIG}:local-runtime-a:1" "${RUNTIME_B_KUBECONFIG}:local-runtime-b:2"; do
	kubeconfig=${entry%%:*}
	rest=${entry#*:}
	cell=${rest%%:*}
	expected_label=${rest#*:}
	node_ports=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get service "${cell}-ingress" \
		-o jsonpath='{range .spec.ports[*]}{.name}={.nodePort}{"\n"}{end}')
	grep -Fxq 'guard=30420' <<<"${node_ports}" || die "${cell} Guard NodePort is not 30420"
	grep -Fxq 'api-peer=30421' <<<"${node_ports}" || die "${cell} api-peer NodePort is not 30421"
	runtime_config=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system \
		get configmap "${cell}-runtime-config" -o jsonpath='{.data.config\.jsonc}')
	jq -e --argjson label "${expected_label}" \
		'.topology.datacenter_label == $label and (.topology.datacenters | keys | sort) == ["local-runtime-a", "local-runtime-b"]' \
		<<<"${runtime_config}" >/dev/null || die "${cell} does not have the expected two-Cell topology"
	fdb_config=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get deployment "${cell}-engine" \
		-o jsonpath='{.spec.template.spec.volumes[?(@.name=="fdb-config")].configMap.name}')
	if [[ ${cell} == local-runtime-a ]]; then runtime_a_fdb=${fdb_config}; else runtime_b_fdb=${fdb_config}; fi
done
[[ ${runtime_a_fdb} != "${runtime_b_fdb}" ]] || die "A and B unexpectedly reference the same FDB ConfigMap identity"

unexpected_hub_data_plane=$(kubectl_for "${HUB_KUBECONFIG}" get pods -A \
	-l 'fleet.actor.dev/component in (engine,nats,workerd-host)' -o name)
[[ -z ${unexpected_hub_data_plane} ]] || die "Hub cluster C contains runtime data-plane Pods: ${unexpected_hub_data_plane}"

leader_pod=$(kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system get pod \
	-l fleet.actor.dev/component=engine -o jsonpath='{.items[0].metadata.name}')
epoxy_state=$(kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system exec "${leader_pod}" -- \
	/usr/bin/curl --fail --silent --show-error http://127.0.0.1:6421/epoxy/coordinator/state)
jq -e '[.config.replicas[] | select(.status == "Active") | .replica_id] | sort == [1, 2]' \
	<<<"${epoxy_state}" >/dev/null || die "Epoxy does not have active A/B replicas"

deadline=$((SECONDS + 60))
until curl -fsS --max-time 3 -o /dev/null "${base_url}/healthz"; do
	(( SECONDS < deadline )) || die "Caddy did not become reachable at ${base_url}"
	sleep 2
done
landing=$(curl -fsS --max-time 3 "${base_url}/")
jq -e '.service == "rivet-local-ingress" and .status == "ok"' <<<"${landing}" >/dev/null || \
	die "local ingress landing response is invalid"
workers=$(curl -fsS --max-time 5 "${base_url}/v1/workers")
jq -e '.workers | type == "array"' <<<"${workers}" >/dev/null || \
	die "Workers API is not available through the public /v1 ingress"
if grep -Eqi 'namespace|runner|datacenter|actor_id' <<<"${workers}"; then
	die "public Workers API leaked private topology"
fi
legacy_registry_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
	"${base_url}/api/worker-registry/v1/namespaces/default/workers")
[[ ${legacy_registry_status} == 404 ]] || die "legacy Worker Registry API remains publicly reachable"
grafana_health=$(curl -fsS --max-time 5 "${base_url}/grafana/api/health")
jq -e '.database == "ok"' <<<"${grafana_health}" >/dev/null || \
	die "Hub Grafana health API is not available through the public ingress"
grafana_dashboards=$(curl -fsS --max-time 5 "${base_url}/grafana/api/search?type=dash-db")
jq -e '
	map(.uid) as $uids |
	["actor-mesh-cell-fleet", "actor-mesh-compute", "actor-mesh-storage"] |
	all(. as $uid | $uids | index($uid) != null)
' <<<"${grafana_dashboards}" >/dev/null || \
	die "anonymous Grafana API does not expose all fleet dashboards"
for dashboard_uid in actor-mesh-cell-fleet actor-mesh-compute actor-mesh-storage; do
	grafana_dashboard=$(curl -fsS --max-time 5 \
		"${base_url}/grafana/api/dashboards/uid/${dashboard_uid}")
	jq -e --arg uid "${dashboard_uid}" '.dashboard.uid == $uid' <<<"${grafana_dashboard}" >/dev/null || \
		die "anonymous Grafana API returned the wrong dashboard for ${dashboard_uid}"
done

verify_runtime() {
	local host=$1
	local response
	response=$(curl -fsS --max-time 5 -H "Host: ${host}.local" "${base_url}/health")
	jq -e '.runtime == "engine" and .status == "ok"' <<<"${response}" >/dev/null || \
		die "${host} did not return a healthy Engine response"
}

verify_runtime runtime-a
verify_runtime runtime-b
global_response=$(curl -fsS --max-time 5 "${base_url}/health")
jq -e '.runtime == "engine" and .status == "ok"' <<<"${global_response}" >/dev/null || \
	die "global ingress did not return a healthy Engine response"
log "local ingress is healthy at ${base_url}; Workers API is public at ${base_url}/v1 and Grafana at ${base_url}/grafana/"
