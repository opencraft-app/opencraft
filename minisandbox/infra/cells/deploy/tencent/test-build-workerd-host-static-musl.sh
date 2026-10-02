#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)
source_script=$repo_root/runtimes/workerd/host/build-static-musl.sh
tmp=$(mktemp -d)
cleanup() {
	find "$tmp" -depth -delete
}
trap cleanup EXIT

workspace=$tmp/repo
host_dir=$workspace/runtimes/workerd/host
bin_dir=$tmp/bin
install -d "$host_dir" "$bin_dir" "$tmp/workerd/tools"
install -m 0755 "$source_script" "$host_dir/build-static-musl.sh"
install -m 0755 /dev/null "$tmp/workerd/tools/zig-cxx-musl"

cat >"$tmp/zig" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == version ]]
printf '0.14.1\n'
EOF
chmod 0755 "$tmp/zig"

cat >"$bin_dir/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
	-s) printf 'Linux\n' ;;
	-m) printf 'x86_64\n' ;;
	*) exit 1 ;;
esac
EOF

cat >"$bin_dir/cargo" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[[ \${CC:?} == "$tmp/workerd/tools/zig-cxx-musl" ]]
[[ \${CXX:?} == "$tmp/workerd/tools/zig-cxx-musl" ]]
[[ \${CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER:?} == "$tmp/workerd/tools/zig-cxx-musl" ]]
artifact="$workspace/target/x86_64-unknown-linux-musl/release/rivet-workerd-host"
install -d "\$(dirname -- "\$artifact")"
printf '#!/usr/bin/env bash\nprintf "test-host 0.0.0\\n"\n' >"\$artifact"
chmod 0755 "\$artifact"
EOF

cat >"$bin_dir/file" <<'EOF'
#!/usr/bin/env bash
printf '%s: static executable\n' "$1"
EOF

cat >"$bin_dir/readelf" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod 0755 "$bin_dir/uname" "$bin_dir/cargo" "$bin_dir/file" "$bin_dir/readelf"

PATH="$bin_dir:$PATH" \
	WORKERD_ZIG="$tmp/zig" \
	RIVET_WORKERD_HOST_MUSL_LINKER="$tmp/workerd/tools/zig-cxx-musl" \
	"$host_dir/build-static-musl.sh" >/dev/null

printf 'workerd-host static musl build environment test passed\n'
