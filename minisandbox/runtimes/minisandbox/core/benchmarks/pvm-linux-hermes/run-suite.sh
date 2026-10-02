#!/bin/sh

set -eu

bench_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$bench_root/../.." && pwd)
kernel=${MS_HERMES_KERNEL:-$repo_root/target/pvm-linux/build/arch/x86/boot/bzImage}
base=${MS_HERMES_BASE:-$repo_root/target/pvm-linux/hermes-base-d66341ab2863-x86_64.erofs}
app=${MS_HERMES_APP:-$repo_root/target/pvm-linux/hermes-app-d66341ab2863-x86_64.erofs}
upper=${MS_HERMES_UPPER:-$repo_root/target/pvm-linux/hermes-upper-8g.ext4}
memory_mib=${MS_HERMES_MEMORY_MIB:-2048}
build_root=$bench_root/build
binary=$repo_root/target/release/examples/pvm_linux_hermes

test -f "$kernel"
test -f "$base"
test -f "$app"
test -f "$upper"
mkdir -p "$build_root"

cargo build --locked --release -p minisandbox-core \
  --example pvm_linux_hermes --manifest-path "$repo_root/Cargo.toml"

run_case() {
  name=$1
  shift
  pool=$build_root/$name-pool
  mkdir -p "$pool"
  printf '{"kind":"hermes-benchmark","case":"%s"}\n' "$name"
  if test -x /usr/bin/time; then
    /usr/bin/time -v "$binary" \
      "$kernel" "$base" "$app" "$upper" "$pool" "$memory_mib" "$@"
  else
    "$binary" "$kernel" "$base" "$app" "$upper" "$pool" "$memory_mib" "$@"
  fi
}

run_case smoke
run_case startup-sequential-32 --startup-clones 32
run_case startup-concurrent-20 --concurrent-startup-clones 20
run_case chat-concurrent-1 --concurrent-chat-clones 1
run_case chat-concurrent-4 --concurrent-chat-clones 4
run_case chat-concurrent-8 --concurrent-chat-clones 8
run_case chat-concurrent-20 --concurrent-chat-clones 20
run_case warm-chat-concurrent-1 --concurrent-warm-chat-clones 1
run_case warm-chat-concurrent-4 --concurrent-warm-chat-clones 4
run_case warm-chat-concurrent-8 --concurrent-warm-chat-clones 8
run_case warm-chat-concurrent-20 --concurrent-warm-chat-clones 20
run_case gateway-concurrent-1 --concurrent-gateway-clones 1
run_case gateway-concurrent-4 --concurrent-gateway-clones 4
run_case gateway-concurrent-8 --concurrent-gateway-clones 8
run_case gateway-concurrent-20 --concurrent-gateway-clones 20

if test -n "${MS_HERMES_REAL_PROVIDER:-}" \
  && test -n "${MS_HERMES_REAL_MODEL:-}" \
  && test -n "${MS_HERMES_REAL_CREDENTIAL_ENV:-}"; then
  run_case real-chat --real-chat \
    "$MS_HERMES_REAL_PROVIDER" \
    "$MS_HERMES_REAL_MODEL" \
    "$MS_HERMES_REAL_CREDENTIAL_ENV"
fi
