#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
workflow=$script_dir/run-initial-cell-qualification.sh
[[ -x $workflow ]]
hold_helper=$script_dir/../runtime/with-runtime-scale-in-hold.sh
[[ -x $hold_helper ]]
for guard in \
	'INITIAL_QUALIFICATION_EXECUTE must be true' \
	'actor-cell-argo-convergence/v1' \
	'Argo convergence receipt is not from production Cell registration' \
	'INITIAL_RUNTIME_RELEASE_RECEIPT is required' \
	'initial qualification reviewed-source identity is malformed or not physically materialized' \
	'initial runtime release receipt belongs to another Cell' \
	'Argo convergence and initial runtime release use different image inventories' \
	'initial runtime release is outside the Argo-bound image inventory' \
	'RELEASE_RECEIPTS_DIR=$(dirname -- "$INITIAL_RUNTIME_RELEASE_RECEIPT")' \
	'AUTONOMY_QUALIFICATION_MODE=initial-cell' \
	'AUTONOMY_CONTROL_FILE=${preflight_controls[0]}' \
	'QUALIFICATION_PROFILE=production-cell' \
	'ENGINE_HA_DYNAMIC_RUNTIME_CAPACITY=true' \
	'qualify-engine-ha.sh' \
	'actor-cell-initial-qualification/v2' \
	'final audit did not select the exact current-run' \
	'operator_activation_required":True'; do
	grep -Fq "$guard" "$workflow" || {
		echo "initial Cell qualification workflow lost gate: $guard" >&2
		exit 1
	}
done
for qualifier in "$script_dir/../runtime/qualify-runtime.sh" "$script_dir/../runtime/qualify-engine-ha.sh"; do
	grep -Fq 'exec "$script_dir/with-runtime-scale-in-hold.sh" "$0" "$@"' "$qualifier" || {
		echo "production qualification lost the scale-in hold: $qualifier" >&2
		exit 1
	}
done
if grep -Eq 'physical-restore|DR_EXECUTE|dr_receipt' "$workflow"; then
	echo "initial Cell qualification must not execute or require physical restore" >&2
	exit 1
fi
if grep -Eq '^[[:space:]]*"?\$operations_dir/publish-qualified-release\.sh' "$workflow"; then
	echo "initial Cell qualification must not cross the operator activation boundary" >&2
	exit 1
fi
echo "initial Cell qualification workflow contract: pass"
