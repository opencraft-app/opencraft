"""Check and repair playground frontend environment image tags."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Sequence

from contracts.image_existence import ImageCheckResult, docker_login, inspect_image, registry_from_image


RunCommand = Callable[..., subprocess.CompletedProcess[str]]


@dataclass(frozen=True)
class EnsureResult:
    status: str
    target: ImageCheckResult
    source: ImageCheckResult | None = None
    reason: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ensure a playground frontend target image tag exists, with a narrow same-source retag escape hatch."
    )
    parser.add_argument("--target-image", required=True, help="Expected FRONTEND_IMAGE for the playground env")
    parser.add_argument(
        "--source-image",
        action="append",
        default=[],
        help="Existing equivalent frontend image tag to retag from. May be passed multiple times.",
    )
    parser.add_argument("--docker-bin", default=os.environ.get("DOCKER_BIN", "docker"))
    parser.add_argument("--skip-login", action="store_true", help="Do not run docker login before inspect/push")
    parser.add_argument("--apply", action="store_true", help="Actually docker pull/tag/push when the target tag is missing")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    return parser.parse_args()


def image_repo(image: str) -> str:
    ref = image.split("@", 1)[0]
    last_slash = ref.rfind("/")
    last_colon = ref.rfind(":")
    if last_colon <= last_slash:
        raise ValueError(f"image reference must include an explicit tag: {image}")
    return ref[:last_colon]


def image_tag(image: str) -> str:
    ref = image.split("@", 1)[0]
    last_slash = ref.rfind("/")
    last_colon = ref.rfind(":")
    if last_colon <= last_slash:
        raise ValueError(f"image reference must include an explicit tag: {image}")
    return ref[last_colon + 1 :]


def source_id_from_tag(tag: str) -> str:
    candidate = tag.rsplit("-", 1)[-1]
    if len(candidate) < 7 or any(ch not in "0123456789abcdefABCDEF" for ch in candidate):
        raise ValueError(f"cannot infer source sha from image tag: {tag}")
    return candidate.lower()


def validate_retag_pair(source_image: str, target_image: str) -> None:
    if image_repo(source_image) != image_repo(target_image):
        raise ValueError(f"source and target image repositories differ: {source_image} -> {target_image}")
    source_id = source_id_from_tag(image_tag(source_image))
    target_id = source_id_from_tag(image_tag(target_image))
    if source_id != target_id:
        raise ValueError(f"source and target image tags are not the same source sha: {source_id} != {target_id}")


def login_for_images(images: Sequence[str], docker_bin: str, run: RunCommand, skip_login: bool) -> None:
    if skip_login:
        return
    logged_in: set[str] = set()
    for image in images:
        registry = registry_from_image(image)
        if registry in logged_in:
            continue
        docker_login(registry, docker_bin, run=run)
        logged_in.add(registry)


def docker_retag_push(source_image: str, target_image: str, docker_bin: str, run: RunCommand) -> None:
    for command in (
        [docker_bin, "pull", source_image],
        [docker_bin, "tag", source_image, target_image],
        [docker_bin, "push", target_image],
    ):
        result = run(command, text=True, capture_output=True, check=False)
        if result.stdout:
            print(result.stdout, file=sys.stderr, end="")
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")
        if result.returncode != 0:
            raise RuntimeError(f"docker command failed: {' '.join(command)}")


def ensure_playground_frontend_image(
    *,
    target_image: str,
    source_images: Sequence[str],
    docker_bin: str = "docker",
    skip_login: bool = False,
    apply: bool = False,
    run: RunCommand = subprocess.run,
) -> EnsureResult:
    login_for_images([target_image, *source_images], docker_bin, run, skip_login)
    target = inspect_image(target_image, docker_bin, run=run)
    if target.exists:
        return EnsureResult(status="exists", target=target, reason="target image already exists")

    if not source_images:
        return EnsureResult(
            status="missing",
            target=target,
            reason="target image is missing and no source image was provided; build the target env image",
        )

    last_missing_source: ImageCheckResult | None = None
    for source_image in source_images:
        validate_retag_pair(source_image, target_image)
        source = inspect_image(source_image, docker_bin, run=run)
        if not source.exists:
            last_missing_source = source
            continue
        if not apply:
            return EnsureResult(
                status="retag_required",
                target=target,
                source=source,
                reason="target is missing; rerun with --apply to retag from the equivalent source image",
            )
        docker_retag_push(source_image, target_image, docker_bin, run)
        repaired = inspect_image(target_image, docker_bin, run=run)
        if not repaired.exists:
            raise RuntimeError(f"target image is still missing after retag push: {target_image}")
        return EnsureResult(status="retagged", target=repaired, source=source, reason="target image was retagged from equivalent source")

    source_text = last_missing_source.image if last_missing_source else ",".join(source_images)
    return EnsureResult(
        status="missing",
        target=target,
        source=last_missing_source,
        reason=f"target image is missing and no provided source image exists: {source_text}",
    )


def emit(result: EnsureResult, output_format: str) -> None:
    payload = {
        "status": result.status,
        "reason": result.reason,
        "target": {"image": result.target.image, "exists": result.target.exists, "digest": result.target.digest},
        "source": (
            {"image": result.source.image, "exists": result.source.exists, "digest": result.source.digest}
            if result.source is not None
            else None
        ),
    }
    if output_format == "json":
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return

    print(f"playground frontend image status: {result.status}")
    print(f"target: {result.target.image}")
    if result.target.digest:
        print(f"target_digest: {result.target.digest}")
    if result.source is not None:
        print(f"source: {result.source.image}")
        if result.source.digest:
            print(f"source_digest: {result.source.digest}")
    print(f"reason: {result.reason}")


def main() -> int:
    args = parse_args()
    try:
        result = ensure_playground_frontend_image(
            target_image=args.target_image,
            source_images=args.source_image,
            docker_bin=args.docker_bin,
            skip_login=args.skip_login,
            apply=args.apply,
        )
    except (ValueError, RuntimeError, FileNotFoundError, subprocess.CalledProcessError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    emit(result, args.format)
    return 0 if result.status in {"exists", "retagged"} else 1
