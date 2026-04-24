#!/usr/bin/env python3
"""
Build a release image from the central release bundle manifest.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import yaml


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a release image from scripts/release-bundles.yaml")
    parser.add_argument("--service", required=True, help="Bundle id, e.g. payment")
    parser.add_argument("--env", required=True, help="Target env, e.g. beijing-sandbox or shprod")
    parser.add_argument("--tag", required=True, help="Image tag to build")
    parser.add_argument("--platform", default="linux/amd64", help="Docker build platform")
    parser.add_argument("--push", action="store_true", help="Push after successful build")
    return parser.parse_args()


def load_manifest() -> dict:
    path = Path("scripts/release-bundles.yaml")
    return yaml.safe_load(path.read_text()) or {}


def main() -> int:
    args = parse_args()
    data = load_manifest()
    bundles = data.get("bundles") or {}
    bundle = bundles.get(args.service)
    if not bundle:
        print(f"unknown release bundle: {args.service}", file=sys.stderr)
        return 1

    dockerfile = bundle.get("dockerfile")
    build_context = bundle.get("build_context")
    image_repo = (bundle.get("image_repo") or {}).get(args.env)
    if not dockerfile or not build_context or not image_repo:
        print(f"bundle {args.service} does not define docker build inputs for env {args.env}", file=sys.stderr)
        return 1

    image = f"{image_repo}:{args.tag}"
    cmd = [
        "docker",
        "build",
        "--platform",
        args.platform,
        "-f",
        dockerfile,
        "-t",
        image,
        build_context,
    ]
    subprocess.run(cmd, check=True)
    if args.push:
        subprocess.run(["docker", "push", image], check=True)
    print(image)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
