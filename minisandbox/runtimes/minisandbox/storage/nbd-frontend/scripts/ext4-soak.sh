#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# -lt 2 || $# -gt 3 ]]; then
    echo "usage: $0 /dev/nbdX /path/to/xfstests [evidence-directory]" >&2
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

readonly XFSTESTS_DIR="$(cd "$2" && pwd)"
readonly FSSTRESS="${XFSTESTS_DIR}/ltp/fsstress"
readonly FSX="${XFSTESTS_DIR}/ltp/fsx"
[[ -x "${FSSTRESS}" && -x "${FSX}" ]] || {
    echo "error: build upstream xfstests before running the soak gate" >&2
    exit 2
}
for program in awk blockdev e2fsck find git install mkfs.ext4 mount mountpoint ps \
    qemu-nbd setsid sha256sum sync umount uname xfs_io; do
    command -v "${program}" >/dev/null || {
        echo "error: ${program} is required" >&2
        exit 2
    }
done

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SERVER_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly FSSTRESS_WORKER="${SCRIPT_DIR}/fsstress-soak-worker.sh"
readonly SOAK_SECONDS="${MINISANDBOX_SOAK_SECONDS:-7200}"
readonly ATTACH_TIMEOUT_SECONDS="${MINISANDBOX_SOAK_ATTACH_TIMEOUT_SECONDS:-7200}"
readonly REQUEST_TIMEOUT_SECONDS="${MINISANDBOX_SOAK_REQUEST_TIMEOUT_SECONDS:-300}"
readonly FSSTRESS_PROCS="${MINISANDBOX_SOAK_PROCS:-8}"
readonly FSSTRESS_OPS="${MINISANDBOX_SOAK_FSSTRESS_OPS:-128}"
readonly FSX_FILE_BYTES="${MINISANDBOX_SOAK_FSX_BYTES:-268435456}"
readonly SEED="${MINISANDBOX_SOAK_SEED:-1597463007}"
[[ -x "${FSSTRESS_WORKER}" ]] || {
    echo "error: missing executable fsstress worker ${FSSTRESS_WORKER}" >&2
    exit 2
}
[[ "${SOAK_SECONDS}" =~ ^[0-9]+$ && "${SOAK_SECONDS}" -ge 1 ]] || {
    echo "error: MINISANDBOX_SOAK_SECONDS must be a positive integer" >&2
    exit 2
}
[[ "${ATTACH_TIMEOUT_SECONDS}" =~ ^[0-9]+$ && "${ATTACH_TIMEOUT_SECONDS}" -ge 1 \
    && "${ATTACH_TIMEOUT_SECONDS}" -le 86400 ]] || {
    echo "error: MINISANDBOX_SOAK_ATTACH_TIMEOUT_SECONDS must be between 1 and 86400" >&2
    exit 2
}
[[ "${REQUEST_TIMEOUT_SECONDS}" =~ ^[0-9]+$ && "${REQUEST_TIMEOUT_SECONDS}" -ge 1 \
    && "${REQUEST_TIMEOUT_SECONDS}" -le 86400 ]] || {
    echo "error: MINISANDBOX_SOAK_REQUEST_TIMEOUT_SECONDS must be between 1 and 86400" >&2
    exit 2
}
[[ "${FSSTRESS_PROCS}" =~ ^[0-9]+$ && "${FSSTRESS_PROCS}" -ge 1 ]] || {
    echo "error: MINISANDBOX_SOAK_PROCS must be a positive integer" >&2
    exit 2
}
[[ "${FSSTRESS_OPS}" =~ ^[0-9]+$ && "${FSSTRESS_OPS}" -ge 1 \
    && "${FSSTRESS_OPS}" -le 1000000 ]] || {
    echo "error: MINISANDBOX_SOAK_FSSTRESS_OPS must be between 1 and 1000000" >&2
    exit 2
}
[[ "${FSX_FILE_BYTES}" =~ ^[0-9]+$ && "${FSX_FILE_BYTES}" -ge 1048576 \
    && "${FSX_FILE_BYTES}" -le 1073741824 ]] || {
    echo "error: MINISANDBOX_SOAK_FSX_BYTES must be between 1 MiB and 1 GiB" >&2
    exit 2
}
[[ "${SEED}" =~ ^[0-9]+$ && "${SEED}" -ge 1 && "${SEED}" -le 2147483647 ]] || {
    echo "error: MINISANDBOX_SOAK_SEED must be between 1 and INT32_MAX" >&2
    exit 2
}

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
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-ext4-soak.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
readonly MOUNT_DIR="${EVIDENCE_DIR}/mnt"
install -m 0755 "${SERVER_SOURCE}" "${SERVER}"
mkdir -p "${MOUNT_DIR}" "${EVIDENCE_DIR}/cos" "${EVIDENCE_DIR}/fsx-artifacts"
git -C "${XFSTESTS_DIR}" rev-parse HEAD >"${EVIDENCE_DIR}/upstream-commit"
git -C "${STORAGE_DIR}" rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}" status --short >"${EVIDENCE_DIR}/worktree-status"
sha256sum "${SERVER}" >"${EVIDENCE_DIR}/server-sha256"
uname -a >"${EVIDENCE_DIR}/host-kernel"
printf '%s\n' \
    "duration_seconds=${SOAK_SECONDS}" \
    "attach_timeout_seconds=${ATTACH_TIMEOUT_SECONDS}" \
    "request_timeout_seconds=${REQUEST_TIMEOUT_SECONDS}" \
    "fsstress_processes=${FSSTRESS_PROCS}" \
    "fsstress_ops_per_process_per_cycle=${FSSTRESS_OPS}" \
    "fsx_file_bytes=${FSX_FILE_BYTES}" \
    "seed=${SEED}" \
    >"${EVIDENCE_DIR}/configuration"

server_pid=""
fsstress_pid=""
fsx_pid=""
fsstress_pgid=""
fsx_pgid=""

process_group_has_live_members() {
    local pgid="$1"
    ps -eo pgid=,stat= | awk -v pgid="${pgid}" \
        '$1 == pgid && $2 !~ /^Z/ { found = 1 } END { exit !found }'
}

terminate_process_group() {
    local pgid="$1"
    local signal="TERM"

    [[ "${pgid}" =~ ^[0-9]+$ ]] || return 0
    if ! process_group_has_live_members "${pgid}"; then
        wait "${pgid}" >/dev/null 2>&1 || true
        return 0
    fi

    kill -TERM -- "-${pgid}" >/dev/null 2>&1 || true
    for _ in {1..200}; do
        if ! process_group_has_live_members "${pgid}"; then
            wait "${pgid}" >/dev/null 2>&1 || true
            return 0
        fi
        sleep 0.05
    done

    signal="KILL"
    kill -KILL -- "-${pgid}" >/dev/null 2>&1 || true
    for _ in {1..200}; do
        if ! process_group_has_live_members "${pgid}"; then
            wait "${pgid}" >/dev/null 2>&1 || true
            return 0
        fi
        sleep 0.05
    done

    echo "error: process group ${pgid} survived ${signal}" >&2
    return 1
}

cleanup() {
    local exit_status=$?
    local cleanup_failed=0
    trap - EXIT

    terminate_process_group "${fsstress_pgid}" || cleanup_failed=1
    terminate_process_group "${fsx_pgid}" || cleanup_failed=1
    fsstress_pid=""
    fsx_pid=""
    fsstress_pgid=""
    fsx_pgid=""

    if mountpoint -q "${MOUNT_DIR}"; then
        for _ in {1..200}; do
            umount "${MOUNT_DIR}" >/dev/null 2>&1 && break
            sleep 0.05
        done
    fi
    if mountpoint -q "${MOUNT_DIR}"; then
        echo "error: cleanup could not unmount ${MOUNT_DIR}" >&2
        cleanup_failed=1
    elif [[ -e "/sys/block/${DEVICE_NAME}/pid" ]]; then
        qemu-nbd -d "${DEVICE}" >/dev/null 2>&1 || cleanup_failed=1
    fi
    [[ -n "${server_pid}" ]] && kill "${server_pid}" >/dev/null 2>&1 || true

    if [[ "${exit_status}" -eq 0 && "${cleanup_failed}" -ne 0 ]]; then
        exit_status=1
    fi
    return "${exit_status}"
}
trap cleanup EXIT

wait_ready() {
    local started_seconds="${SECONDS}"
    while (( SECONDS - started_seconds < ATTACH_TIMEOUT_SECONDS )); do
        [[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "2147483648" ]] && return
        if ! kill -0 "${server_pid}" 2>/dev/null; then
            wait "${server_pid}" >/dev/null 2>&1 || true
            server_pid=""
            echo "error: NBD server exited before attaching ${DEVICE}" >&2
            exit 1
        fi
        sleep 0.1
    done
    echo "error: NBD attachment timed out for ${DEVICE}" >&2
    exit 1
}

start_server() {
    local log="$1"
    "${SERVER}" \
        --device "${DEVICE}" \
        --database "${EVIDENCE_DIR}/blocks.db" \
        --cos-root "${EVIDENCE_DIR}/cos" \
        --volume-id ext4-soak \
        --request-timeout-seconds "${REQUEST_TIMEOUT_SECONDS}" \
        >"${log}" 2>&1 &
    server_pid=$!
    wait_ready
}

stop_server() {
    local log="$1"
    blockdev --flushbufs "${DEVICE}"
    qemu-nbd -d "${DEVICE}" >/dev/null
    wait "${server_pid}"
    server_pid=""
    grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${log}"
}

start_server "${EVIDENCE_DIR}/server-initial.log"
mkfs.ext4 -F "${DEVICE}" >"${EVIDENCE_DIR}/mkfs.log" 2>&1
mount "${DEVICE}" "${MOUNT_DIR}"
mkdir -p "${MOUNT_DIR}/stress" "${MOUNT_DIR}/fsx"
xfs_io -f -c 'pwrite -S 0x6d -b 1m 0 1m' -c fsync \
    "${MOUNT_DIR}/sentinel.bin" >"${EVIDENCE_DIR}/sentinel-write.log"
sentinel_hash="$(sha256sum "${MOUNT_DIR}/sentinel.bin" | awk '{print $1}')"
printf '%s\n' "${sentinel_hash}" >"${EVIDENCE_DIR}/sentinel-sha256.expected"
df -h "${MOUNT_DIR}" >"${EVIDENCE_DIR}/df-before.log"

started_epoch="$(date +%s)"
setsid "${FSSTRESS_WORKER}" \
    "${FSSTRESS}" \
    "${MOUNT_DIR}/stress" \
    "${SOAK_SECONDS}" \
    "${FSSTRESS_PROCS}" \
    "${FSSTRESS_OPS}" \
    "${SEED}" \
    >"${EVIDENCE_DIR}/fsstress.log" 2>&1 &
fsstress_pid=$!
fsstress_pgid="${fsstress_pid}"
setsid "${FSX}" \
    --duration="${SOAK_SECONDS}" \
    -q -y \
    -S "${SEED}" \
    -l "${FSX_FILE_BYTES}" \
    -o 1048576 \
    -P "${EVIDENCE_DIR}/fsx-artifacts" \
    "${MOUNT_DIR}/fsx/data.bin" \
    >"${EVIDENCE_DIR}/fsx.log" 2>&1 &
fsx_pid=$!
fsx_pgid="${fsx_pid}"

completed_pid=""
completed_status=0
if wait -n -p completed_pid "${fsstress_pid}" "${fsx_pid}"; then
    completed_status=0
else
    completed_status=$?
fi

if [[ "${completed_pid}" == "${fsstress_pid}" ]]; then
    completed_name="fsstress"
    fsstress_pid=""
    remaining_name="fsx"
    remaining_pid="${fsx_pid}"
elif [[ "${completed_pid}" == "${fsx_pid}" ]]; then
    completed_name="fsx"
    fsx_pid=""
    remaining_name="fsstress"
    remaining_pid="${fsstress_pid}"
else
    echo "error: wait did not identify the completed soak worker" >&2
    exit 1
fi

if [[ "${completed_status}" -ne 0 ]]; then
    terminate_process_group "${completed_pid}" || true
    terminate_process_group "${remaining_pid}" || true
    fsstress_pid=""
    fsx_pid=""
    fsstress_pgid=""
    fsx_pgid=""
    echo "error: ${completed_name} failed with status ${completed_status}; see ${EVIDENCE_DIR}/${completed_name}.log" >&2
    exit 1
fi

if wait "${remaining_pid}"; then
    remaining_status=0
else
    remaining_status=$?
    terminate_process_group "${remaining_pid}" || true
    fsstress_pid=""
    fsx_pid=""
    fsstress_pgid=""
    fsx_pgid=""
    echo "error: ${remaining_name} failed with status ${remaining_status}; see ${EVIDENCE_DIR}/${remaining_name}.log" >&2
    exit 1
fi
fsstress_pid=""
fsx_pid=""
fsstress_pgid=""
fsx_pgid=""
grep -q 'MINISANDBOX_FSSTRESS_CYCLES_OK' "${EVIDENCE_DIR}/fsstress.log"
grep -q 'operations completed A-OK' "${EVIDENCE_DIR}/fsx.log"
finished_epoch="$(date +%s)"
elapsed_seconds="$((finished_epoch - started_epoch))"
[[ "${elapsed_seconds}" -ge "${SOAK_SECONDS}" ]]
printf 'elapsed_seconds=%s\n' "${elapsed_seconds}" >>"${EVIDENCE_DIR}/configuration"

sync -f "${MOUNT_DIR}"
df -h "${MOUNT_DIR}" >"${EVIDENCE_DIR}/df-after.log"
find "${MOUNT_DIR}/stress" -xdev -printf '%y %p\n' \
    >"${EVIDENCE_DIR}/fsstress-tree.log"
sentinel_before_reconnect="$(sha256sum "${MOUNT_DIR}/sentinel.bin" | awk '{print $1}')"
printf '%s\n' "${sentinel_before_reconnect}" \
    >"${EVIDENCE_DIR}/sentinel-sha256.before-reconnect"
[[ "${sentinel_before_reconnect}" == "${sentinel_hash}" ]]
[[ -f "${MOUNT_DIR}/fsx/data.bin" ]]
umount "${MOUNT_DIR}"
e2fsck -fn "${DEVICE}" >"${EVIDENCE_DIR}/e2fsck-before-reconnect.log" 2>&1
stop_server "${EVIDENCE_DIR}/server-initial.log"

start_server "${EVIDENCE_DIR}/server-reopened.log"
e2fsck -fn "${DEVICE}" >"${EVIDENCE_DIR}/e2fsck-after-reconnect.log" 2>&1
mount -o ro "${DEVICE}" "${MOUNT_DIR}"
sentinel_after_reconnect="$(sha256sum "${MOUNT_DIR}/sentinel.bin" | awk '{print $1}')"
printf '%s\n' "${sentinel_after_reconnect}" \
    >"${EVIDENCE_DIR}/sentinel-sha256.after-reconnect"
[[ "${sentinel_after_reconnect}" == "${sentinel_hash}" ]]
[[ -f "${MOUNT_DIR}/fsx/data.bin" ]]
umount "${MOUNT_DIR}"
stop_server "${EVIDENCE_DIR}/server-reopened.log"
{
    echo "status=ok"
    echo "duration_seconds=${elapsed_seconds}"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
    echo "upstream_commit=$(<"${EVIDENCE_DIR}/upstream-commit")"
    echo "recovery_writer_epoch=3"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_EXT4_SOAK_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
echo "upstream_commit=$(<"${EVIDENCE_DIR}/upstream-commit")"
echo "duration_seconds=${elapsed_seconds}"
echo "sentinel_sha256=${sentinel_hash}"
sed -n '1,5p' "${EVIDENCE_DIR}/fsx.log"
sed -n '1,20p' "${EVIDENCE_DIR}/server-initial.log"
sed -n '1,20p' "${EVIDENCE_DIR}/server-reopened.log"
