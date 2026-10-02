#!/usr/bin/env bash
set -euo pipefail

workspace_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
zig=${WORKERD_ZIG:-}
workerd_source=${RIVET_WORKERD_SOURCE:-$workspace_root/third-party/workerd-fdb}
linker=${RIVET_WORKERD_HOST_MUSL_LINKER:-${workerd_source:+$workerd_source/tools/zig-cxx-musl}}
lock_file=$workspace_root/runtimes/workerd/workerd-fdb.lock

if [[ $(uname -s)-$(uname -m) != Linux-x86_64 ]]; then
	echo "the Rivet workerd host release must be built on Linux x86_64" >&2
	exit 1
fi
if [[ -z "$zig" || ! -x "$zig" ]]; then
	echo "WORKERD_ZIG must point to a verified Zig compiler" >&2
	exit 1
fi
if [[ "$workerd_source" != /* || ! -d "$workerd_source/.git" ]]; then
	echo "missing workerd-fdb checkout; run runtimes/workerd/setup-fork.sh" >&2
	exit 1
fi
zig_version=$("$zig" version)
if [[ "$zig_version" != 0.14.1 ]]; then
	echo "WORKERD_ZIG must be the qualified Zig 0.14.1 release, got: $zig_version" >&2
	exit 1
fi
if [[ ! -f "$lock_file" ]]; then
	echo "missing workerd source lock: $lock_file" >&2
	exit 1
fi
expected_workerd_commit=$(awk -F'"' '$1 ~ /^fork_commit/ { print $2 }' "$lock_file")
actual_workerd_commit=$(git -C "$workerd_source" rev-parse HEAD 2>/dev/null || true)
if [[ -z "$expected_workerd_commit" || "$actual_workerd_commit" != "$expected_workerd_commit" ]]; then
	echo "RIVET_WORKERD_SOURCE must be the locked workerd-fdb commit $expected_workerd_commit" >&2
	exit 1
fi
if [[ ! -x "$linker" ]]; then
	echo "RIVET_WORKERD_HOST_MUSL_LINKER must point to the Zig musl linker wrapper" >&2
	exit 1
fi

cd "$workspace_root"
export WORKERD_ZIG="$zig"
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$linker"
# Cargo's linker setting only covers Rust's final link. Native dependencies
# such as ring are compiled by cc-rs, which otherwise falls back to a missing
# x86_64-linux-musl-gcc and silently bypasses the verified Zig toolchain.
export CC="$linker"
export CXX="$linker"
linker_sha256=$(sha256sum "$linker" | awk '{print $1}')
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-feature=+crt-static -C link-arg=-Wl,--build-id=0x$linker_sha256"

cargo build --locked --release --target x86_64-unknown-linux-musl -p rivet-workerd-host "$@"

artifact=target/x86_64-unknown-linux-musl/release/rivet-workerd-host
file "$artifact"
if readelf -l "$artifact" | grep -q INTERP; then
	echo "rivet-workerd-host unexpectedly contains a dynamic interpreter" >&2
	exit 1
fi
if readelf --version-info "$artifact" 2>/dev/null | grep -q GLIBC_; then
	echo "rivet-workerd-host unexpectedly contains GLIBC version dependencies" >&2
	exit 1
fi
if readelf -d "$artifact" 2>/dev/null | grep -q '(NEEDED)'; then
	echo "rivet-workerd-host unexpectedly contains shared-library dependencies" >&2
	exit 1
fi
"$artifact" --version
"$artifact" --help >/dev/null
