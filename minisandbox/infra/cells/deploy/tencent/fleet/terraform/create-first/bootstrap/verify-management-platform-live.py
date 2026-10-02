#!/usr/bin/env python3
"""Verify live Argo HA resources against one rendered complete install."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import yaml


WORKLOAD_KINDS = {"Deployment", "StatefulSet"}


def mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def images(value: dict[str, Any]) -> list[str]:
    pod = mapping(mapping(mapping(value.get("spec"), "workload spec").get("template"), "pod template").get("spec"), "pod spec")
    result = [
        container.get("image")
        for collection in (pod.get("initContainers", []), pod.get("containers", []))
        for container in collection if isinstance(container, dict) and isinstance(container.get("image"), str)
    ]
    return sorted(result)


def identity(value: dict[str, Any]) -> tuple[str, str]:
    return str(value.get("kind", "")), str(mapping(value.get("metadata"), "resource metadata").get("name", ""))


def ready(value: dict[str, Any]) -> None:
    kind, name = identity(value)
    metadata = mapping(value.get("metadata"), f"{kind}/{name} metadata")
    spec = mapping(value.get("spec"), f"{kind}/{name} spec")
    status = mapping(value.get("status"), f"{kind}/{name} status")
    replicas = spec.get("replicas", 1)
    if not isinstance(replicas, int) or replicas < 1 or status.get("observedGeneration") != metadata.get("generation"):
        raise ValueError(f"{kind}/{name} has not observed its desired generation")
    if status.get("readyReplicas", 0) != replicas:
        raise ValueError(f"{kind}/{name} is not fully ready")
    if kind == "Deployment" and status.get("updatedReplicas", 0) != replicas:
        raise ValueError(f"Deployment/{name} is not fully updated")
    if kind == "StatefulSet" and status.get("currentRevision") != status.get("updateRevision"):
        raise ValueError(f"StatefulSet/{name} has not reached its update revision")


def verify(rendered: str, render_receipt: Any, live_values: list[Any]) -> dict[str, Any]:
    receipt = mapping(render_receipt, "Argo render receipt")
    if receipt.get("schema") != "actor-argocd-ha-render/v1" or receipt.get("verdict") != "passed":
        raise ValueError("Argo render receipt is not passed evidence")
    expected_documents = [item for item in yaml.safe_load_all(rendered) if item]
    expected_workloads = {
        identity(item): item for item in expected_documents if item.get("kind") in WORKLOAD_KINDS
    }
    expected_crds = {
        identity(item): item for item in expected_documents if item.get("kind") == "CustomResourceDefinition"
    }
    if len(expected_workloads) != 8 or len(expected_crds) != 3:
        raise ValueError("rendered Argo HA inventory is incomplete")
    live = [mapping(item, "live resource") for item in live_values]
    actual = {identity(item): item for item in live}
    if len(actual) != len(live) or set(actual) != set(expected_workloads) | set(expected_crds):
        raise ValueError("live Argo resource inventory differs from rendered install")
    inventory_digest = receipt.get("imageInventoryDigest")
    workload_records = []
    for key, expected in sorted(expected_workloads.items()):
        item = actual[key]
        metadata = mapping(item.get("metadata"), "live workload metadata")
        if not isinstance(metadata.get("uid"), str) or not metadata["uid"]:
            raise ValueError(f"live {key[0]}/{key[1]} UID is missing")
        if images(item) != images(expected):
            raise ValueError(f"live {key[0]}/{key[1]} images differ from rendered install")
        annotations = mapping(mapping(mapping(item["spec"], "live workload spec").get("template"), "live pod template").get("metadata"), "live pod metadata").get("annotations", {})
        if not isinstance(annotations, dict) or annotations.get("fleet.actor.dev/image-inventory-digest") != inventory_digest:
            raise ValueError(f"live {key[0]}/{key[1]} image inventory annotation differs")
        ready(item)
        workload_records.append({"kind": key[0], "name": key[1], "uid": metadata["uid"], "images": images(item)})
    crd_records = []
    for key in sorted(expected_crds):
        item = actual[key]
        metadata = mapping(item.get("metadata"), "live CRD metadata")
        conditions = mapping(item.get("status"), "live CRD status").get("conditions")
        if not isinstance(metadata.get("uid"), str) or not metadata["uid"]:
            raise ValueError(f"live CRD/{key[1]} UID is missing")
        if not isinstance(conditions, list) or not any(
            isinstance(condition, dict) and condition.get("type") == "Established" and condition.get("status") == "True"
            for condition in conditions
        ):
            raise ValueError(f"live CRD/{key[1]} is not Established")
        crd_records.append({"name": key[1], "uid": metadata["uid"]})
    return {"workloads": workload_records, "crds": crd_records}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rendered", type=Path, required=True)
    parser.add_argument("--render-receipt", type=Path, required=True)
    parser.add_argument("--live", type=Path, action="append", required=True)
    args = parser.parse_args()
    try:
        result = verify(
            args.rendered.read_text(), json.loads(args.render_receipt.read_text()),
            [json.loads(path.read_text()) for path in args.live],
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
