#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# -lt 3 || $# -gt 4 ]]; then
    echo "usage: $0 /dev/nbdX /dev/nbdY /path/to/xfstests [evidence-directory]" >&2
    exit 2
fi

readonly ORIGIN_DEVICE="$1"
readonly REPLAY_DEVICE="$2"
readonly ORIGIN_NAME="${ORIGIN_DEVICE##*/}"
readonly REPLAY_NAME="${REPLAY_DEVICE##*/}"
for pair in "${ORIGIN_DEVICE}:${ORIGIN_NAME}" "${REPLAY_DEVICE}:${REPLAY_NAME}"; do
    device="${pair%%:*}"
    name="${pair##*:}"
    [[ "${device}" == "/dev/${name}" && "${name}" =~ ^nbd[0-9]+$ ]] || {
        echo "error: both devices must be explicit /dev/nbdX nodes" >&2
        exit 2
    }
    [[ -b "${device}" ]] || { echo "error: missing block device ${device}" >&2; exit 2; }
    [[ ! -e "/sys/block/${name}/pid" ]] || {
        echo "error: ${device} is already attached" >&2
        exit 2
    }
    [[ "$(blockdev --getsize64 "${device}")" == "0" ]] || {
        echo "error: refusing non-empty NBD device ${device}" >&2
        exit 2
    }
done
[[ "${ORIGIN_DEVICE}" != "${REPLAY_DEVICE}" ]] || {
    echo "error: origin and replay devices must differ" >&2
    exit 2
}
[[ "${EUID}" -eq 0 ]] || { echo "error: root is required" >&2; exit 2; }

readonly XFSTESTS_DIR="$(cd "$3" && pwd)"
readonly REPLAY_LOG="${XFSTESTS_DIR}/src/log-writes/replay-log"
[[ -x "${REPLAY_LOG}" ]] || {
    echo "error: build xfstests and its replay-log helper first" >&2
    exit 2
}
for program in blockdev dmsetup e2fsck find git install losetup mkfs.ext4 modprobe mount \
    mountpoint qemu-nbd sha256sum sort sync truncate udevadm umount xfs_io; do
    command -v "${program}" >/dev/null || {
        echo "error: ${program} is required" >&2
        exit 2
    }
done

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SERVER_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly LOG_BYTES="${MINISANDBOX_DM_LOG_BYTES:-536870912}"
[[ "${LOG_BYTES}" =~ ^[0-9]+$ && "${LOG_BYTES}" -ge 134217728 ]] || {
    echo "error: log device must be at least 128 MiB" >&2
    exit 2
}

if [[ ! -x "${SERVER_SOURCE}" ]]; then
    cargo build --release --manifest-path "${STORAGE_DIR}/Cargo.toml" \
        -p minisandbox-nbd-frontend
fi

if [[ $# -eq 4 ]]; then
    EVIDENCE_DIR="$4"
    [[ ! -e "${EVIDENCE_DIR}" ]] || {
        echo "error: evidence directory already exists" >&2
        exit 2
    }
    mkdir -p "${EVIDENCE_DIR}"
else
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-dmlogwrites.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
readonly ORIGIN_MNT="${EVIDENCE_DIR}/origin-mnt"
readonly REPLAY_MNT="${EVIDENCE_DIR}/replay-mnt"
readonly DM_NAME="minisandbox-logwrites-$$"
readonly DM_DEVICE="/dev/mapper/${DM_NAME}"
readonly LOG_IMAGE="${EVIDENCE_DIR}/write-log.img"
mkdir -p "${ORIGIN_MNT}" "${REPLAY_MNT}" "${EVIDENCE_DIR}/origin-cos"
install -m 0755 "${SERVER_SOURCE}" "${SERVER}"
sha256sum "${SERVER}" >"${EVIDENCE_DIR}/server-sha256"
git -C "${XFSTESTS_DIR}" rev-parse HEAD >"${EVIDENCE_DIR}/upstream-commit"
git -C "${STORAGE_DIR}/.." rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}/.." status --short >"${EVIDENCE_DIR}/worktree-status"
uname -a >"${EVIDENCE_DIR}/host-kernel"
truncate -s "${LOG_BYTES}" "${LOG_IMAGE}"
loop_device="$(losetup --find --show "${LOG_IMAGE}")"

origin_pid=""
replay_pid=""
cleanup() {
    mountpoint -q "${ORIGIN_MNT}" && umount "${ORIGIN_MNT}" || true
    mountpoint -q "${REPLAY_MNT}" && umount "${REPLAY_MNT}" || true
    dmsetup info "${DM_NAME}" >/dev/null 2>&1 && dmsetup remove --retry "${DM_NAME}" || true
    [[ -e "/sys/block/${ORIGIN_NAME}/pid" ]] && qemu-nbd -d "${ORIGIN_DEVICE}" >/dev/null 2>&1 || true
    [[ -e "/sys/block/${REPLAY_NAME}/pid" ]] && qemu-nbd -d "${REPLAY_DEVICE}" >/dev/null 2>&1 || true
    [[ -n "${origin_pid}" ]] && kill "${origin_pid}" >/dev/null 2>&1 || true
    [[ -n "${replay_pid}" ]] && kill "${replay_pid}" >/dev/null 2>&1 || true
    [[ -n "${loop_device}" ]] && losetup -d "${loop_device}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_ready() {
    local device="$1"
    local pid="$2"
    for _ in $(seq 1 400); do
        [[ "$(blockdev --getsize64 "${device}" 2>/dev/null || true)" == "2147483648" ]] && return
        kill -0 "${pid}"
        sleep 0.05
    done
    echo "error: NBD attachment timed out for ${device}" >&2
    exit 1
}

modprobe dm_log_writes
dmsetup targets | grep -q '^log-writes '
"${SERVER}" \
    --device "${ORIGIN_DEVICE}" \
    --database "${EVIDENCE_DIR}/origin.db" \
    --cos-root "${EVIDENCE_DIR}/origin-cos" \
    --volume-id dmlog-origin >"${EVIDENCE_DIR}/origin-server.log" 2>&1 &
origin_pid=$!
wait_ready "${ORIGIN_DEVICE}" "${origin_pid}"

sectors="$(blockdev --getsz "${ORIGIN_DEVICE}")"
dmsetup create "${DM_NAME}" \
    --table "0 ${sectors} log-writes ${ORIGIN_DEVICE} ${loop_device}"
udevadm settle
mkfs.ext4 -F "${DM_DEVICE}" >"${EVIDENCE_DIR}/mkfs.log" 2>&1
dmsetup message "${DM_NAME}" 0 mark mkfs
mount "${DM_DEVICE}" "${ORIGIN_MNT}"

xfs_io -f \
    -c 'pwrite -S 0xa5 -b 1m 0 1m' \
    -c fsync \
    "${ORIGIN_MNT}/a.bin" >"${EVIDENCE_DIR}/write-a.log"
a_hash="$(sha256sum "${ORIGIN_MNT}/a.bin" | awk '{print $1}')"
sync -f "${ORIGIN_MNT}"
dmsetup message "${DM_NAME}" 0 mark after-a

xfs_io -f \
    -c 'pwrite -S 0x5a -b 1m 0 1m' \
    -c fsync \
    "${ORIGIN_MNT}/b.bin" >"${EVIDENCE_DIR}/write-b.log"
b_hash="$(sha256sum "${ORIGIN_MNT}/b.bin" | awk '{print $1}')"
sync -f "${ORIGIN_MNT}"
dmsetup message "${DM_NAME}" 0 mark after-b
umount "${ORIGIN_MNT}"
dmsetup message "${DM_NAME}" 0 mark end
dmsetup status "${DM_NAME}" >"${EVIDENCE_DIR}/dm-status.log"
udevadm settle
dmsetup remove --retry "${DM_NAME}"
blockdev --flushbufs "${ORIGIN_DEVICE}"
qemu-nbd -d "${ORIGIN_DEVICE}" >/dev/null
wait "${origin_pid}"
origin_pid=""
grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${EVIDENCE_DIR}/origin-server.log"

for mark in after-a after-b end; do
    case_dir="${EVIDENCE_DIR}/replay-${mark}"
    mkdir -p "${case_dir}/cos"
    "${REPLAY_LOG}" --log "${loop_device}" --find --end-mark "${mark}" \
        >"${case_dir}/find.log"
    [[ -s "${case_dir}/find.log" ]]

    "${SERVER}" \
        --device "${REPLAY_DEVICE}" \
        --database "${case_dir}/blocks.db" \
        --cos-root "${case_dir}/cos" \
        --volume-id "replay-${mark}" >"${case_dir}/server.log" 2>&1 &
    replay_pid=$!
    wait_ready "${REPLAY_DEVICE}" "${replay_pid}"
    "${REPLAY_LOG}" \
        --log "${loop_device}" \
        --replay "${REPLAY_DEVICE}" \
        --end-mark "${mark}" \
        >"${case_dir}/replay.log" 2>&1
    blockdev --flushbufs "${REPLAY_DEVICE}"

    # A sync mark can still describe a mounted, therefore unclean, ext4
    # superblock. Mounting once performs the same journal recovery as boot.
    mount "${REPLAY_DEVICE}" "${REPLAY_MNT}"
    [[ "$(sha256sum "${REPLAY_MNT}/a.bin" | awk '{print $1}')" == "${a_hash}" ]]
    if [[ "${mark}" == "after-a" ]]; then
        [[ ! -e "${REPLAY_MNT}/b.bin" ]]
        expected_entries=$'a.bin\nlost+found'
    else
        [[ "$(sha256sum "${REPLAY_MNT}/b.bin" | awk '{print $1}')" == "${b_hash}" ]]
        expected_entries=$'a.bin\nb.bin\nlost+found'
    fi
    actual_entries="$(find "${REPLAY_MNT}" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)"
    [[ "${actual_entries}" == "${expected_entries}" ]]
    printf '%s\n' "${actual_entries}" >"${case_dir}/root-entries.log"
    umount "${REPLAY_MNT}"
    e2fsck -fn "${REPLAY_DEVICE}" >"${case_dir}/e2fsck.log" 2>&1
    blockdev --flushbufs "${REPLAY_DEVICE}"
    qemu-nbd -d "${REPLAY_DEVICE}" >/dev/null
    wait "${replay_pid}"
    replay_pid=""
    grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${case_dir}/server.log"
done

losetup -d "${loop_device}"
loop_device=""
{
    echo "status=ok"
    echo "replay_prefixes=after-a,after-b,end"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
    echo "upstream_commit=$(<"${EVIDENCE_DIR}/upstream-commit")"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_DM_LOG_WRITES_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
echo "upstream_commit=$(<"${EVIDENCE_DIR}/upstream-commit")"
echo "a_sha256=${a_hash}"
echo "b_sha256=${b_hash}"
sed -n '1,20p' "${EVIDENCE_DIR}/origin-server.log"
for mark in after-a after-b end; do
    echo "mark=${mark} entry=$(<"${EVIDENCE_DIR}/replay-${mark}/find.log")"
    sed -n '1,20p' "${EVIDENCE_DIR}/replay-${mark}/server.log"
done
