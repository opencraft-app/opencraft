"""Generate the materialized release bundle manifest from split source files."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

RUNTIME_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_DIR = RUNTIME_DIR / "bundles"
DEFAULT_OUTPUT = RUNTIME_DIR / "release-bundles.manifest"


def parse_bundle_source_text(source: str, text: str) -> dict[str, Any]:
    document = yaml.safe_load(text) or {}
    if not isinstance(document, dict):
        raise ValueError(f"{source} must contain a YAML mapping")
    return document


def merge_bundle_source_documents(documents: list[tuple[str, str]]) -> dict[str, Any]:
    manifest: dict[str, Any] = {"bundles": {}}
    for source, text in documents:
        document = parse_bundle_source_text(source, text)
        bundles = document.pop("bundles", {}) or {}
        if not isinstance(bundles, dict):
            raise ValueError(f"{source}: bundles must be a YAML mapping")
        for bundle_name, bundle in bundles.items():
            if bundle_name in manifest["bundles"]:
                raise ValueError(f"duplicate release bundle {bundle_name} in {source}")
            manifest["bundles"][bundle_name] = bundle
        for key, value in document.items():
            if key in manifest and key != "bundles":
                raise ValueError(f"duplicate release manifest top-level key {key} in {source}")
            manifest[key] = value
    if not manifest["bundles"]:
        raise ValueError("no release bundles found in source documents")
    return manifest


def merge_bundle_sources(source_dir: Path) -> dict[str, Any]:
    if not source_dir.is_dir():
        raise FileNotFoundError(f"release bundle source dir not found: {source_dir}")

    documents = [(str(path), path.read_text()) for path in sorted(source_dir.glob("*.bundle"))]
    if not documents:
        raise ValueError(f"no release bundle source files found in {source_dir}")
    return merge_bundle_source_documents(documents)


def dump_manifest(manifest: dict[str, Any]) -> str:
    return yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate .ci/runtime/release-bundles.manifest from split bundle sources.")
    parser.add_argument("--source-dir", default=str(DEFAULT_SOURCE_DIR))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--check", action="store_true", help="Validate split bundle sources without writing output.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    source_dir = Path(args.source_dir).resolve()
    output = Path(args.output).resolve()
    rendered = dump_manifest(merge_bundle_sources(source_dir))

    if args.check:
        print(f"release bundle sources are valid: {source_dir}")
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered)
    print(output)
    return 0
