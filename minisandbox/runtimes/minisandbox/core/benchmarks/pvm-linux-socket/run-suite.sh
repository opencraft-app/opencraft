#!/bin/sh

set -eu

bench_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$bench_root/../.." && pwd)
kernel="$repo_root/target/pvm-linux/build/arch/x86/boot/bzImage"
rootfs="$bench_root/build/debian-socket-bench.erofs"
manifest="$bench_root/Cargo.toml"

test -f "$kernel"
test -f "$rootfs"

run_mode() {
  cargo run --release --manifest-path "$manifest" -- \
    "$kernel" "$rootfs" "$1" "$2" "$3" "$4" "$5" "$6"
}

for bytes in 1 32 256 1024; do
  run_mode tcp-rr "$bytes" 1 1 10000 0
done

# Offered-load runs distinguish low-QPS efficiency from saturation throughput.
# For tcp-rr-rate the last two values are target RR/s and duration in ms.
for rate in 100 1000 5000; do
  run_mode tcp-rr-rate 32 1 1 "$rate" 5000
done

for bytes in 4096 65536 1048576; do
  run_mode tcp-stream-tx "$bytes" 1 1 67108864 0
  run_mode tcp-stream-rx "$bytes" 1 1 67108864 0
done

# One clone with many guest sockets exercises fairness inside one broker.
run_mode tcp-rr 32 8 1 2000 0
run_mode tcp-rr 32 32 1 2000 0

# Several concurrently restored clones exercise aggregate broker scheduling.
run_mode tcp-rr 32 1 8 2000 0

# A deliberately slow host receiver proves that guest TX observes backpressure.
run_mode tcp-stream-tx 65536 1 1 8388608 2000

# Host-to-guest connection establishment reuses the same payload matrix while
# exercising the checkpointed listener, bounded offer queue, and accept path.
run_mode ingress-tcp-rr 32 1 1 10000 0
run_mode ingress-tcp-rr 32 8 1 2000 0
run_mode ingress-tcp-rr 32 16 1 1000 0
run_mode ingress-tcp-rr-rate 32 1 1 1000 5000
run_mode ingress-tcp-stream-tx 65536 1 1 16777216 0
run_mode ingress-tcp-stream-rx 65536 1 1 16777216 0
run_mode ingress-tcp-rr 32 1 4 2000 0
run_mode ingress-tcp-stream-tx 65536 1 1 8388608 2000
