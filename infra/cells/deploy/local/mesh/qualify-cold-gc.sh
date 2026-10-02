#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in cargo jq python3; do require_command "${command}"; done
run_id=$(date -u +%Y%m%dT%H%M%SZ)
receipt_dir=${LOCAL_COLD_GC_QUALIFICATION_DIR:-${MESH_STATE_DIR}/receipts/cold-gc/${run_id}}
mkdir -p -- "${receipt_dir}"
tests=()

run_case() {
	local id=$1
	shift
	log "cold GC matrix: ${id}"
	"$@" >"${receipt_dir}/${id}.log" 2>&1
	tests+=("${id}")
}

run_case storage-profile "${MESH_DIR}/test-storage-profile.sh"
run_case s3-delete-faults python3 -m unittest \
	infra/cells/deploy/local/runtime-cold-tier/test_local_s3.py
run_case policy cargo test --manifest-path Cargo.toml -p depot --test cold_gc_policy
run_case bounded-delete cargo test --manifest-path Cargo.toml -p depot \
	--lib cold_tier::delete::tests
run_case crash-boundaries cargo test --manifest-path Cargo.toml -p depot \
	--test fault_controller --features test-faults \
	cold_delete_issue_faults_straddle_the_durable_fdb_boundary
run_case accounting cargo test --manifest-path Cargo.toml -p depot \
	--test cold_storage_accounting
run_case inventory cargo test --manifest-path Cargo.toml -p depot --test cold_inventory
run_case delete-issued-retry cargo test --manifest-path Cargo.toml -p depot \
	--test cold_workflow_publish --features test-faults \
	cold_delete_failure_keeps_delete_issued_tombstone_and_retries
run_case response-loss-replay cargo test --manifest-path Cargo.toml -p depot \
	--test branch_gc --features test-faults \
	branch_gc_replays_after_exact_object_delete_response_loss

python3 - "${receipt_dir}" "${run_id}" "${tests[@]}" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
summary = {
    "schema": "rivet-local-cold-gc-matrix/v1",
    "run_id": sys.argv[2],
    "verdict": "passed",
    "default_deletion_enabled": False,
    "coverage": {
        "lifecycle": ["live", "retired", "delete_issued", "deleted_total"],
        "delete_response_loss": "response-loss-replay+s3-delete-faults",
        "crash_before_issue_commit": "transactional mark plus PreDurableCommit fault boundary",
        "crash_after_issue_commit": "delete-issued-retry",
		"s3_protocol_429_503": "s3-delete-faults+bounded-delete",
        "delayed_retry_no_resurrection": "response-loss-replay",
        "duplicate_delete_idempotent": "s3-delete-faults+response-loss-replay",
        "inventory_reconciliation": "inventory+accounting",
        "orphan_zero": "response-loss-replay",
    },
    "tests": [
        {"id": case, "verdict": "passed", "log": f"{case}.log"}
        for case in sys.argv[3:]
    ],
}
(root / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
print(root / "summary.json")
PY

log "local cold GC fault matrix passed: ${receipt_dir}/summary.json"
