#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
mkdir -p /data/tmp
tmp_dir=$(mktemp -d /data/tmp/actor-fleet-controller-verify.XXXXXX)
trap 'rm -rf "$tmp_dir"' EXIT

cd "$repo_root"
GOTOOLCHAIN="${GOTOOLCHAIN:-auto}" GOSUMDB="${GO_SUMDB:-sum.golang.org}" \
	go test ./internal/fleetcontroller ./internal/runtimecapacity/... \
	./cmd/actor-fleet-controller ./cmd/workerd-runtime-capacity-controller
GOTOOLCHAIN="${GOTOOLCHAIN:-auto}" GOSUMDB="${GO_SUMDB:-sum.golang.org}" \
	go vet ./internal/fleetcontroller ./internal/runtimecapacity/... \
	./cmd/actor-fleet-controller ./cmd/workerd-runtime-capacity-controller

"$script_dir/tke-native-runtime-nodepool/test-admission-contract.sh"

kubectl apply --dry-run=client -f "$script_dir/crds.yaml" >/dev/null
kubectl kustomize "$script_dir/controller" >"$tmp_dir/controller.yaml"
kubectl kustomize "$script_dir/controller-e2e" >"$tmp_dir/controller-e2e.yaml"
kubectl apply --dry-run=client -f "$tmp_dir/controller.yaml" >/dev/null
kubectl apply --dry-run=client -f "$tmp_dir/controller-e2e.yaml" >/dev/null

python3 - "$script_dir" "$tmp_dir/controller.yaml" <<'PY'
import json
import hashlib
import sys
from pathlib import Path

import yaml

fleet_dir = Path(sys.argv[1])
controller_docs = [d for d in yaml.safe_load_all(Path(sys.argv[2]).read_text()) if d]
crds = [d for d in yaml.safe_load_all((fleet_dir / "crds.yaml").read_text()) if d]
names = {d["metadata"]["name"] for d in crds if d.get("kind") == "CustomResourceDefinition"}
for required in (
    "rivetcellclaims.fleet.actor.dev",
    "rivetcellregistrations.fleet.actor.dev",
    "rivetcellreports.fleet.actor.dev",
    "fdbscaleoperations.fleet.actor.dev",
    "fdbvolumeretirements.fleet.actor.dev",
):
    if required not in names:
        raise SystemExit(f"missing CRD {required}")

scale_operation = next(
    d for d in crds
    if d.get("metadata", {}).get("name") == "fdbscaleoperations.fleet.actor.dev"
)
status_schema = scale_operation["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["status"]
capacity_schema = status_schema["properties"]["nodeCapacity"]["properties"]
for field in ("primaryStorageProcesses", "auxiliaryStorageProcesses"):
    if capacity_schema.get(field) != {"type": "integer"}:
        raise SystemExit(f"FDBScaleOperation status.nodeCapacity must preserve {field}")

deployment = next(d for d in controller_docs if d.get("kind") == "Deployment")
if deployment["spec"]["replicas"] != 2:
    raise SystemExit("controller must run two leader-elected replicas")
if deployment["spec"]["template"]["spec"].get("imagePullSecrets") != [{"name": "actor-fleet-tcr"}]:
    raise SystemExit("controller must retain its regional TCR pull credential across reconstruction")

role = next(d for d in controller_docs if d.get("kind") == "ClusterRole")
delete_rules = [rule for rule in role["rules"] if "delete" in rule["verbs"]]
delete_targets = {
    (tuple(rule.get("apiGroups", [])), tuple(rule.get("resources", [])))
    for rule in delete_rules
}
expected_delete_targets = {
    (("work.open-cluster-management.io",), ("manifestworks",)),
    (("node.tke.cloud.tencent.com",), ("machines",)),
}
if delete_targets != expected_delete_targets:
    raise SystemExit(
        "controller deletion authority must be limited to OCM ManifestWork lifecycle "
        f"and exact TKE Machine replacement: {delete_rules}"
    )
required_rules = {
    ("fleet.actor.dev", "rivetenvironmentreports"): {"get", "list", "watch"},
    ("cluster.open-cluster-management.io", "managedclusters"): {"get", "list", "watch"},
    ("work.open-cluster-management.io", "manifestworks"): {"get", "list", "watch", "create", "patch", "update", "delete"},
}
for (api_group, resource), verbs in required_rules.items():
    matching = [
        rule for rule in role["rules"]
        if rule.get("apiGroups") == [api_group] and resource in rule.get("resources", [])
    ]
    if len(matching) != 1 or not verbs.issubset(set(matching[0].get("verbs", []))):
        raise SystemExit(f"controller is missing {api_group}/{resource} authority: {matching}")
pod_rules = [
    rule for rule in role["rules"]
    if rule.get("apiGroups") == [""] and "pods" in rule.get("resources", [])
]
if not pod_rules or not {"get", "list", "watch"}.issubset(set(pod_rules[0]["verbs"])):
    raise SystemExit("controller must observe storage Pods when reserving auxiliary FDB capacity")
node_rules = [
    rule for rule in role["rules"]
    if rule.get("apiGroups") == [""] and "nodes" in rule.get("resources", [])
]
if not node_rules or not {"get", "list", "watch"}.issubset(set(node_rules[0]["verbs"])):
    raise SystemExit("controller must observe Node topology when selecting balanced FDB scale-down targets")
if any(rule.get("apiGroups") == [""] and "secrets" in rule.get("resources", []) for rule in role["rules"]):
    raise SystemExit("external provider credential access must not be cluster-wide")
credential_role = next(
    d for d in controller_docs
    if d.get("kind") == "Role" and d.get("metadata", {}).get("name") == "actor-fleet-controller-leader-election"
)
secret_rules = [rule for rule in credential_role["rules"] if rule.get("resources") == ["secrets"]]
if len(secret_rules) != 1 or secret_rules[0].get("verbs") != ["get"]:
    raise SystemExit("external provider may only get credentials in its controller namespace")

e2e_docs = [
    d for d in yaml.safe_load_all((fleet_dir / "controller" / "e2e-profile-pool.yaml").read_text()) if d
]
profile = next(d for d in e2e_docs if d.get("kind") == "RivetCellProfile")
shard_class = next(d for d in e2e_docs if d.get("kind") == "ShardClass")
digest = "sha256:" + hashlib.sha256(
    json.dumps(profile["spec"], sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
if digest != shard_class["spec"]["profileRef"]["digest"]:
    raise SystemExit(f"e2e profile digest is stale: expected {digest}")

print("actor_fleet_controller_invariants=passed")
PY
