#!/usr/bin/env bash
set -euo pipefail

API_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${API_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

for command in curl jq kubectl python3; do
	require_command "${command}"
done

port=$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)
internal_port=$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)
log_file=${MESH_STATE_DIR}/workers-api-port-forward.log
kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system port-forward service/workers-api "${port}:8080" >"${log_file}" 2>&1 &
forward_pid=$!
internal_log_file=${MESH_STATE_DIR}/workers-object-router-port-forward.log
kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system port-forward service/workers-object-router "${internal_port}:8081" >"${internal_log_file}" 2>&1 &
internal_forward_pid=$!
trap 'kill "${forward_pid}" "${internal_forward_pid}" >/dev/null 2>&1 || true; wait "${forward_pid}" "${internal_forward_pid}" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
	if curl --fail --silent --max-time 1 "http://127.0.0.1:${port}/readyz" >/dev/null; then
		break
	fi
	sleep 0.25
done
ready=$(curl --fail --silent --max-time 2 "http://127.0.0.1:${port}/readyz")
jq -e '.status == "ready"' <<<"${ready}" >/dev/null
replicas=$(kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system get deployment workers-api -o json)
jq -e '
  .spec.replicas >= 3 and
  .status.readyReplicas == .spec.replicas and
  .status.updatedReplicas == .spec.replicas and
  .status.availableReplicas == .spec.replicas and
  .spec.template.spec.automountServiceAccountToken == true
' <<<"${replicas}" >/dev/null || die "Workers API does not have its complete HPA-managed replica set Ready"
jq -e '
  [.spec.template.spec.containers[] | select(.name == "workers-api") | .args[]] as $args |
  ([$args[] | select(startswith("--engine-cell-uid="))] | length) == 2 and
  ([$args[] | select(startswith("--engine-pool-uid="))] | length) == 2 and
  ($args | index("--internal-listen-address=:8081")) != null and
  ($args | index("--object-miss-capacity=4096")) != null and
  ($args | index("--serving-route-source=static")) != null and
  ([$args[] | select(startswith("--stateless-executor-url="))] | length) == 2 and
  ([$args[] | select(startswith("--stateless-executor-token="))] | length) == 2 and
  ([$args[] | select(startswith("--object-router-token="))] | length) == 2 and
  all($args[]; contains("__") | not)
' <<<"${replicas}" >/dev/null
pdb=$(kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system get poddisruptionbudget workers-api -o json)
jq -e '.spec.maxUnavailable == 1' <<<"${pdb}" >/dev/null || die "Workers API PDB lost bounded disruption"
workers=$(curl --fail --silent --max-time 2 "http://127.0.0.1:${port}/v1/workers")
jq -e '.workers | type == "array"' <<<"${workers}" >/dev/null
if grep -Eqi 'namespace|runner|datacenter|actor_id' <<<"${workers}"; then
	die "Workers API leaked private topology"
fi
metrics=$(curl --fail --silent --max-time 2 "http://127.0.0.1:${port}/metrics")
for metric in \
	worker_dispatch_requests_total \
	object_router_requests_total \
	object_router_cache_requests_total \
	object_router_registry_seconds \
	object_router_route_revision \
	object_router_inflight \
	object_router_indeterminate_total; do
	grep -q "${metric}" <<<"${metrics}" || die "Workers API metrics omitted ${metric}"
done
object_path="/internal/v1/workers/counter/objects/Counter/$(printf 'a%.0s' {1..64})/fetch"
object_router_token=$(kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system get secret \
	workers-api-local-stateless-auth -o jsonpath='{.data.object-router-a-token}' | base64 --decode)
public_internal_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
	-H "X-Rivet-Object-Router-Token: ${object_router_token}" \
	-H 'X-Rivet-Original-URL: not-a-url' "http://127.0.0.1:${port}${object_path}")
[[ "${public_internal_status}" == "404" ]] || die "public listener exposed Object Router route"
internal_unauthorized_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
	-H 'X-Rivet-Original-URL: not-a-url' "http://127.0.0.1:${internal_port}${object_path}")
[[ "${internal_unauthorized_status}" == "404" ]] || die "Object Router accepted an unauthenticated request"
internal_authorized_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
	-H "X-Rivet-Object-Router-Token: ${object_router_token}" \
	-H 'X-Rivet-Original-URL: not-a-url' "http://127.0.0.1:${internal_port}${object_path}")
[[ "${internal_authorized_status}" == "400" ]] || die "Object Router capability listener did not authenticate independently"
private_service=$(kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system get service \
	workers-object-router-private -o json)
jq -e '.spec.type == "NodePort" and .spec.ports[0].nodePort == 30083' <<<"${private_service}" >/dev/null
routes=$(kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system get configmap -l fleet.actor.dev/cell-route=true -o json)
jq -e '.items | length == 2 and all(.[]; .immutable == true)' <<<"$routes" >/dev/null

prometheus_proxy=/api/v1/namespaces/mesh-observability/services/http:actor-mesh-observability-prometheus:9090/proxy
query=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("count(up{namespace=\"workers-api-system\",service=\"workers-api\"} == 1)", safe=""))')
scrape_ready=false
for _ in $(seq 1 60); do
	ready_replicas=$(kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system get deployment workers-api \
		-o jsonpath='{.status.readyReplicas}')
	if snapshot=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${prometheus_proxy}/api/v1/query?query=${query}" 2>/dev/null) && \
		jq -e --arg ready "${ready_replicas}" '.status == "success" and .data.result[0].value[1] == $ready' \
			<<<"${snapshot}" >/dev/null 2>&1; then
		scrape_ready=true
		break
	fi
	sleep 0.5
done
[[ ${scrape_ready} == true ]] || die "Hub Prometheus did not discover the complete Workers API replica set"
hpa=$(kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system get hpa workers-api -o json)
jq -e '
  .spec.minReplicas == 3 and .spec.maxReplicas == 30 and
  any(.status.conditions[]?; .type == "ScalingActive" and .status == "True")
' <<<"${hpa}" >/dev/null || die "Workers API HPA is not active"
custom_metrics=$(kubectl_for "${HUB_KUBECONFIG}" get --raw \
	'/apis/custom.metrics.k8s.io/v1beta1/namespaces/workers-api-system/pods/*/workers_api_routing_requests_in_flight')
jq -e --argjson ready "${ready_replicas}" '
  .kind == "MetricValueList" and (.items | length) == $ready and
  all(.items[]; .describedObject.kind == "Pod" and .metricName == "workers_api_routing_requests_in_flight")
' <<<"${custom_metrics}" >/dev/null || die "Workers API bounded custom metrics are unavailable"
rules=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${prometheus_proxy}/api/v1/rules")
jq -e '
	[.data.groups[] | select(.name == "actor-mesh-workers-api-recording" or .name == "actor-mesh-workers-api-alerts")]
	| length == 2
' <<<"${rules}" >/dev/null || die "Hub Prometheus omitted Workers API recording or alert rules"
stateless_query=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("count(actor_fleet:cell_stateless_expected == 1) == 2 and count(actor_fleet:cell_stateless_up == 1) == 2", safe=""))')
stateless=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${prometheus_proxy}/api/v1/query?query=${stateless_query}")
jq -e '.status == "success" and (.data.result | length) == 1 and .data.result[0].value[1] == "2"' \
	<<<"${stateless}" >/dev/null || die "Hub Prometheus omitted the two healthy stateless Cell aggregates"
grafana_proxy=/api/v1/namespaces/mesh-observability/services/http:actor-mesh-observability-grafana:80/proxy
dashboard=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${grafana_proxy}/grafana/api/search?query=Workers")
jq -e 'any(.[]; .uid == "actor-mesh-workers" and .title == "Workers 与 Durable Objects")' \
	<<<"${dashboard}" >/dev/null || die "Grafana did not load the Workers and Durable Objects dashboard"
dashboard=$(kubectl_for "${HUB_KUBECONFIG}" get --raw "${grafana_proxy}/grafana/api/dashboards/uid/actor-mesh-workers")
jq -e '
	[.dashboard.panels[].title] as $titles |
	all(["逐 Cell 无状态并发与排队", "无状态 Pod 与待调度容量"][]; . as $title | $titles | index($title) != null)
' <<<"${dashboard}" >/dev/null || die "Grafana Workers dashboard omitted stateless Cell capacity panels"

log "Workers API public /v1, isolated Object Router, HPA/custom metrics, Prometheus rules, and Chinese Grafana dashboard are ready"
