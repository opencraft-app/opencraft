#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../../operations" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell_name=$RIVET_CELL_NAME
machine_set=${RUNTIME_MACHINE_SET:-np-runtime0}
statefulset=${RUNTIME_STATEFULSET:-${cell_name}-runtime-hosts}
provider_receipt=${RUNTIME_MACHINE_REPAIR_QUALIFICATION_RECEIPT:?provider qualification receipt is required}
timeout_seconds=${RUNTIME_AUTOMATIC_REPAIR_TIMEOUT_SECONDS:-2400}
receipt=${QUALIFICATION_RECEIPT:-/data/tmp/runtime-automatic-repair-$(date -u +%Y%m%dT%H%M%SZ).json}
canonical_receipts_dir=${RUNTIME_MACHINE_REPAIR_CANONICAL_RECEIPTS_DIR:-/data/actor-qualification/receipts}
canonical_provider_receipt=$canonical_receipts_dir/${cell_name}-runtime-machine-repair-current.json
canonical_automatic_receipt=$canonical_receipts_dir/${cell_name}-runtime-automatic-repair-current.json
temporary_root=${TMPDIR:-/data/tmp}
mkdir -p "$temporary_root" "$(dirname -- "$receipt")"
temporary=$(mktemp -d "$temporary_root/runtime-automatic-repair.XXXXXX")
provider_publish=
automatic_publish=
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

[[ $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ && $machine_set == np-runtime0 ]] || {
	echo "automatic repair qualification requires a production Cell and np-runtime0" >&2
	exit 2
}
[[ $provider_receipt == /* && -f $provider_receipt ]] || {
	echo "provider qualification receipt must be an existing absolute path" >&2
	exit 2
}
[[ $canonical_receipts_dir == /* ]] || {
	echo "canonical runtime Machine repair receipt directory must be absolute" >&2
	exit 2
}
[[ $timeout_seconds =~ ^[1-9][0-9]*$ ]] || {
	echo "RUNTIME_AUTOMATIC_REPAIR_TIMEOUT_SECONDS must be positive" >&2
	exit 2
}

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="runtime.automatic-machine-repair" \
	AUTONOMY_CONTROL_CELL="$cell_name" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
		"$operations_dir/assert-autonomy-control.sh"
fi

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
provider_receipt_sha=$(sha256sum "$provider_receipt" | cut -d' ' -f1)
enabled=false
injected=false
passed=false
target_name=
target_uid=
target_node=
target_node_uid=
machine_set_uid=
cluster_uid=
baseline_replicas=0

restore_failed_target() {
	[[ $injected == true && -n $target_node && -n $target_node_uid && -n $target_uid ]] || return 0
	if ! kubectl "${kubeconfig_args[@]}" get node "$target_node" -o json >"$temporary/cleanup-node.json" 2>/dev/null; then
		return 0
	fi
	if ! python3 - "$temporary/cleanup-node.json" "$target_node_uid" "$target_uid" >"$temporary/cleanup-node-patch.json" <<'PY'
import json
import sys
from datetime import datetime, timezone

node = json.load(open(sys.argv[1]))
node_uid, machine_uid = sys.argv[2:]
metadata = node["metadata"]
if metadata["uid"] != node_uid:
    raise SystemExit("cleanup target Node UID changed")
raw = metadata.get("annotations", {}).get("fleet.actor.dev/runtime-admission-state")
if not raw:
    raise SystemExit("cleanup target has no admission identity")
state = json.loads(raw)
identity = state.get("identity", {})
if identity.get("node_uid") != node_uid or identity.get("machine_uid") != machine_uid:
    raise SystemExit("cleanup target admission identity changed")
state["phase"] = "Admitted"
state["transition_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
state["reason"] = "automatic replacement qualification failed; exact target restored"
operations = [
    {"op": "test", "path": "/metadata/uid", "value": node_uid},
    {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
    {"op": "test", "path": "/metadata/annotations/fleet.actor.dev~1runtime-admission-state", "value": raw},
    {"op": "replace", "path": "/metadata/annotations/fleet.actor.dev~1runtime-admission-state", "value": json.dumps(state, separators=(",", ":"), sort_keys=True)},
]
labels = metadata.get("labels", {})
phase_path = "/metadata/labels/fleet.actor.dev~1runtime-admission-phase"
if "fleet.actor.dev/runtime-admission-phase" in labels:
    operations.append({"op": "replace", "path": phase_path, "value": "admitted"})
else:
    operations.append({"op": "add", "path": phase_path, "value": "admitted"})
admitted_path = "/metadata/labels/fleet.actor.dev~1runtime-admitted"
if "fleet.actor.dev/runtime-admitted" in labels:
    operations.append({"op": "replace", "path": admitted_path, "value": "true"})
else:
    operations.append({"op": "add", "path": admitted_path, "value": "true"})
if "fleet.actor.dev/runtime-capacity-drain" in metadata.get("annotations", {}):
    operations.append({"op": "remove", "path": "/metadata/annotations/fleet.actor.dev~1runtime-capacity-drain"})
for index in reversed(range(len(node.get("spec", {}).get("taints", [])))):
    if node["spec"]["taints"][index].get("key") in {
        "fleet.actor.dev/runtime-admission", "fleet.actor.dev/runtime-capacity-drain"
    }:
        operations.append({"op": "remove", "path": "/spec/taints/%d" % index})
json.dump(operations, sys.stdout)
PY
	then
		return 1
	fi
	kubectl "${kubeconfig_args[@]}" patch node "$target_node" --type=json \
		--patch-file "$temporary/cleanup-node-patch.json" >/dev/null
}

contract_failed_surge() {
	((baseline_replicas > 0)) || return 0
	local current_hosts current_nodes
	current_hosts=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "$statefulset" \
		-o jsonpath='{.spec.replicas}' 2>/dev/null || true)
	if [[ $current_hosts =~ ^[0-9]+$ ]] && ((current_hosts == baseline_replicas + 1)); then
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "$statefulset" \
			-o json >"$temporary/cleanup-statefulset.json" || return 1
		python3 - "$temporary/cleanup-statefulset.json" "$current_hosts" "$baseline_replicas" \
			>"$temporary/cleanup-statefulset-patch.json" <<'PY'
import json
import sys

statefulset = json.load(open(sys.argv[1]))
current, baseline = (int(value) for value in sys.argv[2:])
if statefulset["spec"]["replicas"] != current:
    raise SystemExit("runtime StatefulSet replica count changed during cleanup")
json.dump([
    {"op": "test", "path": "/metadata/uid", "value": statefulset["metadata"]["uid"]},
    {"op": "test", "path": "/metadata/resourceVersion", "value": statefulset["metadata"]["resourceVersion"]},
    {"op": "test", "path": "/spec/replicas", "value": current},
    {"op": "replace", "path": "/spec/replicas", "value": baseline},
], sys.stdout)
PY
		kubectl "${kubeconfig_args[@]}" -n "$namespace" patch statefulset "$statefulset" --type=json \
			--patch-file "$temporary/cleanup-statefulset-patch.json" >/dev/null || return 1
		kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status statefulset/"$statefulset" \
			--timeout=5m >/dev/null || return 1
	fi
	current_nodes=$(kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" \
		-o jsonpath='{.spec.replicas}' 2>/dev/null || true)
	if [[ $current_nodes =~ ^[0-9]+$ ]] && ((current_nodes == baseline_replicas + 1)); then
		kubectl "${kubeconfig_args[@]}" patch machineset.node.tke.cloud.tencent.com "$machine_set" \
			--type=json -p "[{\"op\":\"test\",\"path\":\"/spec/replicas\",\"value\":${current_nodes}},{\"op\":\"replace\",\"path\":\"/spec/replicas\",\"value\":${baseline_replicas}}]" >/dev/null
	fi
}

finish() {
	status=$?
	set +e
	if [[ $passed != true ]]; then
		restore_failed_target
		if [[ $enabled == true ]]; then
			AUTONOMY_OPERATION_LOCK_HELD=1 "$script_dir/configure-runtime-machine-repair.sh" disable >/dev/null 2>&1 || true
		fi
		contract_failed_surge
		python3 - "$receipt" "$started_at" "$cell_name" "$machine_set" "$cluster_uid" "$machine_set_uid" \
			"$target_name" "$target_uid" "$target_node" "$provider_receipt_sha" "$injected" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, started, cell, machine_set, cluster_uid, machine_set_uid, target_name, target_uid, target_node, provider_sha, injected = sys.argv[1:]
payload = {
    "schema": "rivet-runtime-automatic-repair-qualification/v1",
    "verdict": "failed",
    "started_at": started,
    "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "cell": cell,
    "machine_set": machine_set,
    "cluster_uid": cluster_uid,
    "machine_set_uid": machine_set_uid,
    "provider_receipt_sha256": provider_sha,
    "fault_injected": injected == "true",
    "target": {"name": target_name, "uid": target_uid, "node": target_node},
}
with open(path, "w", encoding="utf-8") as output:
    json.dump(payload, output, indent=2, sort_keys=True)
    output.write("\n")
PY
	fi
	[[ -z $provider_publish ]] || rm -f -- "$provider_publish"
	[[ -z $automatic_publish ]] || rm -f -- "$automatic_publish"
	rm -rf -- "$temporary"
	exit "$status"
}
trap finish EXIT

cluster_uid=$(kubectl "${kubeconfig_args[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}')
kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o json >"$temporary/machineset.json"
machine_set_uid=$(python3 - "$temporary/machineset.json" <<'PY'
import json
import sys

uid = json.load(open(sys.argv[1]))["metadata"].get("uid")
if not uid:
    raise SystemExit("MachineSet UID is empty")
print(uid)
PY
)
"$script_dir/verify-runtime-machine-repair-receipt.py" \
	--expected-cell "$cell_name" --expected-machine-set "$machine_set" \
	--cluster-uid "$cluster_uid" --machine-set-uid "$machine_set_uid" "$provider_receipt"

kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "$statefulset" -o json >"$temporary/statefulset.json"
kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
	-l "fleet.actor.dev/cell-name=${cell_name},fleet.actor.dev/component=workerd-host" -o json >"$temporary/pods.json"
kubectl "${kubeconfig_args[@]}" get nodes \
	-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/nodes.json"
kubectl "${kubeconfig_args[@]}" get machines.node.tke.cloud.tencent.com \
	-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/machines.json"
read -r baseline_replicas target_name target_uid target_node target_node_uid target_zone baseline_zones < <(
	python3 - "$temporary/statefulset.json" "$temporary/pods.json" "$temporary/nodes.json" \
		"$temporary/machines.json" "$temporary/machineset.json" <<'PY'
import json
import sys

statefulset, pods, nodes, machines, machine_set = (json.load(open(path)) for path in sys.argv[1:])
replicas = machine_set["spec"]["replicas"]
if machine_set["spec"].get("deletePolicy") != "Newest":
    raise SystemExit("MachineSet deletePolicy is not Newest")
if machine_set.get("status", {}).get("replicas", replicas) != replicas:
    raise SystemExit("MachineSet is not at steady capacity")
if statefulset["spec"]["replicas"] != replicas or statefulset.get("status", {}).get("readyReplicas", 0) != replicas:
    raise SystemExit("runtime StatefulSet is not at exact steady capacity")
live_pods = [item for item in pods["items"] if not item["metadata"].get("deletionTimestamp")]
ready_pods = [item for item in live_pods if item.get("status", {}).get("phase") == "Running" and any(
    condition.get("type") == "Ready" and condition.get("status") == "True"
    for condition in item.get("status", {}).get("conditions", [])
)]
if len(live_pods) != replicas or len(ready_pods) != replicas:
    raise SystemExit("runtime Host inventory is not exactly Ready")
node_by_name = {item["metadata"]["name"]: item for item in nodes["items"]}
machine_by_node = {
    item.get("status", {}).get("nodeRef", {}).get("name"): item
    for item in machines["items"]
    if item.get("status", {}).get("nodeRef", {}).get("name")
}
if len(machines["items"]) != replicas or len(machine_by_node) != replicas or len(node_by_name) != replicas:
    raise SystemExit("Machine inventory is not exact")
for pod in ready_pods:
    node_name = pod["spec"].get("nodeName")
    node = node_by_name.get(node_name)
    machine = machine_by_node.get(node_name)
    if node is None or machine is None or node["metadata"].get("labels", {}).get("fleet.actor.dev/runtime-admitted") != "true":
        raise SystemExit("runtime Host is not on exact admitted capacity")
    conditions = {item["type"]: item["status"] for item in node.get("status", {}).get("conditions", [])}
    if conditions.get("Ready") != "True" or any(
        conditions.get(key) == "True"
        for key in ("DiskPressure", "MemoryPressure", "PIDPressure", "NetworkUnavailable")
    ):
        raise SystemExit("runtime Host Node is not locally healthy")
    taint_keys = {item.get("key") for item in node.get("spec", {}).get("taints", [])}
    metadata = node["metadata"]
    if metadata.get("annotations", {}).get("fleet.actor.dev/runtime-capacity-drain") or taint_keys.intersection({
        "fleet.actor.dev/runtime-admission", "fleet.actor.dev/runtime-capacity-drain"
    }):
        raise SystemExit("runtime Host Node retains a scheduling fence")
    state = json.loads(node["metadata"]["annotations"]["fleet.actor.dev/runtime-admission-state"])
    if state.get("phase") != "Admitted" or state["identity"].get("node_uid") != node["metadata"]["uid"] or state["identity"].get("machine_uid") != machine["metadata"]["uid"]:
        raise SystemExit("runtime admission identity is stale")
zones = sorted(node["metadata"].get("labels", {}).get("topology.kubernetes.io/zone", "") for node in node_by_name.values())
if replicas != 3 or len(zones) != 3 or len(set(zones)) != 3 or any(not zone for zone in zones):
    raise SystemExit("runtime automatic replacement requires an exact three-zone baseline")
target_pod = sorted(ready_pods, key=lambda item: item["metadata"]["name"])[-1]
target_node = node_by_name[target_pod["spec"]["nodeName"]]
target_machine = machine_by_node[target_node["metadata"]["name"]]
target_zone = target_node["metadata"]["labels"]["topology.kubernetes.io/zone"]
print(replicas, target_machine["metadata"]["name"], target_machine["metadata"]["uid"], target_node["metadata"]["name"], target_node["metadata"]["uid"], target_zone, ",".join(zones))
PY
)
python3 - "$temporary/machines.json" >"$temporary/baseline-uids" <<'PY'
import json
import sys

for uid in sorted(item["metadata"]["uid"] for item in json.load(open(sys.argv[1]))["items"]):
    print(uid)
PY

AUTONOMY_OPERATION_LOCK_HELD=1 "$script_dir/configure-runtime-machine-repair.sh" enable "$provider_receipt"
enabled=true

kubectl "${kubeconfig_args[@]}" get node "$target_node" -o json >"$temporary/target-node.json"
python3 - "$temporary/target-node.json" "$target_uid" >"$temporary/quarantine-patch.json" <<'PY'
import json
import sys
from datetime import datetime, timezone

node = json.load(open(sys.argv[1]))
machine_uid = sys.argv[2]
metadata = node["metadata"]
state_raw = metadata["annotations"]["fleet.actor.dev/runtime-admission-state"]
state = json.loads(state_raw)
if state.get("phase") != "Admitted" or state["identity"].get("node_uid") != metadata["uid"] or state["identity"].get("machine_uid") != machine_uid:
    raise SystemExit("repair target lost its admitted identity")
state["phase"] = "Quarantined"
state["transition_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
state["reason"] = "runtime automatic replacement qualification"
encoded = json.dumps(state, separators=(",", ":"), sort_keys=True)
operations = [
    {"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
    {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
    {"op": "test", "path": "/metadata/annotations/fleet.actor.dev~1runtime-admission-state", "value": state_raw},
    {"op": "test", "path": "/metadata/labels/fleet.actor.dev~1runtime-admitted", "value": "true"},
    {"op": "replace", "path": "/metadata/annotations/fleet.actor.dev~1runtime-admission-state", "value": encoded},
    {"op": "replace", "path": "/metadata/labels/fleet.actor.dev~1runtime-admission-phase", "value": "quarantined"},
    {"op": "remove", "path": "/metadata/labels/fleet.actor.dev~1runtime-admitted"},
]
taint = {"key": "fleet.actor.dev/runtime-admission", "value": "pending", "effect": "NoSchedule"}
if node.get("spec", {}).get("taints") is None:
    operations.append({"op": "add", "path": "/spec/taints", "value": [taint]})
else:
    operations.append({"op": "add", "path": "/spec/taints/-", "value": taint})
json.dump(operations, sys.stdout)
PY
kubectl "${kubeconfig_args[@]}" patch node "$target_node" --type=json \
	--patch-file "$temporary/quarantine-patch.json" >/dev/null
injected=true

deadline=$((SECONDS + timeout_seconds))
while ((SECONDS < deadline)); do
	kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o json >"$temporary/final-machineset.json"
	kubectl "${kubeconfig_args[@]}" get machines.node.tke.cloud.tencent.com \
		-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/final-machines.json"
	kubectl "${kubeconfig_args[@]}" get nodes \
		-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/final-nodes.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "$statefulset" -o json >"$temporary/final-statefulset.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
		-l "fleet.actor.dev/cell-name=${cell_name},fleet.actor.dev/component=workerd-host" -o json >"$temporary/final-pods.json"
	if python3 - "$baseline_replicas" "$target_uid" "$target_node_uid" "$temporary/baseline-uids" \
		"$temporary/final-machineset.json" "$temporary/final-machines.json" "$temporary/final-nodes.json" \
		"$temporary/final-statefulset.json" "$temporary/final-pods.json" >"$temporary/replacement" <<'PY'
import json
import sys

replicas = int(sys.argv[1])
target_uid, target_node_uid, baseline_path = sys.argv[2:5]
machine_set, machines, nodes, statefulset, pods = (json.load(open(path)) for path in sys.argv[5:])
if machine_set["spec"]["replicas"] != replicas or machine_set.get("status", {}).get("replicas", replicas) != replicas:
    raise SystemExit(1)
if statefulset["spec"]["replicas"] != replicas or statefulset.get("status", {}).get("readyReplicas", 0) != replicas:
    raise SystemExit(1)
baseline = {line.strip() for line in open(baseline_path) if line.strip()}
final = {item["metadata"]["uid"] for item in machines["items"]}
replacement = final - baseline
if len(final) != replicas or target_uid in final or len(replacement) != 1 or len(baseline - final) != 1:
    raise SystemExit(1)
if len(nodes["items"]) != replicas or any(item["metadata"]["uid"] == target_node_uid for item in nodes["items"]):
    raise SystemExit(1)
node_by_name = {item["metadata"]["name"]: item for item in nodes["items"]}
machine_by_node = {item.get("status", {}).get("nodeRef", {}).get("name"): item for item in machines["items"]}
live = [item for item in pods["items"] if not item["metadata"].get("deletionTimestamp")]
if len(live) != replicas:
    raise SystemExit(1)
for pod in live:
    if pod.get("status", {}).get("phase") != "Running" or not any(c.get("type") == "Ready" and c.get("status") == "True" for c in pod.get("status", {}).get("conditions", [])):
        raise SystemExit(1)
    node = node_by_name.get(pod["spec"].get("nodeName"))
    machine = machine_by_node.get(pod["spec"].get("nodeName"))
    if node is None or machine is None or node["metadata"].get("labels", {}).get("fleet.actor.dev/runtime-admitted") != "true":
        raise SystemExit(1)
zones = sorted(node["metadata"].get("labels", {}).get("topology.kubernetes.io/zone", "") for node in nodes["items"])
if replicas != 3 or len(zones) != 3 or len(set(zones)) != 3 or any(not zone for zone in zones):
    raise SystemExit(1)
replacement_machine = next(item for item in machines["items"] if item["metadata"]["uid"] in replacement)
replacement_node = node_by_name[replacement_machine["status"]["nodeRef"]["name"]]
replacement_zone = replacement_node["metadata"]["labels"]["topology.kubernetes.io/zone"]
print(replacement_machine["metadata"]["name"], replacement_machine["metadata"]["uid"], replacement_node["metadata"]["name"], replacement_node["metadata"]["uid"], replacement_zone, ",".join(zones))
PY
	then
		break
	fi
	sleep 5
done
((SECONDS < deadline)) || {
	echo "automatic runtime Machine replacement did not converge" >&2
	exit 1
}
read -r replacement_name replacement_uid replacement_node replacement_node_uid replacement_zone final_zones <"$temporary/replacement"

python3 - "$receipt" "$started_at" "$cell_name" "$machine_set" "$cluster_uid" "$machine_set_uid" \
	"$baseline_replicas" "$target_name" "$target_uid" "$target_node" "$target_node_uid" \
	"$target_zone" "$baseline_zones" "$replacement_name" "$replacement_uid" "$replacement_node" \
	"$replacement_node_uid" "$replacement_zone" "$final_zones" "$provider_receipt_sha" <<'PY'
import json
import sys
from datetime import datetime, timezone

(path, started, cell, machine_set, cluster_uid, machine_set_uid, replicas, target_name, target_uid,
 target_node, target_node_uid, target_zone, baseline_zones, replacement_name, replacement_uid,
 replacement_node, replacement_node_uid, replacement_zone, final_zones, provider_sha) = sys.argv[1:]
payload = {
    "schema": "rivet-runtime-automatic-repair-qualification/v2",
    "verdict": "passed",
    "started_at": started,
    "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "cell": cell,
    "machine_set": machine_set,
    "cluster_uid": cluster_uid,
    "machine_set_uid": machine_set_uid,
    "delete_policy": "Newest",
    "baseline_replicas": int(replicas),
    "provider_receipt_sha256": provider_sha,
    "fault_injected": True,
    "target": {"name": target_name, "uid": target_uid, "node": target_node, "node_uid": target_node_uid, "zone": target_zone},
    "replacement": {"name": replacement_name, "uid": replacement_uid, "node": replacement_node, "node_uid": replacement_node_uid, "zone": replacement_zone},
    "topology": {"required_zones": 3, "baseline_zones": baseline_zones.split(","), "final_zones": final_zones.split(",")},
    "exact_target_removed": True,
    "ready_capacity_restored": True,
}
with open(path, "w", encoding="utf-8") as output:
    json.dump(payload, output, indent=2, sort_keys=True)
    output.write("\n")
PY
"$script_dir/verify-runtime-automatic-repair-receipt.py" \
	--expected-cell "$cell_name" --expected-machine-set "$machine_set" \
	--cluster-uid "$cluster_uid" --machine-set-uid "$machine_set_uid" \
	--provider-receipt-sha256 "$provider_receipt_sha" "$receipt"

# Publish the provider evidence first and the automatic-replacement evidence
# last. A crash between the two leaves either no automatic receipt or a digest
# mismatch, so a future runtime install fails closed instead of inheriting a
# half-published qualification.
mkdir -p "$canonical_receipts_dir"
provider_publish=$(mktemp "$canonical_receipts_dir/.${cell_name}-runtime-machine-repair-current.XXXXXX")
automatic_publish=$(mktemp "$canonical_receipts_dir/.${cell_name}-runtime-automatic-repair-current.XXXXXX")
install -m 0600 "$provider_receipt" "$provider_publish"
install -m 0600 "$receipt" "$automatic_publish"
mv -f -- "$provider_publish" "$canonical_provider_receipt"
mv -f -- "$automatic_publish" "$canonical_automatic_receipt"
passed=true
echo "automatic runtime Machine replacement qualified: receipt=$receipt canonical=$canonical_automatic_receipt"
