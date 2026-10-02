#!/usr/bin/env python3
"""Render the regional FDB profile from the complete private image inventory."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
FLEET = ROOT.parents[2]
REF = re.compile(r"^(?P<repository>[^\s@]+)@(?P<digest>sha256:[0-9a-f]{64})$")


def image_contract():
    path = FLEET / "gitops" / "image-seed" / "image_contract.py"
    spec = importlib.util.spec_from_file_location("regional_profile_image_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("image inventory validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def spec_digest(profile: dict) -> str:
    encoded = json.dumps(profile["spec"], sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def render(profile_source: str, image_inventory: dict) -> tuple[list[dict], dict]:
    contract = image_contract().validate_inventory(image_inventory)
    matches = [item for item in contract["images"] if item["repository"] == "fdb-kubernetes-monitor"]
    if len(matches) != 1:
        raise ValueError("complete image inventory has no unique FDB monitor")
    match = REF.fullmatch(matches[0]["ref"])
    if match is None:
        raise ValueError("FDB monitor is not a digest-pinned registry reference")

    documents = [item for item in yaml.safe_load_all(profile_source) if item]
    profiles = [item for item in documents if item.get("kind") == "RivetCellProfile"]
    classes = [item for item in documents if item.get("kind") == "ShardClass"]
    if len(documents) != 2 or len(profiles) != 1 or len(classes) != 1:
        raise ValueError("regional source must contain exactly one RivetCellProfile and one ShardClass")
    profile, shard_class = profiles[0], classes[0]
    kubernetes = profile["spec"]["foundationDB"]["kubernetes"]
    version = profile["spec"]["foundationDB"]["version"]
    kubernetes["imageRepository"] = match.group("repository")
    kubernetes["imageTagDigest"] = f"{version}@{match.group('digest')}"
    digest = spec_digest(profile)
    reference = shard_class["spec"]["profileRef"]
    if reference.get("name") != profile["metadata"]["name"]:
        raise ValueError("ShardClass profile name differs from regional profile")
    reference["digest"] = digest
    annotations = profile.setdefault("metadata", {}).setdefault("annotations", {})
    annotations["fleet.actor.dev/image-inventory-digest"] = contract["inventoryDigest"]
    shard_class.setdefault("metadata", {}).setdefault("annotations", {})[
        "fleet.actor.dev/image-inventory-digest"
    ] = contract["inventoryDigest"]
    receipt = {
        "schema": "actor-regional-profile-render/v1",
        "verdict": "passed",
        "profileName": profile["metadata"]["name"],
        "className": shard_class["metadata"]["name"],
        "profileDigest": digest,
        "imageInventoryDigest": contract["inventoryDigest"],
        "fdbMonitorImage": matches[0]["ref"],
    }
    return documents, receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=FLEET / "beijing-kubernetes-profile.yaml")
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        documents, receipt = render(args.source.read_text(), json.loads(args.images.read_text()))
        if args.output.exists() or args.receipt.exists():
            raise ValueError("profile output and receipt must both be new paths")
        args.output.write_text(yaml.safe_dump_all(documents, explicit_start=True, sort_keys=False))
        args.receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
