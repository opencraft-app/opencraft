#!/usr/bin/env python3
"""Merge the bounded Cell kinds into an existing Argo inventory policy."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml


def parse_inclusions(value: str | None, source: str) -> list[dict]:
    if value is None or value.strip() == "":
        return []
    parsed = yaml.safe_load(value)
    if not isinstance(parsed, list) or not all(isinstance(item, dict) for item in parsed):
        raise ValueError(f"{source} resource.inclusions must be a YAML list of objects")
    return parsed


def canonical(item: dict) -> str:
    return json.dumps(item, sort_keys=True, separators=(",", ":"))


def merge(existing: list[dict], required: list[dict]) -> list[dict]:
    result: list[dict] = []
    seen: set[str] = set()
    for item in existing + required:
        identity = canonical(item)
        if identity not in seen:
            result.append(item)
            seen.add(identity)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--existing-configmap", required=True, type=Path)
    parser.add_argument("--required-configmap", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("refusing to overwrite merged Argo inventory policy")

    existing_document = json.loads(args.existing_configmap.read_text())
    required_document = yaml.safe_load(args.required_configmap.read_text())
    existing = parse_inclusions(
        existing_document.get("data", {}).get("resource.inclusions"), "existing"
    )
    required = parse_inclusions(
        required_document.get("data", {}).get("resource.inclusions"), "required"
    )
    merged = merge(existing, required)
    output = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "argocd-cm", "namespace": "argocd"},
        "data": {
            "resource.inclusions": yaml.safe_dump(merged, sort_keys=False),
        },
    }
    args.output.write_text(yaml.safe_dump(output, sort_keys=False))
    print(json.dumps({"existing": len(existing), "required": len(required), "merged": len(merged)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
