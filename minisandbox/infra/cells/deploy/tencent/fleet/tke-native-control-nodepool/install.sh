#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
overlay=${1:-$script_dir/overlays/actor-bj-k01}
machine_set=${CONTROL_MACHINE_SET:-np-control0}
node_selector=${CONTROL_NODE_SELECTOR:-fleet.actor.dev/control-pool=true}
expected_nodes=${CONTROL_EXPECTED_NODES:-3}
expected_zones=${CONTROL_EXPECTED_ZONES:-3}
timeout_seconds=${CONTROL_NODE_READY_TIMEOUT_SECONDS:-1800}
kubeconfig_args=()
if [[ -n ${KUBECONFIG:-} ]]; then
	kubeconfig_args=(--kubeconfig "$KUBECONFIG")
fi

for value in "$expected_nodes" "$expected_zones" "$timeout_seconds"; do
	[[ $value =~ ^[1-9][0-9]*$ ]] || {
		echo "node counts and timeout must be positive integers" >&2
		exit 2
	}
done
[[ -d $overlay ]] || {
	echo "control MachineSet overlay does not exist: $overlay" >&2
	exit 2
}

temporary=$(mktemp -d)
cleanup() {
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

kubectl "${kubeconfig_args[@]}" kustomize "$overlay" >"$temporary/control-machineset.yaml"
python3 - "$temporary/control-machineset.yaml" "$machine_set" "$expected_nodes" <<'PY'
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text()
name = sys.argv[2]
replicas = sys.argv[3]
for fragment in (
    "apiVersion: node.tke.cloud.tencent.com/v1beta1",
    "kind: MachineSet",
    f"name: {name}",
    f"replicas: {replicas}",
    "createPolicy: ZoneEquality",
    'fleet.actor.dev/control-pool: "true"',
):
    if fragment not in text:
        raise SystemExit(f"control MachineSet lost required fragment: {fragment}")
for forbidden in (
    "fleet.actor.dev/fdb-dedicated",
    "fleet.actor.dev/runtime-pool",
    "rivet.dev/compute",
    "rivet.dev/pvm",
):
    if forbidden in text:
        raise SystemExit(f"control MachineSet carries forbidden execution identity: {forbidden}")
PY

kubectl "${kubeconfig_args[@]}" apply -f "$temporary/control-machineset.yaml"
kubectl "${kubeconfig_args[@]}" get machineset "$machine_set" -o json \
	>"$temporary/applied-machineset.json"
read -r machine_set_uid desired_instance_types <<EOF
$(python3 - "$temporary/applied-machineset.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
uid = value.get("metadata", {}).get("uid")
instance_types = value.get("spec", {}).get("instanceTypes")
if not uid or not isinstance(instance_types, list) or not instance_types or not all(
    isinstance(item, str) and item for item in instance_types
):
    raise SystemExit("applied control MachineSet has no immutable UID/instance type contract")
print(uid, ",".join(instance_types))
PY
)
EOF
deadline=$((SECONDS + timeout_seconds))
topology_ready=false
while ((SECONDS < deadline)); do
	ready=$(kubectl "${kubeconfig_args[@]}" get machineset "$machine_set" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)
	observed=$(kubectl "${kubeconfig_args[@]}" get machineset "$machine_set" -o jsonpath='{.status.observedGeneration}' 2>/dev/null || true)
	generation=$(kubectl "${kubeconfig_args[@]}" get machineset "$machine_set" -o jsonpath='{.metadata.generation}' 2>/dev/null || true)
	if [[ $ready == "$expected_nodes" && $observed == "$generation" ]]; then
		if kubectl "${kubeconfig_args[@]}" get nodes -l "$node_selector" -o json | \
			python3 -c '
import json
import sys
expected_nodes = int(sys.argv[1])
expected_zones = int(sys.argv[2])
nodes = json.load(sys.stdin)["items"]
assert len(nodes) == expected_nodes
zones = set()
hosts = set()
for node in nodes:
    conditions = {value["type"]: value["status"] for value in node["status"]["conditions"]}
    assert conditions.get("Ready") == "True"
    labels = node["metadata"]["labels"]
    assert labels.get("fleet.actor.dev/control-pool") == "true"
    assert labels.get("rivet.dev/compute") != "true"
    assert labels.get("rivet.dev/pvm") != "true"
    assert labels.get("fleet.actor.dev/fdb-dedicated") != "true"
    zones.add(labels["topology.kubernetes.io/zone"])
    hosts.add(labels["kubernetes.io/hostname"])
assert len(zones) == expected_zones
assert len(hosts) == expected_nodes
' "$expected_nodes" "$expected_zones" && \
			kubectl "${kubeconfig_args[@]}" get machines \
				-l "node.tke.cloud.tencent.com/machineset=$machine_set" -o json | \
			python3 -c '
import json
import sys
expected_nodes = int(sys.argv[1])
machine_set_uid = sys.argv[2]
desired_types = set(sys.argv[3].split(","))
machines = json.load(sys.stdin)["items"]
assert len(machines) == expected_nodes
for machine in machines:
    owners = machine.get("metadata", {}).get("ownerReferences", [])
    assert any(owner.get("uid") == machine_set_uid for owner in owners)
    assert machine.get("spec", {}).get("providerSpec", {}).get("value", {}).get("instanceType") in desired_types
    assert machine.get("status", {}).get("phase") == "Running"
    assert machine.get("status", {}).get("nodeRef", {}).get("name")
' "$expected_nodes" "$machine_set_uid" "$desired_instance_types"; then
			topology_ready=true
			break
		fi
	fi
	sleep 5
done

[[ $topology_ready == true && ${ready:-} == "$expected_nodes" && ${observed:-} == "${generation:-missing}" ]] || {
	echo "control MachineSet readiness and node topology did not converge before timeout" >&2
	exit 1
}
kubectl "${kubeconfig_args[@]}" get nodes -l "$node_selector" \
	-L topology.kubernetes.io/zone -o wide
