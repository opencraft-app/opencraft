#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lock=${RIVET_TOOLCHAIN_LOCK:-$script_dir/toolchains.lock.json}
destination=${RIVET_TOOLCHAIN_DIR:?RIVET_TOOLCHAIN_DIR is required}
receipt=${RIVET_TOOLCHAIN_RECEIPT:?RIVET_TOOLCHAIN_RECEIPT is required}
export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}

[[ $destination == /* && $receipt == /* && $TMPDIR == /* && -f $lock ]] || { echo "toolchain paths must be absolute and the lock must exist" >&2; exit 2; }
[[ -d $(dirname -- "$destination") && -d $(dirname -- "$receipt") && ! -e $receipt ]] || { echo "toolchain output parents must exist and receipt must be new" >&2; exit 2; }
[[ -d $TMPDIR ]] || install -d -m 1777 "$TMPDIR"
for command in curl jq python3 sha256sum tar; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
jq -e '
  keys == ["bazel","platform","schemaVersion","zig"] and
  .schemaVersion == 1 and .platform == "linux/amd64" and
  (.bazel | keys == ["binarySha256","url","version"]) and
  (.zig | keys == ["archiveSha256","binarySha256","url","version"]) and
  .bazel.version == "9.2.0" and .zig.version == "0.14.1" and
  ([.bazel.binarySha256,.zig.archiveSha256,.zig.binarySha256] | all(test("^[0-9a-f]{64}$"))) and
  (.bazel.url | startswith("https://github.com/bazelbuild/bazel/releases/download/9.2.0/")) and
  (.zig.url | startswith("https://ziglang.org/download/0.14.1/"))
' "$lock" >/dev/null || { echo "runtime toolchain lock is invalid" >&2; exit 1; }

zig_sha=$(jq -r .zig.binarySha256 "$lock")
bazel_sha=$(jq -r .bazel.binarySha256 "$lock")
zig_archive=${RIVET_ZIG_ARCHIVE:-}
bazel_binary=${RIVET_BAZEL_BINARY:-}
if [[ -n $zig_archive || -n $bazel_binary ]]; then
	[[ $zig_archive == /* && $bazel_binary == /* && -f $zig_archive && -f $bazel_binary ]] || {
		echo "supplied toolchain artifacts must be two absolute regular files" >&2
		exit 2
	}
fi
download_with_retries() {
	local output=$1 url=$2 attempt
	for attempt in 1 2 3 4 5; do
		rm -f -- "$output"
		if curl --fail --location --connect-timeout 15 --max-time 1800 \
			--output "$output" "$url"; then
			return 0
		fi
		sleep $((attempt * 2))
	done
	echo "toolchain download failed after five attempts: $url" >&2
	return 1
}
verify_installation() {
	[[ -x $destination/zig/zig && -x $destination/bazel ]] || return 1
	[[ $(sha256sum "$destination/zig/zig" | cut -d' ' -f1) == "$zig_sha" ]] || return 1
	[[ $(sha256sum "$destination/bazel" | cut -d' ' -f1) == "$bazel_sha" ]] || return 1
	[[ $($destination/zig/zig version) == 0.14.1 ]] || return 1
	"$destination/bazel" --version | grep -qx 'bazel 9.2.0'
}

if [[ -e $destination ]]; then
	verify_installation || { echo "existing toolchain installation differs from the lock" >&2; exit 1; }
else
	stage=$(mktemp -d "$(dirname -- "$destination")/.runtime-toolchains.XXXXXX")
	download=$(mktemp -d "$TMPDIR/runtime-toolchain-download.XXXXXX")
	cleanup() { [[ -z $stage ]] || rm -rf -- "$stage"; rm -rf -- "$download"; }
	trap cleanup EXIT INT TERM
	if [[ -n $zig_archive ]]; then
		cp -- "$zig_archive" "$download/zig.tar.xz"
		cp -- "$bazel_binary" "$download/bazel"
	else
		download_with_retries "$download/zig.tar.xz" "$(jq -r .zig.url "$lock")"
		download_with_retries "$download/bazel" "$(jq -r .bazel.url "$lock")"
	fi
	printf '%s  %s\n' "$(jq -r .zig.archiveSha256 "$lock")" "$download/zig.tar.xz" | sha256sum --check --status
	printf '%s  %s\n' "$bazel_sha" "$download/bazel" | sha256sum --check --status
	tar -tf "$download/zig.tar.xz" | python3 -c '
import pathlib,sys
names=[line.rstrip("\n") for line in sys.stdin]
if not names: raise SystemExit("empty Zig archive")
for name in names:
    path=pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts: raise SystemExit("unsafe Zig archive path")
'
	install -d -m 0755 "$stage/zig"
	tar -xJf "$download/zig.tar.xz" --strip-components=1 -C "$stage/zig"
	install -m 0755 "$download/bazel" "$stage/bazel"
	mv "$stage" "$destination"
	stage=
	verify_installation || { echo "installed toolchains differ from the lock" >&2; exit 1; }
fi

receipt_stage=$(mktemp "$(dirname -- "$receipt")/.runtime-toolchain-receipt.XXXXXX")
jq -n \
	--arg lock_digest "sha256:$(sha256sum "$lock" | cut -d' ' -f1)" \
	--arg zig_sha256 "sha256:$zig_sha" \
	--arg bazel_sha256 "sha256:$bazel_sha" \
	'{schema:"actor-runtime-toolchains/v1",verdict:"passed",platform:"linux/amd64",lockDigest:$lock_digest,zig:{version:"0.14.1",sha256:$zig_sha256},bazel:{version:"9.2.0",sha256:$bazel_sha256}}' \
	>"$receipt_stage"
if ! ln "$receipt_stage" "$receipt"; then
	rm -f -- "$receipt_stage"
	exit 1
fi
rm -f -- "$receipt_stage"
printf 'runtime_toolchains=passed receipt=%s\n' "$receipt"
