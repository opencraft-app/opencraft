#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in cargo python3 rg stat; do require_command "${command}"; done

credential_file=${RIVET_TENCENT_COS_CREDENTIAL_FILE:-${MESH_STATE_DIR}/tencent-cos-root.env}
bucket=${RIVET_TENCENT_COS_BUCKET:-actor-depot-cold-dev-bj-local-a-1388575217}
[[ -f ${credential_file} ]] || die "Tencent COS credential file is missing: ${credential_file}"
[[ $(stat -c '%a' "${credential_file}") == 600 ]] || die "COS credential file must have mode 0600"

set -a
# shellcheck disable=SC1090
source "${credential_file}"
set +a
export RUST_LOG=warn
export RIVET_TEST_S3_ENDPOINT=https://cos.ap-beijing.myqcloud.com
export RIVET_TEST_S3_REGION=ap-beijing
export RIVET_TEST_S3_BUCKET=${bucket}
export RIVET_TEST_S3_ADDRESSING_STYLE=virtual

evidence_root=${AGENTS_DIR:-${HOME}/.agents}/benchmarks/local-mesh/real-cos-data-safety
run_id=$(date -u +%Y%m%dT%H%M%SZ)
run_dir=${evidence_root}/${run_id}
mkdir -p -- "${run_dir}"

tests=(
	cold_workflow_publish:s3_missing_and_corrupt_cold_objects_fail_closed_without_refill
	cold_workflow_publish:s3_upload_and_publish_response_loss_replay_by_exact_key
	cold_workflow_publish:concurrent_s3_cold_recovery_keeps_actor_branches_isolated
	cold_workflow_publish:history_pin_blocks_cold_retirement_until_released
	branch_gc:pinned_branch_gc_requeues_without_a_sleeping_per_branch_workflow
	branch_gc:branch_gc_waits_for_inflight_cold_put_before_deleting_branch
)

for test_case in "${tests[@]}"; do
	test_binary=${test_case%%:*}
	test_name=${test_case#*:}
	cargo test -p depot --test "${test_binary}" --features test-faults \
		"${test_name}" >"${run_dir}/${test_binary}-${test_name}.log" 2>&1
	rg -q '1 passed; 0 failed' "${run_dir}/${test_binary}-${test_name}.log" || \
		die "data-safety test did not execute exactly once: ${test_binary}:${test_name}"
done

python3 - "${run_dir}" "${bucket}" "${tests[@]}" <<'PY'
import json
import pathlib
import sys

run_dir = pathlib.Path(sys.argv[1])
bucket = sys.argv[2]
tests = [entry.split(":", 1) for entry in sys.argv[3:]]
summary = {
    "schema": "rivet-real-cos-data-safety/v1",
    "bucket": bucket,
    "verdict": "passed",
    "tests": [
        {
            "binary": binary,
            "name": name,
            "log": f"{binary}-{name}.log",
            "verdict": "passed",
        }
        for binary, name in tests
    ],
}
(run_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
print(run_dir / "summary.json")
PY
