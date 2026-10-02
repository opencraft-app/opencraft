#!/usr/bin/env python3
"""Join management Terraform, image and pull-bootstrap evidence."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent


def load_inputs():
    path = ROOT / "validate-inputs.py"
    spec = importlib.util.spec_from_file_location("management_platform_inputs", path)
    if spec is None or spec.loader is None:
        raise ValueError("bootstrap input validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def validate(terraform: Any, images: Any, pull_receipt: Any, pull_sha256: str) -> dict[str, Any]:
    public = load_inputs().validate(terraform, images, "management")
    pull = mapping(pull_receipt, "pull receipt")
    if pull.get("schema") != "actor-create-first-pull-bootstrap/v1" or pull.get("verdict") != "passed":
        raise ValueError("management pull receipt is not passed bootstrap evidence")
    cluster = mapping(pull.get("cluster"), "pull receipt cluster")
    if (
        pull.get("role") != "management" or pull.get("identity") != public["identity"]
        or pull.get("imageInventoryDigest") != public["imageInventoryDigest"]
        or cluster.get("id") != public["clusterId"] or cluster.get("vpcId") != public["vpcId"]
        or not isinstance(cluster.get("uid"), str) or not cluster["uid"]
    ):
        raise ValueError("management pull receipt differs from Terraform/image identity")
    namespaces = pull.get("namespaces")
    records = {
        item.get("name"): item for item in namespaces
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    } if isinstance(namespaces, list) else {}
    expected = set(public["namespaces"])
    if set(records) != expected or len(records) != len(namespaces):
        raise ValueError("management pull receipt namespace inventory differs")
    if any(
        not isinstance(records[name].get(field), str) or not records[name][field]
        for name in expected for field in ("namespaceUid", "secretUid")
    ):
        raise ValueError("management pull receipt has an invalid namespace identity")
    argocd = records["argocd"]
    actor_git = records["actor-git-system"]
    return {
        "schemaVersion": 1,
        "managementId": public["identity"],
        "clusterId": public["clusterId"],
        "clusterUid": cluster["uid"],
        "imageInventoryDigest": public["imageInventoryDigest"],
        "pullCredentialReceiptSha256": pull_sha256,
        "argocdNamespaceUid": argocd["namespaceUid"],
        "argocdPullSecretUid": argocd["secretUid"],
        "actorGitNamespaceUid": actor_git["namespaceUid"],
        "actorGitPullSecretUid": actor_git["secretUid"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--pull-receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        pull_raw = args.pull_receipt.read_bytes()
        result = validate(
            json.loads(args.inventory.read_text()), json.loads(args.images.read_text()),
            json.loads(pull_raw), hashlib.sha256(pull_raw).hexdigest(),
        )
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
