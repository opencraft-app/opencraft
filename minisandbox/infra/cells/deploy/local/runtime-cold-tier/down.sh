#!/usr/bin/env bash
set -euo pipefail

COLD_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${COLD_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

cluster_exists "${HUB_CLUSTER}" || exit 0
kubectl_for "${HUB_KUBECONFIG}" delete namespace runtime-cold-tier-system \
	--ignore-not-found --wait=true
log "local runtime cold-tier namespace and PVC were removed"
