#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib-tat.sh
source "$script_dir/lib-tat.sh"

usage() {
	cat <<'EOF'
Usage: tat-download.sh ABSOLUTE_REMOTE_FILE LOCAL_FILE

Downloads one file through bounded TAT outputs, verifies its byte count and
SHA-256 locally, and atomically renames it into place. Set
TAT_DOWNLOAD_OVERWRITE=1 to replace an existing local target.
EOF
}

if [[ $# -eq 1 && ($1 == -h || $1 == --help) ]]; then
	usage
	exit 0
fi
[[ $# -eq 2 ]] || {
	usage >&2
	exit 2
}
remote_file=$1
local_file=$2
[[ $remote_file == /* && $remote_file != / ]] || tat_die "remote source must be an absolute file path"

tat_initialize
tat_require_command sha256sum

chunk_chars=${TAT_DOWNLOAD_CHUNK_CHARS:-12000}
overwrite=${TAT_DOWNLOAD_OVERWRITE:-0}
[[ $chunk_chars =~ ^[1-9][0-9]*$ ]] || tat_die "TAT_DOWNLOAD_CHUNK_CHARS must be a positive integer"
((chunk_chars <= 18000)) || tat_die "TAT_DOWNLOAD_CHUNK_CHARS must not exceed 18000"
[[ $overwrite == 0 || $overwrite == 1 ]] || tat_die "TAT_DOWNLOAD_OVERWRITE must be 0 or 1"
[[ $overwrite == 1 || ! -e $local_file ]] || tat_die "local target exists: $local_file"
local_dir=$(dirname -- "$local_file")
[[ -d $local_dir ]] || tat_die "local target directory does not exist: $local_dir"

printf -v quoted_remote '%q' "$remote_file"
metadata_payload=$(printf '%s\n' \
	'set -euo pipefail' \
	"test -f $quoted_remote" \
	"bytes=\$(wc -c < $quoted_remote)" \
	"sha=\$(sha256sum $quoted_remote | cut -d ' ' -f1)" \
	"encoded=\$(base64 < $quoted_remote | tr -d '\\n' | wc -c)" \
	"chunks=\$(( (encoded + $chunk_chars - 1) / $chunk_chars ))" \
	"printf '%s %s %s %s\\n' \"\$bytes\" \"\$sha\" \"\$encoded\" \"\$chunks\"")
metadata=$(tat_run_and_wait actor-fleet-download-metadata 120 "$metadata_payload")
read -r remote_bytes remote_sha encoded_chars chunk_count <<<"$metadata"
[[ $remote_bytes =~ ^[0-9]+$ ]] || tat_die "invalid remote byte count"
[[ $remote_sha =~ ^[0-9a-f]{64}$ ]] || tat_die "invalid remote SHA-256"
[[ $encoded_chars =~ ^[0-9]+$ && $chunk_count =~ ^[0-9]+$ ]] || tat_die "invalid remote chunk metadata"

temporary_b64=$(mktemp "$local_dir/.tat-download.XXXXXX.b64")
temporary_file=$(mktemp "$local_dir/.tat-download.XXXXXX")
cleanup() {
	rm -f -- "$temporary_b64" "$temporary_file"
}
trap cleanup EXIT

for ((index = 0; index < chunk_count; index++)); do
	start=$((index * chunk_chars + 1))
	end=$(((index + 1) * chunk_chars))
	chunk_payload=$(printf '%s\n' \
		'set -euo pipefail' \
		"base64 < $quoted_remote | tr -d '\\n' | cut -c $start-$end")
	chunk=$(tat_run_and_wait actor-fleet-download-chunk 120 "$chunk_payload")
	printf '%s' "$chunk" >>"$temporary_b64"
done

[[ $(wc -c <"$temporary_b64" | tr -d ' ') == "$encoded_chars" ]] || tat_die "encoded download length mismatch"
base64 --decode <"$temporary_b64" >"$temporary_file"
local_bytes=$(wc -c <"$temporary_file" | tr -d ' ')
local_sha=$(sha256sum "$temporary_file" | cut -d' ' -f1)
[[ $local_bytes == "$remote_bytes" ]] || tat_die "download byte count mismatch"
[[ $local_sha == "$remote_sha" ]] || tat_die "download SHA-256 mismatch"
mv -f -- "$temporary_file" "$local_file"
echo "tat-download: chunks=$chunk_count local=$local_file sha256=$local_sha" >&2
