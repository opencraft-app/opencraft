#!/usr/bin/env python3
"""
Resolve release bundle metadata for CI and local automation.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resolve a release bundle from scripts/release-bundles.yaml")
    parser.add_argument("--service", required=True, help="Bundle id, e.g. ai-gateway")
    parser.add_argument("--env", required=True, help="Target env, e.g. beijing-sandbox or shprod")
    parser.add_argument("--tag", required=True, help="Image tag to resolve")
    parser.add_argument(
        "--format",
        choices=("json", "dotenv"),
        default="json",
        help="Output format",
    )
    return parser.parse_args()


def load_bundle(service: str, env: str) -> dict[str, str]:
    manifest_path = Path("scripts/release-bundles.yaml")
    data = yaml.safe_load(manifest_path.read_text()) or {}
    bundles = data.get("bundles") or {}
    bundle = bundles.get(service)
    if not bundle:
        raise KeyError(f"unknown release bundle: {service}")

    dockerfile = bundle.get("dockerfile")
    build_context = bundle.get("build_context")
    image_repo = (bundle.get("image_repo") or {}).get(env)
    if not dockerfile or not build_context or not image_repo:
        raise ValueError(f"bundle {service} does not define docker build inputs for env {env}")

    return {
        "service": service,
        "env": env,
        "dockerfile": str(dockerfile),
        "build_context": str(build_context),
        "image_repo": str(image_repo),
    }


def emit_dotenv(metadata: dict[str, str], tag: str) -> str:
    image = f"{metadata['image_repo']}:{tag}"
    lines = [
        f"BUILD_SERVICE={metadata['service']}",
        f"BUILD_ENV={metadata['env']}",
        f"BUILD_TAG={tag}",
        f"BUILD_DOCKERFILE={metadata['dockerfile']}",
        f"BUILD_CONTEXT={metadata['build_context']}",
        f"BUILD_IMAGE_REPO={metadata['image_repo']}",
        f"BUILD_IMAGE={image}",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    args = parse_args()
    try:
        metadata = load_bundle(args.service, args.env)
    except (KeyError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    result = {
        **metadata,
        "tag": args.tag,
        "image": f"{metadata['image_repo']}:{args.tag}",
    }
    if args.format == "json":
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(emit_dotenv(metadata, args.tag), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
