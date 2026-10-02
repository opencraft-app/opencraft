#!/usr/bin/env python3
"""Revalidate reviewed regional mirrors without pretending to copy upstream."""

import argparse
import importlib.util
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from image_contract import digest, load, validate_inventory, validate_seed, validate_upstream


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("regional_product_lock", ROOT / "product-lock.py")
PRODUCT_LOCK = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(PRODUCT_LOCK)
IMAGE_ID = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")


def plan(inventory, upstream, registry, expected_inventory_digest):
    inventory = validate_inventory(inventory)
    upstream = validate_upstream(upstream)
    if inventory["inventoryDigest"] != expected_inventory_digest:
        raise ValueError("inventory differs from the explicitly reviewed digest")
    if inventory["registry"] != registry:
        raise ValueError("inventory differs from the exact regional registry")
    if inventory["sourceLockDigest"] != digest(upstream):
        raise ValueError("inventory does not bind the reviewed upstream lock")
    current = {item["repository"]: item for item in inventory["images"]}
    images = []
    for item in upstream["images"]:
        mirrored = current[item["repository"]]
        if mirrored["provenance"] != {"kind": "mirror", "source": item["source"]}:
            raise ValueError("regional mirror provenance differs from the reviewed source")
        images.append({
            "repository": item["repository"],
            "source": item["source"],
            "destination": mirrored["ref"],
            "destinationDigest": mirrored["ref"].split("@", 1)[1],
        })
    seed = {
        "schemaVersion": 1, "result": "passed", "registry": registry,
        "namespace": "actor-fleet", "platform": "linux/amd64",
        "sourceLockDigest": digest(upstream), "images": images,
    }
    return validate_seed(seed, upstream)


def new_outputs(outputs, inputs):
    resolved = set()
    for path in outputs:
        if not path.is_absolute() or path.exists() or path.is_symlink():
            raise ValueError("outputs must be new absolute non-symlink paths")
        actual = path.resolve()
        if actual in resolved or actual in {item.resolve() for item in inputs}:
            raise ValueError("outputs must be distinct from each other and all inputs")
        resolved.add(actual)


def cold_pull(ref, auth_file):
    # A separate empty graph per image prevents shared layers from warming another pull.
    with tempfile.TemporaryDirectory(prefix="actor-regional-seed-cold.", dir="/data/tmp") as directory:
        command = (
            os.environ.get("BUILDAH", "buildah"), "--root", directory + "/storage",
            "--runroot", directory + "/runroot", "--storage-driver", "vfs",
        )
        pulled = subprocess.run(
            (*command, "pull", "--quiet", "--platform", "linux/amd64",
             "--authfile", str(auth_file), "docker://" + ref),
            check=True, capture_output=True, text=True, timeout=600,
        )
        identity = pulled.stdout.strip()
        if not IMAGE_ID.fullmatch(identity):
            raise ValueError("regional cold pull returned an invalid local image identity")
        inspected = subprocess.run(
            (*command, "inspect", "--type", "image", identity),
            check=True, capture_output=True, text=True, timeout=60,
        )
        value = json.loads(inspected.stdout)
        if not isinstance(value, dict):
            raise ValueError("regional image inspect must return an object")
        platforms = []
        for name in ("Docker", "OCIv1"):
            config = value.get(name)
            if isinstance(config, dict) and (config.get("os") or config.get("architecture")):
                platforms.append((config.get("os"), config.get("architecture")))
        if not platforms or any(item != ("linux", "amd64") for item in platforms):
            raise ValueError("regional image platform is not exactly linux/amd64")
        return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--expected-inventory-digest", required=True)
    parser.add_argument("--upstream-lock", required=True, type=Path)
    parser.add_argument("--registry", required=True)
    parser.add_argument("--registry-auth-file", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--proof-output", required=True, type=Path)
    args = parser.parse_args()
    try:
        auth = args.registry_auth_file
        if (not auth.is_absolute() or auth.is_symlink() or not auth.is_file()
                or auth.stat().st_mode & 0o777 != 0o600 or auth.stat().st_uid != os.geteuid()):
            raise ValueError("registry auth must be an owned private 0600 regular non-symlink file")
        new_outputs((args.output, args.proof_output), (args.inventory, args.upstream_lock, auth))
        inventory = load(args.inventory)
        upstream = load(args.upstream_lock)
        seed = plan(inventory, upstream, args.registry, args.expected_inventory_digest)
        verified = []
        for item in seed["images"]:
            identity = cold_pull(item["destination"], auth)
            verified.append({
                "repository": item["repository"], "ref": item["destination"],
                "localImageId": identity, "platform": "linux/amd64", "coldPullVerified": True,
            })
            print("regional_image_verified repository=" + item["repository"], flush=True)
        proof = {
            "schema": "actor-regional-image-seed-revalidation/v1", "result": "passed",
            "mode": "regional_revalidation", "originEvidence": "inherited_reviewed_inventory",
            "inventoryDigest": inventory["inventoryDigest"], "sourceLockDigest": seed["sourceLockDigest"],
            "seedReceiptDigest": digest(seed), "registry": args.registry,
            "namespace": "actor-fleet", "platform": "linux/amd64",
            "verification": "separate_empty_buildah_vfs_per_image", "images": verified,
        }
        # Publish the explicit proof first. A seed without its proof is never a completed operation.
        PRODUCT_LOCK.write_new(args.proof_output, proof)
        PRODUCT_LOCK.write_new(args.output, seed)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        parser.error("regional registry cold pull or inspect failed; no seed was published")
    except (OSError, ValueError, TypeError, KeyError):
        parser.error("regional seed preflight, platform verification or immutable publication failed")
    print(json.dumps({"result": "passed", "images": len(verified), "seedReceiptDigest": digest(seed),
                      "proofDigest": digest(proof)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
