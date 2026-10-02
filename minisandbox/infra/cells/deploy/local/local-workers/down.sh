#!/usr/bin/env bash
set -euo pipefail

STACK_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
LOCAL_DIR=$(cd -- "${STACK_DIR}/.." && pwd)
MESH_DIR=${LOCAL_DIR}/mesh
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

if [[ ${1:-} != --destroy ]]; then
	die "down deletes all three local k3d clusters and their data; rerun as $0 --destroy"
fi
"${LOCAL_DIR}/ingress/down.sh"
"${MESH_DIR}/down.sh"
