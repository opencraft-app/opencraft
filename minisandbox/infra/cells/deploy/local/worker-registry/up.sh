#!/usr/bin/env bash
set -euo pipefail

REGISTRY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${REGISTRY_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

for command in docker jq k3d kubectl sed sha256sum; do
	require_command "${command}"
done
cluster_exists "${HUB_CLUSTER}" || die "cluster ${HUB_CLUSTER} is missing; run ${MESH_DIR}/up.sh first"

crd_dir=${CELLS_DIR}/deploy/tencent/fleet/fdb-operator/vendor/crds

fetch_crd() {
	local name=$1 expected=$2
	[[ -f ${crd_dir}/${name} ]] || die "vendored FDB CRD is missing: ${name}"
	[[ $(sha256sum "${crd_dir}/${name}" | cut -d' ' -f1) == "${expected}" ]] || \
		die "checksum mismatch for ${name}"
}

fetch_crd apps.foundationdb.org_foundationdbclusters.yaml 57511675909ad02345909343efa295e4c28fcfb67c811cb021663a7c03dcd3f1
fetch_crd apps.foundationdb.org_foundationdbbackups.yaml 2fb8313e25fa58be8a09f8a0cfc04172d80605b92850a523d73031ba8195a266
fetch_crd apps.foundationdb.org_foundationdbrestores.yaml 499d7feb7d3e553f75b23c77a7e7d9467355703f771284b683ec4f4515ee9c6b

log "installing the Code Plane FDB operator in Hub cluster ${HUB_CLUSTER}"
kubectl_for "${HUB_KUBECONFIG}" apply \
	-f "${crd_dir}/apps.foundationdb.org_foundationdbclusters.yaml" \
	-f "${crd_dir}/apps.foundationdb.org_foundationdbbackups.yaml" \
	-f "${crd_dir}/apps.foundationdb.org_foundationdbrestores.yaml" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" apply -k "${CELLS_DIR}/deploy/tencent/fleet/fdb-operator" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n actor-fdb-cell-system rollout status \
	deployment/fdb-kubernetes-operator-controller-manager --timeout=10m

log "installing the dedicated Code Plane FDB and persistent local COS double"
kubectl_for "${HUB_KUBECONFIG}" apply -f "${REGISTRY_DIR}/manifests/code-plane.yaml" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system create configmap worker-registry-local-cos \
	--from-file=local_cos.py="${REGISTRY_DIR}/local_cos.py" --dry-run=client -o yaml | \
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null

deadline=$((SECONDS + 600))
until kubectl_for "${HUB_KUBECONFIG}" -n actor-fdb-cell-system get \
	foundationdbcluster worker-registry-code-plane -o json | jq -e '
		.status.configured == true and
		(.status.available == true or .status.health.available == true) and
		(.status.fullReplication == true or .status.health.fullReplication == true) and
		.status.desiredProcessGroups == 3 and
		.status.reconciledProcessGroups == 3
	' >/dev/null; do
	((SECONDS < deadline)) || die "Code Plane FDB did not become healthy within 10 minutes"
	sleep 2
done

cluster_file=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fdb-cell-system get configmap \
	worker-registry-code-plane-config -o jsonpath='{.data.cluster-file}')
[[ -n ${cluster_file} ]] || die "Code Plane FDB cluster file is empty"
kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system create configmap worker-registry-fdb \
	--from-literal=fdb.cluster="${cluster_file}" --dry-run=client -o yaml | \
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null

local_cos_image=python:3.12-alpine@sha256:1887c114801a8c82a4ec01daa52cfe7fc3f63573640e2247320289807ac1c3bb
local_cos_image_tag=python:3.12-alpine
local_cos_image_digest=${local_cos_image#*@}
docker pull "${local_cos_image}" >/dev/null
[[ $(docker image inspect "${local_cos_image_tag}" --format '{{json .RepoDigests}}') == *"@${local_cos_image_digest}"* ]] || \
	die "${local_cos_image_tag} does not match the pinned Registry COS image digest"
k3d image import "${local_cos_image_tag}" --cluster "${HUB_CLUSTER}" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system rollout status \
	deployment/worker-registry-cos --timeout=3m

WORKER_REGISTRY_IMAGE=${WORKER_REGISTRY_IMAGE:-rivet/worker-registry:local}
log "building Worker registry image ${WORKER_REGISTRY_IMAGE}"
"${REGISTRY_DIR}/build-local-image.sh" "${WORKER_REGISTRY_IMAGE}"
log "importing Worker registry into Hub cluster ${HUB_CLUSTER}"
k3d image import "${WORKER_REGISTRY_IMAGE}" --cluster "${HUB_CLUSTER}" >/dev/null
WORKER_REGISTRY_IMAGE_ID=$(docker image inspect "${WORKER_REGISTRY_IMAGE}" --format '{{.Id}}')

sed -e "s#__WORKER_REGISTRY_IMAGE__#${WORKER_REGISTRY_IMAGE}#" \
	-e "s#__WORKER_REGISTRY_IMAGE_ID__#${WORKER_REGISTRY_IMAGE_ID}#" \
	"${REGISTRY_DIR}/manifests/registry.yaml" | \
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system rollout status \
	deployment/worker-registry --timeout=3m

"${REGISTRY_DIR}/verify.sh"

# The old filesystem backend was used only before the project was released.
# Remove its exact, now-unmounted PVC only after the durable Registry has passed.
kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system delete pvc worker-registry-data \
	--ignore-not-found --wait=true >/dev/null
