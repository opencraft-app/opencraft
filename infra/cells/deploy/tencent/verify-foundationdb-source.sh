#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
lock_file="$script_dir/foundationdb-source.lock"

lock_value() {
	local key=$1
	local line
	line=$(grep -E "^${key}=" "$lock_file" || true)
	[[ -n "$line" ]] || return 1
	printf '%s\n' "${line#*=}"
}

for required in repository tag commit patch_sha256 patched_tree_sha256 source_dir license; do
	lock_value "$required" >/dev/null || {
		printf 'missing lock field: %s\n' "$required" >&2
		exit 1
	}
done

locked_tag=$(lock_value tag)
locked_commit=$(lock_value commit)
source_dir="$repo_root/$(lock_value source_dir)"
[[ -d "$source_dir/.git" ]] || {
	printf 'FoundationDB source clone missing: %s\n' "$source_dir" >&2
	exit 1
}

actual_commit=$(git -C "$source_dir" rev-parse HEAD)
[[ "$actual_commit" == "$locked_commit" ]] || {
	printf 'FoundationDB source commit mismatch: expected=%s actual=%s\n' \
		"$locked_commit" "$actual_commit" >&2
	exit 1
}

untracked=$(git -C "$source_dir" status --porcelain --untracked-files=all | awk '$1 == "??"')
[[ -z "$untracked" ]] || {
	printf 'FoundationDB source contains untracked build inputs:\n%s\n' "$untracked" >&2
	exit 1
}

actual_patch_sha256=$(git -C "$source_dir" diff --binary --no-ext-diff | sha256sum | awk '{print $1}')
locked_patch_sha256=$(lock_value patch_sha256)
[[ "$actual_patch_sha256" == "$locked_patch_sha256" ]] || {
	printf 'FoundationDB source patch mismatch: expected=%s actual=%s\n' \
		"$locked_patch_sha256" "$actual_patch_sha256" >&2
	exit 1
}

actual_patched_tree_sha256=$("$script_dir/foundationdb-source-tree-sha256.sh" "$source_dir")
locked_patched_tree_sha256=$(lock_value patched_tree_sha256)
[[ "$actual_patched_tree_sha256" == "$locked_patched_tree_sha256" ]] || {
	printf 'FoundationDB patched source tree mismatch: expected=%s actual=%s\n' \
		"$locked_patched_tree_sha256" "$actual_patched_tree_sha256" >&2
	exit 1
}

tag_commit=$(git -C "$source_dir" rev-list -n 1 "$locked_tag")
[[ "$tag_commit" == "$locked_commit" ]] || {
	printf 'FoundationDB tag does not resolve to locked commit\n' >&2
	exit 1
}

cmake_file="$source_dir/bindings/c/CMakeLists.txt"
grep -Fq 'option(FDB_STATIC_C_CLIENT' "$cmake_file"
grep -Fq 'add_library(fdb_c STATIC' "$cmake_file"
grep -Fq 'add_custom_target(strip_only_fdb_c DEPENDS fdb_c)' "$cmake_file"
grep -Fq 'target_link_libraries(fdb_c PUBLIC $<BUILD_INTERFACE:fdbclient>)' "$cmake_file"

top_level_cmake="$source_dir/CMakeLists.txt"
grep -Fq 'option(BUILD_FLOWBENCH "Configure the Flow microbenchmark target" ON)' \
	"$top_level_cmake"
grep -Fq 'if(BUILD_FLOWBENCH)' "$top_level_cmake"

platform_file="$source_dir/flow/Platform.actor.cpp"
net2_file="$source_dir/flow/Net2.actor.cpp"
profiler_file="$source_dir/flow/Profiler.actor.cpp"
signal_safe_unwind_file="$source_dir/flow/SignalSafeUnwind.cpp"
platform_header="$source_dir/flow/include/flow/Platform.h"
boost_file="$source_dir/cmake/CompileBoost.cmake"
compiler_file="$source_dir/cmake/ConfigureCompiler.cmake"
grep -Fq '#if defined(__linux__) && defined(__GLIBC__)' "$platform_file"
grep -Fq '#if defined(__linux__) && defined(__GLIBC__)' "$net2_file"
grep -Fq '#if defined(__linux__) && defined(__GLIBC__)' "$profiler_file"
grep -Fq '#if defined(__linux__) && defined(__GLIBC__) && !defined(USE_SANITIZER)' \
	"$signal_safe_unwind_file"
grep -Fq '#include <sys/types.h>' "$platform_header"
grep -Fq '#if !defined(HAS_ALIGNED_ALLOC)' "$platform_header"
grep -Fq 'FDB_BOOST_NOSTDLIBXX' "$boost_file"
grep -Fq 'env_set(FDB_LINK_LIBATOMIC ON BOOL' "$compiler_file"
grep -Fq 'NOT USE_LIBCXX AND FDB_LINK_LIBATOMIC' "$compiler_file"
grep -Fq 'FDB_BUILD_ID_LINKER_FLAG' "$compiler_file"

git -C "$source_dir" diff --check
printf '%s\n' \
	"foundationdb_source_commit=$actual_commit" \
	"foundationdb_patch_sha256=$actual_patch_sha256" \
	"foundationdb_patched_tree_sha256=$actual_patched_tree_sha256" \
	'static_c_client_patch=present' \
	'static_strip_target_patch=present' \
	'optional_flowbench_patch=present' \
	'musl_platform_guards=present' \
	'configurable_libatomic_link=present'
