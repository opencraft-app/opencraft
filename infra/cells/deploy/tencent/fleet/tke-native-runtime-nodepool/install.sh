#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
overlay=${1:-$script_dir/overlays/actor-bj-k01}
machine_set=${RUNTIME_MACHINE_SET:-np-runtime0}
node_selector=${RUNTIME_NODE_SELECTOR:-fleet.actor.dev/runtime-pool=true}
expected_nodes=${RUNTIME_EXPECTED_NODES:-3}
expected_zones=${RUNTIME_EXPECTED_ZONES:-3}
timeout_seconds=${RUNTIME_NODE_READY_TIMEOUT_SECONDS:-1800}
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
	echo "runtime MachineSet overlay does not exist: $overlay" >&2
	exit 2
}

temporary_root=${TMPDIR:-/data/tmp}
mkdir -p "$temporary_root"
temporary=$(mktemp -d "$temporary_root/runtime-nodepool-install.XXXXXX")
cleanup() {
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

kubectl "${kubeconfig_args[@]}" kustomize "$overlay" >"$temporary/runtime-machineset.yaml"
python3 - "$temporary/runtime-machineset.yaml" "$machine_set" "$expected_nodes" <<'PY'
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
    'fleet.actor.dev/runtime-pool: "true"',
    'rivet.dev/compute: "true"',
    "key: rivet.dev/compute",
    "effect: NoSchedule",
):
    if fragment not in text:
        raise SystemExit(f"runtime MachineSet lost required fragment: {fragment}")
for forbidden in (
    "fleet.actor.dev/fdb-dedicated",
    "fleet.actor.dev/control-pool",
    "rivet.dev/pvm",
):
    if forbidden in text:
        raise SystemExit(f"runtime MachineSet carries forbidden identity: {forbidden}")
for fragment in (
    "key: fleet.actor.dev/runtime-admission",
    "value: pending",
):
    if fragment not in text:
        raise SystemExit(f"runtime MachineSet lost its default-deny admission fence: {fragment}")
PY

kubectl "${kubeconfig_args[@]}" apply -f "$temporary/runtime-machineset.yaml"
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
    assert labels.get("rivet.dev/compute") == "true"
    assert labels.get("fleet.actor.dev/control-pool") != "true"
    assert labels.get("fleet.actor.dev/fdb-dedicated") != "true"
    taints = node["spec"].get("taints", [])
    assert {"key": "rivet.dev/compute", "value": "true", "effect": "NoSchedule"} in taints
    zones.add(labels["topology.kubernetes.io/zone"])
    hosts.add(labels["kubernetes.io/hostname"])
assert len(zones) == expected_zones
assert len(hosts) == expected_nodes
' "$expected_nodes" "$expected_zones"; then
			topology_ready=true
			break
		fi
	fi
	sleep 5
done

[[ $topology_ready == true && ${ready:-} == "$expected_nodes" && ${observed:-} == "${generation:-missing}" ]] || {
	echo "runtime MachineSet readiness and node topology did not converge before timeout" >&2
	exit 1
}
kubectl "${kubeconfig_args[@]}" get nodes -l "$node_selector" \
	-L topology.kubernetes.io/zone -o wide
