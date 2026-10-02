#!/usr/bin/env python3
"""Validate the complete, non-secret evidence needed for Cell platform install."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parent


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"bootstrap validator is unavailable: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def passed(value: Any, schema: str, name: str) -> dict[str, Any]:
    result = mapping(value, name)
    if result.get("schema") != schema or result.get("verdict") != "passed":
        raise ValueError(f"{name} is not passed {schema} evidence")
    return result


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def validate(
    terraform: Any,
    images: Any,
    pull_receipt: Any,
    pull_receipt_sha256: str,
    storage_receipt: Any,
    tls_receipt: Any,
    profile_source: str,
    profile_receipt: Any,
) -> dict[str, Any]:
    public = load("cell_platform_public", ROOT / "validate-inputs.py").validate(terraform, images, "cell")
    inventory = mapping(terraform, "Terraform inventory")
    image_contract = load(
        "cell_platform_images", ROOT.parents[2] / "gitops" / "image-seed" / "image_contract.py",
    ).validate_inventory(mapping(images, "image inventory"))
    cell_id = public["identity"]
    image_digest = public["imageInventoryDigest"]

    pull = passed(pull_receipt, "actor-create-first-pull-bootstrap/v1", "pull receipt")
    cluster = mapping(pull.get("cluster"), "pull receipt cluster")
    if (
        pull.get("role") != "cell" or pull.get("identity") != cell_id
        or pull.get("imageInventoryDigest") != image_digest
        or cluster.get("id") != public["clusterId"] or cluster.get("vpcId") != public["vpcId"]
        or not isinstance(cluster.get("uid"), str) or not cluster["uid"]
    ):
        raise ValueError("pull receipt differs from Cell Terraform/image identity")
    namespaces = pull.get("namespaces")
    if not isinstance(namespaces, list):
        raise ValueError("pull receipt lacks Cell namespace identities")
    namespace_map = {
        item.get("name"): item for item in namespaces
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    required_namespaces = {"actor-fdb-cell-system", "fdb-operator-actor-fleet-controller-system"}
    if not required_namespaces.issubset(namespace_map) or any(
        not isinstance(namespace_map[name].get(key), str) or not namespace_map[name][key]
        for name in required_namespaces for key in ("namespaceUid", "secretUid")
    ):
        raise ValueError("pull receipt lacks Cell namespace identities")
    namespace_uid = namespace_map["actor-fdb-cell-system"]["namespaceUid"]

    storage = passed(storage_receipt, "actor-create-first-storage-bootstrap/v1", "storage receipt")
    if (
        storage.get("cellId") != cell_id or storage.get("imageInventoryDigest") != image_digest
        or storage.get("pullCredentialReceiptSha256") != pull_receipt_sha256
        or storage.get("cluster") != {"id": public["clusterId"], "uid": cluster["uid"]}
        or storage.get("namespace") != {"name": "actor-fdb-cell-system", "uid": namespace_uid}
        or storage.get("buckets") != {
            "cold": inventory["storage"]["cold"], "backup": inventory["storage"]["backup"],
        }
    ):
        raise ValueError("storage receipt differs from Cell bootstrap identity")
    storage_secrets = storage.get("secrets")
    expected_storage = {
        ("backup", f"{cell_id}-backup-credentials"),
        ("cold", f"{cell_id}-runtime-cos"),
    }
    storage_records = {
        (item.get("role"), item.get("name")): item.get("uid")
        for item in storage_secrets if isinstance(item, dict) and item.get("uid")
    } if isinstance(storage_secrets, list) else {}
    if (
        not isinstance(storage_secrets, list) or set(storage_records) != expected_storage
        or len(storage_records) != len(storage_secrets)
    ):
        raise ValueError("storage receipt has incomplete Secret identities")

    tls = passed(tls_receipt, "actor-fdb-tls-bootstrap/v1", "FDB TLS receipt")
    if tls.get("cellId") != cell_id or tls.get("namespace") != {"name": "actor-fdb-cell-system", "uid": namespace_uid}:
        raise ValueError("FDB TLS receipt differs from Cell bootstrap identity")
    tls_secrets = tls.get("secrets")
    expected_tls = {
        ("operator", "fdb-operator-tls"),
        ("cell", f"{cell_id}-fdb-tls"),
        ("backup", f"{cell_id}-backup-tls"),
    }
    tls_records = {
        (item.get("purpose"), item.get("name")): item.get("uid")
        for item in tls_secrets if isinstance(item, dict) and item.get("uid")
    } if isinstance(tls_secrets, list) else {}
    if (
        not isinstance(tls_secrets, list) or set(tls_records) != expected_tls
        or len(tls_records) != len(tls_secrets)
    ):
        raise ValueError("FDB TLS receipt has incomplete Secret identities")

    documents = [item for item in yaml.safe_load_all(profile_source) if item]
    profiles = [item for item in documents if item.get("kind") == "RivetCellProfile"]
    classes = [item for item in documents if item.get("kind") == "ShardClass"]
    if len(documents) != 2 or len(profiles) != 1 or len(classes) != 1:
        raise ValueError("regional profile must contain exactly one Profile and Class")
    profile, shard_class = profiles[0], classes[0]
    regional = load("cell_platform_profile", ROOT / "render-regional-profile.py")
    digest = regional.spec_digest(profile)
    profile_evidence = passed(profile_receipt, "actor-regional-profile-render/v1", "regional profile receipt")
    monitor = next(item for item in image_contract["images"] if item["repository"] == "fdb-kubernetes-monitor")
    if (
        digest != inventory["fleet"]["profileDigest"]
        or shard_class.get("metadata", {}).get("name") != inventory["fleet"]["className"]
        or shard_class.get("spec", {}).get("profileRef") != {
            "name": profile.get("metadata", {}).get("name"), "digest": digest,
        }
        or profile_evidence.get("profileName") != profile.get("metadata", {}).get("name")
        or profile_evidence.get("className") != shard_class.get("metadata", {}).get("name")
        or profile_evidence.get("profileDigest") != digest
        or profile_evidence.get("imageInventoryDigest") != image_digest
        or profile_evidence.get("fdbMonitorImage") != monitor["ref"]
        or profile.get("metadata", {}).get("annotations", {}).get("fleet.actor.dev/image-inventory-digest") != image_digest
    ):
        raise ValueError("regional Profile/Class differs from Terraform or image inventory")

    controller = next(item for item in image_contract["images"] if item["repository"] == "actor-fleet-controller")
    provenance = controller["provenance"]
    return {
        "schemaVersion": 1,
        "cellId": cell_id,
        "clusterId": public["clusterId"],
        "clusterUid": cluster["uid"],
        "namespace": {
            "name": "actor-fdb-cell-system",
            "uid": namespace_uid,
            "pullSecretUid": namespace_map["actor-fdb-cell-system"]["secretUid"],
        },
        "controllerNamespace": {
            "name": "fdb-operator-actor-fleet-controller-system",
            "uid": namespace_map["fdb-operator-actor-fleet-controller-system"]["namespaceUid"],
            "pullSecretUid": namespace_map["fdb-operator-actor-fleet-controller-system"]["secretUid"],
        },
        "imageInventoryDigest": image_digest,
        "controller": {
            "image": controller["ref"],
            "sourceRevision": provenance["sourceRevision"],
            # Bootstrap nodes intentionally use Tencent Agent's Python 3.7.
            "sourceManifestSha256": provenance["sourceManifestDigest"][len("sha256:"):],
        },
        "profile": {
            "name": profile["metadata"]["name"],
            "className": shard_class["metadata"]["name"],
            "digest": digest,
        },
        "prerequisiteSecrets": sorted(
            [
                {"name": name, "uid": uid}
                for (_, name), uid in {**storage_records, **tls_records}.items()
            ],
            key=lambda item: item["name"],
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    for name in ("inventory", "images", "pull_receipt", "storage_receipt", "tls_receipt", "profile", "profile_receipt"):
        parser.add_argument("--" + name.replace("_", "-"), type=Path, required=True)
    args = parser.parse_args()
    try:
        pull_raw = args.pull_receipt.read_bytes()
        result = validate(
            json.loads(args.inventory.read_text()), json.loads(args.images.read_text()),
            json.loads(pull_raw), sha256(pull_raw), json.loads(args.storage_receipt.read_text()),
            json.loads(args.tls_receipt.read_text()), args.profile.read_text(),
            json.loads(args.profile_receipt.read_text()),
        )
    except (KeyError, OSError, StopIteration, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(str(error), file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
