#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
operations_dir=$fleet_root/operations
runtime_dir=$fleet_root/runtime
cell=actor-bj-q01
namespace=actor-fdb-cell-system
kubeconfig=${KUBECONFIG:-/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig}
receipt_dir=${QUALIFICATION_RECEIPT_DIR:-/data/actor-qualification/receipts}
run_id=${ENGINE_HA_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(tr -d - </proc/sys/kernel/random/uuid | cut -c1-8)}
receipt=${ENGINE_HA_RECEIPT:-$receipt_dir/${cell}-engine-ha-${run_id}.json}

[[ -f $kubeconfig ]] || {
	echo "q01 kubeconfig does not exist: $kubeconfig" >&2
	exit 2
}
[[ $receipt == /* && ! -e $receipt ]] || {
	echo "ENGINE_HA_RECEIPT must be a new absolute path: $receipt" >&2
	exit 2
}

if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
fi

mkdir -p "$receipt_dir"
KUBECONFIG=$kubeconfig \
RIVET_CELL_NAME=$cell \
RIVET_CELL_NAMESPACE=$namespace \
ENGINE_HA_RECEIPT=$receipt \
RUN_ID=$run_id \
AUTONOMY_OPERATION_LOCK_HELD=1 \
AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=${AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY:-1} \
	"$runtime_dir/qualify-engine-ha.sh" "$@"

CELL=$cell CELL_NAMESPACE=$namespace KUBECONFIG_PATH=$kubeconfig \
	"$operations_dir/cache-qualification-receipt.sh" "$receipt"

sha256sum "$receipt"
