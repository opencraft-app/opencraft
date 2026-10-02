#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

[[ $# -eq 2 ]] || die "usage: $0 <runtime-a|runtime-b> <available-cell-slots>"
cluster=$1
slots=$2
[[ ${cluster} == runtime-a || ${cluster} == runtime-b ]] || die "unknown runtime ${cluster}"
[[ ${slots} == 0 || ${slots} == 1 ]] || die "available-cell-slots must be 0 or 1 for the one-Cell local environment"
if [[ ${cluster} == runtime-a ]]; then
	kubeconfig=${RUNTIME_A_KUBECONFIG}
else
	kubeconfig=${RUNTIME_B_KUBECONFIG}
fi

# This is deliberately based on a live Prometheus query rather than a prefilled
# capacity fixture. The local harness simulates only the not-yet-installed FDB
# Operator and Cell controller readiness bits.
query='/api/v1/namespaces/observability/services/http:actor-observability-prometheus:9090/proxy/api/v1/query?query=count(kube_node_status_condition%7Bcondition%3D%22Ready%22%2Cstatus%3D%22true%22%7D)'
response=$(kubectl_for "${kubeconfig}" get --raw "${query}")
ready_nodes=$(jq -r 'if .status == "success" and (.data.result | length) == 1 then .data.result[0].value[1] | tonumber | floor else error("Prometheus has no ready-node evidence") end' <<<"${response}")
(( ready_nodes > 0 )) || die "Prometheus reports no Ready nodes for ${cluster}"

cluster_uid=$(kubectl_for "${HUB_KUBECONFIG}" get managedcluster "${cluster}" -o jsonpath='{.metadata.uid}')
cluster_generation=$(kubectl_for "${HUB_KUBECONFIG}" get managedcluster "${cluster}" -o jsonpath='{.metadata.generation}')
report_name=local-${cluster}
if kubectl_for "${HUB_KUBECONFIG}" get rivetenvironmentreport "${report_name}" >/dev/null 2>&1; then
	existing_ref=$(kubectl_for "${HUB_KUBECONFIG}" get rivetenvironmentreport "${report_name}" -o json)
	existing_uid=$(jq -r '.spec.managedClusterRef.uid' <<<"${existing_ref}")
	existing_generation=$(jq -r '.spec.managedClusterRef.generation' <<<"${existing_ref}")
	if [[ ${existing_uid} != "${cluster_uid}" || ${existing_generation} != "${cluster_generation}" ]]; then
		log "recreating ${report_name}: ManagedCluster fence advanced from ${existing_uid}/${existing_generation} to ${cluster_uid}/${cluster_generation}"
		kubectl_for "${HUB_KUBECONFIG}" delete rivetenvironmentreport "${report_name}" --wait=true >/dev/null
	fi
fi
current=$((1 - slots))
observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat <<EOF | kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null
apiVersion: fleet.actor.dev/v1alpha1
kind: RivetEnvironmentReport
metadata:
  name: ${report_name}
  annotations:
    local.fleet.actor.dev/evidence: prometheus-ready-nodes=${ready_nodes}
    local.fleet.actor.dev/simulated-components: fdb-operator,cell-controller
spec:
  managedClusterRef:
    name: ${cluster}
    uid: ${cluster_uid}
    generation: ${cluster_generation}
  observedManagedClusterGeneration: ${cluster_generation}
  observedAt: ${observed_at}
  region: local
  health:
    reachable: true
    apiReady: true
    cellControllerReady: true
    fdbOperatorReady: true
  capacity:
    maxCells: 1
    currentCells: ${current}
    provisioningCells: 0
    availableCellSlots: ${slots}
    allocatableCellUnits: ${ready_nodes}
    maxConcurrentProvisioning: 1
EOF
log "synced ${cluster}: Prometheus ready_nodes=${ready_nodes}, available_slots=${slots}"
