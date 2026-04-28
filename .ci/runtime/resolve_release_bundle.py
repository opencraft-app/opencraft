#!/usr/bin/env python3
"""
Resolve release bundle metadata for CI and local automation.
"""

from __future__ import annotations

import argparse
import json
import sys
from release_bundle_lib import load_bundle, load_manifest, require_build_metadata


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resolve a release bundle from .ci/runtime/release-bundles.yaml")
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


def emit_dotenv(metadata: dict[str, object], tag: str) -> str:
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
        manifest = load_manifest()
        bundle = require_build_metadata(load_bundle(manifest, args.service, args.env))
    except (KeyError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    result = {
        "service": bundle.service,
        "env": bundle.env,
        "dockerfile": bundle.dockerfile,
        "build_context": bundle.build_context,
        "image_repo": bundle.image_repo,
        "publish_paths": bundle.publish_paths,
        "tag": args.tag,
        "image": f"{bundle.image_repo}:{args.tag}",
    }
    if args.format == "json":
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(emit_dotenv(result, args.tag), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
