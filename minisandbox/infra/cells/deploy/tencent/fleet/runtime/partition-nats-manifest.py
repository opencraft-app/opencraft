#!/usr/bin/env python3
"""Partition rendered NATS resources so an update can defer Pod replacement."""

import argparse
import re
from pathlib import Path


def identity(document: str):
    kind = re.search(r"(?m)^kind: ([^\n]+)$", document)
    name = re.search(r"(?m)^  name: ([^\n]+)$", document)
    if kind is None or name is None:
        raise ValueError("NATS document is missing a top-level kind or metadata.name")
    return kind.group(1), name.group(1)


def partition(source: str, output: Path, cell: str) -> None:
    stateful_identity = ("StatefulSet", f"{cell}-nats")
    expected_base = {
        ("ServiceAccount", f"{cell}-runtime"),
        ("ConfigMap", f"{cell}-nats-config"),
        ("Service", f"{cell}-nats"),
        ("PodDisruptionBudget", f"{cell}-nats"),
    }
    base = []
    found_base = set()
    stateful = None
    for raw in source.split("\n---\n"):
        document = raw.strip()
        if not document:
            continue
        resource = identity(document)
        if resource == stateful_identity:
            if stateful is not None:
                raise ValueError("duplicate NATS StatefulSet")
            stateful = document
        elif resource in expected_base:
            if resource in found_base:
                raise ValueError(f"duplicate NATS base resource: {resource}")
            found_base.add(resource)
            base.append(document)
        else:
            raise ValueError(f"unexpected NATS resource: {resource}")
    if found_base != expected_base or stateful is None:
        raise ValueError(
            "failed to partition exact NATS resources: "
            f"base={sorted(found_base)} stateful={stateful is not None}"
        )
    output.mkdir(parents=True, exist_ok=True)
    (output / "nats-base.yaml").write_text("\n---\n".join(base) + "\n")
    (output / "nats-statefulset.yaml").write_text(stateful + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cell", required=True)
    args = parser.parse_args()
    try:
        partition(args.manifest.read_text(), args.output, args.cell)
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
