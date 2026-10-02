#!/usr/bin/env python3
"""Fail-closed planning and evidence for the q01 2/1/0 runtime repair."""

import argparse
import collections
import hashlib
import json
import sys
import uuid
from datetime import datetime, timezone


def load(path):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def ready(item):
    return item.get("status", {}).get("phase") == "Running" and any(
        condition.get("type") == "Ready" and condition.get("status") == "True"
        for condition in item.get("status", {}).get("conditions", [])
    )


def inventory(machine_set, machines, nodes, statefulset, pods, cell, require_skew):
    spec = machine_set.get("spec", {})
    if spec.get("replicas") != 3 or machine_set.get("status", {}).get("replicas") != 3:
        raise ValueError("runtime MachineSet is not at an exact 3/3 steady state")
    if spec.get("deletePolicy") != "Newest":
        raise ValueError("runtime MachineSet deletePolicy is not Newest")
    scaling = spec.get("scaling", {})
    if scaling.get("createPolicy") != "ZoneEquality" or scaling.get("minReplicas") != 3 or scaling.get("maxReplicas", 0) < 4:
        raise ValueError("runtime MachineSet has no bounded ZoneEquality repair surge")
    if statefulset.get("spec", {}).get("replicas") != 3 or statefulset.get("status", {}).get("readyReplicas") != 3:
        raise ValueError("runtime StatefulSet is not exactly 3 Ready")

    machine_items = [item for item in machines.get("items", []) if not item["metadata"].get("deletionTimestamp")]
    node_items = [item for item in nodes.get("items", []) if not item["metadata"].get("deletionTimestamp")]
    live_pods = [item for item in pods.get("items", []) if not item["metadata"].get("deletionTimestamp")]
    if len(machine_items) != 3 or len(node_items) != 3 or len(live_pods) != 3:
        raise ValueError("runtime Machine/Node/Host inventory is not exactly three")
    machine_by_node = {
        item.get("status", {}).get("nodeRef", {}).get("name"): item
        for item in machine_items if item.get("status", {}).get("nodeRef", {}).get("name")
    }
    node_by_name = {item["metadata"]["name"]: item for item in node_items}
    if len(machine_by_node) != 3:
        raise ValueError("runtime Machine-to-Node inventory is incomplete")
    host_nodes = set()
    for pod in live_pods:
        node_name = pod.get("spec", {}).get("nodeName")
        if not ready(pod) or node_name not in node_by_name or node_name in host_nodes:
            raise ValueError("runtime Host placement is not exact and Ready")
        host_nodes.add(node_name)

    machine_set_uid = machine_set["metadata"].get("uid")
    if not machine_set_uid:
        raise ValueError("runtime MachineSet UID is missing")
    zone_counts = collections.Counter()
    targets = []
    for node_name, node in node_by_name.items():
        machine = machine_by_node.get(node_name)
        metadata = node["metadata"]
        labels = metadata.get("labels", {})
        conditions = {item["type"]: item["status"] for item in node.get("status", {}).get("conditions", [])}
        taints = {item.get("key") for item in node.get("spec", {}).get("taints", [])}
        if machine is None or labels.get("fleet.actor.dev/cell-name") != cell:
            raise ValueError("runtime Node ownership identity is incomplete")
        if conditions.get("Ready") != "True" or any(conditions.get(key) == "True" for key in (
            "DiskPressure", "MemoryPressure", "PIDPressure", "NetworkUnavailable"
        )):
            raise ValueError("runtime Node is not locally healthy")
        if labels.get("fleet.actor.dev/runtime-admitted") != "true" or metadata.get("annotations", {}).get("fleet.actor.dev/runtime-capacity-drain"):
            raise ValueError("runtime Node is not exactly admitted")
        if taints.intersection({"fleet.actor.dev/runtime-admission", "fleet.actor.dev/runtime-capacity-drain"}):
            raise ValueError("runtime Node retains a scheduling fence")
        try:
            state = json.loads(metadata["annotations"]["fleet.actor.dev/runtime-admission-state"])
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise ValueError("runtime Node admission evidence is invalid") from error
        identity = state.get("identity", {})
        if (state.get("phase") != "Admitted" or identity.get("node_uid") != metadata.get("uid") or
                identity.get("machine_uid") != machine["metadata"].get("uid") or
                identity.get("machine_set_uid") != machine_set_uid):
            raise ValueError("runtime Node admission identity is stale")
        zone = labels.get("topology.kubernetes.io/zone")
        if not zone:
            raise ValueError("runtime Node topology zone is missing")
        zone_counts[zone] += 1
        targets.append((machine["metadata"].get("creationTimestamp", ""), machine["metadata"]["name"], machine, node, zone))
    expected_counts = [1, 2] if require_skew else [1, 1, 1]
    if sorted(zone_counts.values()) != expected_counts:
        raise ValueError("runtime topology does not match the required shape")
    return machine_items, node_items, zone_counts, targets


def make_plan(args):
    documents = [load(path) for path in (
        args.machine_set, args.machines, args.nodes, args.statefulset, args.pods
    )]
    machine_set, machines, nodes, statefulset, pods = documents
    controller = load(args.controller)
    if controller.get("spec", {}).get("replicas") != 1 or controller.get("status", {}).get("readyReplicas") != 1:
        raise ValueError("runtime capacity controller is not exactly one Ready replica")
    containers = controller["spec"]["template"]["spec"].get("containers", [])
    if len(containers) != 1:
        raise ValueError("runtime capacity controller shape changed")
    environment = {item.get("name"): item.get("value") for item in containers[0].get("env", [])}
    if environment.get("RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED") != "true":
        raise ValueError("targeted runtime repair is not enabled")
    if environment.get("RUNTIME_CAPACITY_MAX_REPAIR_SURGE") != "1":
        raise ValueError("runtime repair surge is not exactly one")
    machine_items, _, counts, targets = inventory(
        machine_set, machines, nodes, statefulset, pods, args.cell, True
    )
    overrepresented = next(zone for zone, count in counts.items() if count == 2)
    target = sorted(
        (item for item in targets if item[4] == overrepresented),
        key=lambda item: (item[0], item[1]), reverse=True,
    )[0]
    machine, node, zone = target[2], target[3], target[4]
    return {
        "cell": args.cell,
        "machine_set": machine_set["metadata"]["name"],
        "machine_set_uid": machine_set["metadata"]["uid"],
        "baseline_machine_uids": sorted(item["metadata"]["uid"] for item in machine_items),
        "baseline_zones": sorted(zone for zone, count in counts.items() for _ in range(count)),
        "target": {
            "name": machine["metadata"]["name"], "uid": machine["metadata"]["uid"],
            "node": node["metadata"]["name"], "node_uid": node["metadata"]["uid"], "zone": zone,
        },
    }


def make_patch(node, machine_uid):
    metadata = node["metadata"]
    raw = metadata["annotations"]["fleet.actor.dev/runtime-admission-state"]
    state = json.loads(raw)
    identity = state.get("identity", {})
    if state.get("phase") != "Admitted" or identity.get("node_uid") != metadata["uid"] or identity.get("machine_uid") != machine_uid:
        raise ValueError("topology repair target lost its exact admitted identity")
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    state.update({
        "phase": "Quarantined",
        "attempt_uid": "topology-bootstrap-" + uuid.uuid4().hex,
        "attempt": max(1, int(state.get("attempt", 0)) + 1),
        "started_at": now,
        "transition_at": now,
        "reason": "q01 controlled bootstrap repair of 2/1/0 runtime topology",
    })
    for key in ("probe_pod_name", "probe_pod_uid", "retry_at", "fault", "fault_since"):
        state.pop(key, None)
    encoded = json.dumps(state, separators=(",", ":"), sort_keys=True)
    operations = [
        {"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
        {"op": "test", "path": "/metadata/annotations/fleet.actor.dev~1runtime-admission-state", "value": raw},
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
    return operations


def finalize(args):
    plan = load(args.plan)
    machine_set, machines, nodes, statefulset, pods = [load(path) for path in (
        args.machine_set, args.machines, args.nodes, args.statefulset, args.pods
    )]
    machine_items, node_items, counts, _ = inventory(
        machine_set, machines, nodes, statefulset, pods, plan["cell"], False
    )
    if machine_set["metadata"].get("uid") != plan["machine_set_uid"]:
        raise ValueError("runtime MachineSet UID changed")
    final_uids = {item["metadata"]["uid"] for item in machine_items}
    baseline_uids = set(plan["baseline_machine_uids"])
    if plan["target"]["uid"] in final_uids or len(final_uids - baseline_uids) != 1 or len(baseline_uids - final_uids) != 1:
        raise ValueError("exact target removal and one replacement are not proven")
    if plan["target"]["node_uid"] in {item["metadata"]["uid"] for item in node_items}:
        raise ValueError("target Node UID still exists")
    replacement = next(item for item in machine_items if item["metadata"]["uid"] in final_uids - baseline_uids)
    node_by_name = {item["metadata"]["name"]: item for item in node_items}
    replacement_node = node_by_name[replacement["status"]["nodeRef"]["name"]]
    replacement_identity = {
        "name": replacement["metadata"]["name"], "uid": replacement["metadata"]["uid"],
        "node": replacement_node["metadata"]["name"], "node_uid": replacement_node["metadata"]["uid"],
        "zone": replacement_node["metadata"]["labels"]["topology.kubernetes.io/zone"],
    }
    payload = {
        "schema": "rivet-runtime-topology-repair/v1",
        "verdict": "passed",
        "started_at": args.started_at,
        "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cell": plan["cell"], "machine_set": plan["machine_set"],
        "cluster_uid": args.cluster_uid, "machine_set_uid": plan["machine_set_uid"],
        "policy": {"required_zones": 3, "max_repair_surge": 1, "create_policy": "ZoneEquality", "delete_policy": "Newest"},
        "baseline_zones": plan["baseline_zones"],
        "final_zones": sorted(zone for zone, count in counts.items() for _ in range(count)),
        "target": plan["target"], "replacement": replacement_identity,
        "exact_target_removed": True, "ready_admitted_capacity_restored": True,
    }
    canonical = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    payload["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
    return payload


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command")
    plan = subparsers.add_parser("plan")
    for name in ("machine_set", "machines", "nodes", "statefulset", "pods", "controller"):
        plan.add_argument("--" + name.replace("_", "-"), required=True)
    plan.add_argument("--cell", required=True)
    patch = subparsers.add_parser("patch")
    patch.add_argument("--node", required=True)
    patch.add_argument("--machine-uid", required=True)
    final = subparsers.add_parser("finalize")
    final.add_argument("--plan", required=True)
    for name in ("machine_set", "machines", "nodes", "statefulset", "pods"):
        final.add_argument("--" + name.replace("_", "-"), required=True)
    final.add_argument("--cluster-uid", required=True)
    final.add_argument("--started-at", required=True)
    args = parser.parse_args()
    if args.command is None:
        parser.error("a command is required")
    try:
        if args.command == "plan":
            result = make_plan(args)
        elif args.command == "patch":
            result = make_patch(load(args.node), args.machine_uid)
        else:
            result = finalize(args)
    except (OSError, KeyError, TypeError, json.JSONDecodeError, ValueError) as error:
        print("runtime topology repair: " + str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
