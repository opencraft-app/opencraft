#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)

zig=${FDB_MUSL_ZIG:-}
work_dir=${FDB_MUSL_WORK_DIR:-}
source_dir=${FDB_SOURCE_DIR:-$repo_root/upstream/foundationdb-7.3.79}
jobs=${FDB_MUSL_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1')}

zlib_version=1.3.2
zlib_sha256=bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
openssl_version=3.5.7
openssl_sha256=a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8
fdb_commit=0074653ee0113fc39da0fa088b056c7210ab3191
fdb_patch_sha256=2d1a4bacd4739bb7ff53c94b9c947f86f4ea4bad4996ddafc732865373a93772
fdb_patched_tree_sha256=2464add756d92ee646970e13c70b0b16a6b76cc9f34da6bce5310f9b50741e5c

die() {
	printf '%s\n' "$*" >&2
	exit 1
}

sha256() {
	sha256sum "$1" | awk '{print $1}'
}

fetch_locked() {
	local url=$1
	local target=$2
	local expected=$3
	if [[ -e "$target" ]]; then
		[[ $(sha256 "$target") == "$expected" ]] || die "source cache hash mismatch: $target"
		return
	fi
	local next="$target.next.$$"
	trap 'rm -f -- "$next"' RETURN
	curl --fail --location --retry 4 --silent --show-error "$url" -o "$next"
	[[ $(sha256 "$next") == "$expected" ]] || die "download hash mismatch: $url"
	mv "$next" "$target"
	trap - RETURN
}

extract_locked() {
	local archive=$1
	local directory_name=$2
	local target=$3
	[[ -d "$target" ]] && return
	local staging
	staging=$(mktemp -d "$work_dir/extract.XXXXXX")
	trap 'rm -rf -- "$staging"' RETURN
	tar -xzf "$archive" -C "$staging"
	[[ -d "$staging/$directory_name" ]] || die "archive did not contain $directory_name"
	mv "$staging/$directory_name" "$target"
	rmdir "$staging"
	trap - RETURN
}

[[ $(uname -s)-$(uname -m) == Linux-x86_64 ]] || die "build requires Linux x86_64"
[[ -n "$zig" && -x "$zig" ]] || die "FDB_MUSL_ZIG must point to Zig 0.14.1"
[[ $($zig version) == 0.14.1 ]] || die "only the qualified Zig 0.14.1 toolchain is accepted"
[[ -n "$work_dir" && "$work_dir" = /* ]] || die "FDB_MUSL_WORK_DIR must be an absolute path"
if [[ -d "$source_dir/.git" ]]; then
	[[ $(git -C "$source_dir" rev-parse HEAD) == "$fdb_commit" ]] || \
		die "FoundationDB commit mismatch"
	untracked=$(git -C "$source_dir" status --porcelain --untracked-files=all | awk '$1 == "??"')
	[[ -z "$untracked" ]] || die "FoundationDB source contains untracked build inputs"
	actual_patch_sha256=$(git -C "$source_dir" diff --binary --no-ext-diff | sha256sum | awk '{print $1}')
	[[ "$actual_patch_sha256" == "$fdb_patch_sha256" ]] || \
		die "FoundationDB source patch mismatch"
fi
tree_hash_script=$script_dir/foundationdb-source-tree-sha256.sh
[[ -x "$tree_hash_script" ]] || die "FoundationDB source tree verifier missing"
actual_patched_tree_sha256=$("$tree_hash_script" "$source_dir")
[[ "$actual_patched_tree_sha256" == "$fdb_patched_tree_sha256" ]] || \
	die "FoundationDB patched source tree mismatch"

source_cache=${FDB_MUSL_SOURCE_CACHE:-$work_dir/source-cache}
dependency_source=${FDB_MUSL_DEPENDENCY_SOURCE:-$work_dir/dependency-source}
dependency_build=${FDB_MUSL_DEPENDENCY_BUILD:-$work_dir/dependency-build}
prefix=${FDB_MUSL_PREFIX:-$work_dir/musl-sysroot}
toolchain=${FDB_MUSL_TOOLCHAIN_DIR:-$work_dir/toolchain}
fdb_build=${FDB_MUSL_FDB_BUILD_DIR:-$work_dir/foundationdb-build}
artifacts=${FDB_MUSL_ARTIFACT_DIR:-$work_dir/artifacts}
for path in "$source_cache" "$dependency_source" "$dependency_build" "$prefix" "$toolchain" \
	"$fdb_build" "$artifacts"; do
	[[ "$path" = /* ]] || die "all FDB musl build paths must be absolute: $path"
done
install -d -m 0755 \
	"$source_cache" "$dependency_source" "$dependency_build" "$prefix" "$toolchain" \
	"$artifacts/lib" "$artifacts/include/foundationdb" "$artifacts/bin"

zlib_archive=$source_cache/zlib-$zlib_version.tar.gz
openssl_archive=$source_cache/openssl-$openssl_version.tar.gz
fetch_locked "https://zlib.net/zlib-$zlib_version.tar.gz" "$zlib_archive" "$zlib_sha256"
fetch_locked "https://www.openssl.org/source/openssl-$openssl_version.tar.gz" \
	"$openssl_archive" "$openssl_sha256"

zlib_source=$dependency_source/zlib-$zlib_version
openssl_source=$dependency_source/openssl-$openssl_version
extract_locked "$zlib_archive" "zlib-$zlib_version" "$zlib_source"
extract_locked "$openssl_archive" "openssl-$openssl_version" "$openssl_source"

for compiler in cc c++; do
	wrapper=$toolchain/zig-$compiler
	cat >"$wrapper.next" <<EOF
#!/usr/bin/env bash
exec "$zig" "$compiler" -target x86_64-linux-musl "\$@"
EOF
	chmod 0755 "$wrapper.next"
	mv "$wrapper.next" "$wrapper"
done
for utility in ar ranlib; do
	wrapper=$toolchain/zig-$utility
	cat >"$wrapper.next" <<EOF
#!/usr/bin/env bash
exec "$zig" "$utility" "\$@"
EOF
	chmod 0755 "$wrapper.next"
	mv "$wrapper.next" "$wrapper"
done

zlib_pic_stamp=$prefix/.actor-zlib-$zlib_version-static-pic
if [[ ! -s "$prefix/lib/libz.a" || ! -s "$zlib_pic_stamp" ]]; then
	zlib_build=$dependency_build/zlib-$zlib_version-pic
	[[ ! -e "$zlib_build" ]] || die "incomplete zlib build exists: $zlib_build"
	install -d -m 0755 "$zlib_build"
	(
		cd "$zlib_build"
		CC="$toolchain/zig-cc" AR="$toolchain/zig-ar" RANLIB="$toolchain/zig-ranlib" \
			CFLAGS='-O3 -fPIC' \
			"$zlib_source/configure" --static --prefix="$prefix"
		make -j"$jobs"
		make install
	)
	printf 'zlib=%s cflags=-O3,-fPIC\n' "$zlib_version" >"$zlib_pic_stamp"
fi

openssl_lib_dir=$prefix/lib64
if [[ ! -s "$openssl_lib_dir/libssl.a" ]]; then
	openssl_lib_dir=$prefix/lib
fi
openssl_pic_stamp=$prefix/.actor-openssl-$openssl_version-static-pic
if [[ ! -s "$openssl_lib_dir/libssl.a" || ! -s "$openssl_pic_stamp" ]]; then
	openssl_build=$dependency_build/openssl-$openssl_version-pic
	[[ ! -e "$openssl_build" ]] || die "incomplete OpenSSL build exists: $openssl_build"
	cp -a "$openssl_source" "$openssl_build"
	(
		cd "$openssl_build"
		CC="$toolchain/zig-cc" AR="$toolchain/zig-ar" RANLIB="$toolchain/zig-ranlib" \
			./Configure linux-x86_64 --prefix="$prefix" --openssldir="$prefix/ssl" \
			no-shared no-tests no-dso no-module -static -fPIC
		make -j"$jobs"
		make install_sw
	)
	printf 'openssl=%s cflags=-fPIC\n' "$openssl_version" >"$openssl_pic_stamp"
	openssl_lib_dir=$prefix/lib64
	[[ -s "$openssl_lib_dir/libssl.a" ]] || openssl_lib_dir=$prefix/lib
fi
[[ -s "$openssl_lib_dir/libssl.a" && -s "$openssl_lib_dir/libcrypto.a" ]] || \
	die "static OpenSSL archives missing"

if [[ ! -e "$fdb_build/build.ninja" ]]; then
	[[ ! -e "$fdb_build" ]] || die "incomplete FoundationDB build exists: $fdb_build"
	cmake -S "$source_dir" -B "$fdb_build" -G Ninja \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_C_COMPILER="$toolchain/zig-cc" \
		-DCMAKE_CXX_COMPILER="$toolchain/zig-c++" \
		-DCMAKE_AR="$toolchain/zig-ar" \
		-DCMAKE_RANLIB="$toolchain/zig-ranlib" \
		-DCMAKE_PREFIX_PATH="$prefix" \
		-DOPENSSL_ROOT_DIR="$prefix" \
		-DOPENSSL_USE_STATIC_LIBS=ON \
		-DZLIB_ROOT="$prefix" \
		-DCMAKE_EXE_LINKER_FLAGS=-static \
		-DFDB_STATIC_C_CLIENT=ON \
		-DFDB_LINK_LIBATOMIC=OFF \
		-DFDB_BUILD_ID_LINKER_FLAG=-Wl,--build-id=sha1 \
		-DFDB_BOOST_NOSTDLIBXX=OFF \
		-DFDB_RELEASE=ON \
		-DUSE_LIBCXX=ON \
		-DSTATIC_LINK_LIBCXX=OFF \
		-DUSE_LD=LD \
		-DUSE_JEMALLOC=OFF \
		-DUSE_DTRACE=OFF \
		-DSSD_ROCKSDB_EXPERIMENTAL=OFF \
		-DBUILD_FLOWBENCH=OFF \
		-DBUILD_DOCUMENTATION=OFF \
		-DBUILD_JAVA_BINDING=OFF \
		-DBUILD_GO_BINDING=OFF \
		-DBUILD_RUBY_BINDING=OFF
fi

cmake --build "$fdb_build" --target fdb_c90_test --parallel "$jobs"
probe=$fdb_build/bin/fdb_c90_test
[[ -x "$probe" ]] || die "FoundationDB static probe missing"
! readelf -l "$probe" | grep INTERP >/dev/null || die "FoundationDB probe has a dynamic interpreter"
! readelf -d "$probe" 2>/dev/null | grep NEEDED >/dev/null || \
	die "FoundationDB probe has shared dependencies"

libraries=(
	fdb_c fdbclient fdbrpc libb64 md5 coro flow stacktrace fmt crc32 folly_memcpy eio
)
for library in "${libraries[@]}"; do
	install -m 0644 "$fdb_build/lib/lib$library.a" "$artifacts/lib/lib$library.a"
done
for library in context filesystem iostreams system serialization; do
	install -m 0644 "$fdb_build/boost_install/lib/libboost_$library.a" \
		"$artifacts/lib/libboost_$library.a"
done
install -m 0644 "$openssl_lib_dir/libssl.a" "$artifacts/lib/libssl.a"
install -m 0644 "$openssl_lib_dir/libcrypto.a" "$artifacts/lib/libcrypto.a"
install -m 0644 "$prefix/lib/libz.a" "$artifacts/lib/libz.a"
install -m 0644 "$source_dir/bindings/c/foundationdb/fdb_c.h" \
	"$artifacts/include/foundationdb/fdb_c.h"
install -m 0755 "$probe" "$artifacts/bin/fdb_c90_test"

pie_probe_source=$script_dir/foundationdb-static-pie-probe.c
pie_probe_object=$artifacts/bin/foundationdb-static-pie-probe.o
pie_probe=$artifacts/bin/foundationdb-static-pie-probe
[[ -f "$pie_probe_source" ]] || die "static PIE probe source missing: $pie_probe_source"
"$zig" cc -target x86_64-linux-musl -fPIC \
	-I"$source_dir/bindings/c" -I"$fdb_build/bindings/c/foundationdb" \
	-c "$pie_probe_source" -o "$pie_probe_object"
"$zig" c++ -target x86_64-linux-musl -static -pie "$pie_probe_object" \
	-Wl,--start-group \
	"$artifacts/lib/libfdb_c.a" "$artifacts/lib/libfdbclient.a" \
	"$artifacts/lib/libfdbrpc.a" "$artifacts/lib/liblibb64.a" \
	"$artifacts/lib/libmd5.a" "$artifacts/lib/libcoro.a" "$artifacts/lib/libflow.a" \
	"$artifacts/lib/libstacktrace.a" "$artifacts/lib/libfmt.a" \
	"$artifacts/lib/libcrc32.a" "$artifacts/lib/libfolly_memcpy.a" \
	"$artifacts/lib/libssl.a" "$artifacts/lib/libcrypto.a" "$artifacts/lib/libz.a" \
	"$artifacts/lib/libboost_context.a" "$artifacts/lib/libboost_filesystem.a" \
	"$artifacts/lib/libboost_iostreams.a" "$artifacts/lib/libboost_system.a" \
	"$artifacts/lib/libboost_serialization.a" "$artifacts/lib/libeio.a" \
	-Wl,--end-group -lc++ -lc++abi -lunwind -lrt -lpthread -ldl -o "$pie_probe"
rm -f -- "$pie_probe_object"
! readelf -l "$pie_probe" | grep INTERP >/dev/null || \
	die "FoundationDB static PIE probe has a dynamic interpreter"
! readelf -d "$pie_probe" 2>/dev/null | grep NEEDED >/dev/null || \
	die "FoundationDB static PIE probe has shared dependencies"
readelf -h "$pie_probe" | grep -F 'DYN (' >/dev/null || \
	die "FoundationDB static PIE probe is not ET_DYN"
file "$pie_probe" | grep -F 'static-pie linked' >/dev/null || \
	die "FoundationDB static PIE probe is not identified as static PIE"
"$pie_probe"

source_lock_next=$(mktemp "$artifacts/SOURCE.lock.next.XXXXXX")
{
	printf 'foundationdb_tag=7.3.79\n'
	printf 'foundationdb_commit=%s\n' "$fdb_commit"
	printf 'foundationdb_patch_sha256=%s\n' "$fdb_patch_sha256"
	printf 'foundationdb_patched_tree_sha256=%s\n' "$fdb_patched_tree_sha256"
	printf 'target=x86_64-linux-musl\n'
	printf 'zig_version=%s\n' "$($zig version)"
	printf 'openssl_version=%s\n' "$openssl_version"
	printf 'openssl_source_sha256=%s\n' "$openssl_sha256"
	printf 'openssl_cflags=-fPIC\n'
	printf 'zlib_version=%s\n' "$zlib_version"
	printf 'zlib_source_sha256=%s\n' "$zlib_sha256"
	printf 'zlib_cflags=-O3,-fPIC\n'
} >"$source_lock_next"
chmod 0644 "$source_lock_next"
mv -f -- "$source_lock_next" "$artifacts/SOURCE.lock"

manifest_next=$(mktemp "$artifacts/MANIFEST.sha256.next.XXXXXX")
(
	cd "$artifacts"
	LC_ALL=C find bin include lib -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
) >"$manifest_next"
chmod 0644 "$manifest_next"
mv -f -- "$manifest_next" "$artifacts/MANIFEST.sha256"

sha256sum "$zlib_archive" "$openssl_archive" "$artifacts/lib/libfdb_c.a" "$probe" \
	"$pie_probe" "$artifacts/SOURCE.lock" "$artifacts/MANIFEST.sha256"
file "$probe"
file "$pie_probe"
