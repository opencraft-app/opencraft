#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

[[ $# -le 1 ]] || { echo "usage: $0 [new-evidence-directory]" >&2; exit 2; }
if [[ $# -eq 1 ]]; then
    EVIDENCE_DIR="$1"
    [[ ! -e "${EVIDENCE_DIR}" ]] || {
        echo "error: evidence path already exists: ${EVIDENCE_DIR}" >&2
        exit 2
    }
    mkdir -p "${EVIDENCE_DIR}"
else
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-porcupine.XXXXXX)"
fi
readonly EVIDENCE_DIR

MINISANDBOX_PORCUPINE_HISTORY="${EVIDENCE_DIR}/history.json" \
    cargo test --manifest-path "${STORAGE_DIR}/Cargo.toml" \
        -p minisandbox-block-engine \
        --test concurrent_history \
        -- --nocapture 2>&1 | tee "${EVIDENCE_DIR}/rust-history.log"

(
    cd "${SCRIPT_DIR}"
    go run . --history "${EVIDENCE_DIR}/history.json"
) 2>&1 | tee "${EVIDENCE_DIR}/porcupine.log"

git -C "${STORAGE_DIR}/.." rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
go version >"${EVIDENCE_DIR}/go-version"
grep -q 'MINISANDBOX_BLOCK_LINEARIZABILITY_OK' "${EVIDENCE_DIR}/rust-history.log"
grep -q 'MINISANDBOX_PORCUPINE_OK' "${EVIDENCE_DIR}/porcupine.log"
echo "MINISANDBOX_PORCUPINE_GATE_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
