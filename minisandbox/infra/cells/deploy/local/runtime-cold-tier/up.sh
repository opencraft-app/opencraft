#!/usr/bin/env bash
set -euo pipefail

COLD_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${COLD_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=../mesh/storage-profile.sh
source "${MESH_DIR}/storage-profile.sh"

for command in docker k3d kubectl openssl sed sha256sum; do require_command "${command}"; done
cluster_exists "${HUB_CLUSTER}" || die "cluster ${HUB_CLUSTER} is missing; run ${MESH_DIR}/up.sh first"

image=python:3.12-alpine@sha256:1887c114801a8c82a4ec01daa52cfe7fc3f63573640e2247320289807ac1c3bb
image_tag=python:3.12-alpine
image_digest=${image#*@}
bucket_a=${RIVET_LOCAL_COLD_BUCKET_A:-local-runtime-a-cold}
bucket_b=${RIVET_LOCAL_COLD_BUCKET_B:-local-runtime-b-cold}
qualification_bucket=${RIVET_LOCAL_COLD_QUALIFICATION_BUCKET:-}
buckets=("${bucket_a}" "${bucket_b}")
if [[ -n ${qualification_bucket} ]]; then buckets+=("${qualification_bucket}"); fi
for bucket in "${buckets[@]}"; do
	[[ ${bucket} =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || \
		die "invalid local S3 bucket name: ${bucket}"
done
[[ ${bucket_a} != "${bucket_b}" ]] || die "local runtime A/B cold buckets must differ"
if [[ -n ${qualification_bucket} ]]; then
	[[ ${qualification_bucket} != "${bucket_a}" && ${qualification_bucket} != "${bucket_b}" ]] || \
		die "local cold-GC qualification bucket must be isolated from runtime A/B"
fi
local_s3_buckets=$(IFS=,; printf '%s' "${buckets[*]}")
docker pull "${image}" >/dev/null
[[ $(docker image inspect "${image_tag}" --format '{{json .RepoDigests}}') == *"@${image_digest}"* ]] || \
	die "${image_tag} does not match the pinned local S3 image digest"
k3d image import "${image_tag}" --cluster "${HUB_CLUSTER}" >/dev/null

kubectl_for "${HUB_KUBECONFIG}" create namespace runtime-cold-tier-system \
	--dry-run=client -o yaml | kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null
if ! kubectl_for "${HUB_KUBECONFIG}" -n runtime-cold-tier-system get secret \
	runtime-cold-tier-admin >/dev/null 2>&1; then
	admin_token=$(openssl rand -hex 32)
	kubectl_for "${HUB_KUBECONFIG}" -n runtime-cold-tier-system create secret generic \
		runtime-cold-tier-admin --from-literal="token=${admin_token}" >/dev/null
fi
kubectl_for "${HUB_KUBECONFIG}" -n runtime-cold-tier-system create configmap runtime-cold-tier-script \
	--from-file=local_s3.py="${COLD_DIR}/local_s3.py" --dry-run=client -o yaml | \
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null

script_sha256=$(sha256sum "${COLD_DIR}/local_s3.py" | awk '{print $1}')
sed -e "s/__SCRIPT_SHA256__/${script_sha256}/g" \
	-e "s/__STORAGE_PROFILE_ID__/${RIVET_LOCAL_STORAGE_PROFILE_ID}/g" \
	-e "s/__LOCAL_S3_BUCKETS__/${local_s3_buckets}/g" \
	-e "s/__LOCAL_S3_MAX_OBJECT_BYTES__/${RIVET_LOCAL_COLD_MAX_OBJECT_SIZE_BYTES}/g" \
	"${COLD_DIR}/manifests/cold-tier.yaml" | \
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n runtime-cold-tier-system rollout status \
	deployment/runtime-cold-tier --timeout=3m >/dev/null

RIVET_LOCAL_COLD_BUCKET_A=${bucket_a} RIVET_LOCAL_COLD_BUCKET_B=${bucket_b} \
	RIVET_LOCAL_COLD_QUALIFICATION_BUCKET=${qualification_bucket} \
	"${COLD_DIR}/verify.sh"
log "persistent local Depot cold tier is available on the mesh at k3d-${HUB_CLUSTER}-server-0:30082"
