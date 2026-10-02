#!/usr/bin/env python3
"""Validate and resolve the reviewed product-foundation build plan."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


REPOSITORIES = {
    "base-distroless",
    "base-golang",
    "base-tencentcloud-cli",
    "git-service",
    "runtime-base",
}
IMAGE = re.compile(r"^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$")
DOCKERFILE = re.compile(r"^infra/cells/[A-Za-z0-9._/-]+/Dockerfile(?:\.[A-Za-z0-9._-]+)?$")
BUILD_ARG = re.compile(r"^[A-Z][A-Z0-9_]*$")


def validate(value: dict[str, Any]) -> dict[str, dict[str, str]]:
    if set(value) != {"schemaVersion", "platform", "images"}:
        raise ValueError("foundation lock has an unexpected schema")
    if value["schemaVersion"] != 1 or value["platform"] != "linux/amd64":
        raise ValueError("foundation lock must target schemaVersion 1 and linux/amd64")
    if not isinstance(value["images"], list):
        raise ValueError("foundation lock images must be a list")
    result: dict[str, dict[str, str]] = {}
    for index, raw in enumerate(value["images"]):
        if not isinstance(raw, dict) or set(raw) != {"repository", "source", "dockerfile", "buildArg"}:
            raise ValueError(f"foundation image {index} has an unexpected schema")
        if not all(isinstance(item, str) for item in raw.values()):
            raise ValueError(f"foundation image {index} fields must be strings")
        repository = raw["repository"]
        if repository not in REPOSITORIES or repository in result:
            raise ValueError("foundation lock has an unknown or duplicate repository")
        if IMAGE.fullmatch(raw["source"]) is None:
            raise ValueError(f"foundation source is not digest pinned: {repository}")
        if DOCKERFILE.fullmatch(raw["dockerfile"]) is None or ".." in Path(raw["dockerfile"]).parts:
            raise ValueError(f"foundation Dockerfile path is unsafe: {repository}")
        if BUILD_ARG.fullmatch(raw["buildArg"]) is None:
            raise ValueError(f"foundation build argument is invalid: {repository}")
        result[repository] = dict(raw)
    if set(result) != REPOSITORIES:
        raise ValueError(f"foundation lock is incomplete: missing={sorted(REPOSITORIES - set(result))}")
    if value["images"] != [result[name] for name in sorted(result)]:
        raise ValueError("foundation lock images must use canonical repository order")
    return result


def load(path: Path) -> dict[str, dict[str, str]]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError("foundation lock must be a JSON object")
    return validate(value)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True, type=Path)
    parser.add_argument("--repository")
    parser.add_argument("--field", choices=("source", "dockerfile", "buildArg"))
    args = parser.parse_args()
    try:
        images = load(args.lock)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    if args.repository is None:
        if args.field is not None:
            parser.error("--field requires --repository")
        print("\n".join(sorted(images)))
        return 0
    if args.repository not in images or args.field is None:
        parser.error("--repository must be known and used with --field")
    print(images[args.repository][args.field])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
