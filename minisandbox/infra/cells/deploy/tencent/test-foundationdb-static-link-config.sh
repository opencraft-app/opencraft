#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
module=$repo_root/upstream/foundationdb-rs-0.9.1/foundationdb-sys/build_link.rs
build_script=$script_dir/build-foundationdb-static-musl.sh
engine_script=$script_dir/build-rivet-engine-static-musl.sh
qualification_script=$script_dir/qualify-foundationdb-static-musl.sh
pie_probe_source=$script_dir/foundationdb-static-pie-probe.c
tree_hash_script=$script_dir/foundationdb-source-tree-sha256.sh
runtime_source=$repo_root/upstream/rivet-history/engine/packages/runtime/src/lib.rs
telemetry_source=$repo_root/upstream/rivet-history/engine/packages/telemetry/src/lib.rs
engine_source=$repo_root/upstream/rivet-history/engine/packages/engine/src/main.rs
engine_unit=$script_dir/systemd/actor-rivet-engine.service
installer=$script_dir/install-beijing-workerd-cell.sh
platform_header=$repo_root/upstream/foundationdb-7.3.79/flow/include/flow/Platform.h
platform_source=$repo_root/upstream/foundationdb-7.3.79/flow/Platform.actor.cpp
signal_safe_unwind=$repo_root/upstream/foundationdb-7.3.79/flow/SignalSafeUnwind.cpp
test_binary=$(mktemp "${TMPDIR:-/tmp}/actor-fdb-build-link.XXXXXX")
trap 'rm -f -- "$test_binary"' EXIT

bash -n "$build_script"
bash -n "$engine_script"
bash -n "$qualification_script"
[[ -f "$pie_probe_source" ]]
[[ -x "$tree_hash_script" ]]
rustc --test "$module" -o "$test_binary"
"$test_binary"

grep -Fq 'openssl_sha256=a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8' "$build_script"
grep -Fq 'zlib_sha256=bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16' "$build_script"
grep -Fq 'fdb_patch_sha256=2d1a4bacd4739bb7ff53c94b9c947f86f4ea4bad4996ddafc732865373a93772' "$build_script"
grep -Fq 'fdb_patched_tree_sha256=2464add756d92ee646970e13c70b0b16a6b76cc9f34da6bce5310f9b50741e5c' "$build_script"
grep -Fq 'FDB_MUSL_FDB_BUILD_DIR' "$build_script"
grep -Fq 'FDB_MUSL_ARTIFACT_DIR' "$build_script"
grep -Fq -- '-DCMAKE_EXE_LINKER_FLAGS=-static' "$build_script"
grep -Fq -- '-DFDB_STATIC_C_CLIENT=ON' "$build_script"
grep -Fq -- '-DFDB_BOOST_NOSTDLIBXX=OFF' "$build_script"
grep -Fq -- '-DFDB_BUILD_ID_LINKER_FLAG=-Wl,--build-id=sha1' "$build_script"
grep -Fq "CFLAGS='-O3 -fPIC'" "$build_script"
grep -Fq 'no-shared no-tests no-dso no-module -static -fPIC' "$build_script"
grep -Fq -- '-static -pie "$pie_probe_object"' "$build_script"
grep -Fq -- '-I"$fdb_build/bindings/c/foundationdb"' "$build_script"
grep -Fq 'FoundationDB static PIE probe is not ET_DYN' "$build_script"
grep -Fq 'foundationdb_patched_tree_sha256=%s' "$build_script"
grep -Fq 'find bin include lib -type f -print0' "$build_script"
grep -Fq '"$artifacts/MANIFEST.sha256"' "$build_script"
grep -Fq 'FDB artifact manifest verification failed' "$engine_script"
grep -Fq 'sha256sum --quiet -c MANIFEST.sha256' "$engine_script"
grep -Fq 'Cargo did not fingerprint and link the selected FDB artifact directory' "$engine_script"
grep -Fq 'FDB artifact manifest verification failed' "$qualification_script"
grep -Fq 'Cargo did not fingerprint and link the selected FDB artifact directory' "$qualification_script"
grep -Fq 'rt.shutdown_timeout(RUNTIME_SHUTDOWN_TIMEOUT);' "$runtime_source"
grep -Fq 'drop_with_timeout(guard, SHUTDOWN_TIMEOUT).await' "$telemetry_source"
grep -Fq 'mem::forget(guard);' "$telemetry_source"
grep -Fq 'telemetry_guard.shutdown().await;' "$engine_source"
grep -Fq 'TimeoutStopSec=620s' "$engine_unit"
! grep -Fq 'LD_LIBRARY_PATH=/opt/actor/backup-fence/lib' "$engine_unit"
! grep -Fq 'LD_LIBRARY_PATH=/opt/actor/backup-fence/lib' "$installer"
grep -Fq '#define FDB_API_VERSION 730' "$pie_probe_source"
grep -Fq 'FDB_BUILD_ID_LINKER_FLAG' "$repo_root/upstream/foundationdb-7.3.79/cmake/ConfigureCompiler.cmake"
grep -Fq 'FDB_BOOST_NOSTDLIBXX' "$repo_root/upstream/foundationdb-7.3.79/cmake/CompileBoost.cmake"
grep -Fq '#include <sys/types.h>' "$platform_header"
grep -Fq '#if !defined(HAS_ALIGNED_ALLOC)' "$platform_header"
if grep -Fq '#if (!defined(_ISOC11_SOURCE))' "$platform_header"; then
	printf 'Linux aligned_alloc fallback still relies on a glibc feature macro\n' >&2
	exit 1
fi
grep -Fq '(unsigned int)major(buf.st_dev)' "$platform_source"
grep -Fq '(unsigned int)minor(buf.st_dev)' "$platform_source"
if grep -Fq 'gnu_dev_major' "$platform_source" || grep -Fq 'gnu_dev_minor' "$platform_source"; then
	printf 'Platform device-number lookup still relies on glibc-only symbols\n' >&2
	exit 1
fi
grep -Fq '#if defined(__linux__) && defined(__GLIBC__) && !defined(USE_SANITIZER)' "$signal_safe_unwind"
grep -Fq '! readelf -l "$probe" | grep INTERP >/dev/null' "$build_script"
grep -Fq '! readelf -d "$probe" 2>/dev/null | grep NEEDED >/dev/null' "$build_script"
grep -Fq 'export FDB_CLIENT_LINK_KIND=static' "$engine_script"
grep -Fq -- '--features foundationdb' "$engine_script"
grep -Fq 'export FDB_CLIENT_SYSTEM_LIBS=c++,c++abi,unwind,rt,pthread,dl' "$engine_script"
grep -Fq '! readelf -l "$artifact" | grep INTERP >/dev/null' "$engine_script"
grep -Fq '! readelf -d "$artifact" 2>/dev/null | grep NEEDED >/dev/null' "$engine_script"
grep -Fq "nm \"\$artifact\" 2>/dev/null | grep ' fdb_select_api_version_impl\$' >/dev/null" "$engine_script"
grep -Fq 'built without the `foundationdb` feature' "$engine_script"
grep -Fq 'RIVET_STATIC_FDB_ALLOW_MUTATION=qualification-only' "$qualification_script"
grep -Fq -- '--test integration' "$qualification_script"
grep -Fq -- '--test foundationdb' "$qualification_script"

# A path patch without a matching lock entry is silently accepted by `cargo metadata --no-deps`
# but rejected by the release build's `--locked`. Exercise the full offline graph here.
(
	cd "$repo_root/upstream/rivet-history"
	cargo metadata --locked --offline --format-version 1 >/dev/null
)

printf 'FoundationDB static link configuration tests passed\n'
