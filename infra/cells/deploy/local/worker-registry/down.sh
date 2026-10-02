#!/usr/bin/env bash
set -euo pipefail

REGISTRY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${REGISTRY_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

cluster_exists "${HUB_CLUSTER}" || exit 0
kubectl_for "${HUB_KUBECONFIG}" -n actor-fdb-cell-system delete \
	foundationdbcluster worker-registry-code-plane --ignore-not-found --wait=true
kubectl_for "${HUB_KUBECONFIG}" -n actor-fdb-cell-system delete \
	networkpolicy worker-registry-code-plane --ignore-not-found
kubectl_for "${HUB_KUBECONFIG}" delete namespace worker-registry-system \
	--ignore-not-found --wait=true
