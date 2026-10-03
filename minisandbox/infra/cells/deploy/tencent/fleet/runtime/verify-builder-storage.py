#!/usr/bin/env python3
"""Read-only admission for bulk builds isolated from the online node filesystem."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
from typing import Any


GIB = 1024 ** 3
DEFAULT_ADDITIONAL_BYTES = 64 * GIB
ROOT_INODE_RESERVE = 16384
BULK_REQUIRED_INODES = 81920


def positive(value: Any, label: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def observe(path: str) -> dict[str, Any]:
    original = Path(path)
    if not original.is_absolute():
        raise ValueError("storage path must be absolute")
    resolved = original.resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError("storage path must be an existing directory")
    status = resolved.stat()
    filesystem = os.statvfs(resolved)
    if filesystem.f_flag & os.ST_RDONLY:
        raise ValueError("storage filesystem is read-only")
    mount = json.loads(subprocess.run(
        ["findmnt", "--json", "--target", str(resolved), "--output", "FSTYPE,SOURCE"],
        check=True, capture_output=True, text=True, timeout=10,
    ).stdout)["filesystems"]
    if len(mount) != 1:
        raise ValueError("storage mount identity is ambiguous")
    return {
        "path": str(original), "resolved": str(resolved), "device": status.st_dev,
        "filesystemType": mount[0]["fstype"], "source": mount[0]["source"],
        "capacityBytes": filesystem.f_blocks * filesystem.f_frsize,
        "availableBytes": filesystem.f_bavail * filesystem.f_frsize,
        "availableInodes": filesystem.f_favail,
    }


def evaluate(root: dict[str, Any], bulk: list[dict[str, Any]],
             additional_bytes: int) -> dict[str, Any]:
    """Each backing filesystem pays one build increment and one reserve."""
    positive(additional_bytes, "additional_bytes")
    if additional_bytes < DEFAULT_ADDITIONAL_BYTES:
        raise ValueError("build increment cannot be below the 64 GiB safety floor")
    if not bulk or len(bulk) > 16:
        raise ValueError("between one and sixteen bulk storage paths are required")
    errors = []
    for item in [root, *bulk]:
        for field in ("device", "capacityBytes", "availableInodes"):
            positive(item.get(field), field)
        available = item.get("availableBytes")
        if type(available) is not int or not 0 <= available <= item["capacityBytes"]:
            raise ValueError("invalid availableBytes")
        for field in ("path", "resolved"):
            if not isinstance(item.get(field), str) or not Path(item[field]).is_absolute():
                raise ValueError("invalid observed storage path")
    root_reserve = max(20 * GIB, (root["capacityBytes"] + 4) // 5)
    if root["availableBytes"] < root_reserve:
        errors.append("system-filesystem-reserve")
    if root["availableInodes"] < ROOT_INODE_RESERVE:
        errors.append("system-filesystem-inode-reserve")
    groups: dict[int, list[dict[str, Any]]] = {}
    for item in bulk:
        if item.get("filesystemType") not in {"ext4", "xfs"} or not isinstance(item.get("source"), str) or not item["source"].startswith("/dev/"):
            errors.append("unsupported-build-filesystem:" + item["path"])
        if item["device"] == root["device"]:
            errors.append("bulk-on-system-filesystem:" + item["path"])
        groups.setdefault(item["device"], []).append(item)
    filesystems = []
    for device, paths in sorted(groups.items()):
        capacities = {item["capacityBytes"] for item in paths}
        if len(capacities) != 1:
            raise ValueError("inconsistent capacity for one filesystem")
        capacity = paths[0]["capacityBytes"]
        available = min(item["availableBytes"] for item in paths)
        reserve = max(10 * GIB, (capacity + 9) // 10)
        required = additional_bytes + reserve
        if available < required:
            errors.append("insufficient-build-headroom:" + str(device))
        inodes = min(item["availableInodes"] for item in paths)
        if inodes < BULK_REQUIRED_INODES:
            errors.append("insufficient-build-inodes:" + str(device))
        filesystems.append({"device": device, "paths": [item["path"] for item in paths],
                            "capacityBytes": capacity, "availableBytes": available,
                            "requiredBytes": required, "reserveBytes": reserve,
                            "availableInodes": inodes, "requiredInodes": BULK_REQUIRED_INODES})
    return {"schema": "actor-builder-storage-admission/v1",
            "verdict": "blocked" if errors else "passed", "errors": errors,
            "root": root, "rootReserveBytes": root_reserve,
            "additionalBytesPerFilesystem": additional_bytes, "filesystems": filesystems}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bulk-path", action="append", required=True)
    parser.add_argument("--additional-bytes", type=int, default=DEFAULT_ADDITIONAL_BYTES)
    arguments = parser.parse_args()
    try:
        if len(arguments.bulk_path) > 16:
            raise ValueError("between one and sixteen bulk storage paths are required")
        result = evaluate(observe("/"), [observe(path) for path in arguments.bulk_path],
                          arguments.additional_bytes)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        result = {"schema": "actor-builder-storage-admission/v1", "verdict": "blocked",
                  "errors": [str(error)]}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["verdict"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
