#!/usr/bin/env python3
"""Render the FDB Operator install with exact private image identities."""

import argparse
import re
import sys
from pathlib import Path
from typing import Any, Dict, List

import yaml


SOURCE_OPERATOR = "foundationdb/fdb-kubernetes-operator@sha256:0b1538e0e6b87ac580c9874a22bee452cf0c2ccc618339f81c4ebe01627bfb2d"
SOURCE_MONITOR = "foundationdb/fdb-kubernetes-monitor@sha256:45f5b7632984a4835326f45a7bcfd662886db64d82333796ee14cbb3a7537c8c"
DIGEST_REF = re.compile(r"^[^\s]+@sha256:[0-9a-f]{64}$")


def render(raw: str, operator_image: str, monitor_image: str, inventory_digest: str) -> List[Dict[str, Any]]:
    replacements = {SOURCE_OPERATOR: operator_image, SOURCE_MONITOR: monitor_image}
    if any(DIGEST_REF.fullmatch(value) is None for value in replacements.values()):
        raise ValueError("private FDB images must be pinned registry digests")
    if re.fullmatch(r"sha256:[0-9a-f]{64}", inventory_digest) is None:
        raise ValueError("image inventory digest is invalid")

    documents = [item for item in yaml.safe_load_all(raw) if item]
    seen = {source: 0 for source in replacements}

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            if "image" in value:
                image = value["image"]
                if image not in replacements:
                    raise ValueError(f"unreviewed FDB Operator image: {image}")
                value["image"] = replacements[image]
                seen[image] += 1
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    for document in documents:
        visit(document)
        if document.get("kind") == "Deployment":
            template = document["spec"]["template"]
            template.setdefault("metadata", {}).setdefault("annotations", {})[
                "fleet.actor.dev/image-inventory-digest"
            ] = inventory_digest
            pod = template["spec"]
            if pod.get("imagePullSecrets") not in (None, [{"name": "actor-fleet-tcr"}]):
                raise ValueError("FDB Operator has an unexpected imagePullSecrets contract")
            pod["imagePullSecrets"] = [{"name": "actor-fleet-tcr"}]

    missing = [source for source, count in seen.items() if count == 0]
    if missing:
        raise ValueError("FDB Operator source image is absent: " + ", ".join(missing))
    return documents


def dump_documents(documents: List[Dict[str, Any]]) -> str:
    """Serialize on both current PyYAML and the TLinux bootstrap release."""
    try:
        return yaml.safe_dump_all(documents, explicit_start=True, sort_keys=False)
    except TypeError:
        # The PyYAML bundled with the Python 3.6 bootstrap image predates the
        # sort_keys keyword. Kubernetes does not depend on mapping order.
        return yaml.safe_dump_all(documents, explicit_start=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--operator-image", required=True)
    parser.add_argument("--monitor-image", required=True)
    parser.add_argument("--inventory-digest", required=True)
    args = parser.parse_args()
    try:
        documents = render(
            args.input.read_text(), args.operator_image, args.monitor_image, args.inventory_digest,
        )
        args.output.write_text(dump_documents(documents))
    except (KeyError, OSError, TypeError, ValueError, yaml.YAMLError) as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
