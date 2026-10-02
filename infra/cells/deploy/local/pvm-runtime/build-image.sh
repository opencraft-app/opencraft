#!/usr/bin/env bash
set -euo pipefail

PVM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${PVM_DIR}/lib.sh"

for command in cargo docker git gzip sha256sum; do require_command "${command}"; done
validate_local_pvm_settings

core=${REPO_ROOT}/runtimes/minisandbox/core
sbxlet_workspace=${REPO_ROOT}/runtimes/minisandbox/sbxlet
sbxlet=${sbxlet_workspace}/target/release/sbxlet
pvm_target=${core}/target/pvm-linux
kernel=${pvm_target}/build/arch/x86/boot/bzImage
base=${pvm_target}/hermes-base-d66341ab2863-x86_64.erofs
app=${pvm_target}/hermes-app-d66341ab2863-x86_64.erofs
actor_volume=${pvm_target}/actor-volume-template-2g.ext4
actor_volume_gzip=${actor_volume}.gz

log "building sbxlet"
cargo build --locked --release --manifest-path "${sbxlet_workspace}/Cargo.toml"
if [[ ! -f ${kernel} ]]; then
	log "building pinned PVM Linux guest"
	(
		cd -- "${core}"
		cargo xtask pvm-linux prepare
		cargo xtask pvm-linux configure
		cargo xtask pvm-linux build
	)
fi
if [[ ! -f ${base} || ! -f ${app} ]]; then
	log "building pinned Hermes EROFS layers"
	(cd -- "${core}" && python3 rootfs/build.py hermes)
fi
if [[ ! -f ${actor_volume} || ! -f ${actor_volume}.metadata.json ]]; then
	log "building pre-generated 2 GiB ext4 ActorBlockVolume template"
	(cd -- "${core}" && python3 rootfs/build.py actor-volume-template)
fi
if [[ ! -f ${actor_volume_gzip} || ${actor_volume} -nt ${actor_volume_gzip} ]]; then
	log "compressing the sparse ActorBlockVolume template for the OCI build context"
	temporary_gzip=${actor_volume_gzip}.tmp-$$
	gzip -n -c "${actor_volume}" >"${temporary_gzip}"
	mv -- "${temporary_gzip}" "${actor_volume_gzip}"
fi
for artifact in "${sbxlet}" "${kernel}" "${base}" "${app}" "${base}.metadata.json" "${app}.metadata.json" "${actor_volume}" "${actor_volume_gzip}" "${actor_volume}.metadata.json"; do
	[[ -f ${artifact} ]] || die "required PVM image artifact is missing: ${artifact}"
done

sbxlet_sha=$(sha256sum "${sbxlet}" | awk '{print $1}')
kernel_sha=$(sha256sum "${kernel}" | awk '{print $1}')
base_sha=$(sha256sum "${base}" | awk '{print $1}')
app_sha=$(sha256sum "${app}" | awk '{print $1}')
actor_volume_sha=$(sha256sum "${actor_volume}" | awk '{print $1}')
image_definition_sha=$(sha256sum "${PVM_DIR}/image/Dockerfile" "${PVM_DIR}/image/entrypoint.sh" |
	sha256sum | awk '{print $1}')
content_sha=$(printf '%s\n' \
	"${sbxlet_sha}" "${kernel_sha}" "${base_sha}" "${app_sha}" "${actor_volume_sha}" "${image_definition_sha}" |
	sha256sum | cut -c1-16)
image_ref=${RIVET_LOCAL_PVM_IMAGE:-rivet/minisandbox-hermes:${content_sha}}
archive=${PVM_IMAGE_DIR}/minisandbox-hermes-${content_sha}.docker.tar
source_revision=$(git -C "${REPO_ROOT}" rev-parse HEAD)
builder=${PVM_BUILDX_BUILDER:-minisandbox-pvm}

mkdir -p -- "${PVM_IMAGE_DIR}"
if [[ ! -f ${archive} ]]; then
	if ! docker buildx inspect "${builder}" >/dev/null 2>&1; then
		docker buildx create --name "${builder}" --driver docker-container >/dev/null
	fi
	docker buildx inspect --bootstrap "${builder}" >/dev/null
	temporary=${archive}.tmp-$$
	trap 'rm -f -- "${temporary}"' EXIT
	log "building ${image_ref} as a Docker image archive under /data"
	docker buildx build \
		--builder "${builder}" \
		--platform linux/amd64 \
		--provenance=false \
		--build-context "sbxlet=$(dirname -- "${sbxlet}")" \
		--build-context "pvm=${pvm_target}" \
		--build-arg "SOURCE_REVISION=${source_revision}" \
		--build-arg "SBXLET_SHA256=${sbxlet_sha}" \
		--build-arg "KERNEL_SHA256=${kernel_sha}" \
		--build-arg "BASE_EROFS_SHA256=${base_sha}" \
		--build-arg "APP_EROFS_SHA256=${app_sha}" \
		--build-arg "ACTOR_VOLUME_SHA256=${actor_volume_sha}" \
		--tag "${image_ref}" \
		--output "type=docker,dest=${temporary}" \
		--file "${PVM_DIR}/image/Dockerfile" \
		"${PVM_DIR}/image"
	mv -- "${temporary}" "${archive}"
	trap - EXIT
else
	log "reusing existing OCI archive ${archive}"
fi

printf '%s\n' "${image_ref}" >"${PVM_IMAGE_REF_FILE}"
printf '%s\n' "${archive}" >"${PVM_IMAGE_ARCHIVE_FILE}"
log "PVM runtime image: ${image_ref}"
log "image archive: ${archive} ($(du -h "${archive}" | awk '{print $1}'))"
