#!/usr/bin/env python3
"""
Build a release image from the central release bundle manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import os
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
    parser.add_argument("--image-output-file", help="Optional file path to receive the built image ref")
    return parser.parse_args()


def load_manifest() -> dict:
    path = Path("scripts/release-bundles.yaml")
    return yaml.safe_load(path.read_text()) or {}


def docker_login(image_repo: str) -> None:
    raw_username = os.environ.get("REGISTRY_USERNAME", "")
    raw_password = os.environ.get("REGISTRY_PASSWORD", "")
    username = raw_username.strip()
    password = raw_password.strip()
    if not username or not password:
        return

    registry = image_repo.split("/", 1)[0]
    try:
        subprocess.run(
            ["docker", "login", "-u", username, "--password-stdin", registry],
            input=password.encode(),
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        source = os.environ.get("REGISTRY_PASSWORD_SOURCE", "unknown")
        fingerprint = hashlib.sha256(password.encode()).hexdigest()[:12]
        print(
            (
                "docker login failed: "
                f"registry={registry} "
                f"username={username} "
                f"username_raw_len={len(raw_username)} "
                f"username_len={len(username)} "
                f"password_source={source} "
                f"password_raw_len={len(raw_password)} "
                f"password_len={len(password)} "
                f"password_trimmed={'yes' if raw_password != password else 'no'} "
                f"password_fingerprint={fingerprint}"
            ),
            file=sys.stderr,
        )
        if exc.stderr:
            print(exc.stderr.decode(errors="replace"), file=sys.stderr)
        raise


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
        docker_login(image_repo)
        subprocess.run(["docker", "push", image], check=True)
    if args.image_output_file:
        Path(args.image_output_file).write_text(f"{image}\n")
    else:
        print(image)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
