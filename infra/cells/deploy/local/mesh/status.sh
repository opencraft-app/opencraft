#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

k3d cluster list
if [[ -f ${HUB_KUBECONFIG} ]]; then
	kubectl_for "${HUB_KUBECONFIG}" get managedclusters
	kubectl_for "${HUB_KUBECONFIG}" get manifestworks -A
	kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-controller-system get pods
	if kubectl_for "${HUB_KUBECONFIG}" get namespace mesh-observability >/dev/null 2>&1; then
		kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability get pods
		kubectl_for "${HUB_KUBECONFIG}" get rivetenvironmentreports
		kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get shardpool,rivetcellclaim,rivetcell
	fi
fi

"${MESH_DIR}/health-check.sh"
