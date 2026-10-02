#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
"${MESH_DIR}/install-helm.sh"
"${MESH_DIR}/install-observability.sh"
"${MESH_DIR}/placement-e2e.sh"
