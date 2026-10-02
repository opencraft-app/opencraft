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
for program in blockdev dd dmsetup git install modprobe qemu-nbd sha256sum udevadm; do
    command -v "${program}" >/dev/null || {
        echo "error: ${program} is required" >&2
        exit 2
    }
done

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SERVER_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly ORACLE_SOURCE="${MINISANDBOX_INFLIGHT_ORACLE_BINARY:-${STORAGE_DIR}/target/release/minisandbox-inflight-oracle}"
readonly DM_NAME="minisandbox-flakey-$$"
readonly DM_DEVICE="/dev/mapper/${DM_NAME}"

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
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-dm-flakey.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
readonly ORACLE="${EVIDENCE_DIR}/minisandbox-inflight-oracle"
mkdir -p "${EVIDENCE_DIR}/cos"
install -m 0755 "${SERVER_SOURCE}" "${SERVER}"
install -m 0755 "${ORACLE_SOURCE}" "${ORACLE}"
sha256sum "${SERVER}" "${ORACLE}" >"${EVIDENCE_DIR}/binary-sha256"
git -C "${STORAGE_DIR}/.." rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}/.." status --short >"${EVIDENCE_DIR}/worktree-status"
uname -a >"${EVIDENCE_DIR}/host-kernel"

server_pid=""
cleanup() {
    dmsetup info "${DM_NAME}" >/dev/null 2>&1 && dmsetup remove --retry "${DM_NAME}" || true
    [[ -e "/sys/block/${DEVICE_NAME}/pid" ]] && qemu-nbd -d "${DEVICE}" >/dev/null 2>&1 || true
    [[ -n "${server_pid}" ]] && kill "${server_pid}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

reload_table() {
    local up_seconds="$1"
    local down_seconds="$2"
    dmsetup suspend "${DM_NAME}"
    dmsetup reload "${DM_NAME}" \
        --table "0 ${sectors} flakey ${DEVICE} 0 ${up_seconds} ${down_seconds} 2 error_reads error_writes"
    dmsetup resume "${DM_NAME}"
}

modprobe dm_flakey
dmsetup targets | grep -q '^flakey '
"${SERVER}" \
    --device "${DEVICE}" \
    --database "${EVIDENCE_DIR}/blocks.db" \
    --cos-root "${EVIDENCE_DIR}/cos" \
    --volume-id flakey-volume >"${EVIDENCE_DIR}/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 400); do
    [[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "2147483648" ]] && break
    kill -0 "${server_pid}"
    sleep 0.05
done
[[ "$(blockdev --getsize64 "${DEVICE}")" == "2147483648" ]]

sectors="$(blockdev --getsz "${DEVICE}")"
dmsetup create "${DM_NAME}" \
    --table "0 ${sectors} flakey ${DEVICE} 0 3600 0 2 error_reads error_writes"
udevadm settle
"${ORACLE}" prepare \
    --device "${DM_DEVICE}" \
    --state "${EVIDENCE_DIR}/state" \
    --bytes 65536 \
    --seed 0xf1a6e7 \
    >"${EVIDENCE_DIR}/prepare.log"

# Flush the page cache while the mapping is healthy. Reloading starts a new
# interval; up=0 then enters the down state immediately. Explicit error flags
# avoid relying on kernel-version-specific no-feature behavior.
blockdev --flushbufs "${DM_DEVICE}"
reload_table 0 3600
dmsetup table "${DM_NAME}" >"${EVIDENCE_DIR}/down-table.log"
dmsetup status "${DM_NAME}" >"${EVIDENCE_DIR}/down-status.log"
grep -q '0 3600 2 error_reads error_writes' "${EVIDENCE_DIR}/down-table.log"
if dd if="${DM_DEVICE}" of=/dev/null bs=4096 count=1 iflag=direct status=none \
    2>"${EVIDENCE_DIR}/read-eio.log"; then
    echo "error: direct read unexpectedly succeeded in flakey down state" >&2
    exit 1
fi
if dd if=/dev/zero of="${DM_DEVICE}" bs=4096 count=1 oflag=direct conv=notrunc \
    status=none 2>"${EVIDENCE_DIR}/write-eio.log"; then
    echo "error: direct write unexpectedly succeeded in flakey down state" >&2
    exit 1
fi
grep -qi 'input/output error' "${EVIDENCE_DIR}/read-eio.log"
grep -qi 'input/output error' "${EVIDENCE_DIR}/write-eio.log"

reload_table 3600 0
dmsetup table "${DM_NAME}" >"${EVIDENCE_DIR}/recovered-table.log"
"${ORACLE}" verify \
    --device "${DM_DEVICE}" \
    --state "${EVIDENCE_DIR}/state" \
    | tee "${EVIDENCE_DIR}/verify.log"
blockdev --flushbufs "${DM_DEVICE}"
dmsetup status "${DM_NAME}" >"${EVIDENCE_DIR}/dm-status.log"
# Device probing after the final table reload may still hold a short-lived
# reference. Wait for udev before treating EBUSY as a real teardown failure.
udevadm settle
dmsetup remove --retry "${DM_NAME}"
blockdev --flushbufs "${DEVICE}"
qemu-nbd -d "${DEVICE}" >/dev/null
wait "${server_pid}"
server_pid=""
grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${EVIDENCE_DIR}/server.log"
{
    echo "status=ok"
    echo "failure_mode=error_reads,error_writes"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_DM_FLAKEY_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
sed -n '1,20p' "${EVIDENCE_DIR}/server.log"
sed -n '1,5p' "${EVIDENCE_DIR}/read-eio.log"
sed -n '1,5p' "${EVIDENCE_DIR}/write-eio.log"
