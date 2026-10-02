#!/usr/bin/env python3
"""Verify the immutable identity receipt for a reviewed full source bundle."""

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Optional


HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
PROJECT_PATH = re.compile(r"^(?:\.|[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)$")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(bundle: Path, receipt: Path, expected_revision: Optional[str] = None) -> dict:
    if bundle.is_symlink() or not bundle.is_file():
        raise ValueError("source bundle must be a regular non-symlink file")
    if receipt.is_symlink() or not receipt.is_file():
        raise ValueError("source receipt must be a regular non-symlink file")
    value = json.loads(receipt.read_text(encoding="utf-8"))
    if set(value) != {"schema", "verdict", "source", "content", "bundle"}:
        raise ValueError("source receipt fields do not match the v2 contract")
    if value["schema"] != "actor-reviewed-source-bundle/v2" or value["verdict"] != "passed":
        raise ValueError("source receipt did not pass")
    source, content, artifact = value["source"], value["content"], value["bundle"]
    if set(source) != {"revision", "repositoryTree", "projectPath", "projectTree"} or not all(
        isinstance(source.get(field), str) and HEX40.fullmatch(source[field])
        for field in ("revision", "repositoryTree", "projectTree")
    ):
        raise ValueError("invalid source identity")
    if not isinstance(source["projectPath"], str) or not PROJECT_PATH.fullmatch(source["projectPath"]):
        raise ValueError("invalid source project path")
    if source["projectPath"] != "." and any(part in ("", ".", "..") for part in source["projectPath"].split("/")):
        raise ValueError("invalid source project path")
    if expected_revision is not None and source["revision"] != expected_revision:
        raise ValueError("source revision does not match the requested release")
    if set(content) != {"fileCount", "manifestSha256"}:
        raise ValueError("invalid source content identity")
    if not isinstance(content["fileCount"], int) or content["fileCount"] < 1:
        raise ValueError("invalid source file count")
    if not isinstance(content["manifestSha256"], str) or not HEX64.fullmatch(content["manifestSha256"]):
        raise ValueError("invalid source manifest digest")
    if set(artifact) != {"name", "bytes", "sha256"}:
        raise ValueError("invalid source bundle identity")
    if artifact["name"] != bundle.name:
        raise ValueError("source bundle filename does not match receipt")
    if not isinstance(artifact["bytes"], int) or artifact["bytes"] <= 0:
        raise ValueError("invalid source bundle size")
    if not isinstance(artifact["sha256"], str) or not HEX64.fullmatch(artifact["sha256"]):
        raise ValueError("invalid source bundle digest")
    if bundle.stat().st_size != artifact["bytes"] or sha256(bundle) != artifact["sha256"]:
        raise ValueError("source bundle bytes do not match receipt")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--revision")
    args = parser.parse_args()
    try:
        value = verify(args.bundle, args.receipt, args.revision)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"source bundle verification failed: {error}") from error
    print(f'{value["source"]["revision"]}\t{value["content"]["manifestSha256"]}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
