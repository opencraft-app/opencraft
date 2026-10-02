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
for program in blockdev e2fsck find git install mkfs.ext4 mount mountpoint qemu-nbd \
    sha256sum sqlite3 sync umount uname xfs_io; do
    command -v "${program}" >/dev/null || {
        echo "error: ${program} is required" >&2
        exit 2
    }
done

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SERVER_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly HIGH_BYTES="${MINISANDBOX_ONLINE_HIGH_BYTES:-16777216}"
readonly LOW_BYTES="${MINISANDBOX_ONLINE_LOW_BYTES:-8388608}"
readonly PACK_BYTES="${MINISANDBOX_ONLINE_PACK_BYTES:-1048576}"
for value in "${HIGH_BYTES}" "${LOW_BYTES}" "${PACK_BYTES}"; do
    [[ "${value}" =~ ^[0-9]+$ && "${value}" -ge 4096 \
        && $((value % 4096)) -eq 0 ]] || {
        echo "error: online byte bounds must be positive 4 KiB multiples" >&2
        exit 2
    }
done
[[ "${LOW_BYTES}" -lt "${HIGH_BYTES}" ]] || {
    echo "error: low watermark must be below high watermark" >&2
    exit 2
}

if [[ ! -x "${SERVER_SOURCE}" ]]; then
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
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-online-settle.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
readonly MOUNT_DIR="${EVIDENCE_DIR}/mnt"
readonly DATABASE="${EVIDENCE_DIR}/blocks.db"
readonly COS_ROOT="${EVIDENCE_DIR}/cos"
mkdir -p "${MOUNT_DIR}" "${COS_ROOT}"
install -m 0755 "${SERVER_SOURCE}" "${SERVER}"

git -C "${STORAGE_DIR}" rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}" status --short >"${EVIDENCE_DIR}/worktree-status"
git -C "${STORAGE_DIR}" status --short >"${EVIDENCE_DIR}/minisandbox-status"
sha256sum "${SERVER}" >"${EVIDENCE_DIR}/server-sha256"
uname -a >"${EVIDENCE_DIR}/host-kernel"
printf '%s\n' \
    "high_watermark_bytes=${HIGH_BYTES}" \
    "low_watermark_bytes=${LOW_BYTES}" \
    "max_pack_bytes=${PACK_BYTES}" \
    >"${EVIDENCE_DIR}/configuration"

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
    for _ in $(seq 1 1200); do
        if [[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "2147483648" ]]; then
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
        --volume-id online-ext4 \
        "$@" >"${log}" 2>&1 &
    server_pid=$!
    wait_ready
}

start_server "${EVIDENCE_DIR}/server-online.log" \
    --online-settle-high-bytes "${HIGH_BYTES}" \
    --online-settle-low-bytes "${LOW_BYTES}" \
    --online-settle-pack-bytes "${PACK_BYTES}"

mkfs.ext4 -F "${DEVICE}" >"${EVIDENCE_DIR}/mkfs.log" 2>&1
mount "${DEVICE}" "${MOUNT_DIR}"
xfs_io -f -c 'pwrite -S 0x5a -b 1m 0 64m' -c fsync \
    "${MOUNT_DIR}/payload.bin" >"${EVIDENCE_DIR}/payload-write.log"
expected_sha="$(sha256sum "${MOUNT_DIR}/payload.bin" | cut -d' ' -f1)"
sync -f "${MOUNT_DIR}"

object_count=0
for _ in $(seq 1 1200); do
    object_count="$(find "${COS_ROOT}/objects" -type f -name '*.bin' 2>/dev/null | wc -l)"
    if [[ "${object_count}" -gt 0 ]]; then
        break
    fi
    kill -0 "${server_pid}"
    sleep 0.05
done
[[ "${object_count}" -gt 0 ]] || {
    echo "error: no cold object appeared while ext4 remained mounted" >&2
    exit 1
}
findmnt "${MOUNT_DIR}" >"${EVIDENCE_DIR}/mounted-while-cold"
printf 'objects_while_mounted=%s\n' "${object_count}" \
    >"${EVIDENCE_DIR}/online-observation"

# Continue mutating the same mounted filesystem after cold publication. This
# forces hot/cold mixed reads and proves settlement is not a disconnect hook.
xfs_io -f -c 'pwrite -S 0xa7 -b 1m 0 32m' -c fsync \
    "${MOUNT_DIR}/churn.bin" >"${EVIDENCE_DIR}/churn-write.log"
[[ "$(sha256sum "${MOUNT_DIR}/payload.bin" | cut -d' ' -f1)" == "${expected_sha}" ]]
umount "${MOUNT_DIR}"
qemu-nbd -d "${DEVICE}" >/dev/null
wait "${server_pid}"
server_pid=""
grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${EVIDENCE_DIR}/server-online.log"
grep -q 'MINISANDBOX_NBD_ONLINE_SETTLED' "${EVIDENCE_DIR}/server-online.log"

sqlite3 -readonly "${DATABASE}" <<'SQL' >"${EVIDENCE_DIR}/rounds.tsv"
.mode tabs
SELECT round_id, state, cutoff_commit_version, target_payload_bytes,
       settled_payload_bytes, generation
  FROM settlement_rounds ORDER BY round_id;
SQL
[[ "$(awk -F '\t' '$2 == 1 {count++} END {print count + 0}' "${EVIDENCE_DIR}/rounds.tsv")" == "0" ]]
[[ "$(awk -F '\t' '$2 == 2 {count++} END {print count + 0}' "${EVIDENCE_DIR}/rounds.tsv")" -gt 0 ]]

start_server "${EVIDENCE_DIR}/server-reopened.log"
e2fsck -fn "${DEVICE}" >"${EVIDENCE_DIR}/e2fsck.log" 2>&1
mount -o ro "${DEVICE}" "${MOUNT_DIR}"
actual_sha="$(sha256sum "${MOUNT_DIR}/payload.bin" | cut -d' ' -f1)"
[[ "${actual_sha}" == "${expected_sha}" ]]
umount "${MOUNT_DIR}"
qemu-nbd -d "${DEVICE}" >/dev/null
wait "${server_pid}"
server_pid=""
grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${EVIDENCE_DIR}/server-reopened.log"
trap - EXIT

printf '%s\n' \
    "MINISANDBOX_NBD_ONLINE_SETTLE_EXT4_OK" \
    "payload_sha256=${actual_sha}" \
    "objects_while_mounted=${object_count}" \
    >"${EVIDENCE_DIR}/result"
{
    echo "status=ok"
    echo "payload_sha256=${actual_sha}"
    echo "objects_while_mounted=${object_count}"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
    echo "recovery_writer_epoch=3"
} >"${EVIDENCE_DIR}/admission-status"

echo "MINISANDBOX_NBD_ONLINE_SETTLE_EXT4_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
echo "payload_sha256=${actual_sha}"
echo "objects_while_mounted=${object_count}"
sed -n '1,20p' "${EVIDENCE_DIR}/server-online.log"
sed -n '1,20p' "${EVIDENCE_DIR}/server-reopened.log"
