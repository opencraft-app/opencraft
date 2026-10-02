#!/usr/bin/env python3
"""Materialize the canonical evidence preimages bound by an image inventory."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import image_contract as contract


PRODUCT_SPEC = importlib.util.spec_from_file_location(
    "materialize_product_lock", Path(__file__).with_name("product-lock.py")
)
assert PRODUCT_SPEC and PRODUCT_SPEC.loader
product_lock = importlib.util.module_from_spec(PRODUCT_SPEC)
PRODUCT_SPEC.loader.exec_module(product_lock)


RUN_ID = re.compile(r"^[0-9a-f]{32}$")


def encoded(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def publish_exact(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists():
            if path.is_symlink() or not path.is_file() or path.read_bytes() != payload:
                raise ValueError(f"existing evidence differs: {path}")
        else:
            os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def materialize(inventory_path: Path, upstream_path: Path, output_dir: Path, run_id: str) -> dict[str, Any]:
    inventory = contract.validate_inventory(contract.load(inventory_path))
    upstream = contract.validate_upstream(contract.load(upstream_path))
    if inventory["sourceLockDigest"] != contract.digest(upstream):
        raise ValueError("upstream lock differs from the inventory source-lock digest")

    entries = {item["repository"]: item for item in inventory["images"]}
    seed_images = []
    for upstream_item in upstream["images"]:
        repository = upstream_item["repository"]
        item = entries[repository]
        destination = item["ref"]
        if item["provenance"] != {"kind": "mirror", "source": upstream_item["source"]}:
            raise ValueError(f"mirror provenance differs for {repository}")
        seed_images.append({
            "repository": repository,
            "source": upstream_item["source"],
            "destination": destination,
            "destinationDigest": destination.rsplit("@", 1)[1],
        })
    seed = {
        "schemaVersion": 1,
        "result": "passed",
        "registry": inventory["registry"],
        "namespace": inventory["namespace"],
        "platform": inventory["platform"],
        "sourceLockDigest": inventory["sourceLockDigest"],
        "images": seed_images,
    }
    contract.validate_seed(seed, upstream)
    if contract.digest(seed) != inventory["seedReceiptDigest"]:
        raise ValueError("materialized seed receipt differs from the inventory digest")

    product_entries = []
    product_files: dict[str, bytes] = {}
    for repository in sorted(contract.PRODUCT_REPOSITORIES):
        item = entries[repository]
        provenance = item["provenance"]
        dependencies = [
            {"repository": dependency, "ref": entries[dependency]["ref"]}
            for dependency in sorted(product_lock.DEPENDENCIES[repository])
        ]
        receipt = product_lock.make_receipt(
            repository, item["ref"], provenance["sourceRevision"],
            provenance["sourceManifestDigest"], dependencies,
        )
        payload = encoded(receipt)
        if sha256(payload) != provenance["buildReceiptDigest"]:
            raise ValueError(f"materialized product receipt differs for {repository}")
        product_files[repository] = payload
        product_entries.append({
            "repository": repository,
            "ref": item["ref"],
            "sourceRevision": provenance["sourceRevision"],
            "sourceManifestDigest": provenance["sourceManifestDigest"],
            "buildReceiptDigest": provenance["buildReceiptDigest"],
        })
    product = {
        "schemaVersion": 1,
        "registry": inventory["registry"],
        "namespace": inventory["namespace"],
        "images": product_entries,
    }
    contract.validate_product(product, inventory["registry"], inventory["namespace"])
    if contract.assemble(upstream, seed, product) != inventory:
        raise ValueError("materialized generation does not reproduce the complete inventory")

    seed_path = output_dir / f"image-seed-{run_id}.json"
    product_path = output_dir / f"product-images-{run_id}.json"
    publish_exact(seed_path, encoded(seed))
    publish_exact(product_path, encoded(product))
    products = []
    for repository, payload in sorted(product_files.items()):
        path = output_dir / f"product-{repository}-{run_id}.json"
        publish_exact(path, payload)
        products.append({"repository": repository, "path": str(path), "sha256": sha256(payload)})

    receipt = {
        "schema": "actor-image-generation-evidence-materialization/v1",
        "verdict": "passed",
        "inventory": {
            "path": str(inventory_path.resolve()),
            "fileSha256": sha256(inventory_path.read_bytes()),
            "inventoryDigest": inventory["inventoryDigest"],
        },
        "upstream": {"path": str(upstream_path.resolve()), "sha256": contract.digest(upstream)},
        "seed": {"path": str(seed_path), "sha256": contract.digest(seed)},
        "productLock": {"path": str(product_path), "sha256": contract.digest(product)},
        "products": products,
    }
    receipt_path = output_dir / f"generation-evidence-{run_id}.json"
    publish_exact(receipt_path, encoded(receipt))
    return {"receipt": str(receipt_path), "productReceiptDir": str(output_dir)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if not RUN_ID.fullmatch(args.run_id):
        parser.error("--run-id must contain 32 lowercase hexadecimal characters")
    if not args.inventory.is_file() or not args.upstream.is_file() or not args.output_dir.is_absolute():
        parser.error("inputs must be files and --output-dir must be absolute")
    try:
        result = materialize(args.inventory, args.upstream, args.output_dir, args.run_id)
    except (ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
