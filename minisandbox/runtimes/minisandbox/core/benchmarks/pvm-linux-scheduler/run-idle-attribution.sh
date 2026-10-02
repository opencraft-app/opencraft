#!/bin/sh

set -eu

bench_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$bench_root/../.." && pwd)
kernel="$repo_root/target/pvm-linux/build/arch/x86/boot/bzImage"
rootfs="$bench_root/build/debian-scheduler-bench.erofs"
manifest="$bench_root/Cargo.toml"
counts=${MSBENCH_IDLE_COUNTS:-64}
duration_ms=${MSBENCH_IDLE_DURATION_MS:-30000}
repetitions=${MSBENCH_IDLE_REPETITIONS:-1}
MSBENCH_PRINT_GUEST_RESULTS=${MSBENCH_PRINT_GUEST_RESULTS:-0}
export MSBENCH_PRINT_GUEST_RESULTS

test -f "$kernel"
test -f "$rootfs"

cargo build --release --manifest-path "$manifest"

sample=1
while test "$sample" -le "$repetitions"; do
  case $(((sample - 1) % 3)) in
    0) modes="idle idle-halt-poll-off idle-wait-until" ;;
    1) modes="idle-halt-poll-off idle-wait-until idle" ;;
    2) modes="idle-wait-until idle idle-halt-poll-off" ;;
  esac
  for mode in $modes; do
    printf '{"kind":"idle-sample","sample":%s,"mode":"%s"}\n' "$sample" "$mode"
    "$bench_root/target/release/pvm-linux-scheduler-bench" \
      "$kernel" "$rootfs" "$mode" "$counts" "$duration_ms"
  done
  sample=$((sample + 1))
done
