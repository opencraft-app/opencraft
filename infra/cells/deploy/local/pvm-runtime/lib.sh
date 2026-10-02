#!/usr/bin/env bash
set -euo pipefail

PVM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${PVM_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

REPO_ROOT=$(cd -- "${PVM_DIR}/../../../../.." && pwd)
PVM_NAMESPACE=${PVM_NAMESPACE:-minisandbox-system}
PVM_RUNTIME_NAMESPACE=${PVM_RUNTIME_NAMESPACE:-actor-fdb-cell-system}
PVM_RUNNER_NAME=${PVM_RUNNER_NAME:-minisandbox-hermes-v1}
PVM_MEMORY_MIB=${PVM_MEMORY_MIB:-2048}
PVM_UPPER_SIZE_MIB=${PVM_UPPER_SIZE_MIB:-2048}
PVM_ARTIFACT_ROOT=${PVM_ARTIFACT_ROOT:-/data/build-cache/minisandbox/deployment}
PVM_IMAGE_DIR=${PVM_IMAGE_DIR:-${PVM_ARTIFACT_ROOT}/images}
PVM_IMAGE_REF_FILE=${PVM_IMAGE_REF_FILE:-${PVM_ARTIFACT_ROOT}/current-image-ref}
PVM_IMAGE_ARCHIVE_FILE=${PVM_IMAGE_ARCHIVE_FILE:-${PVM_ARTIFACT_ROOT}/current-image-archive}
PVM_HERMES_KEY_FILE=${PVM_HERMES_KEY_FILE:-${PVM_ARTIFACT_ROOT}/hermes-api-key}

runtime_cells() {
	printf '%s\t%s\t%s\n' local-runtime-a "${RUNTIME_A_CLUSTER}" "${RUNTIME_A_KUBECONFIG}"
	printf '%s\t%s\t%s\n' local-runtime-b "${RUNTIME_B_CLUSTER}" "${RUNTIME_B_KUBECONFIG}"
}

read_single_line() {
	local path=$1 value
	[[ -f ${path} ]] || die "required state file is missing: ${path}"
	IFS= read -r value <"${path}"
	[[ -n ${value} ]] || die "required state file is empty: ${path}"
	printf '%s\n' "${value}"
}

validate_local_pvm_settings() {
	[[ ${PVM_RUNNER_NAME} =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] ||
		die "PVM_RUNNER_NAME must be a DNS-compatible runner name"
	[[ ${PVM_MEMORY_MIB} =~ ^[0-9]+$ ]] && ((PVM_MEMORY_MIB >= 512 && PVM_MEMORY_MIB <= 3072)) ||
		die "PVM_MEMORY_MIB must be an integer between 512 and 3072"
	[[ ${PVM_UPPER_SIZE_MIB} =~ ^[0-9]+$ ]] && ((PVM_UPPER_SIZE_MIB >= 64)) ||
		die "PVM_UPPER_SIZE_MIB must be an integer of at least 64"
}
