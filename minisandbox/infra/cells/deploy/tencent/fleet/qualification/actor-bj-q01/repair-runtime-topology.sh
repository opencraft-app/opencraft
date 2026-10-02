#!/usr/bin/env bash
# Repair only the known healthy q01 2/1/0 runtime topology. After the exact
# quarantine, the existing targeted-repair controller exclusively owns surge,
# Host drain, UID-preconditioned Machine deletion, and contraction.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../../operations" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
cell_name=${RIVET_CELL_NAME:-actor-bj-q01}
machine_set=${RUNTIME_MACHINE_SET:-np-runtime0}
statefulset=${RUNTIME_STATEFULSET:-${cell_name}-runtime-hosts}
controller=${RUNTIME_CAPACITY_DEPLOYMENT:-${cell_name}-runtime-capacity}
timeout_seconds=${RUNTIME_TOPOLOGY_REPAIR_TIMEOUT_SECONDS:-2400}
receipt=${QUALIFICATION_RECEIPT:-/data/actor-qualification/runtime-topology-repair-$(date -u +%Y%m%dT%H%M%SZ).json}
temporary_root=${TMPDIR:-/data/tmp}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

[[ ${TOPOLOGY_REPAIR_EXECUTE:-false} == true ]] || {
	echo "set TOPOLOGY_REPAIR_EXECUTE=true for the explicit q01 topology repair" >&2
	exit 2
}
[[ $cell_name == actor-bj-q01 && $machine_set == np-runtime0 ]] || {
	echo "runtime topology repair is restricted to actor-bj-q01/np-runtime0" >&2
	exit 2
}
[[ $timeout_seconds =~ ^[1-9][0-9]*$ ]] || {
	echo "RUNTIME_TOPOLOGY_REPAIR_TIMEOUT_SECONDS must be positive" >&2
	exit 2
}
[[ $receipt == /* ]] || {
	echo "QUALIFICATION_RECEIPT must be absolute" >&2
	exit 2
}

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW=runtime.topology-repair \
	AUTONOMY_CONTROL_CELL="$cell_name" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY="${AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY:-1}" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
		"$operations_dir/assert-autonomy-control.sh"
fi

mkdir -p "$temporary_root" "$(dirname -- "$receipt")"
temporary=$(mktemp -d "$temporary_root/runtime-topology-repair.XXXXXX")
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
stage=preflight
passed=false

finish() {
	status=$?
	trap - EXIT INT TERM
	if [[ $passed != true ]]; then
		python3 - "$receipt" "$started_at" "$stage" "$cell_name" "$machine_set" <<'PY'
import hashlib
import json
import sys
from datetime import datetime, timezone

path, started, stage, cell, machine_set = sys.argv[1:]
payload = {
    "schema": "rivet-runtime-topology-repair/v1",
    "verdict": "failed",
    "started_at": started,
    "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "stage": stage,
    "cell": cell,
    "machine_set": machine_set,
}
canonical = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
payload["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
with open(path, "w", encoding="utf-8") as output:
    json.dump(payload, output, indent=2, sort_keys=True)
    output.write("\n")
PY
		echo "runtime topology repair failed at stage=$stage; receipt=$receipt" >&2
		if [[ $stage != preflight ]]; then
			echo "the exact Node remains controller-owned and fenced; do not restore it manually" >&2
		fi
	fi
	rm -rf -- "$temporary"
	exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

collect() {
	local prefix=$1
	kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o json >"$temporary/${prefix}-machineset.json"
	kubectl "${kubeconfig_args[@]}" get machines.node.tke.cloud.tencent.com \
		-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/${prefix}-machines.json"
	kubectl "${kubeconfig_args[@]}" get nodes \
		-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/${prefix}-nodes.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "$statefulset" -o json >"$temporary/${prefix}-statefulset.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
		-l "fleet.actor.dev/cell-name=${cell_name},fleet.actor.dev/component=workerd-host" -o json >"$temporary/${prefix}-pods.json"
}

cluster_uid=$(kubectl "${kubeconfig_args[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}')
[[ -n $cluster_uid ]] || { echo "Kubernetes cluster UID is empty" >&2; exit 1; }
collect baseline
kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "$controller" -o json >"$temporary/controller.json"
"$script_dir/runtime_topology_repair.py" plan \
	--machine-set "$temporary/baseline-machineset.json" \
	--machines "$temporary/baseline-machines.json" \
	--nodes "$temporary/baseline-nodes.json" \
	--statefulset "$temporary/baseline-statefulset.json" \
	--pods "$temporary/baseline-pods.json" \
	--controller "$temporary/controller.json" \
	--cell "$cell_name" >"$temporary/plan.json"
read -r machine_set_uid target_uid target_node target_node_uid < <(
	python3 - "$temporary/plan.json" <<'PY'
import json
import sys

plan = json.load(open(sys.argv[1]))
print(plan["machine_set_uid"], plan["target"]["uid"], plan["target"]["node"], plan["target"]["node_uid"])
PY
)

stage=quarantine
kubectl "${kubeconfig_args[@]}" get node "$target_node" -o json >"$temporary/target-node.json"
"$script_dir/runtime_topology_repair.py" patch \
	--node "$temporary/target-node.json" --machine-uid "$target_uid" >"$temporary/quarantine-patch.json"
kubectl "${kubeconfig_args[@]}" patch node "$target_node" --type=json \
	--patch-file "$temporary/quarantine-patch.json" >/dev/null

stage=converge
deadline=$((SECONDS + timeout_seconds))
while ((SECONDS < deadline)); do
	collect final
	if "$script_dir/runtime_topology_repair.py" finalize \
		--plan "$temporary/plan.json" \
		--machine-set "$temporary/final-machineset.json" \
		--machines "$temporary/final-machines.json" \
		--nodes "$temporary/final-nodes.json" \
		--statefulset "$temporary/final-statefulset.json" \
		--pods "$temporary/final-pods.json" \
		--cluster-uid "$cluster_uid" --started-at "$started_at" >"$temporary/candidate-receipt.json" 2>/dev/null
	then
		break
	fi
	sleep 5
done
((SECONDS < deadline)) || {
	echo "runtime topology repair did not converge before timeout" >&2
	exit 1
}

stage=receipt
install -m 0600 "$temporary/candidate-receipt.json" "$receipt"
"$script_dir/verify-runtime-topology-repair-receipt.py" \
	--cluster-uid "$cluster_uid" --machine-set-uid "$machine_set_uid" "$receipt"
passed=true
stage=complete
echo "runtime topology repaired to exact three-zone capacity: receipt=$receipt"
