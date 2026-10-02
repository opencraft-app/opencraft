#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for cluster in "${RUNTIME_B_CLUSTER}" "${RUNTIME_A_CLUSTER}" "${HUB_CLUSTER}"; do
	if cluster_exists "${cluster}"; then
		log "deleting cluster ${cluster}"
		k3d cluster delete "${cluster}"
	fi
done

if docker network inspect "${MESH_NETWORK}" >/dev/null 2>&1; then
	docker network rm "${MESH_NETWORK}" >/dev/null || true
fi

log "cluster state was removed; kubeconfigs remain in ${MESH_STATE_DIR} for inspection"
