#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
wrapper=$script_dir/../../upstream/workerd/tools/zig-cxx-musl
tmp=$(mktemp -d)
cleanup() {
	find "$tmp" -depth -delete
}
trap cleanup EXIT

cat >"$tmp/zig" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$ZIG_ARGUMENT_LOG"
for arg in "$@"; do
	if [[ "$arg" == @* && -n "${ZIG_RESPONSE_LOG:-}" ]]; then
		cp "${arg#@}" "$ZIG_RESPONSE_LOG"
	fi
done
EOF
chmod 0755 "$tmp/zig"

cat >"$tmp/host-cxx" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$HOST_CXX_ARGUMENT_LOG"
EOF
chmod 0755 "$tmp/host-cxx"

ZIG_ARGUMENT_LOG="$tmp/args" WORKERD_ZIG="$tmp/zig" "$wrapper" \
	--target=x86_64-unknown-linux-musl -O2 -c actor.c

grep -Fxq -- '-target' "$tmp/args"
grep -Fxq -- 'x86_64-linux-musl' "$tmp/args"
if grep -Fxq -- '--target=x86_64-unknown-linux-musl' "$tmp/args"; then
	echo "cc-rs target leaked through the qualified Zig wrapper" >&2
	exit 1
fi

cat >"$tmp/musl-link.args" <<'EOF'
"/rust/lib/rustlib/x86_64-unknown-linux-musl/lib/self-contained/rcrt1.o"
"/rust/toolchains/1.91.1-x86_64-unknown-linux-gnu/lib/libhost-proc-macro.so"
"-lstdc++"
"-static-pie"
EOF
ZIG_ARGUMENT_LOG="$tmp/musl-args" ZIG_RESPONSE_LOG="$tmp/musl-response" \
	HOST_CXX_ARGUMENT_LOG="$tmp/unused-host-args" \
	WORKERD_ZIG="$tmp/zig" WORKERD_HOST_CXX="$tmp/host-cxx" \
	"$wrapper" "@$tmp/musl-link.args"

grep -Fxq -- '-static' "$tmp/musl-args"
grep -Fxq -- '-pie' "$tmp/musl-args"
if grep -Fxq -- '-nostdlib' "$tmp/musl-args"; then
	echo "Rust musl target link incorrectly disabled Zig's coherent runtime graph" >&2
	exit 1
fi
grep -Fxq -- '-lc++' "$tmp/musl-response"
if grep -Eq 'self-contained/(rcrt1|crti|crtbeginS|crtendS|crtn)\.o|^"?-static-pie"?$|nostartfiles|nodefaultlibs' \
	"$tmp/musl-response"; then
	echo "Rust CRT or incompatible driver flags leaked into the Zig-owned musl link" >&2
	exit 1
fi
if grep -Eq '^"?-lstdc\+\+"?$' "$tmp/musl-response"; then
	echo "GNU C++ runtime leaked into the musl target link" >&2
	exit 1
fi
if [[ -e "$tmp/unused-host-args" ]]; then
	echo "musl target link was incorrectly routed to the host compiler" >&2
	exit 1
fi

# A Rust musl CRT must be sufficient on its own to select the Zig-owned static
# PIE path. Do not make correctness depend on how a rustc release serializes
# -nostartfiles or -nodefaultlibs; this fixture intentionally omits both.
if grep -Eq 'nostartfiles|nodefaultlibs' "$tmp/musl-link.args"; then
	echo "musl CRT regression fixture unexpectedly contains linker-mode hints" >&2
	exit 1
fi

cat >"$tmp/host-link.args" <<'EOF'
"/rust/toolchains/1.91.1-x86_64-unknown-linux-gnu/lib/libproc-macro.so"
"-nostartfiles"
"-nodefaultlibs"
EOF
ZIG_ARGUMENT_LOG="$tmp/unused-zig-args" HOST_CXX_ARGUMENT_LOG="$tmp/host-args" \
	WORKERD_ZIG="$tmp/zig" WORKERD_HOST_CXX="$tmp/host-cxx" \
	"$wrapper" "@$tmp/host-link.args"

[[ -s "$tmp/host-args" ]]
if [[ -e "$tmp/unused-zig-args" ]]; then
	echo "GNU host build-script link was incorrectly routed to Zig musl" >&2
	exit 1
fi

printf 'zig-cxx-musl target and host-link routing tests passed\n'
