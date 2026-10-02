#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
    echo "usage: $0 /dev/nbdX /path/to/blktests [evidence-directory]" >&2
    exit 2
fi

readonly DEVICE="$1"
readonly DEVICE_NAME="${DEVICE##*/}"
[[ "${DEVICE}" == "/dev/${DEVICE_NAME}" && "${DEVICE_NAME}" =~ ^nbd[0-9]+$ ]] || {
    echo "error: device must be an explicit /dev/nbdX node" >&2
    exit 2
}
[[ "${EUID}" -eq 0 ]] || { echo "error: root is required" >&2; exit 2; }
[[ -b "${DEVICE}" ]] || { echo "error: missing block device ${DEVICE}" >&2; exit 2; }
[[ ! -e "/sys/block/${DEVICE_NAME}/pid" ]] || {
    echo "error: ${DEVICE} is already attached" >&2
    exit 2
}
[[ "$(blockdev --getsize64 "${DEVICE}")" == "0" ]] || {
    echo "error: refusing non-empty NBD device ${DEVICE}" >&2
    exit 2
}

readonly BLKTESTS_DIR="$(cd "$2" && pwd)"
[[ -x "${BLKTESTS_DIR}/check" && -x "${BLKTESTS_DIR}/src/dio-offsets" ]] || {
    echo "error: build blktests with make before running this script" >&2
    exit 2
}
for program in blockdev fio git install qemu-nbd sha256sum tee xfs_io; do
    command -v "${program}" >/dev/null || {
        echo "error: ${program} is required" >&2
        exit 2
    }
done

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SERVER_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly QUICK_SECONDS="${MINISANDBOX_BLKTESTS_QUICK_SECONDS:-30}"

if [[ ! -x "${SERVER_SOURCE}" ]]; then
    cargo build --release --manifest-path "${STORAGE_DIR}/Cargo.toml" \
        -p minisandbox-nbd-frontend
fi

if [[ $# -eq 3 ]]; then
    EVIDENCE_DIR="$3"
    [[ ! -e "${EVIDENCE_DIR}" ]] || {
        echo "error: evidence directory already exists" >&2
        exit 2
    }
    mkdir -p "${EVIDENCE_DIR}"
else
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-blktests.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
install -m 0755 "${SERVER_SOURCE}" "${SERVER}"
git -C "${BLKTESTS_DIR}" rev-parse HEAD >"${EVIDENCE_DIR}/upstream-commit"
git -C "${STORAGE_DIR}/.." rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}/.." status --short >"${EVIDENCE_DIR}/worktree-status"
sha256sum "${SERVER}" >"${EVIDENCE_DIR}/server-sha256"
uname -a >"${EVIDENCE_DIR}/host-kernel"
printf '%s\n' block/003 block/004 block/012 block/042 >"${EVIDENCE_DIR}/selected-cases"
printf 'quick_seconds=%s\n' "${QUICK_SECONDS}" >"${EVIDENCE_DIR}/configuration"

server_pid=""
cleanup() {
    if [[ -e "/sys/block/${DEVICE_NAME}/pid" ]]; then
        blockdev --setrw "${DEVICE}" >/dev/null 2>&1 || true
        qemu-nbd -d "${DEVICE}" >/dev/null 2>&1 || true
    fi
    if [[ -n "${server_pid}" ]]; then
        kill "${server_pid}" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

for test_name in 003 004 012 042; do
    case_dir="${EVIDENCE_DIR}/block-${test_name}"
    mkdir -p "${case_dir}/cos"
    "${SERVER}" \
        --device "${DEVICE}" \
        --database "${case_dir}/blocks.db" \
        --cos-root "${case_dir}/cos" \
        >"${case_dir}/server.log" 2>&1 &
    server_pid=$!
    for _ in $(seq 1 400); do
        if [[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "2147483648" ]]; then
            break
        fi
        kill -0 "${server_pid}"
        sleep 0.05
    done
    [[ "$(blockdev --getsize64 "${DEVICE}")" == "2147483648" ]]

    (
        cd "${BLKTESTS_DIR}"
        TEST_DEVS="${DEVICE}" ./check \
            --device-only \
            --quick="${QUICK_SECONDS}" \
            --output="${EVIDENCE_DIR}/results" \
            "block/${test_name}"
    ) 2>&1 | tee -a "${EVIDENCE_DIR}/blktests-console.log"

    result="${EVIDENCE_DIR}/results/${DEVICE_NAME}/block/${test_name}"
    [[ -f "${result}" ]] || { echo "error: missing result for block/${test_name}" >&2; exit 1; }
    grep -q $'^status\tpass$' "${result}"

    blockdev --setrw "${DEVICE}"
    qemu-nbd -d "${DEVICE}" >/dev/null
    wait "${server_pid}"
    server_pid=""
    grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${case_dir}/server.log"
done

{
    echo "status=ok"
    echo "selected_case_count=4"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
    echo "upstream_commit=$(<"${EVIDENCE_DIR}/upstream-commit")"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_BLKTESTS_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
echo "upstream_commit=$(<"${EVIDENCE_DIR}/upstream-commit")"
for test_name in 003 004 012 042; do
    sed -n '1,20p' "${EVIDENCE_DIR}/block-${test_name}/server.log"
done
