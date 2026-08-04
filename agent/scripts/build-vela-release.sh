#!/bin/sh

set -eu

version=
agent_binary=
output_directory=

usage() {
	echo "usage: build-vela-release.sh --version vX.Y.Z --agent-binary ABSOLUTE_PATH --out-dir PATH" >&2
	exit 2
}

while [ "$#" -gt 0 ]; do
	case "$1" in
	--version)
		[ "$#" -ge 2 ] || usage
		version=$2
		shift 2
		;;
	--agent-binary)
		[ "$#" -ge 2 ] || usage
		agent_binary=$2
		shift 2
		;;
	--out-dir)
		[ "$#" -ge 2 ] || usage
		output_directory=$2
		shift 2
		;;
	*)
		usage
		;;
	esac
done

if ! printf '%s\n' "$version" |
	grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$'; then
	echo "build-vela-release: invalid version" >&2
	exit 2
fi

[ -n "$agent_binary" ] || {
	echo "build-vela-release: --agent-binary is required" >&2
	exit 2
}
case "$agent_binary" in
/*) ;;
*) echo "build-vela-release: agent binary must be an absolute path" >&2; exit 2 ;;
esac
if [ ! -f "$agent_binary" ] || [ -L "$agent_binary" ] || [ ! -x "$agent_binary" ]; then
	echo "build-vela-release: agent binary is not a safe executable" >&2
	exit 1
fi
expected_version='{"mode":"vela","name":"vela-computer","version":"'"$version"'"}'
actual_version=$("$agent_binary" version --json 2>/dev/null) || {
	echo "build-vela-release: cannot read binary version" >&2
	exit 1
}
if [ "$actual_version" != "$expected_version" ]; then
	echo "build-vela-release: binary version does not match requested release" >&2
	exit 1
fi

[ -n "$output_directory" ] || usage
case "$output_directory" in
/*) ;;
*) output_directory="$(pwd)/$output_directory" ;;
esac
output_parent=$(dirname -- "$output_directory")
mkdir -p "$output_parent"
if [ -e "$output_directory" ]; then
	echo "build-vela-release: output directory already exists" >&2
	exit 1
fi

stage=$(mktemp -d "$output_parent/.vela-release.XXXXXX")
cleanup() {
	rm -rf "$stage"
}
trap cleanup EXIT HUP INT TERM

install -m 0755 "$agent_binary" "$stage/vela-computer"
if command -v shasum >/dev/null 2>&1; then
	checksum() {
		shasum -a 256 "$1" | awk '{print $1}'
	}
elif command -v sha256sum >/dev/null 2>&1; then
	checksum() {
		sha256sum "$1" | awk '{print $1}'
	}
else
	echo "build-vela-release: no SHA-256 command is available" >&2
	exit 1
fi

agent_checksum=$(checksum "$stage/vela-computer")
{
	printf '%s  %s\n' "$agent_checksum" "vela-computer"
} >"$stage/SHA256SUMS"
printf '%s\n' "$version" >"$stage/VERSION"
chmod 0644 "$stage/SHA256SUMS" "$stage/VERSION"

mv "$stage" "$output_directory"
trap - EXIT HUP INT TERM
echo "Built canonical Vela release at $output_directory"
