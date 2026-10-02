#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)

source_dir=${RIVET_SOURCE_DIR:-$repo_root}
fdb_artifacts=${FDB_MUSL_ARTIFACT_DIR:-}
zig=${RIVET_ENGINE_MUSL_ZIG:-}
linker=${RIVET_ENGINE_MUSL_LINKER:-}
target_dir=${RIVET_ENGINE_MUSL_TARGET_DIR:-$source_dir/target}

die() {
	printf '%s\n' "$*" >&2
	exit 1
}

[[ $(uname -s)-$(uname -m) == Linux-x86_64 ]] || die "build requires Linux x86_64"
[[ -d "$source_dir" ]] || die "Rivet source missing: $source_dir"
[[ -n "$fdb_artifacts" && "$fdb_artifacts" = /* ]] || \
	die "FDB_MUSL_ARTIFACT_DIR must be an absolute path"
[[ -n "$zig" && -x "$zig" ]] || die "RIVET_ENGINE_MUSL_ZIG must point to Zig 0.14.1"
[[ $($zig version) == 0.14.1 ]] || die "only the qualified Zig 0.14.1 toolchain is accepted"
[[ -x "$linker" ]] || die "RIVET_ENGINE_MUSL_LINKER must be executable"
[[ -s "$fdb_artifacts/MANIFEST.sha256" ]] || die "FDB artifact manifest is missing"
[[ -s "$fdb_artifacts/SOURCE.lock" ]] || die "FDB source lock is missing"
(
	cd "$fdb_artifacts"
	sha256sum --quiet -c MANIFEST.sha256
) || die "FDB artifact manifest verification failed"

static_libraries=(
	fdb_c fdbclient fdbrpc libb64 md5 coro flow stacktrace fmt crc32 folly_memcpy
	ssl crypto z boost_context boost_filesystem boost_iostreams boost_system
	boost_serialization eio
)
for library in "${static_libraries[@]}"; do
	[[ -s "$fdb_artifacts/lib/lib$library.a" ]] || die "missing static archive: lib$library.a"
done

export WORKERD_ZIG="$zig"
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$linker"
export CC="$linker"
export CXX="$linker"
export CARGO_TARGET_DIR="$target_dir"
export FDB_CLIENT_LIB_PATH="$fdb_artifacts/lib"
export FDB_CLIENT_LINK_KIND=static
export FDB_CLIENT_STATIC_LIBS=fdbclient,fdbrpc,libb64,md5,coro,flow,stacktrace,fmt,crc32,folly_memcpy,ssl,crypto,z,boost_context,boost_filesystem,boost_iostreams,boost_system,boost_serialization,eio
# The Rust musl target provides its CRT. The Zig C++ driver, running with -nostdlib for the final
# Rust link, still resolves these explicitly requested C++ runtime archives from its musl sysroot.
export FDB_CLIENT_SYSTEM_LIBS=c++,c++abi,unwind,rt,pthread,dl
export RUSTFLAGS="--cfg tokio_unstable -C target-feature=+crt-static"

(
	cd "$source_dir"
	cargo build --locked --release --target x86_64-unknown-linux-musl \
		-p rivet-engine --bin rivet-engine --features foundationdb
)

fdb_build_output_verified=false
while IFS= read -r output; do
	if grep -Fqx 'cargo:rerun-if-env-changed=FDB_CLIENT_LIB_PATH' "$output" && \
		grep -Fqx "cargo:rustc-link-search=native=$fdb_artifacts/lib" "$output"; then
		fdb_build_output_verified=true
		break
	fi
done < <(find "$target_dir/x86_64-unknown-linux-musl/release/build" \
	-path '*/foundationdb-sys-*/output' -type f -print)
[[ $fdb_build_output_verified == true ]] || \
	die "Cargo did not fingerprint and link the selected FDB artifact directory"

artifact=$target_dir/x86_64-unknown-linux-musl/release/rivet-engine
[[ -x "$artifact" ]] || die "static Engine artifact missing"
! readelf -l "$artifact" | grep INTERP >/dev/null || die "Engine has a dynamic interpreter"
! readelf -d "$artifact" 2>/dev/null | grep NEEDED >/dev/null || die "Engine has shared dependencies"
! readelf --version-info "$artifact" 2>/dev/null | grep GLIBC_ >/dev/null || \
	die "Engine has GLIBC symbols"
# Prefer a direct symbol proof when the release retains a symbol table. The production profile is
# allowed to strip it; in that case reject the exact cfg(not(feature = "foundationdb")) branch.
# Combined with the explicit Cargo feature, mandatory static archive graph, and no DT_NEEDED entry,
# a successful link cannot fall back to libfdb_c.so. Real-cluster qualification remains a separate
# release gate.
if ! nm "$artifact" 2>/dev/null | grep ' fdb_select_api_version_impl$' >/dev/null; then
	file "$artifact" | grep -Fq 'stripped' || \
		die "Engine has no FDB symbol proof and is not an intentionally stripped release"
	if strings "$artifact" | grep -F 'built without the `foundationdb` feature' >/dev/null; then
		die "Engine compiled the no-FoundationDB feature branch"
	fi
fi

sha256sum "$artifact"
file "$artifact"
"$artifact" --version
