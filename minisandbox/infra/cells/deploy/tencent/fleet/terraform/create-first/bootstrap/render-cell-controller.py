#!/usr/bin/env python3
"""Render the Cell-local Fleet controller with one reviewed private image."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

import yaml


SOURCE_IMAGE = "ghcr.io/skipzhang/actor-fleet-controller:dev"
DIGEST_REF = re.compile(r"^[^\s]+@sha256:[0-9a-f]{64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")


def render(raw: str, image: str, inventory_digest: str, revision: str, manifest_sha256: str) -> list[dict[str, Any]]:
    if DIGEST_REF.fullmatch(image) is None:
        raise ValueError("Cell controller image must be a registry digest")
    if re.fullmatch(r"sha256:[0-9a-f]{64}", inventory_digest) is None:
        raise ValueError("image inventory digest is invalid")
    if REVISION.fullmatch(revision) is None or SHA256.fullmatch(manifest_sha256) is None:
        raise ValueError("Cell controller source identity is invalid")
    documents = [item for item in yaml.safe_load_all(raw) if item]
    deployments = [item for item in documents if item.get("kind") == "Deployment"]
    if len(deployments) != 1:
        raise ValueError("Cell controller rendering requires exactly one Deployment")
    deployment = deployments[0]
    metadata = deployment.get("metadata", {})
    if (
        metadata.get("name") != "fdb-operator-actor-fleet-controller"
        or metadata.get("namespace") != "fdb-operator-actor-fleet-controller-system"
    ):
        raise ValueError("unexpected Cell controller identity")
    template = deployment["spec"]["template"]
    pod = template["spec"]
    containers = pod.get("containers", [])
    if len(containers) != 1 or containers[0].get("name") != "manager" or containers[0].get("image") != SOURCE_IMAGE:
        raise ValueError("Cell controller source image contract changed")
    if pod.get("imagePullSecrets") != [{"name": "actor-fleet-tcr"}]:
        raise ValueError("Cell controller must use the scoped pull Secret")
    containers[0]["image"] = image
    annotations = template.setdefault("metadata", {}).setdefault("annotations", {})
    annotations.update({
        "fleet.actor.dev/image-inventory-digest": inventory_digest,
        "fleet.actor.dev/source-commit": revision,
        "fleet.actor.dev/source-manifest-sha256": manifest_sha256,
    })
    return documents


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--inventory-digest", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-manifest-sha256", required=True)
    args = parser.parse_args()
    try:
        documents = render(
            args.input.read_text(), args.image, args.inventory_digest,
            args.source_revision, args.source_manifest_sha256,
        )
        args.output.write_text(yaml.safe_dump_all(documents, explicit_start=True, sort_keys=False))
    except (KeyError, OSError, TypeError, ValueError, yaml.YAMLError) as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
