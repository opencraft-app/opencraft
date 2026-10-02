#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary_root=$(mktemp -d "${TMPDIR:-/data/tmp}/actor-autonomy-source-test.XXXXXX")
cleanup() { rm -rf -- "$temporary_root"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary_root"
# This is a hermetic unit test.  Never contend with the production Cell lock
# merely because verify-manifests.sh is executed on an operations host while
# its autonomy timer is active.
export AUTONOMY_CONTROL_LOCK_PATH=$temporary_root/default-operation.lock

make_source() {
	local marker=$1 revision=$2 manifest_sha target
	# The manifest contains one stable byte sequence whose digest is encoded in
	# the immutable directory name, matching the production source contract.
	local staging=$temporary_root/staging-$marker
	mkdir -p "$staging/.actor-source" "$staging/infra/cells/deploy/tencent/fleet/operations" \
		"$staging/infra/cells/deploy/tencent/fleet/runtime"
	printf '%s\n' "$revision" >"$staging/.actor-source/SOURCE_REVISION"
	printf 'manifest-%s\n' "$marker" >"$staging/.actor-source/RELEASE_SHA256SUMS"
	manifest_sha=$(sha256sum "$staging/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)
	target=$temporary_root/q01-src-${revision}-${manifest_sha}
	mv "$staging" "$target"
	printf '{}\n' >"$target/infra/cells/deploy/tencent/fleet/operations/autonomy-policy.json"
	printf '# verifier\n' >"$target/infra/cells/deploy/tencent/fleet/runtime/verify_bottomless_receipt.py"
	cat >"$target/infra/cells/deploy/tencent/fleet/operations/autonomy_audit.py" <<'EOF'
# audit marker
EOF
	cat >"$target/infra/cells/deploy/tencent/fleet/operations/run-autonomy-governance.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
sleep "\${ENTRYPOINT_TEST_DELAY_SECONDS:-0}"
printf '%s|%s|%s|%s\n' '$marker' \
  "\$AUTONOMY_SOURCE_REVISION" \
  "\$AUTONOMY_SOURCE_MANIFEST_SHA256" \
  "\$AUTONOMY_SOURCE_TARGET" >"\$ENTRYPOINT_TEST_OUTPUT"
if [[ -n \${ENTRYPOINT_TEST_ALLOW_RECEIPT:-} ]]; then
  printf '{"control":"allow","verdict":"passed"}\n' >"\$AUTONOMY_CONTROL_OUTPUT_DIR/autonomy-control-\${CELL}-test.json"
fi
EOF
	cat >"$target/infra/cells/deploy/tencent/fleet/operations/hydrate-qualification-receipts.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
	cat >"$target/infra/cells/deploy/tencent/fleet/operations/publish-qualified-release.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >"$ENTRYPOINT_TEST_PUBLISH_OUTPUT"
EOF
	chmod 0755 "$target/infra/cells/deploy/tencent/fleet/operations/run-autonomy-governance.sh" \
		"$target/infra/cells/deploy/tencent/fleet/operations/hydrate-qualification-receipts.sh" \
		"$target/infra/cells/deploy/tencent/fleet/operations/publish-qualified-release.sh"
	chmod 0755 "$target"
	printf '%s\n' "$target"
}

revision1=1111111111111111111111111111111111111111
revision2=2222222222222222222222222222222222222222
source1=$(make_source old "$revision1")
source2=$(make_source new "$revision2")
link=$temporary_root/current
ln -s "$source1" "$link"
output=$temporary_root/result

AUTONOMY_REVIEWED_SOURCE_LINK=$link \
AUTONOMY_AUDIT_RECEIPT_DIR=$temporary_root \
AUTONOMY_CONTROL_OUTPUT_DIR=$temporary_root \
ENTRYPOINT_TEST_OUTPUT=$output \
ENTRYPOINT_TEST_DELAY_SECONDS=0.2 \
	"$script_dir/autonomy-reviewed-source-entrypoint.sh" &
pid=$!
sleep 0.05
ln -s "$source2" "$temporary_root/current.new"
mv -Tf "$temporary_root/current.new" "$link"
wait "$pid"
source1_manifest=${source1##*-}
[[ $(<"$output") == "old|$revision1|$source1_manifest|$source1" ]] || {
	echo "entrypoint mixed a concurrent source promotion into the active audit" >&2
	exit 1
}

AUTONOMY_REVIEWED_SOURCE_LINK=$link \
AUTONOMY_AUDIT_RECEIPT_DIR=$temporary_root \
AUTONOMY_CONTROL_OUTPUT_DIR=$temporary_root \
ENTRYPOINT_TEST_OUTPUT=$output \
	"$script_dir/autonomy-reviewed-source-entrypoint.sh"
source2_manifest=${source2##*-}
[[ $(<"$output") == "new|$revision2|$source2_manifest|$source2" ]] || {
	echo "next audit did not consume the newly promoted source" >&2
	exit 1
}

fake_kubectl=$temporary_root/kubectl
cat >"$fake_kubectl" <<'EOF'
#!/usr/bin/env bash
printf '{"status":{"phase":"Qualifying","readyForPlacement":false}}\n'
EOF
chmod 0755 "$fake_kubectl"
publish_output=$temporary_root/published-control
CELL=test-cell CELL_NAMESPACE=test-system KUBECONFIG_PATH=$temporary_root/kubeconfig \
KUBECTL=$fake_kubectl AUTONOMY_AUTO_PUBLISH_QUALIFICATION=1 \
AUTONOMY_REVIEWED_SOURCE_LINK=$link AUTONOMY_AUDIT_RECEIPT_DIR=$temporary_root \
AUTONOMY_CONTROL_OUTPUT_DIR=$temporary_root ENTRYPOINT_TEST_OUTPUT=$output \
ENTRYPOINT_TEST_ALLOW_RECEIPT=1 ENTRYPOINT_TEST_PUBLISH_OUTPUT=$publish_output \
	"$script_dir/autonomy-reviewed-source-entrypoint.sh"
[[ $(<"$publish_output") == "$temporary_root/autonomy-control-test-cell-test.json" ]] || {
	echo "entrypoint did not publish the unique fresh allow receipt" >&2
	exit 1
}

lock=$temporary_root/operation.lock
(
	exec 8>"$lock"
	flock 8
	sleep 2
) &
lock_holder=$!
sleep 0.1
if AUTONOMY_CONTROL_LOCK_PATH=$lock AUTONOMY_REVIEWED_SOURCE_LINK=$link \
	AUTONOMY_AUDIT_RECEIPT_DIR=$temporary_root AUTONOMY_CONTROL_OUTPUT_DIR=$temporary_root \
	ENTRYPOINT_TEST_OUTPUT=$output "$script_dir/autonomy-reviewed-source-entrypoint.sh" >/dev/null 2>&1; then
	echo "entrypoint audited while another Cell operation owned the lock" >&2
	exit 1
fi
wait "$lock_holder"

printf 'tampered\n' >>"$source2/.actor-source/RELEASE_SHA256SUMS"
if AUTONOMY_REVIEWED_SOURCE_LINK=$link \
	AUTONOMY_AUDIT_RECEIPT_DIR=$temporary_root \
	AUTONOMY_CONTROL_OUTPUT_DIR=$temporary_root \
	ENTRYPOINT_TEST_OUTPUT=$output \
	"$script_dir/autonomy-reviewed-source-entrypoint.sh" >/dev/null 2>&1; then
	echo "entrypoint accepted a source whose manifest identity was modified" >&2
	exit 1
fi

echo "autonomy_reviewed_source_entrypoint_test=passed"
