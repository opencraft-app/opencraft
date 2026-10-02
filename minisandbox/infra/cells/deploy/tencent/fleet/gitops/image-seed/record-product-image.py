#!/usr/bin/env python3
"""Cold-pull one exact product image before publishing its build receipt."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("actor_product_lock", ROOT / "product-lock.py")
PRODUCT_LOCK = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(PRODUCT_LOCK)


def labels_from_inspect(value: dict[str, Any]) -> dict[str, str]:
    candidates = (
        value.get("Docker", {}).get("config", {}).get("Labels"),
        value.get("OCIv1", {}).get("config", {}).get("Labels"),
    )
    merged: dict[str, str] = {}
    for labels in candidates:
        if isinstance(labels, dict) and all(
            isinstance(key, str) and isinstance(item, str) for key, item in labels.items()
        ):
            merged.update(labels)
    if merged:
        return merged
    raise ValueError("pulled image has no string OCI labels")


def verify_labels(labels: dict[str, str], source_revision: str, source_manifest_digest: str) -> None:
    revisions = {
        labels.get("org.opencontainers.image.revision"),
        labels.get("fleet.actor.dev/source-revision"),
    } - {None}
    if revisions != {source_revision}:
        raise ValueError("pulled image source revision label differs from the reviewed source")
    expected_manifest = (
        source_manifest_digest[7:]
        if source_manifest_digest.startswith("sha256:")
        else source_manifest_digest
    )
    if labels.get("fleet.actor.dev/source-manifest-sha256") != expected_manifest:
        raise ValueError("pulled image source manifest label differs from the reviewed source")


def cold_pull(
    ref: str, auth_file: Path, source_revision: str, source_manifest_digest: str,
) -> None:
    # Never use Buildah's default graph. Product builders have just created
    # this image, so their normal local graph is a warm cache and cannot prove
    # that TCR can serve the exact digest to a replacement node.
    with tempfile.TemporaryDirectory(prefix="actor-product-cold-pull.", dir="/data/tmp") as temporary:
        buildah = os.environ.get("BUILDAH", "buildah")
        storage = (
            buildah, "--root", f"{temporary}/storage", "--runroot", f"{temporary}/runroot",
            "--storage-driver", "vfs",
        )
        pulled = subprocess.run(
            (*storage, "pull", "--quiet", "--authfile", str(auth_file), f"docker://{ref}"),
            check=True,
            capture_output=True,
            text=True,
        )
        image_id = pulled.stdout.strip().splitlines()[-1] if pulled.stdout.strip() else ""
        if not image_id:
            raise ValueError("isolated registry pull returned no image identity")
        inspected = subprocess.run(
            (*storage, "inspect", "--type", "image", image_id),
            check=True,
            capture_output=True,
            text=True,
        )
        value = json.loads(inspected.stdout)
        if not isinstance(value, dict):
            raise ValueError("buildah inspect did not return a JSON object")
        verify_labels(labels_from_inspect(value), source_revision, source_manifest_digest)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-manifest-digest", required=True)
    parser.add_argument("--dependency", action="append", type=PRODUCT_LOCK.parse_dependency, default=[])
    parser.add_argument("--registry-auth-file", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if (
        args.registry_auth_file.is_symlink()
        or not args.registry_auth_file.is_file()
        or args.registry_auth_file.stat().st_mode & 0o077
    ):
        parser.error("--registry-auth-file must be a private regular non-symlink file")
    try:
        receipt = PRODUCT_LOCK.make_receipt(
            args.repository,
            args.ref,
            args.source_revision,
            args.source_manifest_digest,
            args.dependency,
        )
        cold_pull(args.ref, args.registry_auth_file, args.source_revision, args.source_manifest_digest)
        PRODUCT_LOCK.write_new(args.output, receipt)
    except (ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(json.dumps({"output": str(args.output), "digest": PRODUCT_LOCK.digest(receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
