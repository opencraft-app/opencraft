#!/usr/bin/env bash
set -euo pipefail

# Bind a shared Cargo target directory to the exact transitive local inputs of
# the two Runtime binaries. A changed input/toolchain clears the cache before a
# stable-path build; an operations-only source revision can reuse it safely.
source_dir=${RIVET_IMMUTABLE_SOURCE_DIR:?RIVET_IMMUTABLE_SOURCE_DIR is required}
target_dir=${RIVET_CARGO_TARGET_DIR:?RIVET_CARGO_TARGET_DIR is required}
state_file=${RIVET_CARGO_CACHE_STATE:?RIVET_CARGO_CACHE_STATE is required}
python=${ACTOR_BUILD_PYTHON:-python3}
[[ $source_dir == /* && $target_dir == /* && $state_file == /* ]] || {
	echo "Cargo cache paths must be absolute" >&2
	exit 2
}
[[ $target_dir == /data/build-cache/* && $target_dir != /data/build-cache/ && \
   $state_file == /var/lib/actor-build/runtime-workspace/* ]] || {
	echo "Cargo cache target/state are outside bounded builder roots" >&2
	exit 2
}
[[ -d $source_dir && -f $source_dir/Cargo.toml && -f $source_dir/Cargo.lock ]] || {
	echo "Cargo cache source is incomplete" >&2
	exit 2
}
for command in cargo rustc sha256sum "$python"; do
	command -v "$command" >/dev/null || { echo "missing Cargo cache tool: $command" >&2; exit 2; }
done
install -d -m 0755 "$target_dir"
install -d -m 0700 "$(dirname -- "$state_file")"
source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
target_dir=$(CDPATH= cd -- "$target_dir" && pwd)
case "$target_dir/" in "$source_dir"/*) echo "Cargo cache must be outside source" >&2; exit 2;; esac

metadata=$(mktemp)
trap 'rm -f -- "$metadata"' EXIT
cargo metadata --locked --offline --format-version 1 \
	--manifest-path "$source_dir/Cargo.toml" >"$metadata"
input_digest=$("$python" - "$metadata" "$source_dir" <<'PY'
import hashlib
import json
import os
import stat
import sys

metadata_path, source = sys.argv[1:]
source = os.path.realpath(source)
value = json.load(open(metadata_path, encoding="utf-8"))
packages = {item["id"]: item for item in value["packages"]}
nodes = {item["id"]: item for item in value["resolve"]["nodes"]}
roots = [item["id"] for item in value["packages"] if item["name"] in {"rivet-engine", "rivet-workerd-host"}]
if len(roots) != 2:
    raise SystemExit("Runtime Cargo roots are incomplete")
reachable = set()
pending = list(roots)
while pending:
    package_id = pending.pop()
    if package_id in reachable:
        continue
    reachable.add(package_id)
    pending.extend(item["pkg"] for item in nodes[package_id].get("deps", []))

paths = {"Cargo.toml", "Cargo.lock"}
for optional in ("rust-toolchain", "rust-toolchain.toml", ".cargo"):
    if os.path.lexists(os.path.join(source, optional)):
        paths.add(optional)
for package_id in reachable:
    package = packages[package_id]
    if package.get("source") is not None:
        continue
    manifest = os.path.realpath(package["manifest_path"])
    try:
        common = os.path.commonpath([source, manifest])
    except ValueError:
        raise SystemExit("local Cargo dependency escaped source")
    if common != source:
        raise SystemExit("local Cargo dependency escaped source")
    paths.add(os.path.relpath(os.path.dirname(manifest), source))

inventory = {}
for relative_root in sorted(paths):
    start = os.path.join(source, relative_root)
    candidates = [start]
    if os.path.isdir(start) and not os.path.islink(start):
        for directory, names, files in os.walk(start, followlinks=False):
            names[:] = sorted(name for name in names if name not in {".git", "target"})
            candidates.extend(os.path.join(directory, name) for name in names + sorted(files))
    for path in candidates:
        relative = os.path.relpath(path, source).replace(os.sep, "/")
        metadata = os.lstat(path)
        executable = metadata.st_mode & 0o111
        if stat.S_ISREG(metadata.st_mode):
            with open(path, "rb") as handle:
                payload = handle.read()
            kind = b"file"
        elif stat.S_ISLNK(metadata.st_mode):
            payload = os.readlink(path).encode()
            kind = b"link"
        elif stat.S_ISDIR(metadata.st_mode):
            payload = b""
            kind = b"directory"
        else:
            raise SystemExit("unsupported Cargo input: " + relative)
        inventory[relative] = (kind, executable, hashlib.sha256(payload).digest())

digest = hashlib.sha256()
for relative, (kind, executable, payload_digest) in sorted(inventory.items()):
    digest.update(relative.encode() + b"\0" + kind + b"\0")
    digest.update(str(executable).encode() + b"\0" + payload_digest)
print(digest.hexdigest())
PY
)
[[ $input_digest =~ ^[0-9a-f]{64}$ ]]
toolchain_digest=$(
	{
		printf '%s\n' "$input_digest"
		cargo --version --verbose
		rustc --version --verbose
		printf 'lto=%s\nlinker=%s\nrustflags=%s\n' \
			"${CARGO_PROFILE_RELEASE_LTO:-}" \
			"${CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER:-}" \
			"${RUSTFLAGS:-}"
	} | sha256sum | cut -d' ' -f1
)
previous=
if [[ -f $state_file ]]; then
	previous=$(tr -d '[:space:]' <"$state_file")
fi
if [[ $previous != "$toolchain_digest" ]]; then
	# This is an explicitly bounded, reproducible compiler cache. Never retain
	# artifacts after any transitive local input or toolchain contract changes.
	find "$target_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
	staged=$(mktemp "$(dirname -- "$state_file")/.cargo-cache-state.XXXXXX")
	printf '%s\n' "$toolchain_digest" >"$staged"
	chmod 0600 "$staged"
	mv "$staged" "$state_file"
	verdict=reset
else
	verdict=reused
fi
rm -f -- "$metadata"
trap - EXIT
printf 'cargo_cache=%s input_sha256=%s toolchain_sha256=%s target=%s\n' \
	"$verdict" "$input_digest" "$toolchain_digest" "$target_dir"
