#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture_root=$(mktemp -d)
trap 'rm -rf -- "$fixture_root"' EXIT INT TERM

source_dir="$fixture_root/rivet-source"
mkdir -p "$source_dir/engine" "$source_dir/.git" "$source_dir/target/debug"
printf 'workspace\n' >"$source_dir/engine/Cargo.toml"
printf 'appledouble\n' >"$source_dir/engine/._schema.capnp"
printf 'git\n' >"$source_dir/.git/config"
printf 'binary\n' >"$source_dir/target/debug/rivet-engine"

archive="$fixture_root/rivet-source.tar.gz"
"$script_dir/package-rivet-source.sh" "$source_dir" "$archive" >/dev/null
members=$(tar -tzf "$archive")
grep -q '^rivet-source/engine/Cargo.toml$' <<<"$members"
if grep -Eq '(^|/)\._|^rivet-source/(\.git|target)(/|$)' <<<"$members"; then
	echo "source archive retained forbidden members" >&2
	exit 1
fi

if "$script_dir/package-rivet-source.sh" "$source_dir" "$source_dir/bad.tar.gz" >/dev/null 2>&1; then
	echo "packager accepted output inside source tree" >&2
	exit 1
fi

echo "source packaging tests passed"
