#!/usr/bin/env bash
set -euo pipefail

source_dir=${1:-}
[[ -n "$source_dir" && -d "$source_dir" ]] || {
	printf 'usage: %s SOURCE_DIR\n' "$0" >&2
	exit 1
}

hash_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

hash_stream() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | awk '{print $1}'
	else
		shasum -a 256 | awk '{print $1}'
	fi
}

(
	cd "$source_dir"
	find . -mindepth 1 \( -path './.git' -o -path './.git/*' \) -prune -o \
		\( -type f -o -type l \) -print0 |
		LC_ALL=C sort -z |
		while IFS= read -r -d '' path; do
			relative=${path#./}
			if [[ -L "$path" ]]; then
				kind=120000
				payload=$(printf '%s' "$(readlink "$path")" | hash_stream)
			elif [[ -x "$path" ]]; then
				kind=100755
				payload=$(hash_file "$path")
			else
				kind=100644
				payload=$(hash_file "$path")
			fi
			printf '%s\0%s\0%s\0' "$kind" "$relative" "$payload"
		done
) | hash_stream
