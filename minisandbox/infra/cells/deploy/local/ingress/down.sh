#!/usr/bin/env bash
set -euo pipefail

INGRESS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${INGRESS_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

PUBLISHER_NAME=${RIVET_LOCAL_INGRESS_PUBLISHER_NAME:-${MESH_PREFIX}-local-ingress-publisher}
if docker container inspect "${PUBLISHER_NAME}" >/dev/null 2>&1; then
	docker rm -f "${PUBLISHER_NAME}" >/dev/null
	log "removed host TCP publisher ${PUBLISHER_NAME}"
fi
if [[ -f ${HUB_KUBECONFIG} ]]; then
	kubectl_for "${HUB_KUBECONFIG}" delete namespace local-ingress-system --ignore-not-found >/dev/null
fi
log "local ingress resources were removed; generated state remains under ${MESH_STATE_DIR}/local-ingress"
