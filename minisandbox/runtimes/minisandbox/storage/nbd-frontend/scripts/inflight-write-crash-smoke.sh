#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
    echo "usage: $0 /dev/nbdX [evidence-directory]" >&2
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
for program in blockdev git install mkfifo qemu-nbd sha256sum timeout; do
    command -v "${program}" >/dev/null || {
        echo "error: ${program} is required" >&2
        exit 2
    }
done

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SERVER_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly ORACLE_SOURCE="${MINISANDBOX_INFLIGHT_ORACLE_BINARY:-${STORAGE_DIR}/target/release/minisandbox-inflight-oracle}"
readonly REQUEST_SIZES="${MINISANDBOX_INFLIGHT_SIZES:-512 4096 65536 1048576}"
readonly KILL_DELAYS="${MINISANDBOX_INFLIGHT_DELAYS:-0 0.001 0.010 0.020}"
readonly DEFAULT_BASE_SEEDS="1 521235070 1597463007 2147480000"
readonly BASE_SEEDS="${MINISANDBOX_INFLIGHT_SEEDS:-${DEFAULT_BASE_SEEDS}}"
readonly QUEUE_MAX_KIB=1024
readonly QUEUE_LIMIT="/sys/block/${DEVICE_NAME}/queue/max_sectors_kb"
readonly ORIGINAL_QUEUE_MAX="$(<"${QUEUE_LIMIT}")"

if [[ ! -x "${SERVER_SOURCE}" || ! -x "${ORACLE_SOURCE}" ]]; then
    cargo build --release --manifest-path "${STORAGE_DIR}/Cargo.toml" \
        -p minisandbox-nbd-frontend
fi

if [[ $# -eq 2 ]]; then
    EVIDENCE_DIR="$2"
    [[ ! -e "${EVIDENCE_DIR}" ]] || {
        echo "error: evidence directory already exists" >&2
        exit 2
    }
    mkdir -p "${EVIDENCE_DIR}"
else
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-inflight-crash.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
readonly ORACLE="${EVIDENCE_DIR}/minisandbox-inflight-oracle"
install -m 0755 "${SERVER_SOURCE}" "${SERVER}"
install -m 0755 "${ORACLE_SOURCE}" "${ORACLE}"
printf '%s\n' \
    "request_sizes=${REQUEST_SIZES}" \
    "kill_delays=${KILL_DELAYS}" \
    "base_seeds=${BASE_SEEDS}" \
    >"${EVIDENCE_DIR}/configuration"
git -C "${STORAGE_DIR}" rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}" status --short >"${EVIDENCE_DIR}/worktree-status"
sha256sum "${SERVER}" "${ORACLE}" >"${EVIDENCE_DIR}/binary-sha256"
uname -a >"${EVIDENCE_DIR}/host-kernel"

server_pid=""
writer_pid=""
cleanup() {
    if [[ -n "${writer_pid}" ]]; then
        kill -TERM "${writer_pid}" >/dev/null 2>&1 || true
        wait "${writer_pid}" 2>/dev/null || true
    fi
    if [[ -e "/sys/block/${DEVICE_NAME}/pid" ]]; then
        qemu-nbd -d "${DEVICE}" >/dev/null 2>&1 || true
    fi
    if [[ -n "${server_pid}" ]]; then
        kill -9 "${server_pid}" >/dev/null 2>&1 || true
    fi
    printf '%s\n' "${ORIGINAL_QUEUE_MAX}" >"${QUEUE_LIMIT}" 2>/dev/null || true
}
trap cleanup EXIT

wait_ready() {
    for _ in $(seq 1 400); do
        [[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "2147483648" ]] && return
        kill -0 "${server_pid}"
        sleep 0.05
    done
    echo "error: NBD attachment timed out" >&2
    exit 1
}

start_server() {
    local directory="$1"
    local log="$2"
    "${SERVER}" \
        --device "${DEVICE}" \
        --database "${directory}/blocks.db" \
        --cos-root "${directory}/cos" \
        >"${log}" 2>&1 &
    server_pid=$!
    wait_ready
    printf '%s\n' "${QUEUE_MAX_KIB}" >"${QUEUE_LIMIT}"
    [[ "$(<"${QUEUE_LIMIT}")" == "${QUEUE_MAX_KIB}" ]]
}

clean_disconnect() {
    blockdev --flushbufs "${DEVICE}"
    printf '%s\n' "${ORIGINAL_QUEUE_MAX}" >"${QUEUE_LIMIT}"
    qemu-nbd -d "${DEVICE}" >/dev/null
    wait "${server_pid}"
    server_pid=""
}

reset_after_crash() {
    wait "${server_pid}" 2>/dev/null || true
    server_pid=""
    for _ in $(seq 1 400); do
        [[ ! -e "/sys/block/${DEVICE_NAME}/pid" ]] && break
        sleep 0.05
    done
    qemu-nbd -d "${DEVICE}" >/dev/null 2>&1 || true
    for _ in $(seq 1 400); do
        [[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "0" ]] && break
        sleep 0.05
    done
    [[ "$(blockdev --getsize64 "${DEVICE}")" == "0" ]]
    printf '%s\n' "${ORIGINAL_QUEUE_MAX}" >"${QUEUE_LIMIT}"
}

# Prove the host-specific request-shape assumption before applying the exact
# two-transaction possible-values oracle. With max_sectors_kb=1024, two 1 MiB
# direct writes must arrive as exactly two NBD WRITE commands.
calibration="${EVIDENCE_DIR}/calibration"
mkdir -p "${calibration}/cos"
start_server "${calibration}" "${calibration}/server.log"
"${ORACLE}" prepare \
    --device "${DEVICE}" \
    --state "${calibration}/state" \
    --bytes 1048576 \
    --seed 0x1f116a7e \
    >"${calibration}/prepare.log"
"${ORACLE}" overwrite \
    --device "${DEVICE}" \
    --state "${calibration}/state" \
    >"${calibration}/overwrite.log"
"${ORACLE}" verify \
    --device "${DEVICE}" \
    --state "${calibration}/state" \
    >"${calibration}/verify.log"
clean_disconnect
grep -q 'MINISANDBOX_NBD_STOPPED.*writes=2 .*errors=0' "${calibration}/server.log"
grep -q 'MINISANDBOX_INFLIGHT_VERIFY_OK phase=Completed cut=2 transactions=2' \
    "${calibration}/verify.log"

trial=0
seed_index=0
for base_seed in ${BASE_SEEDS}; do
    [[ "${base_seed}" =~ ^[0-9]+$ && "${base_seed}" -ge 1 \
        && "${base_seed}" -le 2147483647 ]] || {
        echo "error: each MINISANDBOX_INFLIGHT_SEEDS value must be between 1 and INT32_MAX" >&2
        exit 2
    }
    seed_index=$((seed_index + 1))
    for request_size in ${REQUEST_SIZES}; do
        [[ "${request_size}" =~ ^[0-9]+$ ]] || {
            echo "error: invalid request size" >&2
            exit 2
        }
        for kill_delay in ${KILL_DELAYS}; do
            trial=$((trial + 1))
            case_name="seed-$(printf '%02d' "${seed_index}")"
            case_name+="-trial-$(printf '%03d' "${trial}")-${request_size}"
            case_dir="${EVIDENCE_DIR}/${case_name}"
            mkdir -p "${case_dir}/cos"
            mkfifo "${case_dir}/go.fifo"
            start_server "${case_dir}" "${case_dir}/server-before-crash.log"
            grep -q 'writer_epoch=2' "${case_dir}/server-before-crash.log"

            seed=$(((base_seed + request_size + trial - 1) % 2147483647 + 1))
            "${ORACLE}" prepare \
                --device "${DEVICE}" \
                --state "${case_dir}/state" \
                --bytes "${request_size}" \
                --seed "${seed}" \
                >"${case_dir}/prepare.log"

            timeout --signal=KILL 15s "${ORACLE}" overwrite \
                --device "${DEVICE}" \
                --state "${case_dir}/state" \
                --go-file "${case_dir}/go.fifo" \
                >"${case_dir}/overwrite.log" 2>&1 &
            writer_pid=$!
            for _ in $(seq 1 400); do
                grep -q 'MINISANDBOX_INFLIGHT_INTENT_READY' "${case_dir}/overwrite.log" 2>/dev/null && break
                kill -0 "${writer_pid}"
                sleep 0.01
            done
            grep -q 'MINISANDBOX_INFLIGHT_INTENT_READY' "${case_dir}/overwrite.log"
            printf 'x' >"${case_dir}/go.fifo"
            if [[ "${kill_delay}" != "0" ]]; then
                sleep "${kill_delay}"
            fi
            kill -9 "${server_pid}"
            reset_after_crash
            wait "${writer_pid}" 2>/dev/null || true
            writer_pid=""

            start_server "${case_dir}" "${case_dir}/server-after-crash.log"
            grep -q 'writer_epoch=3' "${case_dir}/server-after-crash.log"
            "${ORACLE}" verify \
                --device "${DEVICE}" \
                --state "${case_dir}/state" \
                | tee "${case_dir}/verify.log"
            clean_disconnect
            grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${case_dir}/server-after-crash.log"
        done
    done
done
{
    echo "status=ok"
    echo "trial_count=${trial}"
    echo "base_seed_count=${seed_index}"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_INFLIGHT_CRASH_OK trials=${trial} base_seeds=${seed_index}"
echo "evidence_dir=${EVIDENCE_DIR}"
echo "original_max_sectors_kb=${ORIGINAL_QUEUE_MAX} test_max_sectors_kb=${QUEUE_MAX_KIB}"
sed -n '1,10p' "${calibration}/server.log"
