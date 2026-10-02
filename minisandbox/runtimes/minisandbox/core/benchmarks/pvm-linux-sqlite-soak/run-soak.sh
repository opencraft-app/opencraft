#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly BENCHMARK_DIR="${REPOSITORY}/benchmarks/pvm-linux-sqlite-soak"
readonly KERNEL="${MSBENCH_KERNEL:-${REPOSITORY}/target/pvm-linux/build/arch/x86/boot/bzImage}"
readonly DEFAULT_LOWER="${REPOSITORY}/target/pvm-linux/debian-trixie-20260713-x86_64.erofs"
readonly SEED_EXT4="${MSBENCH_SEED_EXT4:-${REPOSITORY}/target/pvm-linux/minisandbox-upper-warm-2g.ext4}"
readonly DURATION_SECONDS="${MSBENCH_DURATION_SECONDS:-300}"
readonly CLONES_PER_WAVE="${MSBENCH_CLONES_PER_WAVE:-4}"
readonly SETTLE_BASELINE="${MSBENCH_SETTLE_BASELINE:-0}"
readonly GUEST_STRESS="${MSBENCH_GUEST_STRESS:-0}"
readonly APP_LAYER="${MSBENCH_APP_LAYER:-${REPOSITORY}/target/pvm-linux/pvm-sqlite-soak-guest-stress.erofs}"
readonly LAYERED_BASE="${MSBENCH_LAYERED_BASE:-${REPOSITORY}/target/pvm-linux/debian-layered-init-x86_64.erofs}"
if [[ -n "${MSBENCH_GUEST_TIMEOUT_SECONDS:-}" ]]; then
    GUEST_TIMEOUT_SECONDS="${MSBENCH_GUEST_TIMEOUT_SECONDS}"
elif [[ "${GUEST_STRESS}" == 1 ]]; then
    GUEST_TIMEOUT_SECONDS=120
else
    GUEST_TIMEOUT_SECONDS=30
fi
readonly GUEST_TIMEOUT_SECONDS
readonly TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly EVIDENCE="${MSBENCH_EVIDENCE:-${BENCHMARK_DIR}/evidence/${TIMESTAMP}}"

if [[ -n "${MSBENCH_LOWER:-}" ]]; then
    LOWER="${MSBENCH_LOWER}"
elif [[ "${GUEST_STRESS}" == 1 ]]; then
    if [[ ! -f "${LAYERED_BASE}" ]] \
        || [[ "${DEFAULT_LOWER}" -nt "${LAYERED_BASE}" ]] \
        || [[ "${REPOSITORY}/crates/minisandbox-init/src/lib.rs" -nt "${LAYERED_BASE}" ]]; then
        "${BENCHMARK_DIR}/build-layered-base.sh" "${DEFAULT_LOWER}" "${LAYERED_BASE}"
    fi
    LOWER="${LAYERED_BASE}"
else
    LOWER="${DEFAULT_LOWER}"
fi
readonly LOWER

for required in "${KERNEL}" "${LOWER}" "${SEED_EXT4}"; do
    [[ -f "${required}" ]] || {
        echo "missing required artifact: ${required}" >&2
        exit 1
    }
done
[[ "${DURATION_SECONDS}" =~ ^[0-9]+$ ]] || {
    echo "MSBENCH_DURATION_SECONDS must be a non-negative integer" >&2
    exit 1
}
[[ "${CLONES_PER_WAVE}" =~ ^[0-9]+$ ]] || {
    echo "MSBENCH_CLONES_PER_WAVE must be an integer" >&2
    exit 1
}
[[ "${SETTLE_BASELINE}" == 0 || "${SETTLE_BASELINE}" == 1 ]] || {
    echo "MSBENCH_SETTLE_BASELINE must be 0 or 1" >&2
    exit 1
}
[[ "${GUEST_STRESS}" == 0 || "${GUEST_STRESS}" == 1 ]] || {
    echo "MSBENCH_GUEST_STRESS must be 0 or 1" >&2
    exit 1
}
[[ "${GUEST_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]] || {
    echo "MSBENCH_GUEST_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 1
}

if [[ "${GUEST_STRESS}" == 1 ]] && {
    [[ ! -f "${APP_LAYER}" ]] \
        || [[ "${REPOSITORY}/guest/pvm-linux/python-warm.py" -nt "${APP_LAYER}" ]] \
        || [[ "${REPOSITORY}/guest/pvm-linux/block_stress.py" -nt "${APP_LAYER}" ]];
}; then
    "${BENCHMARK_DIR}/build-guest-layer.sh" "${APP_LAYER}"
fi

mkdir -p "$(dirname "${EVIDENCE}")"
arguments=(
    "${KERNEL}"
    "${LOWER}"
    "${SEED_EXT4}"
    "${EVIDENCE}"
    --duration-seconds "${DURATION_SECONDS}"
    --clones-per-wave "${CLONES_PER_WAVE}"
    --guest-timeout-seconds "${GUEST_TIMEOUT_SECONDS}"
)
if [[ "${SETTLE_BASELINE}" == 1 ]]; then
    arguments+=(--settle-baseline)
fi
if [[ "${GUEST_STRESS}" == 1 ]]; then
    arguments+=(--app-layer "${APP_LAYER}" --guest-stress)
fi

cd "${REPOSITORY}"
cargo run --locked --release \
    --manifest-path "${BENCHMARK_DIR}/Cargo.toml" -- \
    "${arguments[@]}" | tee "${EVIDENCE}.log"
