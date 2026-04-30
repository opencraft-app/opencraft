"""Verify that release image references exist in the container registry."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Sequence


RunCommand = Callable[..., subprocess.CompletedProcess[str]]


@dataclass(frozen=True)
class ImageCheckResult:
    image: str
    exists: bool
    digest: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify release image references exist before GitOps pinning.")
    parser.add_argument("--image", required=True, help="Image reference or JSON payload with images mapping")
    parser.add_argument("--docker-bin", default=os.environ.get("DOCKER_BIN", "docker"))
    parser.add_argument("--skip-login", action="store_true", help="Do not run docker login before inspecting images")
    parser.add_argument("--format", choices=("text", "json", "dotenv"), default="text")
    return parser.parse_args()


def image_references(raw_image: str) -> list[str]:
    raw = raw_image.strip()
    if not raw:
        raise ValueError("image reference is empty")
    if not raw.startswith("{"):
        return [raw]

    payload = json.loads(raw)
    images = payload.get("images") if isinstance(payload, dict) else None
    if not isinstance(images, dict) or not images:
        raise ValueError("image JSON payload must contain a non-empty images object")

    refs = [str(value).strip() for value in images.values()]
    if any(not ref for ref in refs):
        raise ValueError("image JSON payload contains an empty image reference")
    return refs


def registry_from_image(image: str) -> str:
    if "/" not in image:
        raise ValueError(f"image reference must include a registry/repository path: {image}")
    return image.split("/", 1)[0]


def password_fingerprint(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()[:12]


def docker_login(registry: str, docker_bin: str, run: RunCommand = subprocess.run) -> bool:
    username = os.environ.get("REGISTRY_USERNAME", "").strip()
    password = os.environ.get("REGISTRY_PASSWORD", "").strip()
    if not username or not password:
        return False

    try:
        run(
            [docker_bin, "login", "-u", username, "--password-stdin", registry],
            input=password,
            text=True,
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        source = os.environ.get("REGISTRY_PASSWORD_SOURCE", "unknown")
        print(
            (
                "docker login failed before image existence check: "
                f"registry={registry} username={username} password_source={source} "
                f"password_len={len(password)} password_fingerprint={password_fingerprint(password)}"
            ),
            file=sys.stderr,
        )
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        raise
    return True


def inspect_image(image: str, docker_bin: str, run: RunCommand = subprocess.run) -> ImageCheckResult:
    result = run(
        [docker_bin, "manifest", "inspect", image],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        if stderr:
            print(stderr, file=sys.stderr)
        return ImageCheckResult(image=image, exists=False)

    digest = ""
    try:
        manifest = json.loads(result.stdout or "{}")
        digest = str(manifest.get("Descriptor", {}).get("digest") or manifest.get("digest") or "")
    except json.JSONDecodeError:
        digest = ""
    return ImageCheckResult(image=image, exists=True, digest=digest)


def verify_images(
    images: Sequence[str],
    *,
    docker_bin: str = "docker",
    skip_login: bool = False,
    run: RunCommand = subprocess.run,
) -> list[ImageCheckResult]:
    if not images:
        raise ValueError("no image references provided")

    logged_in: set[str] = set()
    results: list[ImageCheckResult] = []
    for image in images:
        registry = registry_from_image(image)
        if not skip_login and registry not in logged_in:
            docker_login(registry, docker_bin, run=run)
            logged_in.add(registry)
        results.append(inspect_image(image, docker_bin, run=run))
    return results


def emit(results: Sequence[ImageCheckResult], output_format: str) -> None:
    payload = {
        "images": [
            {
                "image": result.image,
                "exists": result.exists,
                **({"digest": result.digest} if result.digest else {}),
            }
            for result in results
        ],
        "all_exist": all(result.exists for result in results),
    }

    if output_format == "json":
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return
    if output_format == "dotenv":
        print(f"IMAGE_EXISTS={str(payload['all_exist']).lower()}")
        image_refs_json = json.dumps([result.image for result in results], ensure_ascii=False, sort_keys=True)
        print("IMAGE_REFS_JSON=" + shlex.quote(image_refs_json))
        return

    for result in results:
        status = "exists" if result.exists else "missing"
        digest_suffix = f" digest={result.digest}" if result.digest else ""
        print(f"image {status}: {result.image}{digest_suffix}")


def main() -> int:
    args = parse_args()
    try:
        refs = image_references(args.image)
        results = verify_images(refs, docker_bin=args.docker_bin, skip_login=args.skip_login)
    except (ValueError, FileNotFoundError, subprocess.CalledProcessError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    emit(results, args.format)
    if not all(result.exists for result in results):
        return 1
    return 0
