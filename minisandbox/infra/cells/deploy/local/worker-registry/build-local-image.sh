#!/usr/bin/env bash
set -euo pipefail

REGISTRY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${REGISTRY_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

for command in curl docker jq sha256sum; do require_command "${command}"; done

image=${1:?usage: build-local-image.sh IMAGE}
build_image=${WORKER_REGISTRY_BUILD_IMAGE:-golang:1.25.4-bookworm@sha256:e17419604b6d1f9bc245694425f0ec9b1b53685c80850900a376fb10cb0f70cb}
runtime_image=${WORKER_REGISTRY_RUNTIME_IMAGE:-gcr.io/distroless/cc-debian12@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f}
lock=${CELLS_DIR}/deploy/tencent/fleet/worker-registry/foundationdb-client.lock.json
artifact_dir=${RIVET_LOCAL_ARTIFACT_DIR:-/data/build-cache/minisandbox/local-artifacts}
fdb_client=${WORKER_REGISTRY_FDB_CLIENT_DEB:-${artifact_dir}/foundationdb-clients_7.3.79-1_amd64.deb}
expected_sha=$(jq -er '.packageSha256' "${lock}")
url=$(jq -er '.url' "${lock}")

mkdir -p -- "$(dirname -- "${fdb_client}")" /data/tmp
if [[ ! -f ${fdb_client} || $(sha256sum "${fdb_client}" | cut -d' ' -f1) != "${expected_sha}" ]]; then
	temporary_download=${fdb_client}.partial.$$
	curl --fail --location --retry 3 --output "${temporary_download}" "${url}"
	[[ $(sha256sum "${temporary_download}" | cut -d' ' -f1) == "${expected_sha}" ]] || \
		die "downloaded FoundationDB client differs from its lock"
	mv -f -- "${temporary_download}" "${fdb_client}"
fi

context=$(mktemp -d /data/tmp/local-worker-registry-context.XXXXXX)
cleanup() { rm -rf -- "${context}"; }
trap cleanup EXIT
install -d -m 0755 "${context}/cmd" "${context}/internal"
install -m 0644 "${CELLS_DIR}/go.mod" "${CELLS_DIR}/go.sum" "${context}/"
cp -a -- "${CELLS_DIR}/cmd/worker-registry" "${context}/cmd/"
cp -a -- "${CELLS_DIR}/internal/workerregistry" "${context}/internal/"
install -m 0644 "${CELLS_DIR}/Dockerfile.worker-registry" "${context}/Dockerfile"
install -m 0644 "${fdb_client}" "${context}/foundationdb-clients_7.3.79-1_amd64.deb"

docker build --file "${context}/Dockerfile" \
	--build-arg "WORKER_REGISTRY_BUILD_IMAGE=${build_image}" \
	--build-arg "WORKER_REGISTRY_RUNTIME_IMAGE=${runtime_image}" \
	--tag "${image}" "${context}"
