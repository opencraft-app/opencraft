#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture_root=$(mktemp -d)
trap 'rm -rf -- "$fixture_root"' EXIT INT TERM

workspace="$fixture_root/engine"
mkdir -p "$workspace/packages/engine" "$workspace/target/release" "$fixture_root/bin"
printf '%s\n' \
	'[package]' \
	'name = "rivet-engine"' \
	'[features]' \
	'default = []' \
	'foundationdb = ["rivet-pools/foundationdb", "universaldb/foundationdb"]' \
	>"$workspace/packages/engine/Cargo.toml"

printf '%s\n' \
	'#!/usr/bin/env bash' \
	'set -euo pipefail' \
	'printf "%s\\n" "$@" >"$FAKE_CARGO_ARGS"' \
	'printf "#!/usr/bin/env sh\\nexit 0\\n" >"$FAKE_CARGO_ARTIFACT"' \
	'chmod +x "$FAKE_CARGO_ARTIFACT"' \
	>"$fixture_root/bin/cargo"
chmod +x "$fixture_root/bin/cargo"

export FAKE_CARGO_ARGS="$fixture_root/cargo.args"
export FAKE_CARGO_ARTIFACT="$workspace/target/release/rivet-engine"
output="$fixture_root/rivet-engine"
CARGO_BIN="$fixture_root/bin/cargo" "$script_dir/build-rivet-engine.sh" \
	"$workspace" "$output" >/dev/null

expected=$(printf '%s\n' build --locked --release -p rivet-engine --features foundationdb)
actual=$(cat "$FAKE_CARGO_ARGS")
[[ "$actual" == "$expected" ]] || {
	echo "unexpected cargo arguments" >&2
	diff -u <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
	exit 1
}
[[ -x "$output" ]]

sed -i.bak '/^foundationdb =/d' "$workspace/packages/engine/Cargo.toml"
if CARGO_BIN="$fixture_root/bin/cargo" "$script_dir/build-rivet-engine.sh" \
	"$workspace" "$output" >/dev/null 2>&1; then
	echo "build accepted a workspace without the FoundationDB feature contract" >&2
	exit 1
fi

echo "rivet-engine build wrapper tests passed"
