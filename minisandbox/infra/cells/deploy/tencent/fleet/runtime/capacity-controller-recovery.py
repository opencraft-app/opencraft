#!/usr/bin/env python3
"""Plan the narrowly scoped controller-first stage of a Runtime release."""

import argparse
import copy
import json
import re
import sys
from pathlib import Path


SCHEMA = "actor-runtime-capacity-controller-recovery/v1"
INTENT = "fleet.actor.dev/runtime-capacity-downscale-intent"
DRAIN = "fleet.actor.dev/runtime-capacity-drain"
HOLD = "fleet.actor.dev/runtime-release-hold"
CELL = "fleet.actor.dev/cell-name"
MACHINE_SET = "node.tke.cloud.tencent.com/machineset"
PINNED = re.compile(r"^[^\s]+@sha256:[0-9a-f]{64}$")
NAME = re.compile(r"^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$")


def identity(document, kind, name, namespace=None):
    metadata = document.get("metadata", {})
    if document.get("kind") != kind or metadata.get("name") != name:
        raise ValueError("recovery resource kind/name mismatch")
    if namespace is not None and metadata.get("namespace") != namespace:
        raise ValueError("recovery resource namespace mismatch")
    if metadata.get("deletionTimestamp") or not all(
        isinstance(metadata.get(field), str) and metadata[field]
        for field in ("uid", "resourceVersion")
    ):
        raise ValueError("recovery resource identity is missing or terminating")
    return metadata


def singleton(document, cell, namespace):
    metadata = identity(document, "Deployment", cell + "-runtime-capacity", namespace)
    spec = document.get("spec", {})
    if metadata.get("labels", {}).get(CELL) != cell or type(spec.get("replicas")) is not int or spec.get("replicas") != 1 or (
        spec.get("strategy", {}).get("type") != "Recreate"
    ):
        raise ValueError("capacity recovery requires the exact singleton Recreate writer")
    containers = spec.get("template", {}).get("spec", {}).get("containers", [])
    if len(containers) != 1 or containers[0].get("name") != "controller":
        raise ValueError("capacity recovery container identity mismatch")
    image = containers[0].get("image", "")
    if not isinstance(image, str) or PINNED.fullmatch(image) is None:
        raise ValueError("capacity recovery requires a pinned original image")
    # The durable snapshot contains Secret references, never resolved values.
    for env in containers[0].get("env", []):
        name = env.get("name", "")
        sensitive = name.endswith(("TOKEN", "PASSWORD", "SECRET_ID", "SECRET_KEY", "PRIVATE_KEY"))
        if sensitive and env.get("value"):
            raise ValueError("capacity recovery cannot journal inline credentials")
    return metadata


def exact_item(items, kind, name):
    if not isinstance(items, dict) or not isinstance(items.get("items"), list) or len(items["items"]) > 500:
        raise ValueError("recovery inventory is not bounded")
    if items.get("metadata", {}).get("continue"):
        raise ValueError("recovery inventory is incomplete")
    matches = [item for item in items["items"] if item.get("metadata", {}).get("name") == name]
    if len(matches) != 1:
        raise ValueError("recovery exact resource is missing or duplicated")
    return matches[0], identity(matches[0], kind, name)


def unchanged_original(current, original, cell, namespace):
    observed = singleton(current, cell, namespace)
    expected = singleton(original, cell, namespace)
    if observed["uid"] != expected["uid"] or current["spec"]["template"] != original["spec"]["template"]:
        raise ValueError("capacity recovery original snapshot has another writer")


def owned_hold(statefulset, hold, cell, namespace):
    runtime = identity(statefulset, "StatefulSet", cell + "-runtime-hosts", namespace)
    if runtime.get("labels", {}).get(CELL) != cell or hold.get("workload_uid") != runtime["uid"] or (
        not re.fullmatch(r"release-[0-9a-f]{32}", hold.get("id", ""))
    ):
        raise ValueError("recovery release hold identity mismatch")
    if json.loads(runtime.get("annotations", {}).get(HOLD, "null")) != hold:
        raise ValueError("recovery does not own the live release hold")


def prepare(deployment, statefulset, hold, machine_set, machines, nodes,
            cell, namespace, image, revision, manifest, journal_name):
    if not all(isinstance(value, str) and NAME.fullmatch(value) for value in (cell, namespace, journal_name)):
        raise ValueError("recovery Cell/namespace/journal name is invalid")
    if len(journal_name) > 63 or PINNED.fullmatch(image) is None or (
        re.fullmatch(r"[0-9a-f]{40}", revision) is None or re.fullmatch(r"[0-9a-f]{64}", manifest) is None
    ):
        raise ValueError("recovery candidate identity is invalid")
    metadata = singleton(deployment, cell, namespace)
    owned_hold(statefulset, hold, cell, namespace)
    raw = machine_set.get("metadata", {}).get("annotations", {}).get(INTENT, "")
    intent = json.loads(raw)
    if not isinstance(intent, dict) or intent.get("version") != 2 or intent.get("phase") not in ("prepared", "issued"):
        raise ValueError("recovery requires a known exact downscale intent")
    attempts = intent.get("attempts", 0)
    if type(attempts) is not int or attempts != 0 or intent.get("request_id", "") != "":
        raise ValueError("recovery cannot cancel attempted or accepted provider work")
    for key in ("machine_set_name", "machine_name", "node_name"):
        if not isinstance(intent.get(key), str) or NAME.fullmatch(intent[key]) is None:
            raise ValueError("recovery intent resource names are invalid")
    set_metadata = identity(machine_set, "MachineSet", intent["machine_set_name"])
    if set_metadata["uid"] != intent.get("machine_set_uid") or (
        machine_set.get("spec", {}).get("template", {}).get("spec", {}).get("metadata", {}).get("labels", {}).get(CELL) != cell
    ):
        raise ValueError("recovery MachineSet UID/Cell mismatch")
    before, after = intent.get("from_replicas"), intent.get("to_replicas")
    if type(before) is not int or type(after) is not int or before < 2 or after != before - 1 or (
        machine_set.get("spec", {}).get("replicas") != before
    ):
        raise ValueError("recovery source capacity changed")
    machine, machine_metadata = exact_item(machines, "Machine", intent["machine_name"])
    node, node_metadata = exact_item(nodes, "Node", intent["node_name"])
    if machine_metadata["uid"] != intent.get("machine_uid") or node_metadata["uid"] != intent.get("node_uid"):
        raise ValueError("recovery exact Machine/Node UID changed")
    if machine_metadata.get("labels", {}).get(MACHINE_SET) != set_metadata["name"] or (
        node_metadata.get("labels", {}).get(MACHINE_SET) != set_metadata["name"] or
        machine.get("status", {}).get("nodeRef", {}).get("name") != node_metadata["name"]
    ):
        raise ValueError("recovery Machine/Node association changed")
    if node_metadata.get("annotations", {}).get(DRAIN) or any(
        taint.get("key") == DRAIN for taint in node.get("spec", {}).get("taints", []) or []
    ):
        raise ValueError("recovery requires an entirely absent Node fence")
    original = copy.deepcopy(deployment["spec"]["template"])
    candidate = copy.deepcopy(original)
    if candidate["spec"]["containers"][0]["image"] == image:
        raise ValueError("recovery candidate is already the original image")
    candidate["spec"]["containers"][0]["image"] = image
    journal = {
        "schema": SCHEMA, "cell": cell, "namespace": namespace, "hold": hold,
        "deployment": {"name": metadata["name"], "uid": metadata["uid"]},
        "originalTemplate": original, "candidateTemplate": candidate,
        "candidateSource": {"revision": revision, "manifestSha256": manifest},
        "intent": intent,
    }
    configmap = {
        "apiVersion": "v1", "kind": "ConfigMap", "immutable": True,
        "metadata": {"name": journal_name, "namespace": namespace, "labels": {CELL: cell}},
        "data": {"journal.json": json.dumps(journal, separators=(",", ":"), sort_keys=True)},
    }
    return configmap, template_patch(metadata, original, candidate)


def template_patch(metadata, expected, desired):
    return [
        {"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
        {"op": "test", "path": "/spec/template", "value": expected},
        {"op": "replace", "path": "/spec/template", "value": desired},
    ]


def rollback(deployment, configmap, statefulset):
    if configmap.get("immutable") is not True:
        raise ValueError("capacity recovery journal is not immutable")
    journal = json.loads(configmap.get("data", {}).get("journal.json", "null"))
    if not isinstance(journal, dict) or journal.get("schema") != SCHEMA:
        raise ValueError("capacity recovery journal schema mismatch")
    identity(configmap, "ConfigMap", configmap["metadata"]["name"], journal["namespace"])
    owned_hold(statefulset, journal["hold"], journal["cell"], journal["namespace"])
    metadata = singleton(deployment, journal["cell"], journal["namespace"])
    if metadata["uid"] != journal["deployment"]["uid"] or metadata["name"] != journal["deployment"]["name"]:
        raise ValueError("capacity recovery rollback Deployment UID changed")
    observed = deployment["spec"]["template"]
    if observed == journal["originalTemplate"]:
        return template_patch(metadata, observed, observed)
    if observed != journal["candidateTemplate"]:
        raise ValueError("capacity recovery rollback template has another writer")
    return template_patch(metadata, observed, journal["originalTemplate"])


def load(path):
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    plan = sub.add_parser("prepare")
    for arg in ("deployment", "original-deployment", "statefulset", "hold-identity", "machineset", "machines", "nodes"):
        plan.add_argument("--" + arg, type=Path, required=True)
    for arg in ("cell", "namespace", "image", "revision", "manifest", "journal-name"):
        plan.add_argument("--" + arg, required=True)
    plan.add_argument("--journal", type=Path, required=True)
    plan.add_argument("--patch", type=Path, required=True)
    undo = sub.add_parser("rollback")
    for arg in ("deployment", "statefulset", "journal", "patch"):
        undo.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == "prepare":
            unchanged_original(load(args.deployment), load(args.original_deployment), args.cell, args.namespace)
            journal, patch = prepare(
                load(args.deployment), load(args.statefulset), load(args.hold_identity),
                load(args.machineset), load(args.machines), load(args.nodes),
                args.cell, args.namespace, args.image, args.revision, args.manifest, args.journal_name,
            )
            args.journal.write_text(json.dumps(journal))
        else:
            patch = rollback(load(args.deployment), load(args.journal), load(args.statefulset))
        args.patch.write_text(json.dumps(patch))
        return 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        # Never include snapshot contents or inline credential values.
        print("capacity controller recovery rejected: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
