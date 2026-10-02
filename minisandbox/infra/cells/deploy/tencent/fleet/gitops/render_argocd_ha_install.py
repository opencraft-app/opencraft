#!/usr/bin/env python3
"""Render the complete reviewed Argo CD HA install against one private inventory."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
from typing import Any

import yaml


VERSION = "3.5.2"
SOURCE_URL = "https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.2/manifests/ha/install.yaml"
INPUT_SHA256 = "2ce4de1f93549619a72fa7aee124d92fe73aa28ad062f1c614e15b5576ca0466"
SOURCE_REPOSITORIES = {
    "quay.io/argoproj/argocd:v3.5.2": "argocd",
    "ghcr.io/dexidp/dex:v2.45.1": "argocd-dex",
    "public.ecr.aws/docker/library/haproxy:3.0.8-alpine": "argocd-haproxy",
    "public.ecr.aws/docker/library/redis:8.2.3-alpine": "argocd-redis",
}
WORKLOADS = {"Deployment", "StatefulSet"}
CLUSTER_SCOPED = {"CustomResourceDefinition", "ClusterRole", "ClusterRoleBinding"}
THREE_NODE_ANTI_AFFINITY_DEPLOYMENTS = {"argocd-redis-ha-haproxy"}
ROOT = pathlib.Path(__file__).resolve().parent


def image_contract():
    path = ROOT / "image-seed" / "image_contract.py"
    spec = importlib.util.spec_from_file_location("argocd_ha_image_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("complete image inventory validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def private_images(inventory: Any) -> tuple[dict[str, str], str]:
    contract = image_contract().validate_inventory(inventory)
    by_repository = {item["repository"]: item["ref"] for item in contract["images"]}
    missing = sorted(set(SOURCE_REPOSITORIES.values()) - set(by_repository))
    if missing:
        raise ValueError("complete image inventory lacks Argo images: " + ", ".join(missing))
    return (
        {source: by_repository[repository] for source, repository in SOURCE_REPOSITORIES.items()},
        contract["inventoryDigest"],
    )


def replace_images(value: Any, replacements: dict[str, str], counts: dict[str, int]) -> None:
    if isinstance(value, dict):
        if isinstance(value.get("image"), str):
            source = value["image"]
            if source not in replacements:
                raise ValueError("unreviewed Argo image: " + source)
            value["image"] = replacements[source]
            counts[source] += 1
        for child in value.values():
            replace_images(child, replacements, counts)
    elif isinstance(value, list):
        for child in value:
            replace_images(child, replacements, counts)


def render(raw: bytes, inventory: Any) -> tuple[list[dict], dict[str, Any]]:
    input_digest = hashlib.sha256(raw).hexdigest()
    if input_digest != INPUT_SHA256:
        raise ValueError("Argo HA install SHA256 is not reviewed")
    replacements, inventory_digest = private_images(inventory)
    documents = [document for document in yaml.safe_load_all(raw) if document]
    counts = {source: 0 for source in replacements}
    kinds = {document.get("kind") for document in documents}
    if not {"CustomResourceDefinition", "ClusterRole", "ClusterRoleBinding"}.issubset(kinds):
        raise ValueError("Argo HA input is not the complete cluster install")
    for document in documents:
        metadata = document.setdefault("metadata", {})
        if document.get("kind") not in CLUSTER_SCOPED:
            metadata["namespace"] = "argocd"
        elif "namespace" in metadata:
            raise ValueError("cluster-scoped Argo resource unexpectedly has a namespace")
        replace_images(document, replacements, counts)
        if document.get("kind") in WORKLOADS:
            pod = document["spec"]["template"]["spec"]
            pod["imagePullSecrets"] = [{"name": "actor-fleet-tcr"}]
            annotations = document["spec"]["template"].setdefault("metadata", {}).setdefault("annotations", {})
            annotations["fleet.actor.dev/image-inventory-digest"] = inventory_digest
        if (
            document.get("kind") == "Deployment"
            and metadata.get("name") in THREE_NODE_ANTI_AFFINITY_DEPLOYMENTS
        ):
            # The upstream HAProxy Deployment has three replicas with required
            # pod anti-affinity. On the qualified three-node management floor,
            # the default 25% surge creates an unschedulable fourth Pod and can
            # deadlock every inventory-only rollout. Replace one replica at a
            # time while retaining two serving replicas.
            document["spec"]["strategy"] = {
                "type": "RollingUpdate",
                "rollingUpdate": {"maxSurge": 0, "maxUnavailable": 1},
            }
    missing = [source for source, count in counts.items() if count == 0]
    if missing:
        raise ValueError("reviewed Argo image is absent: " + ", ".join(missing))
    receipt = {
        "schema": "actor-argocd-ha-render/v1",
        "verdict": "passed",
        "version": VERSION,
        "source": {"url": SOURCE_URL, "sha256": input_digest},
        "imageInventoryDigest": inventory_digest,
        "images": [
            {"source": source, "private": replacements[source], "occurrences": counts[source]}
            for source in sorted(replacements)
        ],
        "resources": len(documents),
    }
    return documents, receipt


def write_new(path: pathlib.Path, payload: str) -> None:
    if path.exists():
        raise ValueError(f"refusing to overwrite output: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--images", required=True, type=pathlib.Path)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    args = parser.parse_args()
    documents, receipt = render(args.input.read_bytes(), json.loads(args.images.read_text()))
    write_new(args.output, yaml.safe_dump_all(documents, explicit_start=True, sort_keys=False))
    try:
        write_new(args.receipt, json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    except Exception:
        args.output.unlink(missing_ok=True)
        raise
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
