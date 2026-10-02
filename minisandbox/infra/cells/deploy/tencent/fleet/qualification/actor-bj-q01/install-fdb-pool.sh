#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
overlay=$fleet_dir/tke-native-nodepool/overlays/actor-bj-q01
expected_nodes=${FDB_EXPECTED_NODES:-9}
expected_zones=${FDB_EXPECTED_ZONES:-3}
timeout_seconds=${FDB_NODE_READY_TIMEOUT_SECONDS:-1800}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

[[ $expected_nodes =~ ^([9]|1[0-9]|2[0-9]|30)$ && $expected_zones == 3 ]]
((expected_nodes % 3 == 0))
temporary=$(mktemp -d)
cleanup() {
	rm -rf -- "$temporary"
}
trap cleanup EXIT
kubectl "${kubeconfig_args[@]}" kustomize "$overlay" >"$temporary/fdb-machineset.yaml"
python3 - "$temporary/fdb-machineset.yaml" "$expected_nodes" <<'PY'
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text()
for fragment in (
    "kind: MachineSet",
    "name: np-fdbpool0",
    f"replicas: {sys.argv[2]}",
    "minReplicas: 9",
    "maxReplicas: 30",
    "createPolicy: ZoneEquality",
    'fleet.actor.dev/fdb-dedicated: "true"',
    "effect: NoSchedule",
):
    if fragment not in text:
        raise SystemExit(f"qualification FDB MachineSet lost required fragment: {fragment}")
PY
kubectl "${kubeconfig_args[@]}" apply -f "$temporary/fdb-machineset.yaml"

deadline=$((SECONDS + timeout_seconds))
while ((SECONDS < deadline)); do
	ready=$(kubectl "${kubeconfig_args[@]}" get machineset np-fdbpool0 -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)
	observed=$(kubectl "${kubeconfig_args[@]}" get machineset np-fdbpool0 -o jsonpath='{.status.observedGeneration}' 2>/dev/null || true)
	generation=$(kubectl "${kubeconfig_args[@]}" get machineset np-fdbpool0 -o jsonpath='{.metadata.generation}' 2>/dev/null || true)
	if [[ $ready == "$expected_nodes" && $observed == "$generation" ]]; then
		if kubectl "${kubeconfig_args[@]}" get nodes -l fleet.actor.dev/fdb-dedicated=true -o json | \
			python3 -c '
import json, sys
expected, expected_zones = map(int, sys.argv[1:])
nodes = json.load(sys.stdin)["items"]
if len(nodes) != expected:
    raise SystemExit(1)
zones, hosts = set(), set()
for node in nodes:
    conditions = {value["type"]: value["status"] for value in node["status"]["conditions"]}
    if conditions.get("Ready") != "True":
        raise SystemExit(1)
    labels = node["metadata"]["labels"]
    if labels.get("fleet.actor.dev/cell-name") != "actor-bj-q01": raise SystemExit(1)
    if labels.get("fleet.actor.dev/fdb-dedicated") != "true": raise SystemExit(1)
    if labels.get("rivet.dev/compute") == "true": raise SystemExit(1)
    if {"key":"fleet.actor.dev/fdb-dedicated","value":"true","effect":"NoSchedule"} not in node["spec"].get("taints", []): raise SystemExit(1)
    zones.add(labels["topology.kubernetes.io/zone"])
    hosts.add(labels["kubernetes.io/hostname"])
if len(zones) != expected_zones or len(hosts) != expected:
    raise SystemExit(1)
' "$expected_nodes" "$expected_zones"; then
			kubectl "${kubeconfig_args[@]}" get nodes -l fleet.actor.dev/fdb-dedicated=true \
				-L topology.kubernetes.io/zone -o wide
			exit 0
		fi
	fi
	sleep 5
done
echo "qualification FDB MachineSet did not converge before timeout" >&2
exit 1
