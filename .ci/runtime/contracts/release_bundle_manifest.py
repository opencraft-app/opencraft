"""Generate the materialized release bundle manifest from split source files."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import yaml

from support.yaml import load_mapping


RUNTIME_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_DIR = RUNTIME_DIR / "bundles"
DEFAULT_OUTPUT = RUNTIME_DIR / "release-bundles.manifest"


def merge_bundle_sources(source_dir: Path) -> dict[str, Any]:
    if not source_dir.is_dir():
        raise FileNotFoundError(f"release bundle source dir not found: {source_dir}")

    manifest: dict[str, Any] = {"bundles": {}}
    for path in sorted(source_dir.glob("*.yaml")):
        document = load_mapping(path)
        bundles = document.pop("bundles", {}) or {}
        if not isinstance(bundles, dict):
            raise ValueError(f"{path}: bundles must be a YAML mapping")
        for bundle_name, bundle in bundles.items():
            if bundle_name in manifest["bundles"]:
                raise ValueError(f"duplicate release bundle {bundle_name} in {path}")
            manifest["bundles"][bundle_name] = bundle
        for key, value in document.items():
            if key in manifest and key != "bundles":
                raise ValueError(f"duplicate release manifest top-level key {key} in {path}")
            manifest[key] = value
    if not manifest["bundles"]:
        raise ValueError(f"no release bundles found in {source_dir}")
    return manifest


def dump_manifest(manifest: dict[str, Any]) -> str:
    return yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate .ci/runtime/release-bundles.manifest from split bundle sources.")
    parser.add_argument("--source-dir", default=str(DEFAULT_SOURCE_DIR))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--check", action="store_true", help="Fail if output is not up to date.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    source_dir = Path(args.source_dir).resolve()
    output = Path(args.output).resolve()
    rendered = dump_manifest(merge_bundle_sources(source_dir))

    if args.check:
        if not output.is_file():
            print(f"release bundle manifest is missing: {output}", file=sys.stderr)
            return 1
        if output.read_text() != rendered:
            print(f"release bundle manifest is stale: regenerate {output}", file=sys.stderr)
            return 1
        print(f"release bundle manifest is up to date: {output}")
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered)
    print(output)
    return 0
