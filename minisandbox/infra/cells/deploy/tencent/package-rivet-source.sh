#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
	echo "usage: $0 SOURCE_DIRECTORY OUTPUT.tar.gz" >&2
	exit 2
fi

source_dir=$(CDPATH= cd -- "$1" && pwd)
output_dir=$(CDPATH= cd -- "$(dirname -- "$2")" && pwd)
output="$output_dir/$(basename -- "$2")"
source_parent=$(dirname -- "$source_dir")
source_name=$(basename -- "$source_dir")
temporary="$output.tmp.$$"

case "$output" in
	"$source_dir"/*)
		echo "output archive must not be inside the source tree" >&2
		exit 2
		;;
esac

cleanup() {
	rm -f -- "$temporary"
}
trap cleanup EXIT INT TERM

# macOS tar otherwise synthesizes AppleDouble `._*` members. Those files are
# not harmless in a Rust workspace: Cargo can discover them as duplicate
# schemas or sources after the archive reaches a Linux builder.
COPYFILE_DISABLE=1 tar -C "$source_parent" \
	--exclude="$source_name/.git" \
	--exclude="$source_name/target" \
	--exclude='._*' \
	--exclude='*/._*' \
	-czf "$temporary" "$source_name"

if tar -tzf "$temporary" | grep -Eq '(^|/)\._[^/]+$'; then
	echo "refusing source archive containing AppleDouble members" >&2
	exit 1
fi
if tar -tzf "$temporary" | grep -Eq "^${source_name}/(\.git|target)(/|$)"; then
	echo "refusing source archive containing build or VCS state" >&2
	exit 1
fi

mv -f -- "$temporary" "$output"
trap - EXIT INT TERM
sha256sum "$output" 2>/dev/null || shasum -a 256 "$output"
