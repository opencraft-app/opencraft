"""Resolve synced Hermes CVM images by exact private image name."""

from __future__ import annotations

import argparse
import json
import subprocess
from typing import Any


PRIVATE_IMAGE_FILTER = json.dumps([{"Name": "image-type", "Values": ["PRIVATE_IMAGE"]}])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resolve one private CVM image id by region and exact image name.")
    parser.add_argument("--region", required=True)
    parser.add_argument("--image-name", required=True)
    return parser.parse_args()


def describe_images(region: str, offset: int) -> dict[str, Any]:
    payload = subprocess.check_output(
        [
            "tccli",
            "cvm",
            "DescribeImages",
            "--region",
            region,
            "--Filters",
            PRIVATE_IMAGE_FILTER,
            "--Offset",
            str(offset),
            "--Limit",
            "100",
        ],
        text=True,
    )
    return json.loads(payload)


def resolve_image_id(region: str, image_name: str) -> str:
    offset = 0
    matches: list[dict[str, Any]] = []
    while True:
        data = describe_images(region, offset)
        images = data.get("ImageSet") or []
        matches.extend(img for img in images if img.get("ImageName") == image_name)
        offset += len(images)
        if offset >= int(data.get("TotalCount") or 0) or not images:
            break

    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one {region} private image named {image_name}, got {len(matches)}")
    image = matches[0]
    if image.get("ImageState") != "NORMAL":
        raise RuntimeError(f"{region} image {image_name} is not NORMAL: {image.get('ImageState')}")
    image_id = image.get("ImageId")
    if not image_id:
        raise RuntimeError(f"{region} image {image_name} is missing ImageId")
    return str(image_id)


def main() -> int:
    args = parse_args()
    print(resolve_image_id(args.region, args.image_name))
    return 0
