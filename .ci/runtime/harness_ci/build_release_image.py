"""
Build a release image from the central release bundle manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from harness_ci.bundles import ImageTarget, load_bundle, load_manifest, require_build_metadata


RUNTIME_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = RUNTIME_DIR.parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a release image from .ci/runtime/release-bundles.yaml")
    parser.add_argument("--service", required=True, help="Bundle id, e.g. payment")
    parser.add_argument("--env", required=True, help="Target env, e.g. beijing-sandbox or shprod")
    parser.add_argument("--tag", required=True, help="Image tag to build")
    parser.add_argument("--platform", default="linux/amd64", help="Docker build platform")
    parser.add_argument("--push", action="store_true", help="Push after successful build")
    parser.add_argument("--image-output-file", help="Optional file path to receive the built image ref")
    return parser.parse_args()


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


def single_target_from_bundle(service: str, dockerfile: str, build_context: str, image_repo: str) -> ImageTarget:
    return ImageTarget(
        name=service,
        image_key=None,
        dockerfile=dockerfile,
        build_context=build_context,
        image_repo=image_repo,
    )


def build_target(target: ImageTarget, tag: str, platform: str, push: bool) -> str:
    image = f"{target.image_repo}:{tag}"
    cmd = [
        "docker",
        "build",
        "--platform",
        platform,
        "-f",
        target.dockerfile,
        "-t",
        image,
        target.build_context,
    ]
    subprocess.run(cmd, cwd=REPO_ROOT, check=True)
    if push:
        docker_login(target.image_repo)
        subprocess.run(["docker", "push", image], check=True)
    return image


def encode_image_payload(images: dict[str, str]) -> str:
    return json.dumps({"images": images}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def main() -> int:
    args = parse_args()
    try:
        bundle = require_build_metadata(load_bundle(load_manifest(), args.service, args.env))
    except (KeyError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    targets = bundle.image_targets or [
        single_target_from_bundle(args.service, bundle.dockerfile or "", bundle.build_context or "", bundle.image_repo or "")
    ]

    built: dict[str, str] = {}
    for target in targets:
        image = build_target(target, args.tag, args.platform, args.push)
        built[target.image_key or f"{args.service.upper().replace('-', '_')}_IMAGE"] = image

    output = next(iter(built.values())) if len(built) == 1 and not bundle.image_targets else encode_image_payload(built)
    if args.image_output_file:
        Path(args.image_output_file).write_text(f"{output}\n")
    else:
        print(output)
    return 0
