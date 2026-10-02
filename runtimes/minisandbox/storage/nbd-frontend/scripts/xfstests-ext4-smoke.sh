#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
    echo "usage: $0 /dev/nbdX /dev/nbdY /path/to/xfstests [evidence-directory]" >&2
    exit 2
fi

readonly TEST_DEVICE="$1"
readonly SCRATCH_DEVICE="$2"
readonly TEST_NAME="${TEST_DEVICE##*/}"
readonly SCRATCH_NAME="${SCRATCH_DEVICE##*/}"
for pair in "${TEST_DEVICE}:${TEST_NAME}" "${SCRATCH_DEVICE}:${SCRATCH_NAME}"; do
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
[[ "${TEST_DEVICE}" != "${SCRATCH_DEVICE}" ]] || {
    echo "error: TEST and SCRATCH devices must differ" >&2
    exit 2
}
[[ "${EUID}" -eq 0 ]] || { echo "error: root is required" >&2; exit 2; }

readonly XFSTESTS_DIR="$(cd "$3" && pwd)"
[[ -x "${XFSTESTS_DIR}/check" && -x "${XFSTESTS_DIR}/ltp/fsstress" ]] || {
    echo "error: build xfstests with make before running this script" >&2
    exit 2
}
for program in awk blockdev e2fsck flock git install mkfs.ext4 mount mountpoint qemu-nbd sha256sum tee umount; do
    command -v "${program}" >/dev/null || {
        echo "error: ${program} is required" >&2
        exit 2
    }
done

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SERVER_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly ATTACH_TIMEOUT_SECONDS="${MINISANDBOX_XFSTESTS_ATTACH_TIMEOUT_SECONDS:-120}"
readonly REQUEST_TIMEOUT_SECONDS="${MINISANDBOX_XFSTESTS_REQUEST_TIMEOUT_SECONDS:-300}"
readonly DEFAULT_CASES_FILE="${SCRIPT_DIR}/xfstests-block-semantics.list"
declare -a XFSTESTS_CASES
if [[ -n "${MINISANDBOX_XFSTESTS_CASES:-}" ]]; then
    read -r -a XFSTESTS_CASES <<<"${MINISANDBOX_XFSTESTS_CASES}"
    CASE_SOURCE="environment override"
else
    mapfile -t XFSTESTS_CASES < <(awk '{ sub(/#.*/, ""); if (NF) print $1 }' "${DEFAULT_CASES_FILE}")
    CASE_SOURCE="${DEFAULT_CASES_FILE}"
fi
readonly -a XFSTESTS_CASES
readonly CASE_SOURCE
[[ "${#XFSTESTS_CASES[@]}" -gt 0 ]] || { echo "error: no xfstests cases selected" >&2; exit 2; }

# xfstests creates host-global transient scope names such as
# fstests-generic-075.scope. Two suite processes running the same case can kill
# or reject one another even when TEST_DEV and RESULT_BASE differ.
readonly LOCK_FILE="${MINISANDBOX_XFSTESTS_LOCK_FILE:-/run/lock/minisandbox-xfstests.lock}"
exec 9>"${LOCK_FILE}"
flock -n 9 || {
    echo "error: another minisandbox xfstests adapter is running" >&2
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
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-xfstests-ext4.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
readonly TEST_MOUNT_DIR="${EVIDENCE_DIR}/test-mnt"
readonly SCRATCH_MOUNT_DIR="${EVIDENCE_DIR}/scratch-mnt"
mkdir -p "${TEST_MOUNT_DIR}" "${SCRATCH_MOUNT_DIR}" "${EVIDENCE_DIR}/results"
install -m 0755 "${SERVER_SOURCE}" "${SERVER}"
git -C "${XFSTESTS_DIR}" rev-parse HEAD >"${EVIDENCE_DIR}/upstream-commit"
git -C "${STORAGE_DIR}/.." rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}/.." status --short >"${EVIDENCE_DIR}/worktree-status"
sha256sum "${SERVER}" >"${EVIDENCE_DIR}/server-sha256"
uname -a >"${EVIDENCE_DIR}/host-kernel"
printf '%s\n' "${XFSTESTS_CASES[@]}" >"${EVIDENCE_DIR}/selected-cases"
printf '%s\n' "${CASE_SOURCE}" >"${EVIDENCE_DIR}/case-source"
printf '%s\n' "${REQUEST_TIMEOUT_SECONDS}" >"${EVIDENCE_DIR}/request-timeout-seconds"
sha256sum "${DEFAULT_CASES_FILE}" >"${EVIDENCE_DIR}/default-cases-sha256"

test_pid=""
scratch_pid=""
cleanup() {
    mountpoint -q "${TEST_MOUNT_DIR}" && umount "${TEST_MOUNT_DIR}" || true
    mountpoint -q "${SCRATCH_MOUNT_DIR}" && umount "${SCRATCH_MOUNT_DIR}" || true
    [[ -e "/sys/block/${TEST_NAME}/pid" ]] && qemu-nbd -d "${TEST_DEVICE}" >/dev/null 2>&1 || true
    [[ -e "/sys/block/${SCRATCH_NAME}/pid" ]] && qemu-nbd -d "${SCRATCH_DEVICE}" >/dev/null 2>&1 || true
    [[ -n "${test_pid}" ]] && kill "${test_pid}" >/dev/null 2>&1 || true
    [[ -n "${scratch_pid}" ]] && kill "${scratch_pid}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_ready() {
    local device="$1"
    local pid="$2"
    for _ in $(seq 1 $((ATTACH_TIMEOUT_SECONDS * 20))); do
        [[ "$(blockdev --getsize64 "${device}" 2>/dev/null || true)" == "2147483648" ]] && return
        kill -0 "${pid}"
        sleep 0.05
    done
    echo "error: NBD attachment timed out for ${device}" >&2
    exit 1
}

"${SERVER}" --device "${TEST_DEVICE}" \
    --database "${EVIDENCE_DIR}/test.db" \
    --cos-root "${EVIDENCE_DIR}/test-cos" \
    --volume-id xfstests-test \
    --request-timeout-seconds "${REQUEST_TIMEOUT_SECONDS}" \
    >"${EVIDENCE_DIR}/test-server.log" 2>&1 &
test_pid=$!
"${SERVER}" --device "${SCRATCH_DEVICE}" \
    --database "${EVIDENCE_DIR}/scratch.db" \
    --cos-root "${EVIDENCE_DIR}/scratch-cos" \
    --volume-id xfstests-scratch \
    --request-timeout-seconds "${REQUEST_TIMEOUT_SECONDS}" \
    >"${EVIDENCE_DIR}/scratch-server.log" 2>&1 &
scratch_pid=$!
wait_ready "${TEST_DEVICE}" "${test_pid}"
wait_ready "${SCRATCH_DEVICE}" "${scratch_pid}"

mkfs.ext4 -F "${TEST_DEVICE}" >"${EVIDENCE_DIR}/mkfs-test.log" 2>&1
mount "${TEST_DEVICE}" "${TEST_MOUNT_DIR}"
(
    cd "${XFSTESTS_DIR}"
    HOST_OPTIONS=/dev/null \
    FSTYP=ext4 \
    TEST_DEV="${TEST_DEVICE}" \
    TEST_DIR="${TEST_MOUNT_DIR}" \
    SCRATCH_DEV="${SCRATCH_DEVICE}" \
    SCRATCH_MNT="${SCRATCH_MOUNT_DIR}" \
    RESULT_BASE="${EVIDENCE_DIR}/results" \
    KEEP_DMESG=yes \
        ./check --exact-order "${XFSTESTS_CASES[@]}"
) 2>&1 | tee "${EVIDENCE_DIR}/xfstests-console.log"

mapfile -t NOTRUN_CASES < <(find "${EVIDENCE_DIR}/results" -type f -name '*.notrun' -print | sort)
if [[ "${#NOTRUN_CASES[@]}" -ne 0 ]]; then
    echo "error: selected supported-set cases were skipped:" >&2
    printf '  %s\n' "${NOTRUN_CASES[@]}" >&2
    exit 1
fi

mountpoint -q "${TEST_MOUNT_DIR}" && umount "${TEST_MOUNT_DIR}" || true
mountpoint -q "${SCRATCH_MOUNT_DIR}" && umount "${SCRATCH_MOUNT_DIR}" || true
blockdev --flushbufs "${TEST_DEVICE}"
blockdev --flushbufs "${SCRATCH_DEVICE}"
qemu-nbd -d "${TEST_DEVICE}" >/dev/null
qemu-nbd -d "${SCRATCH_DEVICE}" >/dev/null
wait "${test_pid}"
wait "${scratch_pid}"
test_pid=""
scratch_pid=""
grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${EVIDENCE_DIR}/test-server.log"
grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${EVIDENCE_DIR}/scratch-server.log"

# Reopen the tested filesystem under a fresh fencing epoch before the final
# read-only filesystem check. This catches persistence that existed only in
# the first frontend process.
"${SERVER}" --device "${TEST_DEVICE}" \
    --database "${EVIDENCE_DIR}/test.db" \
    --cos-root "${EVIDENCE_DIR}/test-cos" \
    --volume-id xfstests-test \
    --request-timeout-seconds "${REQUEST_TIMEOUT_SECONDS}" \
    >"${EVIDENCE_DIR}/test-server-recovery.log" 2>&1 &
test_pid=$!
wait_ready "${TEST_DEVICE}" "${test_pid}"
e2fsck -fn "${TEST_DEVICE}" >"${EVIDENCE_DIR}/e2fsck-test.log" 2>&1
blockdev --flushbufs "${TEST_DEVICE}"
qemu-nbd -d "${TEST_DEVICE}" >/dev/null
wait "${test_pid}"
test_pid=""
grep -q 'writer_epoch=3' "${EVIDENCE_DIR}/test-server-recovery.log"
grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${EVIDENCE_DIR}/test-server-recovery.log"
{
    echo "status=ok"
    echo "filesystem=ext4"
    echo "selected_case_count=${#XFSTESTS_CASES[@]}"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
    echo "upstream_commit=$(<"${EVIDENCE_DIR}/upstream-commit")"
    echo "recovery_writer_epoch=3"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_XFSTESTS_EXT4_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
echo "upstream_commit=$(<"${EVIDENCE_DIR}/upstream-commit")"
sed -n '1,20p' "${EVIDENCE_DIR}/test-server.log"
sed -n '1,20p' "${EVIDENCE_DIR}/scratch-server.log"
sed -n '1,20p' "${EVIDENCE_DIR}/test-server-recovery.log"
sed -n '1,20p' "${EVIDENCE_DIR}/e2fsck-test.log"
