#!/usr/bin/env python3
"""Validate the resumable pre-Host initial Engine/NATS installation boundary."""

import argparse
import json
from pathlib import Path


def verify(cell_name, runtime_image, nats_image, cell, engine, nats):
    if cell.get("metadata", {}).get("name") != cell_name or cell.get("spec", {}).get("desiredState") != "Provisioning":
        raise ValueError("initial Engine prefix requires the exact still-Provisioning Cell")
    for component, kind, image, container, document in (
        ("engine", "Deployment", runtime_image, "engine", engine),
        ("nats", "StatefulSet", nats_image, "nats", nats),
    ):
        metadata, spec = document.get("metadata", {}), document.get("spec", {})
        labels = metadata.get("labels", {})
        if (
            document.get("kind") != kind
            or metadata.get("name") != f"{cell_name}-{component}"
            or metadata.get("deletionTimestamp")
            or labels.get("fleet.actor.dev/cell-name") != cell_name
            or labels.get("fleet.actor.dev/component") != component
            or spec.get("replicas") != 3
        ):
            raise ValueError(f"initial {component} workload identity differs")
        containers = spec.get("template", {}).get("spec", {}).get("containers", [])
        selected = [item for item in containers if item.get("name") == container]
        if len(selected) != 1 or selected[0].get("image") != image or "@sha256:" not in image:
            raise ValueError(f"initial {component} immutable image differs")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("cell_name")
    parser.add_argument("runtime_image")
    parser.add_argument("nats_image")
    parser.add_argument("cell", type=Path)
    parser.add_argument("engine", type=Path)
    parser.add_argument("nats", type=Path)
    args = parser.parse_args()
    try:
        verify(args.cell_name, args.runtime_image, args.nats_image,
               *(json.loads(path.read_text()) for path in (args.cell, args.engine, args.nats)))
    except (ValueError, OSError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
