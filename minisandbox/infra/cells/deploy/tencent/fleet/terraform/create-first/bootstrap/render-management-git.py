#!/usr/bin/env python3
"""Render the management Git service from the complete private image lock."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parent
FLEET = ROOT.parents[2]
DEFAULT_SOURCE = FLEET / "gitops" / "qualification-git-service.yaml"
SOURCE_SHA256 = "78bb9efe9b51cc33b78c208dd860bd542d2a1a17b87583bd522dc9a2d8463daa"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
EXPECTED_RESOURCES = {
    ("Namespace", "actor-git-system"),
    ("StorageClass", "actor-git-cbs-wffc-retain"),
    ("PersistentVolumeClaim", "actor-git-data"),
    ("Service", "actor-git"),
    ("StatefulSet", "actor-git"),
    ("PodDisruptionBudget", "actor-git"),
    ("NetworkPolicy", "actor-git-ingress"),
}


def image_contract():
    path = FLEET / "gitops" / "image-seed" / "image_contract.py"
    spec = importlib.util.spec_from_file_location("management_git_image_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("image inventory validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def write_new(path: Path, data: bytes, mode: int = 0o644) -> None:
    if not path.is_absolute() or path.exists() or not path.parent.is_dir():
        raise ValueError(f"output must be a new absolute path with an existing parent: {path}")
    descriptor = path.open("xb")
    try:
        descriptor.write(data)
        descriptor.flush()
    finally:
        descriptor.close()
    path.chmod(mode)


def replace_labels(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: replace_labels(child) for key, child in value.items()}
    if isinstance(value, list):
        return [replace_labels(child) for child in value]
    if value == "actor-qualification-git":
        return "actor-management-git"
    return value


def render(
    source: Path,
    inventory: dict[str, Any],
    management_id: str,
    platform_receipt_digest: str,
    cluster_uid: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    source_bytes = source.read_bytes()
    if sha256(source_bytes) != SOURCE_SHA256:
        raise ValueError("management Git source manifest differs from the reviewed bytes")
    if not re.fullmatch(r"actor-[a-z]{2}-c[0-9]{2}", management_id):
        raise ValueError("management ID is invalid")
    if not DIGEST.fullmatch(platform_receipt_digest) or not cluster_uid:
        raise ValueError("management platform receipt digest and cluster UID are required")
    validated = image_contract().validate_inventory(mapping(inventory, "image inventory"))
    image = image_contract().resolve(validated, "git-service")["ref"]
    documents = [replace_labels(item) for item in yaml.safe_load_all(source_bytes) if item]
    identities = {
        (item.get("kind"), mapping(item.get("metadata"), "resource metadata").get("name"))
        for item in documents
    }
    if identities != EXPECTED_RESOURCES or len(identities) != len(documents):
        raise ValueError("management Git source resource inventory differs")
    annotations = {
        "fleet.actor.dev/management-id": management_id,
        "fleet.actor.dev/management-cluster-uid": cluster_uid,
        "fleet.actor.dev/management-platform-receipt-digest": platform_receipt_digest,
        "fleet.actor.dev/image-inventory-digest": validated["inventoryDigest"],
    }
    statefulset = None
    for item in documents:
        metadata = mapping(item["metadata"], "resource metadata")
        metadata.setdefault("annotations", {}).update(annotations)
        if item["kind"] == "StatefulSet":
            statefulset = item
    if statefulset is None:
        raise ValueError("management Git StatefulSet is absent")
    template = mapping(mapping(statefulset["spec"], "StatefulSet spec")["template"], "pod template")
    mapping(template["metadata"], "pod metadata").setdefault("annotations", {}).update(annotations)
    containers = mapping(template["spec"], "pod spec").get("containers")
    if not isinstance(containers, list) or len(containers) != 1 or containers[0].get("name") != "gitea":
        raise ValueError("management Git container inventory differs")
    containers[0]["image"] = image
    environment = containers[0].setdefault("env", [])
    if not any(item.get("name") == "GITEA__repository__DEFAULT_BRANCH" for item in environment):
        environment.append({"name": "GITEA__repository__DEFAULT_BRANCH", "value": "main"})
    manifest = yaml.safe_dump_all(documents, explicit_start=True, sort_keys=True).encode()
    receipt = {
        "schema": "actor-create-first-management-git-render/v1",
        "managementId": management_id,
        "clusterUid": cluster_uid,
        "managementPlatformReceiptDigest": platform_receipt_digest,
        "imageInventoryDigest": validated["inventoryDigest"],
        "sourceSha256": sha256(source_bytes),
        "manifestSha256": sha256(manifest),
        "image": image,
        "resources": [
            {"kind": kind, "name": name}
            for kind, name in sorted(EXPECTED_RESOURCES)
        ],
    }
    return documents, receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--management-id", required=True)
    parser.add_argument("--platform-receipt-digest", required=True)
    parser.add_argument("--cluster-uid", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        documents, receipt = render(
            args.source,
            json.loads(args.images.read_text()),
            args.management_id,
            args.platform_receipt_digest,
            args.cluster_uid,
        )
        manifest = yaml.safe_dump_all(documents, explicit_start=True, sort_keys=True).encode()
        write_new(args.output, manifest)
        write_new(args.receipt, (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
    except (OSError, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps({"managementGitRender": "passed", "output": str(args.output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
