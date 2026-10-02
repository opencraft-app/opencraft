#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in docker k3d kubectl clusteradm jq python3 sysctl; do
	require_command "${command}"
done
docker info >/dev/null 2>&1 || die "Docker daemon is not reachable"
require_version k3d "${K3D_VERSION}" "$(k3d version | awk '/^k3d version/ {print $3}')"
require_version clusteradm "${OCM_BUNDLE_VERSION}" "$(clusteradm version | awk -F: '/clusteradm.*version/ {gsub(/[[:space:]]/, "", $2); sub(/-.*/, "", $2); print $2}')"

inotify_instances=$(sysctl -n fs.inotify.max_user_instances)
if (( inotify_instances < 1024 )); then
	if (( EUID != 0 )); then
		die "fs.inotify.max_user_instances=${inotify_instances}; rerun as root or raise it to at least 1024"
	fi
	log "raising fs.inotify.max_user_instances from ${inotify_instances} to 1024 for three k3s clusters"
	sysctl -w fs.inotify.max_user_instances=1024 >/dev/null
fi

mkdir -p "${MESH_STATE_DIR}"
chmod 0700 "${MESH_STATE_DIR}"

if ! docker network inspect "${MESH_NETWORK}" >/dev/null 2>&1; then
	log "creating shared Docker network ${MESH_NETWORK}"
	docker network create "${MESH_NETWORK}" >/dev/null
fi

create_cluster() {
	local cluster=$1
	local api_port=$2
	local role=$3
	local kubelet_config=${MESH_DIR}/manifests/kubelet/10-local-disk-pressure.conf
	if cluster_exists "${cluster}"; then
		log "cluster ${cluster} already exists"
		return
	fi
	[[ -f ${kubelet_config} ]] || die "local kubelet configuration is missing: ${kubelet_config}"
	log "creating ${role} cluster ${cluster}"
	local args=(
		cluster create "${cluster}"
		--image "${K3S_IMAGE}"
		--network "${MESH_NETWORK}"
		--api-port "127.0.0.1:${api_port}"
		--servers 1
		--volume "${kubelet_config}:/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-local-disk-pressure.conf@server:*"
		--k3s-node-label 'rivet.dev/control=true@server:*'
		--k3s-arg '--disable=traefik@server:*'
		--kubeconfig-update-default=false
		--kubeconfig-switch-context=false
		--timeout 5m
		--wait
	)
	if [[ ${role} == runtime ]]; then
		args+=(
			--agents 1
			--volume "${kubelet_config}:/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-local-disk-pressure.conf@agent:*"
			--k3s-node-label 'rivet.dev/compute=true@agent:*'
		)
		if [[ -e /dev/kvm ]]; then
			args+=(--volume '/dev/kvm:/dev/kvm@agent:*' --k3s-node-label 'rivet.dev/pvm=true@agent:*')
		fi
	else
		args+=(--agents 0)
	fi
	k3d "${args[@]}"
}

create_cluster "${HUB_CLUSTER}" "${HUB_API_PORT}" hub
create_cluster "${RUNTIME_A_CLUSTER}" "${RUNTIME_A_API_PORT}" runtime
create_cluster "${RUNTIME_B_CLUSTER}" "${RUNTIME_B_API_PORT}" runtime

ensure_stateless_node() {
	local cluster=$1 short container
	# k3d appends the agent ordinal itself.  Supplying "-0" here would
	# create a node named "...-stateless-0-0" and break the stable local
	# admission target used by the stateless executor installer.
	short=${cluster}-stateless
	container=k3d-${cluster}-stateless-0
	if docker container inspect "${container}" >/dev/null 2>&1; then
		return
	fi
	log "creating isolated stateless baseline node ${container}"
	k3d node create "${short}" --cluster "${cluster}" --role agent \
		--k3s-node-label 'local.fleet.actor.dev/stateless-base=true' \
		--k3s-arg '--node-taint=rivet.dev/stateless=true:NoSchedule' \
		--k3s-arg '--node-taint=startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission=pending:NoSchedule' \
		--wait --timeout 5m
}

ensure_stateless_node "${RUNTIME_A_CLUSTER}"
ensure_stateless_node "${RUNTIME_B_CLUSTER}"

"${MESH_DIR}/seed-k3s-sandbox-image.sh" \
	"${HUB_CLUSTER}" "${RUNTIME_A_CLUSTER}" "${RUNTIME_B_CLUSTER}"

write_kubeconfig "${HUB_CLUSTER}" "${HUB_KUBECONFIG}"
write_kubeconfig "${RUNTIME_A_CLUSTER}" "${RUNTIME_A_KUBECONFIG}"
write_kubeconfig "${RUNTIME_B_CLUSTER}" "${RUNTIME_B_KUBECONFIG}"

prune_stale_stateless_base_nodes() {
	local kubeconfig=$1 desired=$2 node
	while IFS= read -r node; do
		[[ -n ${node} && ${node} != "${desired}" ]] || continue
		# Only the local baseline ownership label enters this loop.  If its
		# k3d container no longer exists, the Kubernetes Node is a stale API
		# object and must not continue contributing to capacity accounting.
		if ! docker container inspect "${node}" >/dev/null 2>&1; then
			log "pruning stale stateless baseline Node ${node}"
			kubectl_for "${kubeconfig}" delete node "${node}" --wait=false >/dev/null
		fi
	done < <(kubectl_for "${kubeconfig}" get nodes \
		-l 'local.fleet.actor.dev/stateless-base=true' \
		-o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
}

prune_stale_stateless_base_nodes "${RUNTIME_A_KUBECONFIG}" "k3d-${RUNTIME_A_CLUSTER}-stateless-0"
prune_stale_stateless_base_nodes "${RUNTIME_B_KUBECONFIG}" "k3d-${RUNTIME_B_CLUSTER}-stateless-0"

enforce_runtime_node_roles() {
	local kubeconfig=$1
	# Nodes owned by the stateless pool must never also enter the durable
	# compute pool.  Clear inherited k3d agent labels/taints first so all
	# subsequent selectors see disjoint capacity classes.
	kubectl_for "${kubeconfig}" label nodes -l 'local.fleet.actor.dev/stateless-base=true' \
		rivet.dev/compute- rivet.dev/control- --overwrite >/dev/null
	kubectl_for "${kubeconfig}" taint nodes -l 'local.fleet.actor.dev/stateless-base=true' \
		rivet.dev/compute- >/dev/null 2>&1 || true
	kubectl_for "${kubeconfig}" label nodes -l 'rivet.dev/compute=true,local.fleet.actor.dev/stateless-base!=true' \
		rivet.dev/control- --overwrite >/dev/null
	kubectl_for "${kubeconfig}" label nodes -l 'rivet.dev/compute!=true,local.fleet.actor.dev/stateless-base!=true' \
		rivet.dev/control=true --overwrite >/dev/null
	kubectl_for "${kubeconfig}" taint nodes -l 'rivet.dev/compute=true,local.fleet.actor.dev/stateless-base!=true' \
		rivet.dev/compute=true:NoSchedule --overwrite >/dev/null
}

enforce_runtime_node_roles "${RUNTIME_A_KUBECONFIG}"
enforce_runtime_node_roles "${RUNTIME_B_KUBECONFIG}"

if ! kubectl_for "${HUB_KUBECONFIG}" get clustermanager cluster-manager >/dev/null 2>&1; then
	log "installing OCM ${OCM_BUNDLE_VERSION} hub control plane"
	KUBECONFIG=${HUB_KUBECONFIG} clusteradm init \
		--bundle-version "${OCM_BUNDLE_VERSION}" \
		--use-bootstrap-token \
		--output-join-command-file "${JOIN_COMMAND_FILE}" \
		--wait
fi

if [[ ! -s ${JOIN_COMMAND_FILE} ]]; then
	KUBECONFIG=${HUB_KUBECONFIG} clusteradm get token \
		--use-bootstrap-token \
		--output-file "${JOIN_COMMAND_FILE}"
fi
chmod 0600 "${JOIN_COMMAND_FILE}"

hub_token=$(python3 - "${JOIN_COMMAND_FILE}" <<'PY'
import shlex
import sys

args = shlex.split(open(sys.argv[1], encoding="utf-8").read())
for index, value in enumerate(args):
    if value == "--hub-token" and index + 1 < len(args):
        print(args[index + 1])
        break
else:
    raise SystemExit("join command has no --hub-token")
PY
)
# k3d puts the server load balancer's stable Docker DNS name in the k3s API
# certificate. Spoke nodes resolve this name through the shared Docker network,
# while its address may change whenever Docker recreates a network endpoint.
hub_endpoint=${HUB_INTERNAL_ENDPOINT}

join_runtime() {
	local name=$1
	local kubeconfig=$2
	if kubectl_for "${HUB_KUBECONFIG}" get managedcluster "${name}" >/dev/null 2>&1; then
		log "managed cluster ${name} already registered"
		repair_runtime_hub_endpoint "${name}" "${kubeconfig}"
		return
	fi
	log "joining ${name} to the OCM hub"
	KUBECONFIG=${kubeconfig} clusteradm join \
		--bundle-version "${OCM_BUNDLE_VERSION}" \
		--hub-token "${hub_token}" \
		--hub-apiserver "${hub_endpoint}" \
		--cluster-name "${name}"
	repair_runtime_hub_endpoint "${name}" "${kubeconfig}"
}

join_runtime runtime-a "${RUNTIME_A_KUBECONFIG}"
join_runtime runtime-b "${RUNTIME_B_KUBECONFIG}"

managed_cluster_accepted() {
	local name=$1
	kubectl_for "${HUB_KUBECONFIG}" get managedcluster "${name}" -o json | jq -e '
		.spec.hubAcceptsClient == true and
		any(.status.conditions[]?; .type == "HubAcceptedManagedCluster" and .status == "True") and
		any(.status.conditions[]?; .type == "ManagedClusterJoined" and .status == "True") and
		any(.status.conditions[]?; .type == "ManagedClusterConditionAvailable" and .status == "True")
	' >/dev/null
}

if managed_cluster_accepted runtime-a && managed_cluster_accepted runtime-b; then
	log "managed clusters are already accepted, joined, and available"
else
	log "accepting managed clusters"
	# clusteradm's --wait loop can keep retrying acceptance after both clusters
	# have already recovered to Available=True. Issue the idempotent mutation
	# once, then wait on the exact conditions consumed by the rest of this
	# installer so a transient spoke restart cannot wedge unattended reconcile.
	KUBECONFIG=${HUB_KUBECONFIG} clusteradm accept --clusters runtime-a,runtime-b
	deadline=$((SECONDS + 300))
	until managed_cluster_accepted runtime-a && managed_cluster_accepted runtime-b; do
		((SECONDS < deadline)) || die "managed clusters did not become accepted, joined, and available within 5 minutes"
		sleep 2
	done
fi

log "installing Rivet Cell CRDs on hub and spokes"
for kubeconfig in "${HUB_KUBECONFIG}" "${RUNTIME_A_KUBECONFIG}" "${RUNTIME_B_KUBECONFIG}"; do
	kubectl_for "${kubeconfig}" apply -f "${CELLS_DIR}/deploy/tencent/fleet/crds.yaml" >/dev/null
done
kubectl_for "${HUB_KUBECONFIG}" apply -f "${MESH_DIR}/manifests/placement/fdb-external-crds.yaml" >/dev/null

log "building and importing the fleet controller image"
docker build \
	--build-arg ACTOR_FLEET_BUILD_IMAGE=golang:1.25.4-bookworm \
	--build-arg ACTOR_FLEET_RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot \
	--build-arg ACTOR_FLEET_GOPROXY=https://proxy.golang.org,direct \
	-t "${CONTROLLER_IMAGE}" -f "${CELLS_DIR}/Dockerfile.actor-fleet-controller" "${CELLS_DIR}"
k3d image import "${CONTROLLER_IMAGE}" --cluster "${HUB_CLUSTER}"
controller_image_id=$(docker image inspect "${CONTROLLER_IMAGE}" --format '{{.Id}}')

log "deploying the fleet controller on the hub"
kubectl_for "${HUB_KUBECONFIG}" apply -k "${MESH_DIR}/manifests/controller"
kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-controller-system patch deployment actor-fleet-controller \
	--type=merge -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"fleet.actor.dev/local-image-id\":\"${controller_image_id}\"}}}}}" >/dev/null
wait_for_deployments "${HUB_KUBECONFIG}" actor-fleet-controller-system

"${MESH_DIR}/install-smoke-work.sh"
"${MESH_DIR}/verify.sh"
