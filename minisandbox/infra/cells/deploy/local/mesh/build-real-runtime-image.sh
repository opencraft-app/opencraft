#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"
REPO_ROOT=$(cd -- "${MESH_DIR}/../../../../.." && pwd)

for command in docker k3d readelf sha256sum; do require_command "${command}"; done

target_dir=${CARGO_TARGET_DIR:-/data/build-cache/minisandbox/root}
profile=${RIVET_LOCAL_RUNTIME_CARGO_PROFILE:-local-e2e}
engine_features=${RIVET_LOCAL_RUNTIME_ENGINE_FEATURES:-rivet-engine/foundationdb}
image_file=${RIVET_LOCAL_RUNTIME_IMAGE_FILE:-${MESH_STATE_DIR}/local-real-runtime-image}
workerd=${RIVET_WORKERD_ARTIFACT:-${REPO_ROOT}/third-party/workerd-fdb/bazel-bin/src/workerd/server/workerd}
engine=${target_dir}/${profile}/rivet-engine
host=${target_dir}/${profile}/rivet-workerd-host
fdb_client=${RIVET_FDB_CLIENT_LIBRARY:-${MESH_STATE_DIR}/artifacts/libfdb_c_7.3.so}
fdb_tools_image=${RIVET_FDB_TOOLS_IMAGE:-foundationdb/foundationdb@sha256:d3530c3066f94abffb61facac527c9c3517f6553ee0e75efa69d54296290156a}
fdbbackup=${RIVET_FDBBACKUP_BINARY:-${MESH_STATE_DIR}/artifacts/fdbbackup_7.3.79}
onion_library=${RIVET_ONION_LIBRARY:-/lib64/libonion_security.so.1.0.19}
[[ -x ${workerd} ]] || die "runtime artifact is missing: ${workerd}"
workerd_program_headers=$(readelf -l "${workerd}")
[[ ${workerd_program_headers} != *INTERP* ]] || die \
	"workerd must be the production static artifact; rebuild with third-party/workerd-fdb/tools/build-rivet-workerd-musl.sh"
workerd_dynamic_section=$(readelf -d "${workerd}" 2>/dev/null || true)
[[ ${workerd_dynamic_section} != *"(NEEDED)"* ]] || die \
	"workerd has dynamic dependencies; rebuild the production static artifact"
grep -aFq 'RIVET_DEPOT_BRIDGE_ADDRESS' "${workerd}" || die \
	"workerd does not include the Rivet Depot SQLite VFS bridge"
if [[ ! -f ${fdb_client} ]]; then
	mkdir -p -- "$(dirname -- "${fdb_client}")"
	docker run --rm --user 0:0 -v "$(dirname -- "${fdb_client}"):/var/output-files" \
		foundationdb/fdb-kubernetes-monitor@sha256:45f5b7632984a4835326f45a7bcfd662886db64d82333796ee14cbb3a7537c8c \
		--copy-library 7.3 --output-dir /var/output-files --mode init
fi
if [[ ! -x ${fdbbackup} ]]; then
	mkdir -p -- "$(dirname -- "${fdbbackup}")"
	docker run --rm --user 0:0 -v "$(dirname -- "${fdbbackup}"):/var/output-files" \
		-e "RIVET_FDBBACKUP_OUTPUT_NAME=$(basename -- "${fdbbackup}")" \
		--entrypoint /bin/bash "${fdb_tools_image}" -ec \
		'install -m 0755 /usr/bin/fdbbackup "/var/output-files/${RIVET_FDBBACKUP_OUTPUT_NAME}"'
fi
for artifact in "${fdb_client}" "${fdbbackup}" "${onion_library}"; do
	[[ -f ${artifact} ]] || die "runtime artifact is missing: ${artifact}"
done

stage=$(mktemp -d)
cleanup() { rm -rf -- "${stage}"; }
trap cleanup EXIT
fdb_link_dir=${MESH_STATE_DIR}/artifacts/fdb-link
mkdir -p "${fdb_link_dir}"
ln -sfn "$(readlink -f -- "${fdb_client}")" "${fdb_link_dir}/libfdb_c.so"
log "building local runtime binaries with Cargo profile ${profile} and FoundationDB enabled"
FDB_CLIENT_LIB_PATH="${fdb_link_dir}" CARGO_TARGET_DIR=${target_dir} \
	cargo build --profile "${profile}" \
		-p rivet-engine -p rivet-workerd-host \
		--features "${engine_features}"
env -u WORKERD_DEPOT_BIN WORKERD_BIN="${workerd}" CARGO_TARGET_DIR=${target_dir} \
	cargo test --profile "${profile}" -p rivet-workerd-host --test workerd_process
for artifact in "${engine}" "${host}"; do [[ -x ${artifact} ]] || die "runtime artifact is missing after build: ${artifact}"; done

image_tag=${RIVET_LOCAL_RUNTIME_IMAGE:-rivet/local-real-runtime:$(sha256sum \
	"${engine}" \
	"${host}" \
	"${workerd}" \
	"${fdb_client}" \
	"${fdbbackup}" \
	"${onion_library}" \
	"${CELLS_DIR}/deploy/tencent/init-workerd-pool.sh" \
	"${MESH_DIR}/real/local-fdbbackup-double" \
	"${REPO_ROOT}/runtimes/workerd/host/workerd/worker.js" \
	"${REPO_ROOT}/runtimes/workerd/host/workerd/config-depot.capnp" \
	"${REPO_ROOT}/runtimes/workerd/host/workerd/stateless-worker.js" \
	"${REPO_ROOT}/runtimes/workerd/host/workerd/config-stateless.capnp" \
	"${MESH_DIR}/real/Dockerfile.runtime" | sha256sum | cut -c1-16)}

install -m 0755 "${engine}" "${stage}/rivet-engine"
install -m 0755 "${host}" "${stage}/rivet-workerd-host"
install -m 0755 "${workerd}" "${stage}/workerd"
install -m 0755 "${CELLS_DIR}/deploy/tencent/init-workerd-pool.sh" "${stage}/init-workerd-pool"
install -m 0755 "${MESH_DIR}/real/local-fdbbackup-double" "${stage}/local-fdbbackup-double"
install -m 0755 "${fdbbackup}" "${stage}/fdbbackup"
install -m 0644 "${REPO_ROOT}/runtimes/workerd/host/workerd/worker.js" "${stage}/worker.js"
install -m 0644 "${REPO_ROOT}/runtimes/workerd/host/workerd/config-depot.capnp" "${stage}/config-depot.capnp"
install -m 0644 "${REPO_ROOT}/runtimes/workerd/host/workerd/stateless-worker.js" "${stage}/stateless-worker.js"
install -m 0644 "${REPO_ROOT}/runtimes/workerd/host/workerd/config-stateless.capnp" "${stage}/config-stateless.capnp"
install -m 0755 "${onion_library}" "${stage}/libonion.so"
install -m 0755 "${fdb_client}" "${stage}/libfdb_c.so"
install -m 0644 "${MESH_DIR}/real/Dockerfile.runtime" "${stage}/Dockerfile"

docker build -t "${image_tag}" "${stage}"
k3d image import "${image_tag}" --cluster "${RUNTIME_A_CLUSTER}"
k3d image import "${image_tag}" --cluster "${RUNTIME_B_CLUSTER}"
printf '%s\n' "${image_tag}" >"${image_file}"
printf '%s\n' "${image_tag}"
