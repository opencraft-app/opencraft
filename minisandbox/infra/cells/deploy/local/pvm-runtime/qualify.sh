#!/usr/bin/env bash
set -euo pipefail

PVM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${PVM_DIR}/lib.sh"

for command in cargo date jq python3; do require_command "${command}"; done
binding=${MESH_STATE_DIR}/local-ingress/binding.json
[[ -f ${binding} ]] || die "local ingress binding is missing; run the local ingress deployment first"
address=$(jq -er '.address' "${binding}")
port=$(jq -er '.httpPort' "${binding}")
base_url=http://${address}:${port}
run_id=$(date -u +%Y%m%dT%H%M%SZ)
evidence_dir=${PVM_EVIDENCE_DIR:-${AGENTS_DIR:-${HOME}/.agents}/benchmarks/pvm-runtime/${run_id}}
mkdir -p -- "${evidence_dir}"

"${PVM_DIR}/verify.sh" | tee "${evidence_dir}/deployment.log"
python3 "${PVM_DIR}/qualify.py" \
	--base-url "${base_url}" \
	--api-key-file "${PVM_HERMES_KEY_FILE}" \
	--concurrency "${PVM_QUALIFICATION_CONCURRENCY:-4}" \
	--output "${evidence_dir}/lifecycle.json"
(
	cd -- "${REPO_ROOT}/runtimes/minisandbox/core"
	cargo test --locked --release -p minisandbox-conformance --test pvm_cow -- --nocapture
) 2>&1 | tee "${evidence_dir}/pvm-cow.log"

jq -n \
	--arg status passed \
	--arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	--arg evidenceDir "${evidence_dir}" \
	--slurpfile lifecycle "${evidence_dir}/lifecycle.json" \
	'{status:$status, completedAt:$completedAt, evidenceDir:$evidenceDir, lifecycle:$lifecycle[0], cowConformance:"passed"}' \
	>"${evidence_dir}/summary.json"
log "PVM lifecycle and COW qualification passed: ${evidence_dir}/summary.json"
