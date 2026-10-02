#!/usr/bin/env python3
"""Partition a rendered runtime manifest into ordered SSA rollout phases."""

import argparse
import re
from pathlib import Path


def identity(document: str):
    kind = re.search(r"(?m)^kind: ([^\n]+)$", document)
    name = re.search(r"(?m)^  name: ([^\n]+)$", document)
    if kind is None or name is None:
        raise ValueError("runtime document is missing a top-level kind or metadata.name")
    return kind.group(1), name.group(1)


def partition(source: str, output: Path, cell: str, reporter_enabled: bool) -> None:
    targets = {
        ("Deployment", f"{cell}-engine"): ("engine", "phase-engine.yaml"),
        ("StatefulSet", f"{cell}-runtime-hosts"): ("runtime", "phase-runtime.yaml"),
        ("Job", f"{cell}-workerd-pool-init"): ("pool", "phase-pool.yaml"),
        ("Deployment", f"{cell}-cell-reporter"): ("reporter", "phase-reporter.yaml"),
    }
    base = []
    found = set()
    output.mkdir(parents=True, exist_ok=True)
    for raw in source.split("\n---\n"):
        document = raw.strip()
        if not document:
            continue
        target = targets.get(identity(document))
        if target is None:
            base.append(document)
            continue
        label, filename = target
        if label in found:
            raise ValueError(f"duplicate phased runtime resource: {label}")
        (output / filename).write_text(document + "\n")
        found.add(label)
    expected = {"engine", "runtime", "pool"}
    if reporter_enabled:
        expected.add("reporter")
    if found != expected:
        raise ValueError(f"failed to partition rendered runtime resources: {sorted(found)}")
    if not base:
        raise ValueError("runtime base phase is empty")
    (output / "phase-base.yaml").write_text("\n---\n".join(base) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cell", required=True)
    parser.add_argument("--reporter-mode", choices=("enabled", "disabled"), required=True)
    args = parser.parse_args()
    try:
        partition(
            args.manifest.read_text(),
            args.output,
            args.cell,
            args.reporter_mode == "enabled",
        )
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
