#!/bin/sh

set -eu

bench_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$bench_root/../.." && pwd)
kernel="$repo_root/target/pvm-linux/build/arch/x86/boot/bzImage"
rootfs="$bench_root/build/debian-scheduler-bench.erofs"
manifest="$bench_root/Cargo.toml"

test -f "$kernel"
test -f "$rootfs"

run_mode() {
  cargo run --release --manifest-path "$manifest" -- \
    "$kernel" "$rootfs" "$1" "$2" "$3"
}

run_mode cpu-python 1,4,8,16 1000
run_mode cpu-sha256 1,4,8,16 1000
run_mode cpu-v8 1,4,8,16 1000
run_mode wakeup 1,4,8,16 1000
run_mode fairness 1,4,8,16 1000
run_mode exit 1,4,8,16 1000
run_mode timer-storm 1,4,16 1000
run_mode idle 1,4,16,64,128 2000
