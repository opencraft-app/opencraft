"""
Resolve release bundle metadata for CI and local automation.
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from contracts.bundles import ImageTarget, load_bundle, load_manifest, require_build_metadata


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resolve a release bundle from .ci/runtime/release-bundles.manifest")
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


def shell_line(key: str, value: object) -> str:
    return f"{key}={shlex.quote(str(value))}"


def single_target(service: str, dockerfile: str, build_context: str, image_repo: str) -> ImageTarget:
    return ImageTarget(
        name=service,
        image_key=None,
        dockerfile=dockerfile,
        build_context=build_context,
        image_repo=image_repo,
    )


def target_image_key(service: str, target: ImageTarget) -> str:
    return target.image_key or f"{service.upper().replace('-', '_')}_IMAGE"


def build_metadata(bundle, tag: str) -> dict[str, object]:
    targets = bundle.image_targets or [
        single_target(bundle.service, bundle.dockerfile or "", bundle.build_context or "", bundle.image_repo or "")
    ]
    image_repos = {target_image_key(bundle.service, target): target.image_repo for target in targets}
    images = {key: f"{repo}:{tag}" for key, repo in image_repos.items()}
    first_target = targets[0]
    first_key = target_image_key(bundle.service, first_target)
    return {
        "service": bundle.service,
        "env": bundle.env,
        "dockerfile": first_target.dockerfile,
        "build_context": first_target.build_context,
        "image_repo": first_target.image_repo,
        "image_repos": image_repos,
        "image_targets": [
            {
                "name": target.name,
                "image_key": target_image_key(bundle.service, target),
                "dockerfile": target.dockerfile,
                "build_context": target.build_context,
                "image_repo": target.image_repo,
                "image": images[target_image_key(bundle.service, target)],
            }
            for target in targets
        ],
        "publish_paths": bundle.publish_paths,
        "tag": tag,
        "image": images[first_key] if len(images) == 1 and not bundle.image_targets else json.dumps({"images": images}, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        "images": images,
    }


def emit_dotenv(metadata: dict[str, object]) -> str:
    lines = [
        shell_line("BUILD_SERVICE", metadata["service"]),
        shell_line("BUILD_ENV", metadata["env"]),
        shell_line("BUILD_TAG", metadata["tag"]),
        shell_line("BUILD_DOCKERFILE", metadata["dockerfile"]),
        shell_line("BUILD_CONTEXT", metadata["build_context"]),
        shell_line("BUILD_IMAGE_REPO", metadata["image_repo"]),
        shell_line("BUILD_IMAGE", metadata["image"]),
        shell_line("BUILD_IMAGES_JSON", json.dumps({"images": metadata["images"]}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))),
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

    result = build_metadata(bundle, args.tag)
    if args.format == "json":
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(emit_dotenv(result), end="")
    return 0
