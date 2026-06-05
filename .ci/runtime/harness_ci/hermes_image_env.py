"""Hermes image build-log parsing helpers for CI runtime commands."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract Hermes image environment from build log JSON.")
    parser.add_argument("build_log", type=Path)
    parser.add_argument("--image-name", default=os.environ.get("HERMES_IMAGE_NAME", ""))
    return parser.parse_args()


def region_env_suffix(region: str) -> str:
    return region.replace("-", "_").upper()


def find_build_payload(log_path: Path) -> dict[str, Any]:
    payload: dict[str, Any] | None = None
    for line in reversed(log_path.read_text(encoding="utf-8").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate.get("target_image_ids"), dict):
            payload = candidate
            break

    if payload is None:
        raise RuntimeError("failed to find Hermes image result JSON in build log")
    return payload


def extract_env_lines(log_path: Path, image_name: str) -> list[str]:
    if not image_name:
        raise RuntimeError("HERMES_IMAGE_NAME is empty")
    payload = find_build_payload(log_path)
    target_image_ids = payload["target_image_ids"]
    lines = [f"HERMES_IMAGE_NAME={image_name}"]
    for region, image_id in sorted(target_image_ids.items()):
        if not image_id:
            raise RuntimeError(f"Hermes image result JSON missing target_image_ids.{region}")
        lines.append(f"HERMES_IMAGE_ID_{region_env_suffix(region)}={image_id}")
    return lines


def main() -> int:
    args = parse_args()
    for line in extract_env_lines(args.build_log, args.image_name):
        print(line)
    return 0
