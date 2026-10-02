#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../../operations" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell_name=$RIVET_CELL_NAME
machine_set=${RUNTIME_MACHINE_SET:-np-runtime0}
statefulset=${RUNTIME_STATEFULSET:-${cell_name}-runtime-hosts}
timeout_seconds=${RUNTIME_MACHINE_REPAIR_TIMEOUT_SECONDS:-1800}
receipt=${QUALIFICATION_RECEIPT:-/data/tmp/runtime-machine-repair-$(date -u +%Y%m%dT%H%M%SZ).json}
temporary_root=${TMPDIR:-/data/tmp}
mkdir -p "$temporary_root" "$(dirname -- "$receipt")"
temporary=$(mktemp -d "$temporary_root/runtime-machine-repair.XXXXXX")
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

[[ $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ && $machine_set == np-runtime0 ]] || {
	echo "runtime Machine repair qualification requires a production Cell and np-runtime0" >&2
	exit 2
}

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="runtime.machine-repair" \
	AUTONOMY_CONTROL_CELL="$cell_name" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
	"$operations_dir/assert-autonomy-control.sh"
fi
[[ $timeout_seconds =~ ^[1-9][0-9]*$ ]] || {
	echo "RUNTIME_MACHINE_REPAIR_TIMEOUT_SECONDS must be a positive integer" >&2
	exit 2
}

original_replicas=
surge_replicas=
surge_applied=false
target_name=
target_uid=
target_node=
target_node_uid=
target_admitted=false
target_fenced=false
hold_applied=false
qualification_id=$(openssl rand -hex 16)
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cluster_uid=$(kubectl "${kubeconfig_args[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}')
[[ -n $cluster_uid ]] || {
	echo "Kubernetes cluster identity is empty" >&2
	exit 1
}

restore_capacity() {
	if [[ $target_fenced == true && -n $target_node && -n $target_node_uid ]]; then
		if kubectl "${kubeconfig_args[@]}" get node "$target_node" -o json >"$temporary/restore-node.json" 2>/dev/null; then
			python3 - "$temporary/restore-node.json" "$target_node_uid" "$target_uid" >"$temporary/restore-node-patch.json" <<'PY'
import json
import sys

node = json.load(open(sys.argv[1]))
node_uid = sys.argv[2]
machine_uid = sys.argv[3]
if node["metadata"]["uid"] != node_uid:
    raise SystemExit(1)
operations = [
    {"op": "test", "path": "/metadata/uid", "value": node_uid},
    {"op": "test", "path": "/metadata/resourceVersion", "value": node["metadata"]["resourceVersion"]},
]
annotation = node["metadata"].get("annotations", {}).get("fleet.actor.dev/runtime-capacity-drain")
if annotation == machine_uid:
    operations.extend([
        {"op": "test", "path": "/metadata/annotations/fleet.actor.dev~1runtime-capacity-drain", "value": machine_uid},
        {"op": "remove", "path": "/metadata/annotations/fleet.actor.dev~1runtime-capacity-drain"},
    ])
for index, taint in enumerate(node.get("spec", {}).get("taints", [])):
    if taint == {"key": "fleet.actor.dev/runtime-capacity-drain", "value": machine_uid, "effect": "NoSchedule"}:
        operations.extend([
            {"op": "test", "path": f"/spec/taints/{index}", "value": taint},
            {"op": "remove", "path": f"/spec/taints/{index}"},
        ])
        break
json.dump(operations, sys.stdout)
PY
			kubectl "${kubeconfig_args[@]}" patch node "$target_node" --type=json \
				--patch-file "$temporary/restore-node-patch.json" >/dev/null 2>&1 || true
		fi
	fi
	if [[ $surge_applied == true && -n $original_replicas ]]; then
		local current_hosts current_nodes target
		current_hosts=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "$statefulset" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)
		current_nodes=$(kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)
		if [[ $current_hosts =~ ^[0-9]+$ && $current_nodes =~ ^[0-9]+$ ]]; then
			target=$original_replicas
			if ((current_hosts > target)); then
				target=$current_hosts
			fi
			if ((current_nodes == surge_replicas && target < current_nodes)); then
				kubectl "${kubeconfig_args[@]}" patch machineset.node.tke.cloud.tencent.com "$machine_set" \
					--type=json -p "[{\"op\":\"test\",\"path\":\"/spec/replicas\",\"value\":${current_nodes}},{\"op\":\"replace\",\"path\":\"/spec/replicas\",\"value\":${target}}]" >/dev/null || true
			fi
		fi
	fi
	if [[ $hold_applied == true ]]; then
		for _ in 1 2 3 4 5; do
			if kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o json >"$temporary/restore-machineset.json" 2>/dev/null && \
				python3 - "$temporary/restore-machineset.json" "$qualification_id" >"$temporary/release-hold-patch.json" <<'PY'
import json
import sys

machine_set = json.load(open(sys.argv[1]))
owner = sys.argv[2]
if machine_set["metadata"].get("annotations", {}).get("fleet.actor.dev/runtime-capacity-qualification-hold") != owner:
    raise SystemExit(1)
json.dump([
    {"op": "test", "path": "/metadata/uid", "value": machine_set["metadata"]["uid"]},
    {"op": "test", "path": "/metadata/resourceVersion", "value": machine_set["metadata"]["resourceVersion"]},
    {"op": "test", "path": "/metadata/annotations/fleet.actor.dev~1runtime-capacity-qualification-hold", "value": owner},
    {"op": "remove", "path": "/metadata/annotations/fleet.actor.dev~1runtime-capacity-qualification-hold"},
], sys.stdout)
PY
			then
				if kubectl "${kubeconfig_args[@]}" patch machineset.node.tke.cloud.tencent.com "$machine_set" --type=json \
					--patch-file "$temporary/release-hold-patch.json" >/dev/null 2>&1; then
					hold_applied=false
					break
				fi
			fi
		done
	fi
}

finish() {
	status=$?
	if ((status != 0)); then
		restore_capacity
		python3 - "$receipt" "$started_at" "$cell_name" "$machine_set" "$target_name" "$target_uid" "$target_node" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, started_at, cell, machine_set, target_name, target_uid, target_node = sys.argv[1:]
payload = {
    "schema": "rivet-runtime-machine-repair-qualification/v2",
    "verdict": "failed",
    "started_at": started_at,
    "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "cell": cell,
    "machine_set": machine_set,
    "target": {"name": target_name, "uid": target_uid, "node": target_node},
}
with open(path, "w", encoding="utf-8") as output:
    json.dump(payload, output, sort_keys=True, indent=2)
    output.write("\n")
PY
	fi
	rm -rf -- "$temporary"
	exit "$status"
}
trap finish EXIT

kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o json >"$temporary/baseline-machineset.json"
kubectl "${kubeconfig_args[@]}" get machines.node.tke.cloud.tencent.com \
	-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/baseline-machines.json"
kubectl "${kubeconfig_args[@]}" get nodes \
	-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/baseline-nodes.json"
kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "$statefulset" -o json >"$temporary/baseline-statefulset.json"

read -r original_replicas maximum_replicas machine_set_uid < <(
	python3 - "$temporary/baseline-machineset.json" "$temporary/baseline-machines.json" "$temporary/baseline-nodes.json" "$temporary/baseline-statefulset.json" "$cell_name" <<'PY'
import json
import sys

machine_set, machines, nodes, statefulset = (json.load(open(path)) for path in sys.argv[1:5])
cell = sys.argv[5]
spec = machine_set["spec"]
replicas = spec["replicas"]
maximum = spec["scaling"]["maxReplicas"]
if spec["template"]["spec"]["metadata"]["labels"].get("fleet.actor.dev/cell-name") != cell:
    raise SystemExit("MachineSet Cell identity mismatch")
if spec.get("deletePolicy") != "Newest":
    raise SystemExit("MachineSet repair requires deletePolicy=Newest")
if machine_set["metadata"].get("annotations", {}).get("fleet.actor.dev/runtime-capacity-qualification-hold"):
    raise SystemExit("MachineSet already has a runtime capacity qualification owner")
pending = {"key": "fleet.actor.dev/runtime-admission", "value": "pending", "effect": "NoSchedule"}
if pending not in spec["template"]["spec"].get("taints", []):
    raise SystemExit("MachineSet has no admission birth fence")
if statefulset["spec"]["replicas"] != replicas or statefulset["status"].get("readyReplicas", 0) != replicas:
    raise SystemExit("runtime StatefulSet is not at the exact steady baseline")
if replicas >= maximum:
    raise SystemExit("MachineSet has no one-Machine repair surge headroom")
if len(machines["items"]) != replicas or len(nodes["items"]) != replicas:
    raise SystemExit("Machine and Node inventory is not at the exact baseline")
machine_by_node = {
    item.get("status", {}).get("nodeRef", {}).get("name"): item["metadata"]["uid"]
    for item in machines["items"]
    if item.get("status", {}).get("nodeRef", {}).get("name")
}
for node in nodes["items"]:
    metadata = node["metadata"]
    conditions = {item["type"]: item["status"] for item in node.get("status", {}).get("conditions", [])}
    if conditions.get("Ready") != "True" or any(conditions.get(key) == "True" for key in ("DiskPressure", "MemoryPressure", "PIDPressure", "NetworkUnavailable")) or metadata.get("labels", {}).get("fleet.actor.dev/runtime-admitted") != "true":
        raise SystemExit(f"runtime Node is not usable: {metadata['name']}")
    if metadata.get("annotations", {}).get("fleet.actor.dev/runtime-capacity-drain"):
        raise SystemExit(f"runtime Node is draining: {metadata['name']}")
    if any(item.get("key") in {"fleet.actor.dev/runtime-admission", "fleet.actor.dev/runtime-capacity-drain"} for item in node.get("spec", {}).get("taints", [])):
        raise SystemExit(f"runtime Node retains a scheduling fence: {metadata['name']}")
    try:
        state = json.loads(metadata["annotations"]["fleet.actor.dev/runtime-admission-state"])
    except (KeyError, TypeError, json.JSONDecodeError):
        raise SystemExit(f"runtime Node lacks durable admission evidence: {metadata['name']}")
    identity = state.get("identity", {})
    if state.get("phase") != "Admitted" or identity.get("node_uid") != metadata["uid"] or identity.get("provider_id") != node["spec"].get("providerID") or identity.get("machine_uid") != machine_by_node.get(metadata["name"]) or identity.get("machine_set_uid") != machine_set["metadata"]["uid"]:
        raise SystemExit(f"runtime Node admission identity is stale: {metadata['name']}")
print(replicas, maximum, machine_set["metadata"]["uid"])
PY
)
surge_replicas=$((original_replicas + 1))

python3 - "$temporary/baseline-machineset.json" "$qualification_id" "$original_replicas" "$surge_replicas" >"$temporary/start-qualification-patch.json" <<'PY'
import json
import sys

machine_set = json.load(open(sys.argv[1]))
owner = sys.argv[2]
original = int(sys.argv[3])
surge = int(sys.argv[4])
operations = [
    {"op": "test", "path": "/metadata/uid", "value": machine_set["metadata"]["uid"]},
    {"op": "test", "path": "/metadata/resourceVersion", "value": machine_set["metadata"]["resourceVersion"]},
    {"op": "test", "path": "/spec/replicas", "value": original},
]
annotations = machine_set["metadata"].get("annotations", {})
if annotations:
    operations.append({"op": "add", "path": "/metadata/annotations/fleet.actor.dev~1runtime-capacity-qualification-hold", "value": owner})
else:
    operations.append({"op": "add", "path": "/metadata/annotations", "value": {"fleet.actor.dev/runtime-capacity-qualification-hold": owner}})
operations.append({"op": "replace", "path": "/spec/replicas", "value": surge})
json.dump(operations, sys.stdout)
PY
kubectl "${kubeconfig_args[@]}" patch machineset.node.tke.cloud.tencent.com "$machine_set" --type=json \
	--patch-file "$temporary/start-qualification-patch.json" >/dev/null
surge_applied=true
hold_applied=true

deadline=$((SECONDS + timeout_seconds))
while ((SECONDS < deadline)); do
	kubectl "${kubeconfig_args[@]}" get machines.node.tke.cloud.tencent.com \
		-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/surge-machines.json"
	if python3 - "$temporary/baseline-machines.json" "$temporary/surge-machines.json" >"$temporary/target" <<'PY'
import json
import sys

baseline = {item["metadata"]["uid"] for item in json.load(open(sys.argv[1]))["items"]}
new = [item for item in json.load(open(sys.argv[2]))["items"] if item["metadata"]["uid"] not in baseline]
if len(new) != 1:
    raise SystemExit(1)
node = new[0].get("status", {}).get("nodeRef", {}).get("name")
if not node:
    raise SystemExit(1)
print(new[0]["metadata"]["name"], new[0]["metadata"]["uid"], node)
PY
	then
		read -r target_name target_uid target_node <"$temporary/target"
		if kubectl "${kubeconfig_args[@]}" get node "$target_node" -o json | python3 -c '
import json, sys
node = json.load(sys.stdin)
conditions = {item["type"]: item["status"] for item in node.get("status", {}).get("conditions", [])}
assert conditions.get("Ready") == "True"
assert not any(conditions.get(key) == "True" for key in ("DiskPressure", "MemoryPressure", "PIDPressure", "NetworkUnavailable"))
assert node["metadata"].get("labels", {}).get("fleet.actor.dev/runtime-admitted") == "true"
assert not any(item.get("key") in {"fleet.actor.dev/runtime-admission", "fleet.actor.dev/runtime-capacity-drain"} for item in node.get("spec", {}).get("taints", []))
state = json.loads(node["metadata"]["annotations"]["fleet.actor.dev/runtime-admission-state"])
identity = state["identity"]
assert state["phase"] == "Admitted"
assert identity["node_uid"] == node["metadata"]["uid"]
assert identity["provider_id"] == node["spec"]["providerID"]
assert identity["machine_uid"] == sys.argv[1]
assert identity["machine_set_uid"] == sys.argv[2]
' "$target_uid" "$machine_set_uid"; then
			target_admitted=true
			break
		fi
	fi
	sleep 5
done
[[ $target_admitted == true && -n $target_uid && -n $target_node ]] || {
	echo "repair surge did not produce one exact admitted Machine" >&2
	exit 1
}
target_node_uid=$(kubectl "${kubeconfig_args[@]}" get node "$target_node" -o jsonpath='{.metadata.uid}')

kubectl "${kubeconfig_args[@]}" get node "$target_node" -o json >"$temporary/target-node.json"
python3 - "$temporary/target-node.json" "$target_uid" >"$temporary/fence-node-patch.json" <<'PY'
import json
import sys

node = json.load(open(sys.argv[1]))
uid = sys.argv[2]
if node["metadata"]["uid"] == "" or uid == "":
    raise SystemExit("repair target identity is incomplete")
operations = [
    {"op": "test", "path": "/metadata/uid", "value": node["metadata"]["uid"]},
    {"op": "test", "path": "/metadata/resourceVersion", "value": node["metadata"]["resourceVersion"]},
]
annotations = node["metadata"].get("annotations", {})
if "fleet.actor.dev/runtime-capacity-drain" in annotations:
    raise SystemExit("repair target already has a runtime capacity drain owner")
if annotations:
    operations.append({"op": "add", "path": "/metadata/annotations/fleet.actor.dev~1runtime-capacity-drain", "value": uid})
else:
    operations.append({"op": "add", "path": "/metadata/annotations", "value": {"fleet.actor.dev/runtime-capacity-drain": uid}})
taint = {"key": "fleet.actor.dev/runtime-capacity-drain", "value": uid, "effect": "NoSchedule"}
if node.get("spec", {}).get("taints") is None:
    operations.append({"op": "add", "path": "/spec/taints", "value": [taint]})
else:
    operations.append({"op": "add", "path": "/spec/taints/-", "value": taint})
json.dump(operations, sys.stdout)
PY
kubectl "${kubeconfig_args[@]}" patch node "$target_node" --type=json \
	--patch-file "$temporary/fence-node-patch.json" >/dev/null
target_fenced=true

kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "$statefulset" -o json | python3 -c '
import json, sys
statefulset = json.load(sys.stdin)
expected = int(sys.argv[1])
assert statefulset["spec"]["replicas"] == expected
assert statefulset["status"].get("readyReplicas", 0) == expected
' "$original_replicas"
kubectl "${kubeconfig_args[@]}" get pods -A --field-selector "spec.nodeName=${target_node}" -o json | python3 -c '
import json, sys
for pod in json.load(sys.stdin)["items"]:
    if pod.get("status", {}).get("phase") in {"Succeeded", "Failed"}:
        continue
    if pod.get("metadata", {}).get("annotations", {}).get("kubernetes.io/config.mirror"):
        continue
    if any(owner.get("kind") == "DaemonSet" and owner.get("controller") for owner in pod.get("metadata", {}).get("ownerReferences", [])):
        continue
    raise SystemExit(f"repair target owns workload Pod: {pod['metadata']['namespace']}/{pod['metadata']['name']}")
'

python3 - "$target_uid" >"$temporary/delete-options.json" <<'PY'
import json
import sys

json.dump({
    "apiVersion": "v1",
    "kind": "DeleteOptions",
    "propagationPolicy": "Foreground",
    "preconditions": {"uid": sys.argv[1]},
}, sys.stdout)
PY
kubectl "${kubeconfig_args[@]}" delete \
	--raw "/apis/node.tke.cloud.tencent.com/v1beta1/machines/${target_name}" \
	-f "$temporary/delete-options.json" >/dev/null

kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o json >"$temporary/pre-release-machineset.json"
python3 - "$temporary/pre-release-machineset.json" "$machine_set_uid" "$qualification_id" "$surge_replicas" "$original_replicas" >"$temporary/finish-qualification-patch.json" <<'PY'
import json
import sys

machine_set = json.load(open(sys.argv[1]))
uid, owner = sys.argv[2:4]
surge, original = map(int, sys.argv[4:6])
json.dump([
    {"op": "test", "path": "/metadata/uid", "value": uid},
    {"op": "test", "path": "/metadata/resourceVersion", "value": machine_set["metadata"]["resourceVersion"]},
    {"op": "test", "path": "/metadata/annotations/fleet.actor.dev~1runtime-capacity-qualification-hold", "value": owner},
    {"op": "test", "path": "/spec/replicas", "value": surge},
    {"op": "replace", "path": "/spec/replicas", "value": original},
    {"op": "remove", "path": "/metadata/annotations/fleet.actor.dev~1runtime-capacity-qualification-hold"},
], sys.stdout)
PY
kubectl "${kubeconfig_args[@]}" patch machineset.node.tke.cloud.tencent.com "$machine_set" --type=json \
	--patch-file "$temporary/finish-qualification-patch.json" >/dev/null
surge_applied=false
hold_applied=false

deadline=$((SECONDS + timeout_seconds))
while ((SECONDS < deadline)); do
	if ! kubectl "${kubeconfig_args[@]}" get machine.node.tke.cloud.tencent.com "$target_name" >/dev/null 2>&1; then
		kubectl "${kubeconfig_args[@]}" get machines.node.tke.cloud.tencent.com \
			-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/final-machines.json"
		kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o json >"$temporary/final-machineset.json"
		if python3 - "$temporary/baseline-machines.json" "$temporary/final-machines.json" "$temporary/final-machineset.json" "$original_replicas" <<'PY'
import json
import sys

baseline = {item["metadata"]["uid"] for item in json.load(open(sys.argv[1]))["items"]}
final = {item["metadata"]["uid"] for item in json.load(open(sys.argv[2]))["items"]}
machine_set = json.load(open(sys.argv[3]))
replicas = int(sys.argv[4])
assert final == baseline, (baseline, final)
assert machine_set["spec"]["replicas"] == replicas
assert machine_set.get("status", {}).get("readyReplicas", replicas) == replicas
assert not machine_set["metadata"].get("annotations", {}).get("fleet.actor.dev/runtime-capacity-qualification-hold")
PY
		then
			break
		fi
	fi
	sleep 5
done
((SECONDS < deadline)) || {
	echo "MachineSet did not return to the exact baseline after UID-targeted delete" >&2
	exit 1
}

python3 - "$receipt" "$started_at" "$cell_name" "$machine_set" "$machine_set_uid" "$cluster_uid" "$original_replicas" "$target_name" "$target_uid" "$target_node" "$temporary/baseline-machines.json" "$temporary/final-machines.json" <<'PY'
import hashlib
import json
import sys
from datetime import datetime, timezone

path, started_at, cell, machine_set, machine_set_uid, cluster_uid, replicas, target_name, target_uid, target_node, baseline_path, final_path = sys.argv[1:]
baseline = sorted(item["metadata"]["uid"] for item in json.load(open(baseline_path))["items"])
final = sorted(item["metadata"]["uid"] for item in json.load(open(final_path))["items"])
payload = {
    "schema": "rivet-runtime-machine-repair-qualification/v2",
    "verdict": "passed",
    "started_at": started_at,
    "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "cell": cell,
    "machine_set": machine_set,
    "machine_set_uid": machine_set_uid,
    "cluster_uid": cluster_uid,
    "delete_policy": "Newest",
    "baseline_replicas": int(replicas),
    "baseline_machine_uids": baseline,
    "target": {"name": target_name, "uid": target_uid, "node": target_node},
    "final_machine_uids": final,
    "exact_baseline_restored": baseline == final,
}
with open(path, "w", encoding="utf-8") as output:
    json.dump(payload, output, sort_keys=True, indent=2)
    output.write("\n")
print(hashlib.sha256(open(path, "rb").read()).hexdigest())
PY

"$script_dir/verify-runtime-machine-repair-receipt.py" \
	--expected-cell "$cell_name" --expected-machine-set "$machine_set" "$receipt"
echo "runtime Machine repair qualification passed: receipt=$receipt"
