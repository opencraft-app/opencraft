#!/usr/bin/env bash
set -euo pipefail

STACK_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
LOCAL_DIR=$(cd -- "${STACK_DIR}/.." && pwd)
MESH_DIR=${LOCAL_DIR}/mesh
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=../mesh/storage-profile.sh
source "${MESH_DIR}/storage-profile.sh"

for command in docker jq k3d kubectl; do require_command "${command}"; done

"${MESH_DIR}/up.sh"
"${MESH_DIR}/up-federated-placement.sh"
"${LOCAL_DIR}/runtime-cold-tier/up.sh"
"${LOCAL_DIR}/worker-registry/up.sh"

"${MESH_DIR}/install-real-fdb.sh"

runtime_image_file=${MESH_STATE_DIR}/local-real-runtime-image
runtime_image=
if [[ -s ${runtime_image_file} ]]; then runtime_image=$(<"${runtime_image_file}"); fi
if [[ ${RIVET_LOCAL_REBUILD_RUNTIME:-false} == true || -z ${runtime_image} ]] || \
	! docker image inspect "${runtime_image}" >/dev/null 2>&1; then
	"${MESH_DIR}/build-real-runtime-image.sh"
else
	log "reusing local runtime image ${runtime_image}"
	k3d image import "${runtime_image}" --cluster "${RUNTIME_A_CLUSTER}" >/dev/null
	k3d image import "${runtime_image}" --cluster "${RUNTIME_B_CLUSTER}" >/dev/null
fi

"${MESH_DIR}/install-real-runtime.sh"

RIVET_LOCAL_RUNTIME_IMAGE_IMPORTED=true "${LOCAL_DIR}/stateless-executor/up.sh"
"${LOCAL_DIR}/workers-api/up.sh"
"${LOCAL_DIR}/ingress/up.sh"
"${STACK_DIR}/verify.sh"

if [[ ${RIVET_LOCAL_SKIP_COLD_QUALIFICATION:-false} != true ]]; then
	"${STACK_DIR}/qualify.sh" runtime-a
fi

binding_file=${MESH_STATE_DIR}/local-ingress/binding.json
address=$(jq -er '.address' "${binding_file}")
port=$(jq -er '.httpPort' "${binding_file}")
log "local Workers stack is ready: API http://${address}:${port}/v1, Grafana http://${address}:${port}/grafana/"
