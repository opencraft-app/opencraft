#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_dir=$(CDPATH= cd -- "$script_dir/../../runtime" && pwd)
temporary=$(mktemp -d /data/tmp/test-source-relay.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

repository=$temporary/repository
project=$repository/minisandbox
mkdir -p "$project" "$temporary/output"
git init -q "$repository"
git -C "$repository" config user.email test@example.invalid
git -C "$repository" config user.name test
printf 'reviewed\n' >"$project/payload.txt"
printf 'excluded\n' >"$repository/sibling.txt"
git -C "$repository" add .
git -C "$repository" commit -qm reviewed
revision=$(git -C "$repository" rev-parse HEAD)
bundle=$temporary/output/source.tar.gz
receipt=$temporary/output/source.receipt.json
RIVET_SOURCE_DIR=$project \
RIVET_SOURCE_REVISION=$revision \
RIVET_SOURCE_BUNDLE=$bundle \
RIVET_SOURCE_RECEIPT=$receipt \
	"$runtime_dir/bundle-full-reviewed-source.sh" >/dev/null

calls=$temporary/relay.calls
payload=$temporary/tat.payload
mock_relay=$temporary/relay
mock_tat=$temporary/tat
cat >"$mock_relay" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\t%s\t%s\n' "$RELAY_REMOTE_MODE" "$1" "$2" >>"$MOCK_RELAY_CALLS"
MOCK
cat >"$mock_tat" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
cat >"$MOCK_TAT_PAYLOAD"
printf 'mock_tat=passed\n'
MOCK
chmod 0700 "$mock_relay" "$mock_tat"

MOCK_RELAY_CALLS=$calls MOCK_TAT_PAYLOAD=$payload \
ACTOR_RELAY_UPLOAD=$mock_relay ACTOR_TAT_RUN=$mock_tat \
	"$script_dir/materialize-full-reviewed-source-via-relay.sh" "$bundle" "$receipt" \
	>"$temporary/output.log"

test "$(wc -l <"$calls" | tr -d ' ')" = 4
grep -Fq $'0600\t'"$bundle"$'\t/var/lib/actor-build/incoming/reviewed-source-' "$calls"
grep -Fq $'0600\t'"$receipt"$'\t/var/lib/actor-build/incoming/reviewed-source-' "$calls"
grep -Fq $'0700\t'"$script_dir/materialize-full-reviewed-source.sh" "$calls"
grep -Fq $'0700\t'"$runtime_dir/verify-full-source-bundle.py" "$calls"
grep -Fq 'ACTOR_SOURCE_BUNDLE_VERIFIER="$verifier"' "$payload"
grep -Fq "= '$revision'" "$payload"
grep -Fq 'reviewed_source_materialized=/var/lib/actor-build/deploy/q01-src-' "$temporary/output.log"

ln -s "$runtime_dir/verify-full-source-bundle.py" "$temporary/verifier-link"
if ACTOR_SOURCE_BUNDLE_VERIFIER=$temporary/verifier-link ACTOR_BUILD_PYTHON=python3.11 \
	"$script_dir/materialize-full-reviewed-source.sh" "$bundle" "$receipt" \
	>"$temporary/symlink.out" 2>"$temporary/symlink.err"; then
	echo "materializer accepted a symlink verifier" >&2
	exit 1
fi
grep -Fq 'ACTOR_SOURCE_BUNDLE_VERIFIER must name an absolute non-symlink regular file' \
	"$temporary/symlink.err"
echo "materialize reviewed source relay tests: pass"
