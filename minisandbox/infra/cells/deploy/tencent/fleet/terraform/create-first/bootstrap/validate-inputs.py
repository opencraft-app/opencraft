#!/usr/bin/env python3
"""Validate the immutable Terraform/image inputs for one cluster bootstrap."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
FLEET = ROOT.parents[2]
ID = {
    "cluster": re.compile(r"^cls-[a-z0-9]+$"),
    "vpc": re.compile(r"^vpc-[a-z0-9]+$"),
    "tcr": re.compile(r"^tcr-[a-z0-9]+$"),
}
HOST = re.compile(r"^[a-z0-9.-]+\.tencentcloudcr\.com$")
BUCKET = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
CELL = re.compile(r"^actor-[a-z]{2}-[a-z][0-9]{2}$")
MANAGEMENT = re.compile(r"^actor-[a-z]{2}-c[0-9]{2}$")
NAMESPACES = {
    "management": (
        "actor-fleet-controller-system",
        "actor-git-system",
        "actor-release-system",
        "argocd",
        "observability",
        "worker-registry-system",
        "workers-api-system",
    ),
    "cell": (
        "actor-fdb-cell-system",
        "actor-runtime-admission-system",
        "actor-stateless-system",
        "fdb-operator-actor-fleet-controller-system",
        "observability",
    ),
}


def image_contract():
    path = FLEET / "gitops" / "image-seed" / "image_contract.py"
    spec = importlib.util.spec_from_file_location("bootstrap_image_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("image inventory validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def exact_keys(value: dict[str, Any], name: str, expected: set[str]) -> None:
    actual = set(value)
    if actual != expected:
        raise ValueError(
            f"{name} schema mismatch: missing={sorted(expected - actual)} "
            f"unknown={sorted(actual - expected)}"
        )


def reject_secret_shapes(value: Any) -> None:
    forbidden = {"kubeconfig", "secretid", "secretkey", "password", "token"}
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in forbidden:
                raise ValueError(f"Terraform inventory contains forbidden secret-shaped key: {key}")
            reject_secret_shapes(child)
    elif isinstance(value, list):
        for child in value:
            reject_secret_shapes(child)


def validate(terraform: Any, images: Any, role: str) -> dict[str, Any]:
    inventory = mapping(terraform, "Terraform inventory")
    reject_secret_shapes(inventory)
    expected_root = {
        "management": {"schemaVersion", "managementId", "region", "availabilityMode", "network", "kubernetes", "registry", "storage"},
        "cell": {
            "schemaVersion", "cellId", "environment", "region", "availabilityMode", "fleet", "network",
            "management", "kubernetes", "registry", "storage", "identity",
        },
    }[role]
    exact_keys(inventory, "Terraform inventory", expected_root)
    region = text(inventory.get("region"), "inventory.region")
    if inventory.get("schemaVersion") != 1 or re.fullmatch(r"[a-z]+-[a-z]+", region) is None:
        raise ValueError("Terraform inventory must be schemaVersion 1 in a valid region")
    availability_mode = text(inventory.get("availabilityMode"), "inventory.availabilityMode")
    if availability_mode not in {"production-multi-zone", "qualification-single-zone"}:
        raise ValueError("Terraform inventory availability mode is invalid")

    identity_key = "managementId" if role == "management" else "cellId"
    identity = text(inventory.get(identity_key), f"inventory.{identity_key}")
    pattern = MANAGEMENT if role == "management" else CELL
    if pattern.fullmatch(identity) is None:
        raise ValueError(f"inventory.{identity_key} is invalid")

    kubernetes = mapping(inventory.get("kubernetes"), "inventory.kubernetes")
    network = mapping(inventory.get("network"), "inventory.network")
    registry = mapping(inventory.get("registry"), "inventory.registry")
    cluster_id = text(kubernetes.get("clusterId"), "inventory.kubernetes.clusterId")
    vpc_id = text(network.get("vpcId"), "inventory.network.vpcId")
    registry_id = text(registry.get("id"), "inventory.registry.id")
    registry_host = text(registry.get("host"), "inventory.registry.host")
    registry_namespace = text(registry.get("namespace"), "inventory.registry.namespace")
    access_ip = text(registry.get("accessIp"), "inventory.registry.accessIp")
    if role == "management":
        storage = mapping(inventory.get("storage"), "inventory.storage")
        exact_keys(
            storage,
            "inventory.storage",
            {"codePlaneBackupBucket", "qualificationEvidenceBucket", "workerCodeBucket"},
        )
        for name, value in storage.items():
            if BUCKET.fullmatch(text(value, f"inventory.storage.{name}")) is None:
                raise ValueError(f"inventory.storage.{name} is not a valid COS bucket name")
    for value, kind in ((cluster_id, "cluster"), (vpc_id, "vpc"), (registry_id, "tcr")):
        if ID[kind].fullmatch(value) is None:
            raise ValueError(f"invalid Tencent {kind} identity")
    if HOST.fullmatch(registry_host) is None:
        raise ValueError("invalid Tencent registry host")

    contract = image_contract().validate_inventory(mapping(images, "image inventory"))
    if contract["registry"] != registry_host or contract["namespace"] != registry_namespace:
        raise ValueError("Terraform registry and complete image inventory differ")

    return {
        "schemaVersion": 1,
        "role": role,
        "identity": identity,
        "region": inventory["region"],
        "availabilityMode": availability_mode,
        "clusterId": cluster_id,
        "vpcId": vpc_id,
        "registryId": registry_id,
        "registryHost": registry_host,
        "registryNamespace": registry_namespace,
        "registryAccessIp": access_ip,
        "imageInventoryDigest": contract["inventoryDigest"],
        "namespaces": list(NAMESPACES[role]),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--role", choices=sorted(NAMESPACES), required=True)
    args = parser.parse_args()
    try:
        result = validate(json.loads(args.inventory.read_text()), json.loads(args.images.read_text()), args.role)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
