#!/usr/bin/env python3
"""Validate upstream locks and assemble the complete TCR image inventory."""

import argparse
import json
import os
from pathlib import Path
import tempfile

from image_contract import (
    ALL_REPOSITORIES, assemble, digest, load, resolve, validate_inventory, validate_upstream,
)


def write_new_json(path: Path, value: dict) -> None:
    """Publish a complete immutable file without a check-then-overwrite race."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
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
    # Tencent bootstrap images still ship Python 3.6. Keep this utility usable
    # there: argparse did not gain required= for subparsers until Python 3.7.
    subparsers = parser.add_subparsers(dest="command")
    validate = subparsers.add_parser("validate-upstream")
    validate.add_argument("--lock", required=True, type=Path)
    validate.add_argument("--emit-tsv", action="store_true")
    inventory = subparsers.add_parser("validate-inventory")
    inventory.add_argument("--lock", required=True, type=Path)
    lookup = subparsers.add_parser("resolve")
    lookup.add_argument("--lock", required=True, type=Path)
    lookup.add_argument("--repository", required=True)
    lookup.add_argument(
        "--field",
        choices=("ref", "source-revision", "source-manifest-digest", "build-receipt-digest"),
        default="ref",
    )
    subparsers.add_parser("required-repositories")
    build = subparsers.add_parser("assemble")
    build.add_argument("--upstream-lock", required=True, type=Path)
    build.add_argument("--seed-receipt", required=True, type=Path)
    build.add_argument("--product-lock", required=True, type=Path)
    build.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if args.command is None:
        parser.error("a command is required")

    if args.command == "required-repositories":
        for repository in sorted(ALL_REPOSITORIES):
            print(repository)
        return 0
    if args.command == "validate-upstream":
        lock = validate_upstream(load(args.lock))
        if args.emit_tsv:
            for item in lock["images"]:
                print("\t".join((item["component"], item["repository"], item["source"])))
        else:
            print(json.dumps({
                "schemaVersion": lock["schemaVersion"],
                "platform": lock["platform"],
                "images": len(lock["images"]),
                "lockDigest": digest(lock),
            }, sort_keys=True))
        return 0
    if args.command == "validate-inventory":
        result = validate_inventory(load(args.lock))
        print(json.dumps({
            "schemaVersion": result["schemaVersion"],
            "images": len(result["images"]),
            "inventoryDigest": result["inventoryDigest"],
        }, sort_keys=True))
        return 0
    if args.command == "resolve":
        item = resolve(load(args.lock), args.repository)
        if args.field == "ref":
            print(item["ref"])
            return 0
        if item["provenance"].get("kind") != "build":
            parser.error(f"{args.field} is available only for product images")
        field = {
            "source-revision": "sourceRevision",
            "source-manifest-digest": "sourceManifestDigest",
            "build-receipt-digest": "buildReceiptDigest",
        }[args.field]
        print(item["provenance"][field])
        return 0
    if args.output.exists() or not args.output.is_absolute():
        parser.error("--output must be a new absolute path")
    result = assemble(load(args.upstream_lock), load(args.seed_receipt), load(args.product_lock))
    write_new_json(args.output, result)
    print(json.dumps({
        "output": str(args.output),
        "images": len(result["images"]),
        "inventoryDigest": result["inventoryDigest"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
