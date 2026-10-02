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
[[ "${EUID}" -eq 0 ]] || {
    echo "error: root is required for NBD ioctls, mkfs, and mount" >&2
    exit 2
}
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
readonly BINARY_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly SETTLE="${MINISANDBOX_NBD_SETTLE:-1}"
[[ "${SETTLE}" == "0" || "${SETTLE}" == "1" ]] || {
    echo "error: MINISANDBOX_NBD_SETTLE must be 0 or 1" >&2
    exit 2
}

if [[ ! -x "${BINARY_SOURCE}" ]]; then
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
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-nbd-ext4.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly BINARY="${EVIDENCE_DIR}/minisandbox-nbd"
readonly MOUNT_DIR="${EVIDENCE_DIR}/mnt"
readonly DATABASE="${EVIDENCE_DIR}/blocks.db"
readonly COS_ROOT="${EVIDENCE_DIR}/cos"
mkdir -p "${MOUNT_DIR}" "${COS_ROOT}"
install -m 0755 "${BINARY_SOURCE}" "${BINARY}"
git -C "${STORAGE_DIR}/.." rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}/.." status --short >"${EVIDENCE_DIR}/worktree-status"
sha256sum "${BINARY}" >"${EVIDENCE_DIR}/server-sha256"
uname -a >"${EVIDENCE_DIR}/host-kernel"
printf 'settle_on_disconnect=%s\n' "${SETTLE}" >"${EVIDENCE_DIR}/configuration"

server_pid=""
cleanup() {
    if mountpoint -q "${MOUNT_DIR}"; then
        umount "${MOUNT_DIR}" || true
    fi
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

first_args=(
    --device "${DEVICE}"
    --database "${DATABASE}"
    --cos-root "${COS_ROOT}"
)
if [[ "${SETTLE}" == "1" ]]; then
    first_args+=(--settle-on-disconnect)
fi

"${BINARY}" "${first_args[@]}" >"${EVIDENCE_DIR}/server-first.log" 2>&1 &
server_pid=$!
wait_ready

mkfs.ext4 -F -q "${DEVICE}"
mount "${DEVICE}" "${MOUNT_DIR}"
dd if=/dev/urandom of="${MOUNT_DIR}/payload.bin" bs=1M count=8 status=none
mkdir "${MOUNT_DIR}/tree"
printf 'minisandbox-nbd-ext4\n' >"${MOUNT_DIR}/tree/marker.txt"
ln "${MOUNT_DIR}/tree/marker.txt" "${MOUNT_DIR}/marker-hardlink"
expected_sha="$(sha256sum "${MOUNT_DIR}/payload.bin" | cut -d' ' -f1)"
sync
umount "${MOUNT_DIR}"
qemu-nbd -d "${DEVICE}" >/dev/null
wait "${server_pid}"
server_pid=""
grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${EVIDENCE_DIR}/server-first.log"

"${BINARY}" \
    --device "${DEVICE}" \
    --database "${DATABASE}" \
    --cos-root "${COS_ROOT}" \
    >"${EVIDENCE_DIR}/server-second.log" 2>&1 &
server_pid=$!
wait_ready

e2fsck -fn "${DEVICE}" |& tee "${EVIDENCE_DIR}/e2fsck.log"
mount -o ro "${DEVICE}" "${MOUNT_DIR}"
actual_sha="$(sha256sum "${MOUNT_DIR}/payload.bin" | cut -d' ' -f1)"
[[ "${actual_sha}" == "${expected_sha}" ]]
[[ "$(<"${MOUNT_DIR}/tree/marker.txt")" == "minisandbox-nbd-ext4" ]]
[[ "$(stat -c %i "${MOUNT_DIR}/tree/marker.txt")" == \
   "$(stat -c %i "${MOUNT_DIR}/marker-hardlink")" ]]
umount "${MOUNT_DIR}"
qemu-nbd -d "${DEVICE}" >/dev/null
wait "${server_pid}"
server_pid=""
grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${EVIDENCE_DIR}/server-second.log"
{
    echo "status=ok"
    echo "payload_sha256=${actual_sha}"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
    echo "recovery_writer_epoch=3"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_EXT4_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
echo "payload_sha256=${actual_sha}"
sed -n '1,20p' "${EVIDENCE_DIR}/server-first.log"
sed -n '1,20p' "${EVIDENCE_DIR}/server-second.log"
