#!/bin/sh

set -eu

script_directory=$(CDPATH= cd "$(dirname "$0")" && pwd)
source_path="$script_directory/../bin/raft-computer-go-linux-amd64"
host=""
destination="/usr/local/bin/raft-computer-go"

while [ "$#" -gt 0 ]; do
	case "$1" in
	--host)
		[ "$#" -ge 2 ] || {
			echo "deploy-linux: --host requires a value" >&2
			exit 2
		}
		host="$2"
		shift 2
		;;
	--source)
		[ "$#" -ge 2 ] || {
			echo "deploy-linux: --source requires a path" >&2
			exit 2
		}
		source_path="$2"
		shift 2
		;;
	--destination)
		[ "$#" -ge 2 ] || {
			echo "deploy-linux: --destination requires a path" >&2
			exit 2
		}
		destination="$2"
		shift 2
		;;
	*)
		echo "usage: deploy-linux.sh --host USER@HOST [--source PATH] [--destination ABSOLUTE_PATH]" >&2
		exit 2
		;;
	esac
done

case "$host" in
"" | *[!A-Za-z0-9._@:-]*)
	echo "deploy-linux: unsafe or missing host" >&2
	exit 2
	;;
esac
case "$destination" in
/*)
	;;
*)
	echo "deploy-linux: unsafe destination; an absolute path is required" >&2
	exit 2
	;;
esac
case "$destination" in
*[!A-Za-z0-9_./-]* | */../* | */.. | *//*)
	echo "deploy-linux: unsafe destination" >&2
	exit 2
	;;
esac

[ -f "$source_path" ] && [ -x "$source_path" ] || {
	echo "deploy-linux: source is not an executable file: $source_path" >&2
	exit 1
}
source_directory=$(CDPATH= cd "$(dirname "$source_path")" && pwd)
source_path="$source_directory/$(basename "$source_path")"

if command -v shasum >/dev/null 2>&1; then
	checksum=$(shasum -a 256 "$source_path" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
	checksum=$(sha256sum "$source_path" | awk '{print $1}')
else
	echo "deploy-linux: no local SHA-256 command is available" >&2
	exit 1
fi

remote_upload="${destination}.upload.$$"
scp "$source_path" "$host:$remote_upload"
ssh "$host" sh -s -- "$remote_upload" "$destination" "$checksum" <<'REMOTE_INSTALL'
set -eu

upload=$1
destination=$2
expected=$3

case "$upload:$destination:$expected" in
*[!A-Za-z0-9_./:-]* | *"/../"* | *"//"*)
	echo "deploy-linux: unsafe remote install arguments" >&2
	exit 2
	;;
esac

actual=$(sha256sum "$upload" | awk '{print $1}')
if [ "$actual" != "$expected" ]; then
	rm -f "$upload"
	echo "deploy-linux: uploaded checksum mismatch" >&2
	exit 1
fi

if [ -f "$destination" ]; then
	current=$(sha256sum "$destination" | awk '{print $1}')
	if [ "$current" = "$expected" ]; then
		rm -f "$upload"
		echo "raft-computer-go is already installed with checksum $expected"
		exit 0
	fi
	backup="${destination}.previous.$(date -u +%Y%m%dT%H%M%SZ)"
	cp -p "$destination" "$backup"
	echo "Preserved previous binary at $backup"
fi

chmod 0755 "$upload"
mv "$upload" "$destination"
echo "Installed $destination with checksum $expected"
REMOTE_INSTALL
