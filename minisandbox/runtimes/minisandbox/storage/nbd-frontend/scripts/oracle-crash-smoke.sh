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

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SERVER_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly ORACLE_SOURCE="${MINISANDBOX_ORACLE_BINARY:-${STORAGE_DIR}/target/release/minisandbox-block-oracle}"
readonly OPERATIONS="${MINISANDBOX_ORACLE_OPERATIONS:-1000}"
readonly CHECKPOINT_EVERY="${MINISANDBOX_ORACLE_CHECKPOINT_EVERY:-50}"
readonly REGION_BYTES="${MINISANDBOX_ORACLE_REGION_BYTES:-67108864}"
readonly SEED="${MINISANDBOX_ORACLE_SEED:-0xdeadbeef}"

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
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-nbd-oracle-crash.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
readonly ORACLE="${EVIDENCE_DIR}/minisandbox-block-oracle"
readonly DATABASE="${EVIDENCE_DIR}/blocks.db"
readonly COS_ROOT="${EVIDENCE_DIR}/cos"
readonly STATE="${EVIDENCE_DIR}/oracle.state"
mkdir -p "${COS_ROOT}"
install -m 0755 "${SERVER_SOURCE}" "${SERVER}"
install -m 0755 "${ORACLE_SOURCE}" "${ORACLE}"
sha256sum "${SERVER}" "${ORACLE}" >"${EVIDENCE_DIR}/binary-sha256"
git -C "${STORAGE_DIR}/.." rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}/.." status --short >"${EVIDENCE_DIR}/worktree-status"
uname -a >"${EVIDENCE_DIR}/host-kernel"

server_pid=""
cleanup() {
    if [[ -e "/sys/block/${DEVICE_NAME}/pid" ]]; then
        qemu-nbd -d "${DEVICE}" >/dev/null 2>&1 || true
    fi
    if [[ -n "${server_pid}" ]]; then
        kill "${server_pid}" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

wait_ready() {
    for _ in $(seq 1 400); do
        if [[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "2147483648" ]]; then
            return
        fi
        kill -0 "${server_pid}"
        sleep 0.05
    done
    echo "error: NBD attachment timed out" >&2
    exit 1
}

"${SERVER}" \
    --device "${DEVICE}" \
    --database "${DATABASE}" \
    --cos-root "${COS_ROOT}" \
    >"${EVIDENCE_DIR}/server-before-crash.log" 2>&1 &
server_pid=$!
wait_ready

"${ORACLE}" run \
    --device "${DEVICE}" \
    --state "${STATE}" \
    --seed "${SEED}" \
    --operations "${OPERATIONS}" \
    --checkpoint-every "${CHECKPOINT_EVERY}" \
    --region-bytes "${REGION_BYTES}" \
    | tee "${EVIDENCE_DIR}/oracle-run.log"

# The oracle state was published only after the final device FLUSH and its own
# fsync+rename+directory-fsync. Kill the complete NBD/SQLite/COS process without
# allowing its normal disconnect or Drop path to run.
kill -9 "${server_pid}"
wait "${server_pid}" 2>/dev/null || true
server_pid=""

for _ in $(seq 1 400); do
    [[ ! -e "/sys/block/${DEVICE_NAME}/pid" ]] && break
    sleep 0.05
done
[[ ! -e "/sys/block/${DEVICE_NAME}/pid" ]]
qemu-nbd -d "${DEVICE}" >/dev/null 2>&1 || true
for _ in $(seq 1 400); do
    [[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "0" ]] && break
    sleep 0.05
done
[[ "$(blockdev --getsize64 "${DEVICE}")" == "0" ]]

"${SERVER}" \
    --device "${DEVICE}" \
    --database "${DATABASE}" \
    --cos-root "${COS_ROOT}" \
    >"${EVIDENCE_DIR}/server-after-crash.log" 2>&1 &
server_pid=$!
wait_ready

"${ORACLE}" verify --device "${DEVICE}" --state "${STATE}" \
    | tee "${EVIDENCE_DIR}/oracle-verify.log"
qemu-nbd -d "${DEVICE}" >/dev/null
wait "${server_pid}"
server_pid=""

grep -q 'writer_epoch=2' "${EVIDENCE_DIR}/server-before-crash.log"
grep -q 'writer_epoch=3' "${EVIDENCE_DIR}/server-after-crash.log"
grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${EVIDENCE_DIR}/server-after-crash.log"
{
    echo "status=ok"
    echo "seed=${SEED}"
    echo "operations=${OPERATIONS}"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
    echo "recovery_writer_epoch=3"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_ORACLE_CRASH_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
sed -n '1,10p' "${EVIDENCE_DIR}/server-before-crash.log"
sed -n '1,10p' "${EVIDENCE_DIR}/server-after-crash.log"
