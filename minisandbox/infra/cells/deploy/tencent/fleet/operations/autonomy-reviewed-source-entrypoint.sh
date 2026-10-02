#!/usr/bin/env bash
set -euo pipefail

# Resolve the atomically promoted source link exactly once.  Everything opened
# after this point uses the captured immutable physical tree, so a concurrent
# promotion can affect only the next audit invocation, never half of this one.
source_link=${AUTONOMY_REVIEWED_SOURCE_LINK:?AUTONOMY_REVIEWED_SOURCE_LINK must name the promoted source symlink}
[[ $source_link =~ ^/[A-Za-z0-9._/-]+$ && -L $source_link ]] || {
	echo "reviewed source link is not a safe absolute symlink: $source_link" >&2
	exit 2
}
source_root=$(readlink -e "$source_link")
[[ -n $source_root && -d $source_root ]] || {
	echo "reviewed source link has no complete target: $source_link" >&2
	exit 2
}

source_name=${source_root##*/}
[[ $source_name =~ ^[a-z0-9-]+-src-([0-9a-f]{40})-([0-9a-f]{64})$ ]] || {
	echo "reviewed source target has no immutable release identity: $source_root" >&2
	exit 2
}
expected_revision=${BASH_REMATCH[1]}
expected_manifest_sha=${BASH_REMATCH[2]}
revision_file=$source_root/.actor-source/SOURCE_REVISION
manifest=$source_root/.actor-source/RELEASE_SHA256SUMS
[[ -f $revision_file && -s $manifest ]] || {
	echo "reviewed source metadata is incomplete: $source_root" >&2
	exit 2
}
revision=$(tr -d '[:space:]' <"$revision_file")
manifest_sha=$(sha256sum "$manifest" | cut -d' ' -f1)
[[ $revision == "$expected_revision" && $manifest_sha == "$expected_manifest_sha" ]] || {
	echo "reviewed source target identity does not match its metadata" >&2
	exit 2
}

# The service runs as root in production.  Requiring the link parent and target
# to be owned by the executing identity and not group/world writable prevents a
# less privileged process from redirecting the governance entrypoint.
effective_uid=$(id -u)
for protected_path in "$(dirname -- "$source_link")" "$source_root"; do
	read -r owner mode < <(stat -c '%u %a' "$protected_path")
	[[ $owner == "$effective_uid" ]] || {
		echo "reviewed source path is owned by uid $owner, expected $effective_uid: $protected_path" >&2
		exit 2
	}
	# Interpret the final two octal digits independently; neither group nor
	# other may mutate the link directory or immutable source root.
	group_digit=$(( (10#$mode / 10) % 10 ))
	other_digit=$(( 10#$mode % 10 ))
	(( (group_digit & 2) == 0 && (other_digit & 2) == 0 )) || {
		echo "reviewed source path is group/world writable: $protected_path" >&2
		exit 2
	}
done

operations_dir=$source_root/infra/cells/deploy/tencent/fleet/operations
policy=$operations_dir/autonomy-policy.json
[[ -x $operations_dir/run-autonomy-governance.sh && -f $operations_dir/autonomy_audit.py ]] || {
	echo "promoted source has no complete autonomy operations tree" >&2
	exit 2
}
[[ -f $operations_dir/../runtime/verify_bottomless_receipt.py && -f $policy ]] || {
	echo "promoted source has no colocated policy or Bottomless verifier" >&2
	exit 2
}

# Serialize the complete audit and optional qualification publication with
# runtime release, rollback, repair, and the other Cell mutation workflows.
# Sampling half-updated Engine/Host templates would otherwise create a false
# block receipt in the middle of a healthy rollout.
if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	lock_path=${AUTONOMY_CONTROL_LOCK_PATH:-/data/tmp/actor-autonomy-operations.lock}
	mkdir -p "$(dirname -- "$lock_path")"
	command -v flock >/dev/null 2>&1 || {
		echo "autonomy operation lock requires flock" >&2
		exit 2
	}
	exec 9>"$lock_path"
	if ! flock -n 9; then
		echo "autonomy audit skipped: another Cell operation owns the lock" >&2
		exit 1
	fi
	export AUTONOMY_OPERATION_LOCK_HELD=1 AUTONOMY_CONTROL_REQUIRE_LOCK=0
fi

# The operator filesystem is a rebuildable cache, not the qualification
# evidence owner. Restore the immutable cluster-side availability copies before
# every audit so replacing the operator node cannot silently erase the gates.
"$operations_dir/hydrate-qualification-receipts.sh"

export AUTONOMY_SOURCE_REVISION=$revision
export AUTONOMY_SOURCE_MANIFEST_SHA256=$manifest_sha
export AUTONOMY_SOURCE_TARGET=$source_root
marker=$(mktemp /data/tmp/autonomy-audit-control.XXXXXX)
cleanup() { rm -f -- "$marker"; }
trap cleanup EXIT INT TERM
set +e
"$operations_dir/run-autonomy-governance.sh" \
	--receipt-dir "$AUTONOMY_AUDIT_RECEIPT_DIR" \
	--policy "$policy" \
	--output-dir "$AUTONOMY_CONTROL_OUTPUT_DIR"
governance_status=$?
set -e

if ((governance_status == 0)) && [[ ${AUTONOMY_AUTO_PUBLISH_QUALIFICATION:-0} == 1 ]]; then
	mapfile -t controls < <(find "$AUTONOMY_CONTROL_OUTPUT_DIR" -maxdepth 1 -type f \
		-name "autonomy-control-${CELL}-*.json" -newer "$marker" -print)
	((${#controls[@]} == 1)) || {
		echo "automatic qualification requires exactly one fresh control receipt" >&2
		exit 70
	}
	control=${controls[0]}
	kubectl=${KUBECTL:-kubectl}
	cell_json=$($kubectl --kubeconfig "$KUBECONFIG_PATH" -n "$CELL_NAMESPACE" \
		get rivetcell "$CELL" -o json)
	ready=$(jq -r '.status.readyForPlacement // false' <<<"$cell_json")
	phase=$(jq -er '.status.phase' <<<"$cell_json")
	if [[ $ready != true ]]; then
		case "$phase" in
		Provisioning | Qualifying)
			if ! CELL="$CELL" CELL_NAMESPACE="$CELL_NAMESPACE" \
				KUBECONFIG_PATH="$KUBECONFIG_PATH" \
				AUTONOMY_OPERATION_LOCK_HELD=1 \
				"$operations_dir/publish-qualified-release.sh" "$control"; then
				echo "automatic qualification publication failed" >&2
				exit 70
			fi
			;;
		*)
			echo "automatic qualification refused unexpected Cell phase: $phase" >&2
			exit 70
			;;
		esac
	fi
fi

exit "$governance_status"
