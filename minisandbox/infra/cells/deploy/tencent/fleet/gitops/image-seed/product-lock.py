#!/usr/bin/env python3
"""Publish immutable product build receipts and assemble their dependency-closed lock."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from image_contract import (
    DIGEST, IMAGE, PRODUCT_REPOSITORIES, REVISION, digest, validate_inventory,
)


SCHEMA = "actor-product-image-build/v1"
DEPENDENCIES = {
    "actor-fleet-controller": frozenset({"base-golang", "base-distroless"}),
    "actor-loadgen": frozenset({"base-golang"}),
    "base-distroless": frozenset(),
    "base-golang": frozenset(),
    "base-tencentcloud-cli": frozenset(),
    "git-service": frozenset(),
    "release-hook": frozenset({"base-tencentcloud-cli"}),
    "rivet-runtime": frozenset({"runtime-base"}),
    "runtime-base": frozenset(),
    "worker-registry": frozenset({"base-golang", "base-distroless"}),
    "workers-api": frozenset({"base-golang", "base-distroless"}),
}
REF = re.compile(r"^(?P<registry>[a-z0-9][a-z0-9.-]*\.tencentcloudcr\.com)/(?P<namespace>[a-z0-9._-]+)/(?P<repository>[a-z0-9][a-z0-9._-]+)@sha256:[0-9a-f]{64}$")
FOUNDATION_REPOSITORIES = frozenset(
    dependency for dependencies in DEPENDENCIES.values() for dependency in dependencies
)


def exact_keys(value: dict[str, Any], expected: set[str], name: str) -> None:
    if set(value) != expected:
        raise ValueError(f"{name} schema differs: expected={sorted(expected)} actual={sorted(value)}")


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def validate_receipt(value: dict[str, Any]) -> dict[str, Any]:
    exact_keys(
        value,
        {
            "schema", "verdict", "repository", "ref", "sourceRevision",
            "sourceManifestDigest", "dependencies", "registryPullVerified",
        },
        "product build receipt",
    )
    if value["schema"] != SCHEMA or value["verdict"] != "passed":
        raise ValueError("product build receipt did not pass")
    repository = value["repository"]
    if repository not in PRODUCT_REPOSITORIES:
        raise ValueError("product build receipt repository is unknown")
    match = REF.fullmatch(str(value["ref"]))
    if match is None or match.group("repository") != repository:
        raise ValueError("product build receipt ref does not name its exact TCR repository")
    if match.group("namespace") != "actor-fleet":
        raise ValueError("product build receipt namespace must be actor-fleet")
    if REVISION.fullmatch(str(value["sourceRevision"])) is None:
        raise ValueError("product build receipt source revision is invalid")
    if DIGEST.fullmatch(str(value["sourceManifestDigest"])) is None:
        raise ValueError("product build receipt source manifest digest is invalid")
    if value["registryPullVerified"] is not True:
        raise ValueError("product build receipt lacks exact registry pull verification")
    dependencies = value["dependencies"]
    if not isinstance(dependencies, list):
        raise ValueError("product build receipt dependencies must be a list")
    found: dict[str, str] = {}
    for index, dependency in enumerate(dependencies):
        if not isinstance(dependency, dict):
            raise ValueError(f"product dependency {index} must be an object")
        exact_keys(dependency, {"repository", "ref"}, f"product dependency {index}")
        name, ref = dependency["repository"], dependency["ref"]
        if name in found or name not in PRODUCT_REPOSITORIES or IMAGE.fullmatch(str(ref)) is None:
            raise ValueError("product build receipt has an invalid or duplicate dependency")
        found[name] = ref
    if set(found) != DEPENDENCIES[repository]:
        raise ValueError(
            f"product dependency set differs for {repository}: "
            f"expected={sorted(DEPENDENCIES[repository])} actual={sorted(found)}"
        )
    if dependencies != sorted(dependencies, key=lambda item: item["repository"]):
        raise ValueError("product build receipt dependencies must use canonical order")
    return value


def make_receipt(
    repository: str, ref: str, source_revision: str, source_manifest_digest: str,
    dependencies: list[dict[str, str]],
) -> dict[str, Any]:
    value = {
        "schema": SCHEMA,
        "verdict": "passed",
        "repository": repository,
        "ref": ref,
        "sourceRevision": source_revision,
        "sourceManifestDigest": source_manifest_digest,
        "dependencies": sorted(dependencies, key=lambda item: item["repository"]),
        "registryPullVerified": True,
    }
    return validate_receipt(value)


def assemble(receipt_paths: list[Path]) -> dict[str, Any]:
    if len(receipt_paths) != len(PRODUCT_REPOSITORIES):
        raise ValueError(f"exactly {len(PRODUCT_REPOSITORIES)} product receipts are required")
    by_repository: dict[str, tuple[dict[str, Any], Path]] = {}
    for path in receipt_paths:
        value = validate_receipt(load(path))
        repository = value["repository"]
        if repository in by_repository:
            raise ValueError(f"duplicate product receipt: {repository}")
        by_repository[repository] = (value, path)
    if set(by_repository) != PRODUCT_REPOSITORIES:
        raise ValueError(
            f"product receipts are incomplete: missing={sorted(PRODUCT_REPOSITORIES - set(by_repository))}"
        )
    registries = {REF.fullmatch(item[0]["ref"]).group("registry") for item in by_repository.values()}
    if len(registries) != 1:
        raise ValueError("product receipts target more than one TCR registry")
    for repository, (receipt, _) in by_repository.items():
        for dependency in receipt["dependencies"]:
            expected = by_repository[dependency["repository"]][0]["ref"]
            if dependency["ref"] != expected:
                raise ValueError(f"{repository} dependency is outside the assembled product lock: {dependency['repository']}")
    images = []
    for repository, (receipt, path) in sorted(by_repository.items()):
        images.append({
            "repository": repository,
            "ref": receipt["ref"],
            "sourceRevision": receipt["sourceRevision"],
            "sourceManifestDigest": receipt["sourceManifestDigest"],
            "buildReceiptDigest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    return {
        "schemaVersion": 1,
        "registry": next(iter(registries)),
        "namespace": "actor-fleet",
        "images": images,
    }


def promote(inventory: dict[str, Any], receipt_paths: list[Path]) -> dict[str, Any]:
    """Atomically replace leaf products in an existing complete inventory."""
    inventory = validate_inventory(inventory)
    if not receipt_paths:
        raise ValueError("at least one product receipt is required")
    receipts: dict[str, tuple[dict[str, Any], Path]] = {}
    for path in receipt_paths:
        receipt = validate_receipt(load(path))
        repository = receipt["repository"]
        if repository in receipts:
            raise ValueError(f"duplicate product receipt: {repository}")
        if repository in FOUNDATION_REPOSITORIES:
            raise ValueError(
                f"foundation product requires a complete generation rebuild: {repository}"
            )
        match = REF.fullmatch(receipt["ref"])
        assert match is not None
        if (
            match.group("registry") != inventory["registry"]
            or match.group("namespace") != inventory["namespace"]
        ):
            raise ValueError("product receipt target differs from the existing inventory")
        receipts[repository] = (receipt, path)

    current = {item["repository"]: item["ref"] for item in inventory["images"]}
    for repository, (receipt, _) in receipts.items():
        for dependency in receipt["dependencies"]:
            if dependency["ref"] != current[dependency["repository"]]:
                raise ValueError(
                    f"{repository} dependency differs from the existing inventory: "
                    f"{dependency['repository']}"
                )

    result = json.loads(json.dumps(inventory))
    by_repository = {item["repository"]: item for item in result["images"]}
    for repository, (receipt, path) in receipts.items():
        by_repository[repository]["ref"] = receipt["ref"]
        by_repository[repository]["provenance"] = {
            "kind": "build",
            "sourceRevision": receipt["sourceRevision"],
            "sourceManifestDigest": receipt["sourceManifestDigest"],
            "buildReceiptDigest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
        }
    result.pop("inventoryDigest", None)
    result["inventoryDigest"] = digest(result)
    return validate_inventory(result)


def write_new(path: Path, value: dict[str, Any]) -> None:
    if not path.is_absolute() or path.exists():
        raise ValueError("output must be a new absolute path")
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


def parse_dependency(value: str) -> dict[str, str]:
    name, separator, ref = value.partition("=")
    if not separator:
        raise argparse.ArgumentTypeError("dependency must use repository=ref")
    return {"repository": name, "ref": ref}


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("required-repositories")
    check = commands.add_parser("validate")
    check.add_argument("--receipt", required=True, type=Path)
    build = commands.add_parser("assemble")
    build.add_argument("--receipt", action="append", required=True, type=Path)
    build.add_argument("--output", required=True, type=Path)
    promotion = commands.add_parser("promote")
    promotion.add_argument("--inventory", required=True, type=Path)
    promotion.add_argument("--receipt", action="append", required=True, type=Path)
    promotion.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "required-repositories":
        for repository in sorted(PRODUCT_REPOSITORIES):
            print(repository)
        return 0
    if args.command == "validate":
        if not args.receipt.is_file():
            parser.error("--receipt must be a regular file")
        result = validate_receipt(load(args.receipt))
        print(result["ref"])
        return 0
    if args.command == "promote":
        if not args.inventory.is_file() or any(not path.is_file() for path in args.receipt):
            parser.error("inventory and every receipt must be regular files")
        try:
            result = promote(load(args.inventory), args.receipt)
            write_new(args.output, result)
        except (ValueError, json.JSONDecodeError) as error:
            parser.error(str(error))
        print(json.dumps({"output": str(args.output), "digest": result["inventoryDigest"]}, sort_keys=True))
        return 0
    if any(not path.is_file() for path in args.receipt):
        parser.error("every --receipt must be a regular file")
    result = assemble(args.receipt)
    write_new(args.output, result)
    print(json.dumps({"output": str(args.output), "digest": digest(result)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
