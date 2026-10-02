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
for program in blkdiscard blockdev cmp dd fio git install python3 qemu-nbd sha256sum; do
    command -v "${program}" >/dev/null || {
        echo "error: ${program} is required" >&2
        exit 2
    }
done

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STORAGE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SERVER_SOURCE="${MINISANDBOX_NBD_BINARY:-${STORAGE_DIR}/target/release/minisandbox-nbd}"
readonly BLOCK_SIZES="${MINISANDBOX_FIO_BLOCK_SIZES:-512 4k 64k 1m}"
readonly QUEUE_DEPTHS="${MINISANDBOX_FIO_QUEUE_DEPTHS:-1 32 128}"
readonly MODE_QUEUE_DEPTH="${MINISANDBOX_FIO_MODE_QUEUE_DEPTH:-32}"
readonly DEVICE_SIZE=2147483648

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
    EVIDENCE_DIR="$(mktemp -d /tmp/minisandbox-nbd-fio.XXXXXX)"
fi
readonly EVIDENCE_DIR
readonly SERVER="${EVIDENCE_DIR}/minisandbox-nbd"
readonly DATABASE="${EVIDENCE_DIR}/blocks.db"
readonly COS_ROOT="${EVIDENCE_DIR}/cos"
mkdir -p "${COS_ROOT}"
install -m 0755 "${SERVER_SOURCE}" "${SERVER}"
git -C "${STORAGE_DIR}/.." rev-parse HEAD >"${EVIDENCE_DIR}/minisandbox-commit"
git -C "${STORAGE_DIR}/.." status --short >"${EVIDENCE_DIR}/worktree-status"
sha256sum "${SERVER}" >"${EVIDENCE_DIR}/server-sha256"
fio --version >"${EVIDENCE_DIR}/fio-version"
uname -a >"${EVIDENCE_DIR}/host-kernel"
cat >"${EVIDENCE_DIR}/configuration" <<EOF
block_sizes=${BLOCK_SIZES}
queue_depths=${QUEUE_DEPTHS}
mode_queue_depth=${MODE_QUEUE_DEPTH}
device_size=${DEVICE_SIZE}
EOF

server_pid=""
server_log=""
cleanup() {
    if [[ -e "/sys/block/${DEVICE_NAME}/pid" ]]; then
        qemu-nbd -d "${DEVICE}" >/dev/null 2>&1 || true
    fi
    if [[ -n "${server_pid}" ]]; then
        kill "${server_pid}" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

start_server() {
    local phase="$1"
    server_log="${EVIDENCE_DIR}/server-${phase}.log"
    "${SERVER}" \
        --device "${DEVICE}" \
        --database "${DATABASE}" \
        --cos-root "${COS_ROOT}" \
        >"${server_log}" 2>&1 &
    server_pid=$!
    for _ in $(seq 1 400); do
        if [[ "$(blockdev --getsize64 "${DEVICE}" 2>/dev/null || true)" == "${DEVICE_SIZE}" ]]; then
            return
        fi
        kill -0 "${server_pid}"
        sleep 0.05
    done
    echo "error: NBD attachment timed out during ${phase}" >&2
    exit 1
}

stop_server() {
    qemu-nbd -d "${DEVICE}" >/dev/null
    wait "${server_pid}"
    server_pid=""
    grep -q 'MINISANDBOX_NBD_STOPPED.*errors=0' "${server_log}"
}

run_fio() {
    local output="$1"
    shift
    fio \
        --filename="${DEVICE}" \
        --ioengine=io_uring \
        --direct=1 \
        --randrepeat=1 \
        --verify=crc32c \
        --verify_fatal=1 \
        --verify_state_save=0 \
        --group_reporting=1 \
        --output-format=json \
        --output="${output}" \
        "$@"
    python3 -c \
        'import json,sys; d=json.load(open(sys.argv[1])); assert d["jobs"][0]["error"] == 0' \
        "${output}"
}

start_server initial

size_for_block() {
    case "$1" in
        512) echo "${MINISANDBOX_FIO_SIZE_512:-512k}" ;;
        4k) echo "${MINISANDBOX_FIO_SIZE_4K:-4m}" ;;
        64k) echo "${MINISANDBOX_FIO_SIZE_64K:-8m}" ;;
        1m) echo "${MINISANDBOX_FIO_SIZE_1M:-16m}" ;;
        *) echo "error: unsupported smoke block size $1" >&2; exit 2 ;;
    esac
}

for block_size in ${BLOCK_SIZES}; do
    for queue_depth in ${QUEUE_DEPTHS}; do
        job="verify-${block_size}-q${queue_depth}"
        output="${EVIDENCE_DIR}/fio-randwrite-${block_size}-q${queue_depth}.json"
        run_fio "${output}" \
            --name="${job}" \
            --rw=randwrite \
            --bs="${block_size}" \
            --iodepth="${queue_depth}" \
            --size="$(size_for_block "${block_size}")" \
            --do_verify=1 \
            --end_fsync=1
    done
done

# The full block-size/queue-depth cross product above stays random-write so its
# results remain comparable. These jobs add sequential and true mixed READ/
# WRITE paths for every request size without multiplying the matrix by three.
for mode in write randrw; do
    for block_size in ${BLOCK_SIZES}; do
        extra_args=()
        [[ "${mode}" != "randrw" ]] || extra_args+=(--rwmixread=50)
        run_fio "${EVIDENCE_DIR}/fio-${mode}-${block_size}-q${MODE_QUEUE_DEPTH}.json" \
            --name="verify-${mode}-${block_size}" \
            --rw="${mode}" \
            --bs="${block_size}" \
            --iodepth="${MODE_QUEUE_DEPTH}" \
            --size="$(size_for_block "${block_size}")" \
            --do_verify=1 \
            --end_fsync=1 \
            "${extra_args[@]}"
    done
done

# Force repeated writes to the same 4 KiB LBAs. A plain randwrite job uses
# fio's random map and therefore does not prove overlapping-write handling.
run_fio "${EVIDENCE_DIR}/fio-overlap-4k-q32.json" \
    --name=verify-overlap-4k \
    --rw=randwrite \
    --norandommap=1 \
    --bs=4k \
    --iodepth=32 \
    --size=4m \
    --io_size=16m \
    --do_verify=1 \
    --end_fsync=1

# End exactly at the last byte of the 2 GiB volume while fio issues 1 MiB user
# requests. Linux may split them at its queue limit; the in-flight gate
# separately calibrates and verifies one 1 MiB NBD command crossing the
# repository's 512 KiB transaction boundary.
run_fio "${EVIDENCE_DIR}/fio-tail-1m-q32.json" \
    --name=verify-volume-tail \
    --rw=write \
    --bs=1m \
    --iodepth=32 \
    --offset=$((DEVICE_SIZE - 16 * 1024 * 1024)) \
    --size=16m \
    --do_verify=1 \
    --end_fsync=1

# Exercise Linux BLKDISCARD and BLKZEROOUT. Linux NBD 6.7 translates the latter
# into ordinary zero WRITE requests even when SEND_WRITE_ZEROES is advertised;
# the exact NBD WRITE_ZEROES+FUA frame remains covered by the protocol gate.
blkdiscard --offset $((1280 * 1024 * 1024)) --length $((4 * 1024 * 1024)) "${DEVICE}"
dd if=/dev/urandom of="${DEVICE}" bs=1M count=4 seek=1024 oflag=direct conv=fsync status=none
blkdiscard --zeroout --offset $((1024 * 1024 * 1024)) --length $((4 * 1024 * 1024)) "${DEVICE}"
dd if="${DEVICE}" bs=1M count=4 skip=1024 iflag=direct status=none \
    | cmp -n $((4 * 1024 * 1024)) - /dev/zero

# Preserve fio verification headers across a real NBD/SQLite process restart.
run_fio "${EVIDENCE_DIR}/fio-restart-write.json" \
    --name=verify-restart \
    --rw=write \
    --bs=64k \
    --iodepth=32 \
    --offset=$((1536 * 1024 * 1024)) \
    --size=16m \
    --do_verify=0 \
    --end_fsync=1
stop_server

start_server recovery
run_fio "${EVIDENCE_DIR}/fio-restart-verify.json" \
    --name=verify-restart \
    --rw=read \
    --bs=64k \
    --iodepth=32 \
    --offset=$((1536 * 1024 * 1024)) \
    --size=16m \
    --verify_only=1
stop_server

grep -Eq 'trims=[1-9][0-9]*' "${EVIDENCE_DIR}/server-initial.log"
grep -q 'writer_epoch=3' "${EVIDENCE_DIR}/server-recovery.log"
expected_results=$((
    $(wc -w <<<"${BLOCK_SIZES}") * $(wc -w <<<"${QUEUE_DEPTHS}")
    + 2 * $(wc -w <<<"${BLOCK_SIZES}")
    + 4
))
[[ "$(find "${EVIDENCE_DIR}" -maxdepth 1 -name 'fio-*.json' | wc -l)" -eq "${expected_results}" ]]
{
    echo "status=ok"
    echo "job_count=${expected_results}"
    echo "minisandbox_commit=$(<"${EVIDENCE_DIR}/minisandbox-commit")"
    echo "recovery_writer_epoch=3"
} >"${EVIDENCE_DIR}/admission-status"
trap - EXIT

echo "MINISANDBOX_NBD_FIO_ADMISSION_OK"
echo "evidence_dir=${EVIDENCE_DIR}"
python3 - "${EVIDENCE_DIR}" <<'PY'
import glob, json, os, sys
for path in sorted(glob.glob(os.path.join(sys.argv[1], "fio-*.json"))):
    job = json.load(open(path))["jobs"][0]
    print(
        f"{job['jobname']} error={job['error']} "
        f"write_iops={job['write']['iops']:.2f} read_iops={job['read']['iops']:.2f}"
    )
PY
sed -n '1,20p' "${EVIDENCE_DIR}/server-initial.log"
sed -n '1,20p' "${EVIDENCE_DIR}/server-recovery.log"
