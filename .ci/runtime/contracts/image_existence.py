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
    key: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify release image references exist before GitOps pinning.")
    parser.add_argument("--image", required=True, help="Image reference or JSON payload with images mapping")
    parser.add_argument("--docker-bin", default=os.environ.get("DOCKER_BIN", "docker"))
    parser.add_argument("--skip-login", action="store_true", help="Do not run docker login before inspecting images")
    parser.add_argument("--format", choices=("text", "json", "dotenv"), default="text")
    return parser.parse_args()


def image_references(raw_image: str) -> list[str]:
    return [entry.image for entry in image_reference_entries(raw_image)]


@dataclass(frozen=True)
class ImageReference:
    image: str
    key: str = ""


def image_reference_entries(raw_image: str) -> list[ImageReference]:
    raw = raw_image.strip()
    if not raw:
        raise ValueError("image reference is empty")
    if not raw.startswith("{"):
        return [ImageReference(image=raw)]

    payload = json.loads(raw)
    images = payload.get("images") if isinstance(payload, dict) else None
    if not isinstance(images, dict) or not images:
        raise ValueError("image JSON payload must contain a non-empty images object")

    refs = [ImageReference(image=str(value).strip(), key=str(key)) for key, value in images.items()]
    if any(not ref.image for ref in refs):
        raise ValueError("image JSON payload contains an empty image reference")
    return refs


def registry_from_image(image: str) -> str:
    if "/" not in image:
        raise ValueError(f"image reference must include a registry/repository path: {image}")
    return image.split("/", 1)[0]


def credential_fingerprint(credential: str) -> str:
    return hashlib.sha256(credential.encode()).hexdigest()[:12]


def docker_login(registry: str, docker_bin: str, run: RunCommand = subprocess.run) -> bool:
    username = os.environ.get("REGISTRY_USERNAME", "").strip()
    credential = os.environ.get("REGISTRY_PASSWORD", "").strip()
    if not username or not credential:
        return False

    try:
        run(
            [docker_bin, "login", "-u", username, "--password-stdin", registry],
            input=credential,
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
                f"credential_len={len(credential)} credential_fingerprint={credential_fingerprint(credential)}"
            ),
            file=sys.stderr,
        )
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        raise
    return True


def inspect_image(
    image: str,
    docker_bin: str,
    run: RunCommand = subprocess.run,
    *,
    key: str = "",
    log_missing_errors: bool = True,
) -> ImageCheckResult:
    result = run(
        [docker_bin, "manifest", "inspect", "--verbose", image],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        if stderr and log_missing_errors:
            print(stderr, file=sys.stderr)
        return ImageCheckResult(image=image, exists=False, key=key)

    digest = ""
    try:
        manifest = json.loads(result.stdout or "{}")
        digest = manifest_digest(manifest)
    except json.JSONDecodeError:
        digest = ""
    return ImageCheckResult(image=image, exists=True, digest=digest, key=key)


def manifest_digest(manifest: object) -> str:
    if isinstance(manifest, dict):
        descriptor = manifest.get("Descriptor")
        if isinstance(descriptor, dict) and descriptor.get("digest"):
            return str(descriptor["digest"])
        if manifest.get("digest"):
            return str(manifest["digest"])
        manifests = manifest.get("manifests")
        if isinstance(manifests, list) and len(manifests) == 1:
            return manifest_digest(manifests[0])
    if isinstance(manifest, list) and len(manifest) == 1:
        return manifest_digest(manifest[0])
    return ""


def verify_images(
    images: Sequence[str | ImageReference],
    *,
    docker_bin: str = "docker",
    skip_login: bool = False,
    run: RunCommand = subprocess.run,
    log_missing_errors: bool = True,
) -> list[ImageCheckResult]:
    if not images:
        raise ValueError("no image references provided")

    logged_in: set[str] = set()
    results: list[ImageCheckResult] = []
    for item in images:
        entry = item if isinstance(item, ImageReference) else ImageReference(image=str(item))
        registry = registry_from_image(entry.image)
        if not skip_login and registry not in logged_in:
            docker_login(registry, docker_bin, run=run)
            logged_in.add(registry)
        results.append(inspect_image(entry.image, docker_bin, run=run, key=entry.key, log_missing_errors=log_missing_errors))
    return results


def digest_ref(image: str, digest: str) -> str:
    if not digest:
        raise ValueError(f"image digest is missing for {image}")
    base = image.split("@", 1)[0]
    last_slash = base.rfind("/")
    last_colon = base.rfind(":")
    if last_colon > last_slash:
        base = base[:last_colon]
    return f"{base}@{digest}"


def digest_pin_payload(results: Sequence[ImageCheckResult]) -> str:
    if not results:
        return ""
    if not all(result.exists and result.digest for result in results):
        return ""
    if any(result.key for result in results):
        return json.dumps(
            {"images": {result.key: digest_ref(result.image, result.digest) for result in results}},
            ensure_ascii=False,
            sort_keys=True,
        )
    if len(results) == 1:
        result = results[0]
        return digest_ref(result.image, result.digest)
    return ""


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
        image_digests_json = json.dumps(
            {result.image: result.digest for result in results if result.digest},
            ensure_ascii=False,
            sort_keys=True,
        )
        print("IMAGE_REFS_JSON=" + shlex.quote(image_refs_json))
        print("IMAGE_DIGESTS_JSON=" + shlex.quote(image_digests_json))
        print("IMAGE_PIN_PAYLOAD=" + shlex.quote(digest_pin_payload(results)))
        return

    for result in results:
        status = "exists" if result.exists else "missing"
        digest_suffix = f" digest={result.digest}" if result.digest else ""
        print(f"image {status}: {result.image}{digest_suffix}")


def main() -> int:
    args = parse_args()
    try:
        refs = image_reference_entries(args.image)
        results = verify_images(refs, docker_bin=args.docker_bin, skip_login=args.skip_login)
    except (ValueError, FileNotFoundError, subprocess.CalledProcessError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    emit(results, args.format)
    if not all(result.exists for result in results):
        return 1
    return 0
