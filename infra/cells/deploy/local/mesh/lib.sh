#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CELLS_DIR=$(cd -- "${MESH_DIR}/../../.." && pwd)

# shellcheck source=versions.env
source "${MESH_DIR}/versions.env"

MESH_PREFIX=${MESH_PREFIX:-rivet}
HUB_CLUSTER=${HUB_CLUSTER:-${MESH_PREFIX}-mesh-hub}
RUNTIME_A_CLUSTER=${RUNTIME_A_CLUSTER:-${MESH_PREFIX}-runtime-a}
RUNTIME_B_CLUSTER=${RUNTIME_B_CLUSTER:-${MESH_PREFIX}-runtime-b}
HUB_API_PORT=${HUB_API_PORT:-16443}
RUNTIME_A_API_PORT=${RUNTIME_A_API_PORT:-26443}
RUNTIME_B_API_PORT=${RUNTIME_B_API_PORT:-36443}
MESH_NETWORK=${MESH_NETWORK:-${MESH_PREFIX}-local-mesh}
MESH_STATE_DIR=${MESH_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/rivet-local-mesh}
CONTROLLER_IMAGE=${CONTROLLER_IMAGE:-rivet/actor-fleet-controller:local}
HUB_INTERNAL_ENDPOINT=${HUB_INTERNAL_ENDPOINT:-https://k3d-${HUB_CLUSTER}-serverlb:6443}
MESH_REPORT_FRESHNESS_SECONDS=${MESH_REPORT_FRESHNESS_SECONDS:-45}

HUB_KUBECONFIG=${MESH_STATE_DIR}/mesh-hub.kubeconfig
RUNTIME_A_KUBECONFIG=${MESH_STATE_DIR}/runtime-a.kubeconfig
RUNTIME_B_KUBECONFIG=${MESH_STATE_DIR}/runtime-b.kubeconfig
JOIN_COMMAND_FILE=${MESH_STATE_DIR}/join-command.sh

log() {
	printf '[local-mesh] %s\n' "$*"
}

die() {
	printf '[local-mesh] error: %s\n' "$*" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || die "required command '$1' is not installed"
}

require_version() {
	local command=$1
	local expected=$2
	local actual=$3
	[[ ${actual} == "${expected}" ]] || die "${command} ${actual} is installed; expected ${expected}"
}

cluster_exists() {
	k3d cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
}

write_kubeconfig() {
	local cluster=$1
	local output=$2
	k3d kubeconfig get "${cluster}" >"${output}"
	chmod 0600 "${output}"
}

kubectl_for() {
	local kubeconfig=$1
	shift
	kubectl --kubeconfig "${kubeconfig}" "$@"
}

wait_for_deployments() {
	local kubeconfig=$1
	local namespace=$2
	kubectl_for "${kubeconfig}" -n "${namespace}" wait deployment --all \
		--for=condition=Available --timeout=5m
}

hub_kubeconfig_server() {
	local kubeconfig=$1
	local secret=$2
	kubectl_for "${kubeconfig}" -n open-cluster-management-agent get secret "${secret}" \
		-o jsonpath='{.data.kubeconfig}' 2>/dev/null | base64 --decode | \
		awk '$1 == "server:" { print $2; exit }'
}

repair_hub_kubeconfig_secret() {
	local kubeconfig=$1
	local secret=$2
	local current encoded patch

	if ! kubectl_for "${kubeconfig}" -n open-cluster-management-agent get secret "${secret}" >/dev/null 2>&1; then
		return 1
	fi
	current=$(hub_kubeconfig_server "${kubeconfig}" "${secret}")
	if [[ ${current} == "${HUB_INTERNAL_ENDPOINT}" ]]; then
		return 1
	fi
	encoded=$(kubectl_for "${kubeconfig}" -n open-cluster-management-agent get secret "${secret}" \
		-o jsonpath='{.data.kubeconfig}' | base64 --decode | \
		sed -E "s#^([[:space:]]*server:)[[:space:]].*#\\1 ${HUB_INTERNAL_ENDPOINT}#" | base64 -w0)
	patch=$(jq -cn --arg kubeconfig "${encoded}" '{data:{kubeconfig:$kubeconfig}}')
	kubectl_for "${kubeconfig}" -n open-cluster-management-agent patch secret "${secret}" \
		--type=merge -p "${patch}" >/dev/null
	log "repaired ${secret} hub endpoint: ${current:-missing} -> ${HUB_INTERNAL_ENDPOINT}"
	return 0
}

repair_runtime_hub_endpoint() {
	local name=$1
	local kubeconfig=$2
	local repaired=false
	local secret
	for secret in bootstrap-hub-kubeconfig hub-kubeconfig-secret; do
		if repair_hub_kubeconfig_secret "${kubeconfig}" "${secret}"; then
			repaired=true
		fi
	done
	if [[ ${repaired} == true ]]; then
		log "restarting ${name} OCM agents to load the stable hub endpoint"
		kubectl_for "${kubeconfig}" -n open-cluster-management-agent rollout restart \
			deployment/klusterlet-registration-agent deployment/klusterlet-work-agent >/dev/null
	fi
}
