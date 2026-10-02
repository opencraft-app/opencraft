#!/usr/bin/env python3
"""Atomically advance one registered Cell to a reviewed Git publication."""

import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional


REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path) -> Dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def plan(
    secret: Dict[str, Any], publication: Dict[str, Any], expected_revision: str,
    publication_receipt_digest: str, platform_receipt_digest: Optional[str] = None,
) -> Dict[str, Any]:
    if publication.get("schema") != "actor-cell-desired-state-publication/v1" or publication.get("verdict") != "passed":
        raise ValueError("publication receipt did not pass")
    cell_id = publication.get("cellId")
    revision = publication.get("gitRevision")
    if not isinstance(cell_id, str) or not re.fullmatch(r"actor-[a-z]{2}-[a-z][0-9]{2}", cell_id):
        raise ValueError("publication Cell ID is invalid")
    if not isinstance(revision, str) or not REVISION.fullmatch(revision):
        raise ValueError("publication Git revision is invalid")
    if not REVISION.fullmatch(expected_revision):
        raise ValueError("expected Git revision is invalid")
    if not DIGEST.fullmatch(publication_receipt_digest):
        raise ValueError("publication receipt digest is invalid")
    if platform_receipt_digest is not None and not DIGEST.fullmatch(platform_receipt_digest):
        raise ValueError("platform receipt digest is invalid")
    for field in (
        "terraformInventoryDigest",
        "handoffReceiptDigest",
        "imageInventoryDigest",
        "profileDigest",
    ):
        if not isinstance(publication.get(field), str) or not DIGEST.fullmatch(publication[field]):
            raise ValueError(f"publication {field} is invalid")

    metadata = secret.get("metadata", {})
    labels = metadata.get("labels", {})
    annotations = metadata.get("annotations", {})
    if metadata.get("name") != f"actor-cell-{cell_id}" or metadata.get("namespace") != "argocd":
        raise ValueError("registered Cell Secret identity does not match publication")
    if labels.get("argocd.argoproj.io/secret-type") != "cluster" or labels.get("fleet.actor.dev/managed-cell") != "true":
        raise ValueError("target is not a managed Argo Cell Secret")
    if labels.get("fleet.actor.dev/cell-id") != cell_id or labels.get("fleet.actor.dev/desired-state") != "published":
        raise ValueError("registered Cell labels do not match publication")
    if annotations.get("fleet.actor.dev/git-revision") != expected_revision:
        raise ValueError("registered Cell revision moved since review")
    if not metadata.get("uid") or not metadata.get("resourceVersion"):
        raise ValueError("registered Cell Secret lacks Kubernetes CAS identity")

    result = copy.deepcopy(secret)
    result_metadata = result["metadata"]
    for field in ("managedFields", "creationTimestamp", "generation"):
        result_metadata.pop(field, None)
    result.pop("status", None)
    promoted = result_metadata.setdefault("annotations", {})
    promoted.update({
        "fleet.actor.dev/git-revision": revision,
        "fleet.actor.dev/inventory-digest": publication["terraformInventoryDigest"],
        "fleet.actor.dev/handoff-receipt-digest": publication["handoffReceiptDigest"],
        "fleet.actor.dev/publication-receipt-digest": publication_receipt_digest,
        "fleet.actor.dev/image-inventory-digest": publication["imageInventoryDigest"],
        "fleet.actor.dev/profile-digest": publication["profileDigest"],
    })
    if platform_receipt_digest is not None:
        promoted["fleet.actor.dev/platform-receipt-digest"] = platform_receipt_digest
    return result


def validate_platform(platform: Dict[str, Any], publication: Dict[str, Any]) -> None:
    if platform.get("schema") != "actor-create-first-cell-platform/v1" or platform.get("verdict") != "passed":
        raise ValueError("Cell platform receipt did not pass")
    if platform.get("cellId") != publication.get("cellId"):
        raise ValueError("Cell platform receipt belongs to another Cell")
    if platform.get("imageInventoryDigest") != publication.get("imageInventoryDigest"):
        raise ValueError("Cell platform image inventory differs from publication")
    if platform.get("profile", {}).get("digest") != publication.get("profileDigest"):
        raise ValueError("Cell platform profile differs from publication")


def run(*arguments: str, **kwargs: Any) -> str:
    stdin = kwargs.pop("stdin", None)
    if kwargs:
        raise TypeError("unexpected run options")
    completed = subprocess.run(
        arguments, input=stdin, universal_newlines=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
    )
    return completed.stdout


def write_new(path: Path, value: Dict[str, Any]) -> None:
    if not path.is_absolute() or path.exists() or not path.parent.is_dir():
        raise ValueError("promotion receipt must be a new absolute path with an existing parent")
    descriptor, staged_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    staged = Path(staged_name)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        try:
            staged.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub-kubeconfig", required=True, type=Path)
    parser.add_argument("--publication-receipt", required=True, type=Path)
    parser.add_argument("--platform-receipt", type=Path)
    parser.add_argument("--expected-revision", required=True)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()

    publication = load_json(args.publication_receipt)
    publication_receipt_digest = sha256(args.publication_receipt)
    platform_receipt_digest = None
    if args.platform_receipt is not None:
        platform = load_json(args.platform_receipt)
        validate_platform(platform, publication)
        platform_receipt_digest = sha256(args.platform_receipt)
    cell_id = publication.get("cellId", "")
    secret_name = f"actor-cell-{cell_id}"
    common = ("kubectl", "--kubeconfig", str(args.hub_kubeconfig), "-n", "argocd")
    before = json.loads(run(*common, "get", "secret", secret_name, "-o", "json"))
    replacement = plan(
        before, publication, args.expected_revision,
        publication_receipt_digest, platform_receipt_digest,
    )
    run(*common, "replace", "-f", "-", stdin=json.dumps(replacement, separators=(",", ":")))
    after = json.loads(run(*common, "get", "secret", secret_name, "-o", "json"))
    if after.get("metadata", {}).get("uid") != before.get("metadata", {}).get("uid"):
        raise ValueError("registered Cell Secret identity changed during promotion")
    expected = plan(
        before, publication, args.expected_revision,
        publication_receipt_digest, platform_receipt_digest,
    )["metadata"]["annotations"]
    actual = after.get("metadata", {}).get("annotations", {})
    for key, value in expected.items():
        if actual.get(key) != value:
            raise ValueError(f"registered Cell promotion did not persist {key}")

    receipt = {
        "schema": "actor-cell-publication-promotion/v1",
        "verdict": "passed",
        "cellId": cell_id,
        "fromRevision": args.expected_revision,
        "toRevision": publication["gitRevision"],
        "publicationReceiptDigest": publication_receipt_digest,
        "platformReceiptDigest": platform_receipt_digest,
        "profileDigest": publication["profileDigest"],
        "imageInventoryDigest": publication["imageInventoryDigest"],
        "argoClusterSecret": {
            "name": secret_name,
            "uid": after["metadata"]["uid"],
            "resourceVersion": after["metadata"]["resourceVersion"],
        },
    }
    write_new(args.receipt, receipt)
    print(json.dumps({"cellPromotion": "passed", "cell": cell_id, "revision": publication["gitRevision"], "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
