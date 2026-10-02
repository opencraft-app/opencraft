#!/usr/bin/env python3
"""Compute a path-independent identity for rendered manifest inputs."""

import argparse
import hashlib
from pathlib import Path
from typing import List


def update_framed(digest, kind: bytes, payload: bytes) -> None:
    digest.update(kind)
    digest.update(len(payload).to_bytes(8, "big"))
    digest.update(payload)


def identity(files: List[Path], values: List[str]) -> str:
    digest = hashlib.sha256()
    for path in files:
        update_framed(digest, b"F", path.read_bytes())
    for value in values:
        update_framed(digest, b"V", value.encode())
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", action="append", default=[], type=Path)
    parser.add_argument("--value", action="append", default=[])
    args = parser.parse_args()
    print(identity(args.file, args.value))


if __name__ == "__main__":
    main()
