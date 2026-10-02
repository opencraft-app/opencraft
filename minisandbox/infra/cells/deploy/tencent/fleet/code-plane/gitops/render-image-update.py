#!/usr/bin/env python3
"""Render a receipt-bound image-only update for the regional code plane."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

import yaml


EXPECTED = {
    "evidence.json",
    "kustomization.yaml",
    "fdb-cluster.yaml",
    "fdb-backup.yaml",
    "worker-registry.yaml",
    "worker-registry-private.yaml",
}


def sha(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def inventory(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("desired tree contains a symlink")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = sha(path.read_bytes())
        elif not path.is_dir():
            raise ValueError("desired tree contains a special file")
    if set(result) != EXPECTED:
        raise ValueError("desired tree inventory differs")
    return result


def load(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain one object")
    return value


def selected_image(image_inventory: dict, repository: str) -> str:
    matches = [item for item in image_inventory.get("images", []) if item.get("repository") == repository]
    if len(matches) != 1:
        raise ValueError(f"image inventory must contain exactly one {repository} image")
    ref = matches[0].get("ref", "")
    if not isinstance(ref, str) or "@sha256:" not in ref or ref.split("@", 1)[0].rsplit("/", 1)[-1] != repository:
        raise ValueError("selected image is not a digest-pinned repository match")
    return ref


def render(source: Path, image_inventory_path: Path, repository: str):
    before = inventory(source)
    image_inventory = load(image_inventory_path)
    image = selected_image(image_inventory, repository)
    result = {name: (source / name).read_bytes() for name in EXPECTED}

    manifests = [item for item in yaml.safe_load_all(result["worker-registry.yaml"]) if item]
    deployments = [item for item in manifests if item.get("kind") == "Deployment" and item.get("metadata", {}).get("name") == "worker-registry"]
    if len(deployments) != 1:
        raise ValueError("worker-registry Deployment is missing or ambiguous")
    containers = deployments[0].get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    targets = [item for item in containers if item.get("name") == "worker-registry"]
    if len(targets) != 1:
        raise ValueError("worker-registry container is missing or ambiguous")
    old_image = targets[0].get("image", "")
    if old_image == image:
        raise ValueError("worker-registry already uses the selected image")
    if old_image.split("@", 1)[0] != image.split("@", 1)[0]:
        raise ValueError("image update changes the registry repository")
    targets[0]["image"] = image
    result["worker-registry.yaml"] = yaml.safe_dump_all(manifests, explicit_start=True, sort_keys=False).encode()

    evidence = json.loads(result["evidence.json"])
    if not isinstance(evidence, dict) or evidence.get("schema") != "actor-regional-code-plane-desired-evidence/v1":
        raise ValueError("regional code-plane evidence is invalid")
    update = {
        "kind": "image",
        "repository": repository,
        "from": old_image,
        "to": image,
        "imageInventorySha256": sha(image_inventory_path.read_bytes()),
        "priorDesiredFiles": before,
    }
    evidence.setdefault("updates", []).append(update)
    result["evidence.json"] = (json.dumps(evidence, indent=2, sort_keys=True) + "\n").encode()

    receipt = {
        "schema": "actor-regional-code-plane-desired-render/v1",
        "verdict": "passed",
        "managementId": evidence.get("managementId"),
        "files": {name: sha(value) for name, value in sorted(result.items())},
        "update": update,
    }
    return result, receipt


def publish(path: Path, value: bytes, mode: int = 0o644) -> None:
    descriptor, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        try:
            os.unlink(staged)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--image-inventory", type=Path, required=True)
    parser.add_argument("--repository", choices=("worker-registry",), required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        if not args.source.is_dir() or args.source.is_symlink():
            raise ValueError("source must be a real directory")
        if args.output_dir.exists() or not args.output_dir.parent.is_dir():
            raise ValueError("output-dir must be new")
        if not args.receipt.is_absolute() or args.receipt.exists() or not args.receipt.parent.is_dir():
            raise ValueError("receipt must be a new absolute path")
        files, receipt = render(args.source, args.image_inventory, args.repository)
        staged = Path(tempfile.mkdtemp(prefix=f".{args.output_dir.name}.", dir=args.output_dir.parent))
        try:
            for name, value in files.items():
                (staged / name).write_bytes(value)
            os.rename(staged, args.output_dir)
        finally:
            if staged.exists():
                shutil.rmtree(staged)
        publish(args.receipt, (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(str(error), file=os.sys.stderr)
        return 2
    print(json.dumps({"verdict": "passed", "desiredState": str(args.output_dir)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
