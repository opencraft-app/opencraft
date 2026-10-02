#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=storage-context.sh
source "${MESH_DIR}/storage-context.sh"

for command in curl kubectl sha256sum; do require_command "${command}"; done

operator_commit=b543152be5614170a1fa976421238989e9820cde
crd_base="https://raw.githubusercontent.com/FoundationDB/fdb-kubernetes-operator/${operator_commit}/config/crd/bases"
temporary=$(mktemp -d)
fdb_suffix=${RIVET_LOCAL_FDB_SUFFIX}
fdb_targets=${RIVET_LOCAL_FDB_TARGETS:-runtime-a,runtime-b}
cleanup() { rm -rf -- "${temporary}"; }
trap cleanup EXIT

fetch_crd() {
	local name=$1 expected=$2
	curl -fsSL "${crd_base}/${name}" -o "${temporary}/${name}"
	[[ $(sha256sum "${temporary}/${name}" | cut -d' ' -f1) == "${expected}" ]] || die "checksum mismatch for ${name}"
}

fetch_crd apps.foundationdb.org_foundationdbclusters.yaml 57511675909ad02345909343efa295e4c28fcfb67c811cb021663a7c03dcd3f1
fetch_crd apps.foundationdb.org_foundationdbbackups.yaml 2fb8313e25fa58be8a09f8a0cfc04172d80605b92850a523d73031ba8195a266
fetch_crd apps.foundationdb.org_foundationdbrestores.yaml 499d7feb7d3e553f75b23c77a7e7d9467355703f771284b683ec4f4515ee9c6b

install_one() {
	local cluster=$1 kubeconfig=$2
	local cell_name="local-${cluster}${fdb_suffix}"
	log "installing official FDB Operator and real ${cell_name} database"
	kubectl_for "${kubeconfig}" apply -f "${temporary}" >/dev/null
	kubectl_for "${kubeconfig}" apply -k "${CELLS_DIR}/deploy/tencent/fleet/fdb-operator" >/dev/null
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system rollout status \
		deployment/fdb-kubernetes-operator-controller-manager --timeout=10m
	sed "s/__CELL_NAME__/${cell_name}/g" "${MESH_DIR}/manifests/data-plane/foundationdb-cluster.yaml" | \
		kubectl_for "${kubeconfig}" apply -f - >/dev/null
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system annotate foundationdbcluster \
		"${cell_name}" "rivet.dev/storage-profile=${RIVET_LOCAL_STORAGE_PROFILE_ID}" \
		--overwrite >/dev/null
}

IFS=',' read -r -a targets <<<"${fdb_targets}"
for target in "${targets[@]}"; do
	case ${target} in
		runtime-a) install_one runtime-a "${RUNTIME_A_KUBECONFIG}" ;;
		runtime-b) install_one runtime-b "${RUNTIME_B_KUBECONFIG}" ;;
		*) die "RIVET_LOCAL_FDB_TARGETS contains unsupported target: ${target}" ;;
	esac
done
RIVET_LOCAL_FDB_SUFFIX=${fdb_suffix} RIVET_LOCAL_FDB_TARGETS=${fdb_targets} \
	"${MESH_DIR}/verify-real-fdb.sh"
