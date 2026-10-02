#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in docker k3d kubectl clusteradm; do
	require_command "${command}"
done

for cluster in "${HUB_CLUSTER}" "${RUNTIME_A_CLUSTER}" "${RUNTIME_B_CLUSTER}"; do
	cluster_exists "${cluster}" || die "cluster ${cluster} is missing"
done

for cluster in runtime-a runtime-b; do
	log "waiting for ${cluster} to become OCM Available"
	kubectl_for "${HUB_KUBECONFIG}" wait managedcluster "${cluster}" \
		--for=condition=ManagedClusterConditionAvailable --timeout=5m
	kubectl_for "${HUB_KUBECONFIG}" -n "${cluster}" wait manifestwork local-mesh-smoke \
		--for=condition=Applied --timeout=5m
done

for entry in "runtime-a:${RUNTIME_A_KUBECONFIG}" "runtime-b:${RUNTIME_B_KUBECONFIG}"; do
	cluster=${entry%%:*}
	kubeconfig=${entry#*:}
	control_nodes=$(kubectl_for "${kubeconfig}" get nodes -l rivet.dev/control=true \
		-o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | sed '/^$/d' | wc -l)
	compute_nodes=$(kubectl_for "${kubeconfig}" get nodes -l rivet.dev/compute=true \
		-o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | sed '/^$/d' | wc -l)
	[[ ${control_nodes} == 1 && ${compute_nodes} == 1 ]] || \
		die "${cluster} must have one disjoint control node and one compute node"
	if kubectl_for "${kubeconfig}" get nodes -l 'rivet.dev/control=true,rivet.dev/compute=true' \
		-o name | grep -q .; then
		die "${cluster} has a node carrying both control and compute identity"
	fi
	compute_taints=$(kubectl_for "${kubeconfig}" get nodes -l rivet.dev/compute=true \
		-o jsonpath='{range .items[*].spec.taints[*]}{.key}{"="}{.value}{":"}{.effect}{"\n"}{end}')
	grep -qx 'rivet.dev/compute=true:NoSchedule' <<<"${compute_taints}" || \
		die "${cluster} compute node is missing its NoSchedule isolation taint"
	actual=$(kubectl_for "${kubeconfig}" -n default get configmap local-mesh-smoke \
		-o jsonpath='{.data.managedCluster}')
	[[ ${actual} == "${cluster}" ]] || die "${cluster} received smoke identity ${actual}"
done

kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-controller-system wait deployment actor-fleet-controller \
	--for=condition=Available --timeout=2m

for crd in foundationdbclusters.apps.foundationdb.org machinesets.node.tke.cloud.tencent.com; do
	kubectl_for "${HUB_KUBECONFIG}" get crd "${crd}" >/dev/null || die "Hub is missing local external API double ${crd}"
done
controller_args=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-controller-system get deployment actor-fleet-controller \
	-o jsonpath='{.spec.template.spec.containers[0].args}')
[[ ${controller_args} == *--enable-fdb-kubernetes-provider=true* ]] || \
	die "fleet controller does not have the production FDB Kubernetes provider enabled"

if [[ -e /dev/kvm ]]; then
	for node in "k3d-${RUNTIME_A_CLUSTER}-agent-0" "k3d-${RUNTIME_B_CLUSTER}-agent-0"; do
		docker exec "${node}" test -c /dev/kvm || die "${node} has no /dev/kvm device"
	done
fi

health_deadline=$((SECONDS + 180))
while ! health_output=$("${MESH_DIR}/health-check.sh" 2>&1); do
	if (( SECONDS >= health_deadline )); then
		printf '%s\n' "${health_output}" >&2
		die "mesh did not reach a healthy evidence and admission state"
	fi
	sleep 5
done
printf '%s\n' "${health_output}"

log "three-cluster mesh is healthy"
kubectl_for "${HUB_KUBECONFIG}" get managedclusters
