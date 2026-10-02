#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib-tat.sh
source "$script_dir/lib-tat.sh"

usage() {
	cat <<'EOF'
Usage: tat-upload.sh LOCAL_FILE ABSOLUTE_REMOTE_FILE

Uploads one file through bounded TAT commands, verifies SHA-256 remotely, and
atomically renames it into place. Set TAT_UPLOAD_OVERWRITE=1 to replace an
existing remote target. Executable local files default to remote mode 0700;
other files default to 0600. TAT_UPLOAD_MODE overrides that mode. Credentials
and instance selection come from the standard tccli environment and
TAT_INSTANCE_ID.
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
local_file=$1
remote_file=$2
[[ -f $local_file ]] || tat_die "local file does not exist: $local_file"
[[ $remote_file == /* && $remote_file != / ]] || tat_die "remote target must be an absolute file path"

tat_initialize
tat_require_command sha256sum
tat_require_command fold
tat_require_command split

chunk_chars=${TAT_UPLOAD_CHUNK_CHARS:-24000}
overwrite=${TAT_UPLOAD_OVERWRITE:-0}
if [[ -n ${TAT_UPLOAD_MODE:-} ]]; then
	remote_mode=$TAT_UPLOAD_MODE
elif [[ -x $local_file ]]; then
	remote_mode=700
else
	remote_mode=600
fi
[[ $chunk_chars =~ ^[1-9][0-9]*$ ]] || tat_die "TAT_UPLOAD_CHUNK_CHARS must be a positive integer"
((chunk_chars <= 30000)) || tat_die "TAT_UPLOAD_CHUNK_CHARS must not exceed 30000"
[[ $overwrite == 0 || $overwrite == 1 ]] || tat_die "TAT_UPLOAD_OVERWRITE must be 0 or 1"
[[ $remote_mode =~ ^[0-7]{3,4}$ ]] || tat_die "TAT_UPLOAD_MODE must be an octal file mode"
local_sha=$(sha256sum "$local_file" | cut -d' ' -f1)
temporary=$(mktemp -d)
cleanup() {
	rm -rf -- "$temporary"
}
trap cleanup EXIT

base64 <"$local_file" | tr -d '\n' | fold -w "$chunk_chars" >"$temporary/all"
if [[ -s $temporary/all ]]; then
	split -l 1 "$temporary/all" "$temporary/part."
else
	: >"$temporary/part.aa"
fi

printf -v quoted_remote '%q' "$remote_file"
remote_b64="${remote_file}.tat-part.b64"
printf -v quoted_remote_b64 '%q' "$remote_b64"
remote_partial="${remote_file}.tat-part"
printf -v quoted_remote_partial '%q' "$remote_partial"
printf -v quoted_remote_dir '%q' "$(dirname -- "$remote_file")"

init_payload=$(printf '%s\n' \
	'set -euo pipefail' \
	"install -d -m 700 $quoted_remote_dir" \
	"if [[ $overwrite != 1 && -e $quoted_remote ]]; then echo 'remote target exists' >&2; exit 17; fi" \
	": > $quoted_remote_b64")
tat_run_and_wait actor-fleet-upload-init 120 "$init_payload"

chunk_count=0
for part in "$temporary"/part.*; do
	chunk=$(<"$part")
	append_payload=$(printf '%s\n' \
		'set -euo pipefail' \
		"printf '%s' '$chunk' >> $quoted_remote_b64")
	tat_run_and_wait actor-fleet-upload-chunk 120 "$append_payload"
	chunk_count=$((chunk_count + 1))
done

finalize_payload=$(printf '%s\n' \
	'set -euo pipefail' \
	"base64 --decode < $quoted_remote_b64 > $quoted_remote_partial" \
	"actual=\$(sha256sum $quoted_remote_partial | cut -d ' ' -f1)" \
	"test \"\$actual\" = '$local_sha'" \
	"chmod $remote_mode $quoted_remote_partial" \
	"mv $quoted_remote_partial $quoted_remote" \
	"rm -f $quoted_remote_b64" \
	"printf 'sha256=%s bytes=%s\\n' \"\$actual\" \"\$(wc -c < $quoted_remote)\"")
tat_run_and_wait actor-fleet-upload-finalize 120 "$finalize_payload"
echo "tat-upload: chunks=$chunk_count remote=$remote_file sha256=$local_sha" >&2
