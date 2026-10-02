#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

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
for program in blockdev cmp date dd flock git install qemu-nbd sha256sum sqlite3 \
    timeout udevadm uname; do
    command -v "${program}" >/dev/null || {
        echo "error: ${program} is required" >&2
        exit 2
    }
done
exec 9>/run/lock/minisandbox-storage-kernel-tests.lock
flock -n 9 || { echo "error: another storage kernel gate is running" >&2; exit 2; }

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REQUEST_TIMEOUT_SECONDS="${MINISANDBOX_NBD_TIMEOUT_TEST_SECONDS:-2}"
[[ "${REQUEST_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ && "${REQUEST_TIMEOUT_SECONDS}" -le 10 ]] || {
    echo "error: timeout test must use 1..10 seconds" >&2
    exit 2
}

if [[ $# -eq 2 ]]; then
    EVIDENCE_DIR="$2"
    [[ ! -e "${EVIDENCE_DIR}" ]] || {
        echo "error: evidence directory already exists" >&2
        exit 2
    }
    mkdir -p "${EVIDENCE_DIR}"
else
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-nbd-timeout.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly BUILD_TARGET="${EVIDENCE_DIR}/cargo-target"
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
readonly ADMIN="${EVIDENCE_DIR}/minisandbox-block-admin"
readonly DATABASE="${EVIDENCE_DIR}/blocks.db"
readonly COS_ROOT="${EVIDENCE_DIR}/cos"
readonly VOLUME="timeout-volume"
readonly TEST_SESSION="timeout-session"
readonly TEST_OP_ID="nbd-write-${TEST_SESSION}-1"
readonly OFFSET=$((256 * 4096))
readonly LENGTH=4096
mkdir -p "${COS_ROOT}"

if [[ -n "${MINISANDBOX_NBD_BINARY:-}" || -n "${MINISANDBOX_BLOCK_ADMIN_BINARY:-}" ]]; then
    [[ -x "${MINISANDBOX_NBD_BINARY:-}" && -x "${MINISANDBOX_BLOCK_ADMIN_BINARY:-}" ]] || {
        echo "error: both injected timeout binaries must be executable" >&2
        exit 2
    }
    server_source="${MINISANDBOX_NBD_BINARY}"
    admin_source="${MINISANDBOX_BLOCK_ADMIN_BINARY}"
else
    cargo build --locked --release --manifest-path "${STORAGE_DIR}/Cargo.toml" \
        --target-dir "${BUILD_TARGET}" \
        -p minisandbox-nbd-frontend --features fault-injection
    server_source="${BUILD_TARGET}/release/minisandbox-nbd"
    admin_source="${BUILD_TARGET}/release/minisandbox-block-admin"
fi
install -m 0755 "${server_source}" "${SERVER}"
install -m 0755 "${admin_source}" "${ADMIN}"
git -C "${STORAGE_DIR}/.." rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}/.." status --short >"${EVIDENCE_DIR}/worktree-status"
sha256sum "${SERVER}" "${ADMIN}" >"${EVIDENCE_DIR}/binary-sha256"
uname -a >"${EVIDENCE_DIR}/host-kernel"
printf '%s\n' \
    "request_timeout_seconds=${REQUEST_TIMEOUT_SECONDS}" \
    "stall_milliseconds=$((REQUEST_TIMEOUT_SECONDS * 3000))" \
    "offset=${OFFSET}" \
    "length=${LENGTH}" \
    "test_session=${TEST_SESSION}" \
    "test_op_id=${TEST_OP_ID}" >"${EVIDENCE_DIR}/configuration"
dd if=/dev/urandom of="${EVIDENCE_DIR}/before.bin" bs=4096 count=1 status=none
dd if=/dev/urandom of="${EVIDENCE_DIR}/after.bin" bs=4096 count=1 status=none
cmp -s "${EVIDENCE_DIR}/before.bin" "${EVIDENCE_DIR}/after.bin" && {
    echo "error: random before/after values unexpectedly match" >&2
    exit 1
}

server_pid=""
cleanup() {
    if [[ -e "/sys/block/${DEVICE_NAME}/pid" ]]; then
        qemu-nbd -d "${DEVICE}" >/dev/null 2>&1 || true
    fi
    if [[ -n "${server_pid}" ]]; then
        kill "${server_pid}" >/dev/null 2>&1 || true
        wait "${server_pid}" 2>/dev/null || true
    fi
}
trap cleanup EXIT

wait_ready() {
    for _ in $(seq 1 1200); do
        if [[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "2147483648" ]]; then
            udevadm settle
            return
        fi
        kill -0 "${server_pid}"
        sleep 0.05
    done
    echo "error: NBD attachment timed out" >&2
    exit 1
}

start_server() {
    local log="$1"
    shift
    "${SERVER}" \
        --device "${DEVICE}" \
        --database "${DATABASE}" \
        --cos-root "${COS_ROOT}" \
        --volume-id "${VOLUME}" \
        "$@" >"${log}" 2>&1 &
    server_pid=$!
    wait_ready
}

stop_server() {
    local log="$1"
    qemu-nbd -d "${DEVICE}" >/dev/null
    wait "${server_pid}"
    server_pid=""
    grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${log}"
}

read_device() {
    local output="$1"
    dd if="${DEVICE}" of="${output}" bs=4096 skip=256 count=1 \
        iflag=direct status=none
}

# Establish a non-zero old value under a normal attachment.
start_server "${EVIDENCE_DIR}/server-seed.log"
dd if="${EVIDENCE_DIR}/before.bin" of="${DEVICE}" bs=4096 seek=256 count=1 \
    oflag=direct conv=fsync,notrunc status=none
read_device "${EVIDENCE_DIR}/seed-read.bin"
cmp "${EVIDENCE_DIR}/before.bin" "${EVIDENCE_DIR}/seed-read.bin"
stop_server "${EVIDENCE_DIR}/server-seed.log"

# The first write uses a deterministic operation identity and outlives the
# kernel's request deadline. EIO is deliberately treated as outcome-unknown.
start_server "${EVIDENCE_DIR}/server-timeout.log" \
    --request-timeout-seconds "${REQUEST_TIMEOUT_SECONDS}" \
    --test-session-id "${TEST_SESSION}" \
    --test-stall-first-write-ms $((REQUEST_TIMEOUT_SECONDS * 3000))
timeout_epoch="$(sed -n 's/.*writer_epoch=\([0-9][0-9]*\).*/\1/p' \
    "${EVIDENCE_DIR}/server-timeout.log" | head -1)"
[[ "${timeout_epoch}" =~ ^[1-9][0-9]*$ ]]
read_device "${EVIDENCE_DIR}/timeout-baseline.bin"
cmp "${EVIDENCE_DIR}/before.bin" "${EVIDENCE_DIR}/timeout-baseline.bin"

started_ns="$(date +%s%N)"
set +e
timeout 15 dd if="${EVIDENCE_DIR}/after.bin" of="${DEVICE}" bs=4096 seek=256 count=1 \
    oflag=direct conv=notrunc status=none \
    >"${EVIDENCE_DIR}/write.stdout" 2>"${EVIDENCE_DIR}/write.stderr"
write_status=$?
set -e
finished_ns="$(date +%s%N)"
elapsed_ms=$(((finished_ns - started_ns) / 1000000))
[[ "${write_status}" -ne 0 && "${write_status}" -ne 124 ]]
grep -Eqi 'input/output error|no such device|connection timed out' \
    "${EVIDENCE_DIR}/write.stderr"
[[ "${elapsed_ms}" -ge $((REQUEST_TIMEOUT_SECONDS * 500)) && "${elapsed_ms}" -lt 15000 ]]

set +e
wait "${server_pid}"
server_status=$?
set -e
server_pid=""
for _ in $(seq 1 400); do
    [[ ! -e "/sys/block/${DEVICE_NAME}/pid" ]] && break
    sleep 0.05
done
[[ ! -e "/sys/block/${DEVICE_NAME}/pid" ]]
qemu-nbd -d "${DEVICE}" >/dev/null 2>&1 || true
[[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "0" ]]

# Observe the unknown outcome without rotating the writer epoch. Only complete
# old or complete new bytes are legal; any mixed/torn value fails closed.
"${ADMIN}" read-range \
    --database "${DATABASE}" \
    --cos-root "${COS_ROOT}" \
    --volume-id "${VOLUME}" \
    --offset "${OFFSET}" \
    --length "${LENGTH}" \
    --output "${EVIDENCE_DIR}/unknown-outcome.bin" \
    >"${EVIDENCE_DIR}/unknown-read.log"
if cmp -s "${EVIDENCE_DIR}/before.bin" "${EVIDENCE_DIR}/unknown-outcome.bin"; then
    unknown_outcome="old"
elif cmp -s "${EVIDENCE_DIR}/after.bin" "${EVIDENCE_DIR}/unknown-outcome.bin"; then
    unknown_outcome="new"
else
    echo "error: timed-out write recovered to neither complete old nor new value" >&2
    exit 1
fi

# Retry the exact same operation identity. It either applies the known-absent
# attempt once or replays the durable result of the late commit.
"${ADMIN}" replay-range-write \
    --database "${DATABASE}" \
    --cos-root "${COS_ROOT}" \
    --volume-id "${VOLUME}" \
    --writer-epoch "${timeout_epoch}" \
    --op-id "${TEST_OP_ID}" \
    --offset "${OFFSET}" \
    --input "${EVIDENCE_DIR}/after.bin" >"${EVIDENCE_DIR}/retry.log"
grep -q 'MINISANDBOX_BLOCK_REPLAY_OK' "${EVIDENCE_DIR}/retry.log"
retry_replayed="$(sed -n 's/.*replayed=\(true\|false\).*/\1/p' \
    "${EVIDENCE_DIR}/retry.log")"
[[ "${retry_replayed}" == "true" || "${retry_replayed}" == "false" ]]
if [[ "${unknown_outcome}" == "new" ]]; then
    [[ "${retry_replayed}" == "true" ]]
fi
"${ADMIN}" read-range \
    --database "${DATABASE}" \
    --cos-root "${COS_ROOT}" \
    --volume-id "${VOLUME}" \
    --offset "${OFFSET}" \
    --length "${LENGTH}" \
    --output "${EVIDENCE_DIR}/after-retry.bin" \
    >"${EVIDENCE_DIR}/after-retry-read.log"
cmp "${EVIDENCE_DIR}/after.bin" "${EVIDENCE_DIR}/after-retry.bin"
op_result_count="$(sqlite3 "${DATABASE}" \
    "SELECT count(*) FROM op_results
      WHERE volume_id='${VOLUME}' AND writer_epoch=${timeout_epoch}
        AND op_id='${TEST_OP_ID}' AND operation_kind=5 AND outcome_kind=1;")"
[[ "${op_result_count}" == "1" ]]

# Rotate the epoch through a normal attachment and verify durable recovery.
start_server "${EVIDENCE_DIR}/server-reopen.log"
read_device "${EVIDENCE_DIR}/reopened.bin"
cmp "${EVIDENCE_DIR}/after.bin" "${EVIDENCE_DIR}/reopened.bin"
stop_server "${EVIDENCE_DIR}/server-reopen.log"

before_sha="$(sha256sum "${EVIDENCE_DIR}/before.bin" | cut -d' ' -f1)"
after_sha="$(sha256sum "${EVIDENCE_DIR}/after.bin" | cut -d' ' -f1)"
{
    echo "status=ok"
    echo "request_timeout_seconds=${REQUEST_TIMEOUT_SECONDS}"
    echo "write_status=${write_status}"
    echo "elapsed_ms=${elapsed_ms}"
    echo "server_status=${server_status}"
    echo "timeout_writer_epoch=${timeout_epoch}"
    echo "unknown_outcome=${unknown_outcome}"
    echo "retry_replayed=${retry_replayed}"
    echo "operation_result_count=${op_result_count}"
    echo "before_sha256=${before_sha}"
    echo "after_sha256=${after_sha}"
    echo "reopened_sha256=$(sha256sum "${EVIDENCE_DIR}/reopened.bin" | cut -d' ' -f1)"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_TIMEOUT_UNKNOWN_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
cat "${EVIDENCE_DIR}/admission-status"
sed -n '1,20p' "${EVIDENCE_DIR}/write.stderr"
sed -n '1,30p' "${EVIDENCE_DIR}/server-timeout.log"
