#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
	echo "usage: $0 RIVET_ENGINE_WORKSPACE [OUTPUT_BINARY]" >&2
	exit 2
fi

workspace=$(CDPATH= cd -- "$1" && pwd)
manifest="$workspace/packages/engine/Cargo.toml"
[[ -f "$manifest" ]] || {
	echo "rivet-engine manifest not found: $manifest" >&2
	exit 1
}

# The upstream Engine intentionally has `default = []`. Building without this explicit feature
# produces a healthy-looking binary that cannot instantiate an FDB UniversalDB pool.
grep -Fq 'foundationdb = ["rivet-pools/foundationdb", "universaldb/foundationdb"]' "$manifest" || {
	echo "rivet-engine FoundationDB feature contract is missing or changed" >&2
	exit 1
}

cargo_bin=${CARGO_BIN:-cargo}
(cd "$workspace" && "$cargo_bin" build --locked --release \
	-p rivet-engine --features foundationdb)

target_root=${CARGO_TARGET_DIR:-$workspace/target}
artifact="$target_root/release/rivet-engine"
[[ -x "$artifact" ]] || {
	echo "expected executable was not produced: $artifact" >&2
	exit 1
}

if [[ $# -eq 2 ]]; then
	output_dir=$(CDPATH= cd -- "$(dirname -- "$2")" && pwd)
	output="$output_dir/$(basename -- "$2")"
	install -m 0755 "$artifact" "$output"
	artifact=$output
fi

if command -v sha256sum >/dev/null 2>&1; then
	sha256sum "$artifact"
else
	shasum -a 256 "$artifact"
fi
printf 'engine_feature=foundationdb\nengine_artifact=%s\n' "$artifact"
