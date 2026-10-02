#!/usr/bin/env python3
"""Verify one Terraform-to-Git Cell handoff without reading any credential."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
from typing import Any


def load_image_contract():
    path = Path(__file__).resolve().parents[1] / "image-seed" / "image_contract.py"
    spec = importlib.util.spec_from_file_location("handoff_image_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("complete image inventory validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def load_object(path: Path, name: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value


def verify(inventory_path: Path, receipt_path: Path, desired_root: Path) -> dict[str, Any]:
    inventory = load_object(inventory_path, "inventory")
    receipt = load_object(receipt_path, "handoff receipt")
    if receipt.get("schemaVersion") != 2 or inventory.get("schemaVersion") != 1:
        raise ValueError("unsupported handoff schemaVersion")
    cell_id = inventory.get("cellId")
    if not isinstance(cell_id, str) or receipt.get("cellId") != cell_id:
        raise ValueError("handoff Cell identity mismatch")
    inventory_digest = sha(canonical(inventory))
    if receipt.get("terraformInventoryDigest") != inventory_digest:
        raise ValueError("Terraform inventory digest mismatch")
    if receipt.get("fleetBinding") != inventory.get("fleet"):
        raise ValueError("handoff Fleet binding mismatch")
    if receipt.get("profileDigest") != inventory.get("fleet", {}).get("profileDigest"):
        raise ValueError("handoff profile digest mismatch")
    files = receipt.get("files")
    if not isinstance(files, dict) or not files:
        raise ValueError("handoff receipt has no file inventory")
    required = {"inventory.json", "image-inventory.json", "cell.json", "kustomization.yaml"}
    if not required.issubset(files):
        raise ValueError("handoff receipt lacks required desired-state files")
    root = desired_root.resolve()
    for relative, expected in sorted(files.items()):
        if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
            raise ValueError(f"unsafe handoff file path: {relative!r}")
        if not isinstance(expected, str) or not expected.startswith("sha256:"):
            raise ValueError(f"invalid handoff digest for {relative}")
        path = (root / relative).resolve()
        if root not in path.parents:
            raise ValueError(f"handoff file escapes desired root: {relative}")
        if not path.is_file() or sha(path.read_bytes()) != expected:
            raise ValueError(f"handoff file is missing or changed: {relative}")
    root_inventory = load_object(root / "inventory.json", "rendered inventory")
    if root_inventory != inventory:
        raise ValueError("rendered and supplied inventories differ")
    image_inventory = load_object(root / "image-inventory.json", "rendered image inventory")
    load_image_contract().validate_inventory(image_inventory)
    if image_inventory.get("inventoryDigest") != receipt.get("imageInventoryDigest"):
        raise ValueError("rendered image inventory digest differs from handoff")
    if image_inventory.get("registry") != inventory.get("registry", {}).get("host"):
        raise ValueError("rendered image inventory registry differs from Terraform")
    if image_inventory.get("namespace") != inventory.get("registry", {}).get("namespace"):
        raise ValueError("rendered image inventory namespace differs from Terraform")
    cell = load_object(root / "cell.json", "rendered Cell")
    annotations = cell.get("metadata", {}).get("annotations", {})
    if annotations.get("fleet.actor.dev/image-inventory-digest") != receipt.get("imageInventoryDigest"):
        raise ValueError("rendered Cell does not bind the image inventory")
    stateless_node_pool_id = inventory.get("kubernetes", {}).get("statelessNodePoolId")
    if (
        not isinstance(stateless_node_pool_id, str)
        or not stateless_node_pool_id.startswith("np-")
        or annotations.get("fleet.actor.dev/stateless-node-pool-id") != stateless_node_pool_id
    ):
        raise ValueError("rendered Cell does not bind the Terraform-owned stateless Native NodePool")
    machine_set_paths = [
        f"machine-pools/{role}/machineset.yaml"
        for role in ("control", "fdb", "runtime")
    ]
    if not set(machine_set_paths).issubset(files):
        raise ValueError("handoff receipt lacks the fixed MachineSet inventory")
    machine_sets: list[str] = []
    for relative in machine_set_paths:
        resource = load_object(root / relative, f"rendered MachineSet {relative}")
        metadata = resource.get("metadata", {})
        name = metadata.get("name")
        labels = resource.get("spec", {}).get("template", {}).get("spec", {}).get("metadata", {}).get("labels", {})
        if (
            resource.get("apiVersion") != "node.tke.cloud.tencent.com/v1beta1"
            or resource.get("kind") != "MachineSet"
            or not isinstance(name, str)
            or not name.startswith("np-")
            or labels.get("fleet.actor.dev/cell") != cell_id
        ):
            raise ValueError(f"rendered MachineSet identity is invalid: {relative}")
        machine_sets.append(name)
    if len(set(machine_sets)) != len(machine_sets):
        raise ValueError("rendered MachineSet inventory contains duplicate identities")
    return {
        "schemaVersion": 1,
        "cellId": cell_id,
        "clusterId": inventory["kubernetes"]["clusterId"],
        "privateEndpoint": inventory["kubernetes"]["privateEndpoint"],
        "statelessNodePoolId": stateless_node_pool_id,
        "machineSets": sorted(machine_sets),
        "terraformInventoryDigest": inventory_digest,
        "handoffReceiptDigest": sha(receipt_path.read_bytes()),
        "profileDigest": receipt["profileDigest"],
        "imageInventoryDigest": receipt["imageInventoryDigest"],
        "fleetBinding": receipt["fleetBinding"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--desired-root", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.inventory, args.receipt, args.desired_root), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
