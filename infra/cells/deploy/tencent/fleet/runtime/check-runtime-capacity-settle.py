#!/usr/bin/env python3
"""Check that no exact runtime Machine downscale can replace a held Host."""

import argparse
import json
import sys
from pathlib import Path


INTENT_ANNOTATION = "fleet.actor.dev/runtime-capacity-downscale-intent"
NODE_DRAIN_ANNOTATION = "fleet.actor.dev/runtime-capacity-drain"


def wait_reason(machine_set, nodes):
    if not isinstance(machine_set, dict):
        raise ValueError("runtime MachineSet document is not an object")
    metadata = machine_set.get("metadata")
    if not isinstance(metadata, dict) or not metadata.get("uid"):
        raise ValueError("runtime MachineSet identity is incomplete")
    annotations = metadata.get("annotations") or {}
    if not isinstance(annotations, dict):
        raise ValueError("runtime MachineSet annotations are malformed")
    if annotations.get(INTENT_ANNOTATION):
        return "exact Machine downscale intent is still active"
    if not isinstance(nodes, dict) or not isinstance(nodes.get("items"), list):
        raise ValueError("runtime Node list is malformed")
    for node in nodes["items"]:
        node_metadata = node.get("metadata") or {}
        node_annotations = node_metadata.get("annotations") or {}
        taints = (node.get("spec") or {}).get("taints") or []
        if node_annotations.get(NODE_DRAIN_ANNOTATION) or any(
            isinstance(item, dict) and item.get("key") == NODE_DRAIN_ANNOTATION
            for item in taints
        ):
            return "runtime Node %s still has an exact scale-down fence" % node_metadata.get(
                "name", "<unknown>"
            )
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--machineset", type=Path, required=True)
    parser.add_argument("--nodes", type=Path, required=True)
    args = parser.parse_args()
    try:
        reason = wait_reason(
            json.loads(args.machineset.read_text()),
            json.loads(args.nodes.read_text()),
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 1
    if reason is not None:
        print(reason)
        return 75
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
