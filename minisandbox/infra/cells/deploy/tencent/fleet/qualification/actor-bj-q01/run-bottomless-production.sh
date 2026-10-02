#!/usr/bin/env bash
# Run the release-bound q01 Bottomless gate from one reviewed source tree.
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
runtime_dir=$fleet_root/runtime
operations_dir=$fleet_root/operations
cell=actor-bj-q01
namespace=actor-fdb-cell-system
kubeconfig=${KUBECONFIG:-/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig}
receipt_dir=${QUALIFICATION_RECEIPT_DIR:-/data/actor-qualification/receipts}
run_id=${BOTTOMLESS_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(tr -d - </proc/sys/kernel/random/uuid | cut -c1-8)}
receipt=${QUALIFICATION_RECEIPT:-$receipt_dir/${cell}-bottomless-production-${run_id}.json}

[[ $run_id =~ ^[0-9A-Za-z-]+$ && ${#run_id} -le 64 ]] || {
	echo "BOTTOMLESS_RUN_ID is not a bounded receipt identity" >&2
	exit 2
}
[[ -f $kubeconfig ]] || {
	echo "q01 kubeconfig does not exist: $kubeconfig" >&2
	exit 2
}
[[ $receipt =~ ^/data/[A-Za-z0-9._/-]+\.json$ && $receipt != *'/../'* && ! -e $receipt ]] || {
	echo "QUALIFICATION_RECEIPT must be a new bounded absolute /data JSON path" >&2
	exit 2
}

mkdir -p /data/tmp "$receipt_dir"

set +e
KUBECONFIG=$kubeconfig \
RIVET_CELL_NAME=$cell \
RIVET_CELL_NAMESPACE=$namespace \
QUALIFICATION_PROFILE=production-cell \
QUALIFICATION_RECEIPT=$receipt \
AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=${AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY:-1} \
	"$runtime_dir/qualify-runtime.sh"
qualification_status=$?
set -e

[[ -s $receipt ]] || {
	echo "Bottomless qualification produced no terminal receipt" >&2
	((qualification_status != 0)) && exit "$qualification_status"
	exit 70
}

# Preserve failed receipts as well as successful ones. The cache is an
# availability copy; persist-receipt-from-builder.sh independently archives
# the exact file to the immutable COS evidence bucket.
CELL=$cell CELL_NAMESPACE=$namespace KUBECONFIG_PATH=$kubeconfig \
	"$operations_dir/cache-qualification-receipt.sh" "$receipt"

if ((qualification_status == 0)); then
	python3 "$runtime_dir/verify_bottomless_receipt.py" \
		--profile production-cell "$receipt" >/dev/null
fi

printf 'bottomless_receipt=%s\n' "$receipt"
sha256sum "$receipt"
exit "$qualification_status"
