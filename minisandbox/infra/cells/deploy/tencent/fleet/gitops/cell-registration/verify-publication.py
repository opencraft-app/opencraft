#!/usr/bin/env python3
"""Verify that one immutable Git publication is the exact Terraform handoff."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"{name} verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def load(path: Path, name: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value


def verify(
    inventory_path: Path,
    handoff_path: Path,
    desired_root: Path,
    publication_path: Path,
    expected_revision: str | None = None,
) -> dict[str, Any]:
    handoff = load_module("publication_handoff", ROOT / "verify-handoff.py").verify(
        inventory_path, handoff_path, desired_root,
    )
    publication = load(publication_path, "publication receipt")
    if (publication.get("schema"), publication.get("verdict")) != (
        "actor-cell-desired-state-publication/v1", "passed",
    ):
        raise ValueError("desired-state publication receipt did not pass")
    for name in (
        "cellId", "terraformInventoryDigest", "handoffReceiptDigest",
        "imageInventoryDigest", "profileDigest",
    ):
        if publication.get(name) != handoff.get(name):
            raise ValueError(f"desired-state publication {name} differs from the handoff")
    revision = publication.get("gitRevision")
    if not isinstance(revision, str) or not REVISION.fullmatch(revision):
        raise ValueError("desired-state publication revision is not immutable")
    if expected_revision is not None and revision != expected_revision:
        raise ValueError("desired-state publication revision differs from registration")
    repository = publication.get("repository")
    if not isinstance(repository, dict) or set(repository) != {"url", "branch", "path"}:
        raise ValueError("desired-state publication repository identity is invalid")
    publisher = load_module("publication_url", ROOT / "publish-desired-state.py")
    publisher.validate_repository_url(repository.get("url"), allow_local=True)
    publisher.validate_branch(repository.get("branch"))
    if repository.get("path") != f"cells/{handoff['cellId']}":
        raise ValueError("desired-state publication path differs from the Cell")
    raw_handoff = load(handoff_path, "handoff receipt")
    expected_files = dict(raw_handoff["files"])
    expected_files["handoff-receipt.json"] = digest(handoff_path.read_bytes())
    if publication.get("files") != expected_files:
        raise ValueError("desired-state publication file inventory differs from the handoff")
    return {
        **handoff,
        "publicationReceiptDigest": digest(publication_path.read_bytes()),
        "gitRevision": revision,
        "repository": repository,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--handoff-receipt", required=True, type=Path)
    parser.add_argument("--desired-root", required=True, type=Path)
    parser.add_argument("--publication-receipt", required=True, type=Path)
    parser.add_argument("--git-revision")
    args = parser.parse_args()
    print(json.dumps(verify(
        args.inventory,
        args.handoff_receipt,
        args.desired_root,
        args.publication_receipt,
        args.git_revision,
    ), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
