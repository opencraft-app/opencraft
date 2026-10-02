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
for program in blkdiscard blockdev cmp dd flock git install qemu-nbd sha256sum \
    sqlite3 sync truncate udevadm uname; do
    command -v "${program}" >/dev/null || {
        echo "error: ${program} is required" >&2
        exit 2
    }
done

exec 9>/run/lock/minisandbox-storage-kernel-tests.lock
flock -n 9 || { echo "error: another storage kernel gate is running" >&2; exit 2; }

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SERVER_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly ADMIN_SOURCE="${MINISANDBOX_BLOCK_ADMIN_BINARY:-${STORAGE_DIR}/target/release/minisandbox-block-admin}"
if [[ ! -x "${SERVER_SOURCE}" || ! -x "${ADMIN_SOURCE}" ]]; then
    cargo build --locked --release --manifest-path "${STORAGE_DIR}/Cargo.toml" \
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
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-nbd-discard.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
readonly ADMIN="${EVIDENCE_DIR}/minisandbox-block-admin"
readonly DATABASE="${EVIDENCE_DIR}/blocks.db"
readonly COS_ROOT="${EVIDENCE_DIR}/cos"
readonly SOURCE_VOLUME="discard-source"
readonly SNAPSHOT="before-discard"
readonly CHILD_VOLUME="discard-snapshot-child"
readonly OFFSET=$((128 * 4096))
readonly LENGTH=$((3 * 4096))
mkdir -p "${COS_ROOT}"
install -m 0755 "${SERVER_SOURCE}" "${SERVER}"
install -m 0755 "${ADMIN_SOURCE}" "${ADMIN}"
git -C "${STORAGE_DIR}/.." rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}/.." status --short >"${EVIDENCE_DIR}/worktree-status"
sha256sum "${SERVER}" "${ADMIN}" >"${EVIDENCE_DIR}/binary-sha256"
uname -a >"${EVIDENCE_DIR}/host-kernel"
printf 'offset=%s\nlength=%s\n' "${OFFSET}" "${LENGTH}" \
    >"${EVIDENCE_DIR}/configuration"
dd if=/dev/urandom of="${EVIDENCE_DIR}/before.bin" bs=4096 count=3 status=none
truncate -s "${LENGTH}" "${EVIDENCE_DIR}/zero.bin"

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
    local volume="$1"
    local log="$2"
    "${SERVER}" \
        --device "${DEVICE}" \
        --database "${DATABASE}" \
        --cos-root "${COS_ROOT}" \
        --volume-id "${volume}" >"${log}" 2>&1 &
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

read_range() {
    local output="$1"
    dd if="${DEVICE}" of="${output}" bs=4096 skip=128 count=3 \
        iflag=direct status=none
}

start_server "${SOURCE_VOLUME}" "${EVIDENCE_DIR}/server-seed.log"
dd if="${EVIDENCE_DIR}/before.bin" of="${DEVICE}" bs=4096 seek=128 count=3 \
    oflag=direct conv=fsync,notrunc status=none
read_range "${EVIDENCE_DIR}/seed-read.bin"
cmp "${EVIDENCE_DIR}/before.bin" "${EVIDENCE_DIR}/seed-read.bin"
stop_server "${EVIDENCE_DIR}/server-seed.log"

"${ADMIN}" snapshot \
    --database "${DATABASE}" \
    --cos-root "${COS_ROOT}" \
    --volume-id "${SOURCE_VOLUME}" \
    --snapshot-id "${SNAPSHOT}" >"${EVIDENCE_DIR}/snapshot.log"
grep -q 'MINISANDBOX_BLOCK_SNAPSHOT_OK' "${EVIDENCE_DIR}/snapshot.log"

start_server "${SOURCE_VOLUME}" "${EVIDENCE_DIR}/server-discard.log"
blkdiscard --offset "${OFFSET}" --length "${LENGTH}" "${DEVICE}"
sync
read_range "${EVIDENCE_DIR}/after-discard.bin"
cmp "${EVIDENCE_DIR}/zero.bin" "${EVIDENCE_DIR}/after-discard.bin"
stop_server "${EVIDENCE_DIR}/server-discard.log"
grep -Eq 'MINISANDBOX_NBD_STOPPED.*trims=1' "${EVIDENCE_DIR}/server-discard.log"

"${ADMIN}" fork \
    --database "${DATABASE}" \
    --cos-root "${COS_ROOT}" \
    --snapshot-id "${SNAPSHOT}" \
    --child-volume-id "${CHILD_VOLUME}" >"${EVIDENCE_DIR}/fork.log"
grep -q 'MINISANDBOX_BLOCK_FORK_OK' "${EVIDENCE_DIR}/fork.log"

start_server "${SOURCE_VOLUME}" "${EVIDENCE_DIR}/server-source-reopen.log"
read_range "${EVIDENCE_DIR}/source-reopen.bin"
cmp "${EVIDENCE_DIR}/zero.bin" "${EVIDENCE_DIR}/source-reopen.bin"
stop_server "${EVIDENCE_DIR}/server-source-reopen.log"

start_server "${CHILD_VOLUME}" "${EVIDENCE_DIR}/server-child.log"
read_range "${EVIDENCE_DIR}/child-read.bin"
cmp "${EVIDENCE_DIR}/before.bin" "${EVIDENCE_DIR}/child-read.bin"
stop_server "${EVIDENCE_DIR}/server-child.log"

discard_versions="$(sqlite3 "${DATABASE}" \
    "SELECT count(*) FROM hot_block_versions
      WHERE source_volume_id='${SOURCE_VOLUME}' AND value_kind=2
        AND block_no BETWEEN 128 AND 130;")"
range_results="$(sqlite3 "${DATABASE}" \
    "SELECT count(*) FROM op_results
      WHERE volume_id='${SOURCE_VOLUME}' AND operation_kind=6
        AND outcome_kind=1;")"
[[ "${discard_versions}" == "3" ]]
[[ "${range_results}" == "1" ]]

before_sha="$(sha256sum "${EVIDENCE_DIR}/before.bin" | cut -d' ' -f1)"
zero_sha="$(sha256sum "${EVIDENCE_DIR}/zero.bin" | cut -d' ' -f1)"
{
    echo "status=ok"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
    echo "before_sha256=${before_sha}"
    echo "discarded_sha256=${zero_sha}"
    echo "source_reopen_sha256=$(sha256sum "${EVIDENCE_DIR}/source-reopen.bin" | cut -d' ' -f1)"
    echo "snapshot_child_sha256=$(sha256sum "${EVIDENCE_DIR}/child-read.bin" | cut -d' ' -f1)"
    echo "discard_versions=${discard_versions}"
    echo "range_operation_results=${range_results}"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_DISCARD_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
cat "${EVIDENCE_DIR}/admission-status"
