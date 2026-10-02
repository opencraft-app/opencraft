#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=storage-profile.sh
source "${MESH_DIR}/storage-profile.sh"

for command in date jq kubectl python3; do require_command "${command}"; done

run_id=$(date -u +%Y%m%dT%H%M%SZ)
receipt_dir=${LOCAL_COLD_QUALIFICATION_DIR:-${MESH_STATE_DIR}/receipts/cold-lifecycle/${run_id}}
mkdir -p -- "${receipt_dir}"

"${CELLS_DIR}/deploy/local/runtime-cold-tier/up.sh"

qualify_cell() {
	local cell=$1
	local kubeconfig=$2
	local engine_port=$3
	local depot_port=$4
	python3 "${MESH_DIR}/qualify-cold-lifecycle.py" \
		--kubeconfig "${kubeconfig}" \
		--hub-kubeconfig "${HUB_KUBECONFIG}" \
		--cell "${cell}" \
		--endpoint-kind local-s3 \
		--engine-port "${engine_port}" \
		--depot-port "${depot_port}" \
		--output "${receipt_dir}/${cell}.json"
}

qualify_cell local-runtime-a "${RUNTIME_A_KUBECONFIG}" 26420 26421
qualify_cell local-runtime-b "${RUNTIME_B_KUBECONFIG}" 26422 26423

jq -n \
	--arg schema rivet-local-cold-lifecycle-suite/v1 \
	--arg runId "${run_id}" \
	--slurpfile runtimeA "${receipt_dir}/local-runtime-a.json" \
	--slurpfile runtimeB "${receipt_dir}/local-runtime-b.json" \
	'{schema: $schema, run_id: $runId, verdict: "passed", cells: {"local-runtime-a": $runtimeA[0], "local-runtime-b": $runtimeB[0]}}' \
	>"${receipt_dir}/summary.json.tmp"
mv "${receipt_dir}/summary.json.tmp" "${receipt_dir}/summary.json"
log "local A/B cold lifecycle qualification passed: ${receipt_dir}/summary.json"
