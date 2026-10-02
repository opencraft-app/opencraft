#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
cleanup(){ rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

base=$temporary/base
bundle=$temporary/delta.tar.gz
mkdir -p "$base/.actor-source"
: >"$bundle"
printf 'reviewed\n' >"$base/tracked.txt"
printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >"$base/.actor-source/SOURCE_REVISION"
(
	cd "$base"
	sha256sum tracked.txt >.actor-source/RELEASE_SHA256SUMS
)

set +e
RIVET_SOURCE_BUNDLE=$bundle \
RIVET_SOURCE_DIR=$base \
RIVET_BASE_REVISION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
RIVET_SOURCE_REVISION=cccccccccccccccccccccccccccccccccccccccc \
	"$script_dir/apply-source-delta.sh" >"$temporary/wrong-base.out" 2>&1
wrong_base_status=$?
set -e
[[ $wrong_base_status -ne 0 ]]
grep -Fq 'builder base identity mismatch' "$temporary/wrong-base.out"

printf 'tampered\n' >"$base/tracked.txt"
set +e
RIVET_SOURCE_BUNDLE=$bundle \
RIVET_SOURCE_DIR=$base \
RIVET_BASE_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
RIVET_SOURCE_REVISION=cccccccccccccccccccccccccccccccccccccccc \
	"$script_dir/apply-source-delta.sh" >"$temporary/tampered-base.out" 2>&1
tampered_base_status=$?
set -e
[[ $tampered_base_status -ne 0 ]]
grep -Fq 'builder base tree no longer matches its reviewed release manifest' \
	"$temporary/tampered-base.out"

upgrade=$temporary/upgrade
payload=$temporary/payload
upgrade_bundle=$temporary/self-upgrade.tar.gz
mkdir -p "$upgrade/.actor-source" "$upgrade/runtime" "$payload/.actor-source" "$payload/runtime"
install -m 0755 "$script_dir/apply-source-delta.sh" "$upgrade/runtime/apply-source-delta.sh"
printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >"$upgrade/.actor-source/SOURCE_REVISION"
(
	cd "$upgrade"
	sha256sum runtime/apply-source-delta.sh >.actor-source/RELEASE_SHA256SUMS
)
cp "$script_dir/apply-source-delta.sh" "$payload/runtime/apply-source-delta.sh"
printf '\n# self-update-test-marker\n' >>"$payload/runtime/apply-source-delta.sh"
printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >"$payload/.actor-source/BASE_REVISION"
printf '%s\n' cccccccccccccccccccccccccccccccccccccccc >"$payload/.actor-source/SOURCE_REVISION"
printf '1\n' >"$payload/.actor-source/FILE_COUNT"
(
	cd "$payload"
	sha256sum runtime/apply-source-delta.sh >.actor-source/SHA256SUMS
	cp .actor-source/SHA256SUMS .actor-source/RELEASE_SHA256SUMS
	tar -czf "$upgrade_bundle" .
)
RIVET_SOURCE_BUNDLE=$upgrade_bundle \
RIVET_SOURCE_DIR=$upgrade \
RIVET_BASE_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
RIVET_SOURCE_REVISION=cccccccccccccccccccccccccccccccccccccccc \
	"$upgrade/runtime/apply-source-delta.sh" >"$temporary/self-upgrade.out"
grep -Fq 'source delta applied and verified: 1 files' "$temporary/self-upgrade.out"
grep -Fq '# self-update-test-marker' "$upgrade/runtime/apply-source-delta.sh"

echo 'source delta base identity tests: pass'
