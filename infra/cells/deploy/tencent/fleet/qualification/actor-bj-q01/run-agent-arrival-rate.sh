#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../../operations" && pwd)
cell=${CELL:-actor-bj-q01}
namespace=${CELL_NAMESPACE:-actor-fdb-cell-system}
machine_set=${RUNTIME_MACHINE_SET:-np-runtime0}
worker=${QUALIFICATION_WORKER:-${cell}-agent-arrival}
kubeconfig=${KUBECONFIG:-/var/lib/actor-build/credentials/${cell}.kubeconfig}
receipt_dir=${QUALIFICATION_RECEIPT_DIR:-/data/actor-qualification/receipts}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
receipt=${QUALIFICATION_RECEIPT:-$receipt_dir/${cell}-agent-arrival-${timestamp}.json}

[[ $receipt == /* ]] || {
	echo "QUALIFICATION_RECEIPT must be absolute" >&2
	exit 2
}
[[ -f $kubeconfig ]] || {
	echo "Cell kubeconfig does not exist: $kubeconfig" >&2
	exit 2
}

if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
fi

AUTONOMY_WORKFLOW=runtime.agent-arrival \
AUTONOMY_CONTROL_CELL=$cell \
AUTONOMY_CONTROL_NAMESPACE=$namespace \
AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=${AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY:-1} \
AUTONOMY_CONTROL_DECISIONS_DIR=${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions} \
	"$operations_dir/assert-autonomy-control.sh"

mkdir -p "$receipt_dir"
python3 "$script_dir/agent-arrival-rate.py" \
	--kubeconfig "$kubeconfig" \
	--receipt "$receipt" \
	--cell "$cell" \
	--namespace "$namespace" \
	--machine-set "$machine_set" \
	--worker "$worker" \
	"$@"

python3 - "$receipt" <<'PY'
import json
import sys

receipt = json.load(open(sys.argv[1]))
if receipt.get("schema") != "actor-cell-agent-arrival-rate/v1":
    raise SystemExit("unexpected Agent arrival receipt schema")
if receipt.get("verdict") != "pass":
    raise SystemExit("Agent arrival qualification did not pass")
if not isinstance(receipt.get("release_binding"), dict):
    raise SystemExit("Agent arrival receipt has no release binding")
hpa = receipt.get("hpa_contract", {})
if (
    hpa.get("average_value") != "16"
    or hpa.get("scale_up_tolerance_ceiling") != 0.1
    or hpa.get("hard_actors_per_host") != 32
):
    raise SystemExit("Agent arrival did not bind HPA target, tolerance ceiling, and hard Host capacity")
baseline = receipt.get("baseline", {})
if baseline.get("machine_set_spec_replicas") != 3:
    raise SystemExit("Agent arrival did not start from the qualified 3-Machine baseline")
if baseline.get("machine_set_qualification_hold"):
    raise SystemExit("Agent arrival ran while provider scale-down was held")
scale_down = receipt.get("scale_down", {})
receipts = scale_down.get("exact_provider_receipts", [])
peak = max(
    item.get("machine_set_spec_replicas", 0)
    for item in receipt.get("timeline", [])
)
expected = {(value, value - 1) for value in range(4, peak + 1)}
def valid_outcome(item):
    intent = item.get("intent", {})
    outcome = item.get("outcome")
    request_id = intent.get("request_id")
    return item.get("version") == 2 and (
        (outcome == "provider_acknowledged" and bool(request_id))
        or (
            outcome == "observed_exact_convergence_after_ambiguous_response"
            and not request_id
        )
    )

observed = {
    (item["intent"]["from_replicas"], item["intent"]["to_replicas"])
    for item in receipts
    if valid_outcome(item)
}
if expected != observed:
    raise SystemExit(
        f"Agent arrival has incomplete exact provider receipts: "
        f"expected={sorted(expected)} observed={sorted(observed)}"
    )
final = scale_down.get("baseline", {})
if (final.get("machine_set_spec_replicas"), final.get("machine_set_status_replicas")) != (3, 3):
    raise SystemExit("Agent arrival did not return the cloud MachineSet to 3/3")
if final.get("machine_set_downscale_intent"):
    raise SystemExit("Agent arrival left an exact scale-down intent behind")
print("agent_arrival_receipt_verified=true")
PY

CELL=$cell CELL_NAMESPACE=$namespace KUBECONFIG_PATH=$kubeconfig \
	"$operations_dir/cache-qualification-receipt.sh" "$receipt"

sha256sum "$receipt"
