#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# -ne 6 ]]; then
    echo "usage: $0 /path/to/fsstress test-directory duration-seconds processes ops-per-process seed" >&2
    exit 2
fi

readonly FSSTRESS="$1"
readonly TEST_DIR="$2"
readonly DURATION_SECONDS="$3"
readonly PROCESSES="$4"
readonly OPS_PER_PROCESS="$5"
readonly BASE_SEED="$6"

[[ -x "${FSSTRESS}" ]] || { echo "error: fsstress is not executable" >&2; exit 2; }
[[ -d "${TEST_DIR}" ]] || { echo "error: test directory does not exist" >&2; exit 2; }
for value in DURATION_SECONDS PROCESSES OPS_PER_PROCESS BASE_SEED; do
    [[ "${!value}" =~ ^[0-9]+$ && "${!value}" -ge 1 ]] || {
        echo "error: ${value} must be a positive integer" >&2
        exit 2
    }
done
[[ "${BASE_SEED}" -le 2147483647 ]] || {
    echo "error: BASE_SEED must not exceed INT32_MAX" >&2
    exit 2
}

# fsstress --duration deliberately ignores -n and accumulates namespace/data
# until the deadline. On a deliberately small 2 GiB qualification volume this
# can turn the test into an accidental ENOSPC test. Run finite, independently
# seeded cycles instead. Upstream -c removes each process directory after every
# loop, bounding live space without weakening the operation mix within a cycle.
readonly START_SECONDS="${SECONDS}"
cycle=0
while (( SECONDS - START_SECONDS < DURATION_SECONDS )); do
    cycle=$((cycle + 1))
    cycle_seed=$(((BASE_SEED + cycle - 2) % 2147483647 + 1))
    "${FSSTRESS}" \
        -c \
        -l 1 \
        -n "${OPS_PER_PROCESS}" \
        -d "${TEST_DIR}" \
        -p "${PROCESSES}" \
        -s "${cycle_seed}"
done

elapsed_seconds="$((SECONDS - START_SECONDS))"
echo "MINISANDBOX_FSSTRESS_CYCLES_OK cycles=${cycle} elapsed_seconds=${elapsed_seconds}"
