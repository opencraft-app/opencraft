#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)

source_dir=${RIVET_SOURCE_DIR:-$repo_root}
fdb_artifacts=${FDB_MUSL_ARTIFACT_DIR:-}
zig=${RIVET_ENGINE_MUSL_ZIG:-}
linker=${RIVET_ENGINE_MUSL_LINKER:-}
target_dir=${RIVET_ENGINE_MUSL_TARGET_DIR:-$source_dir/target}
cluster_file=${FDB_CLUSTER_FILE:-}

die() {
	printf '%s\n' "$*" >&2
	exit 1
}

[[ $(uname -s)-$(uname -m) == Linux-x86_64 ]] || die "qualification requires Linux x86_64"
[[ -d "$source_dir" ]] || die "Rivet source missing: $source_dir"
[[ -n "$fdb_artifacts" && "$fdb_artifacts" = /* ]] || \
	die "FDB_MUSL_ARTIFACT_DIR must be an absolute path"
[[ -n "$cluster_file" && "$cluster_file" = /* && -r "$cluster_file" ]] || \
	die "FDB_CLUSTER_FILE must be an absolute readable qualification-cluster file"
[[ ${RIVET_STATIC_FDB_ALLOW_MUTATION:-} == qualification-only ]] || \
	die "set RIVET_STATIC_FDB_ALLOW_MUTATION=qualification-only after verifying the target is not production"
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
export FDB_CLUSTER_FILE="$cluster_file"
export FDB_CLIENT_LIB_PATH="$fdb_artifacts/lib"
export FDB_CLIENT_LINK_KIND=static
export FDB_CLIENT_STATIC_LIBS=fdbclient,fdbrpc,libb64,md5,coro,flow,stacktrace,fmt,crc32,folly_memcpy,ssl,crypto,z,boost_context,boost_filesystem,boost_iostreams,boost_system,boost_serialization,eio
export FDB_CLIENT_SYSTEM_LIBS=c++,c++abi,unwind,rt,pthread,dl
export RUSTFLAGS="--cfg tokio_unstable -C target-feature=+crt-static"

# The integration test owns and clears the reserved `test` subspace. The explicit mutation
# acknowledgement above prevents this command from being pointed at a production FDB cluster by
# accident. It exercises commit/read/range, snapshot/conflict behavior, atomic mutations, native
# versionstamps, retry and maybe-committed propagation through the same static client archive graph.
(
	cd "$source_dir"
	cargo test --locked --release --target x86_64-unknown-linux-musl \
		-p universaldb --features foundationdb --test integration \
		test_foundationdb_driver -- --exact --nocapture
	cargo test --locked --release --target x86_64-unknown-linux-musl \
		-p universaldb --features foundationdb --test foundationdb -- --nocapture
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

printf 'FoundationDB static-musl real-cluster qualification passed\n'
