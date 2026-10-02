#!/usr/bin/env python3
"""Resolve the Gasoline policy from an exact Cell -> Class -> Profile binding."""

import argparse
import hashlib
import json
from pathlib import Path


def load(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain one JSON object")
    return value


def nested(document: dict, *path):
    value = document
    for part in path:
        if not isinstance(value, dict) or part not in value:
            raise ValueError(f"missing {'.'.join(path)}")
        value = value[part]
    return value


def digest_spec(profile: dict) -> str:
    encoded = json.dumps(
        nested(profile, "spec"), sort_keys=True, separators=(",", ":")
    ).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def integer(policy: dict, field: str, minimum: int, maximum: int) -> int:
    value = policy.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"gasolineRetention.{field} must be in [{minimum}, {maximum}]")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("cell", type=Path)
    parser.add_argument("shard_class", type=Path)
    parser.add_argument("profile", type=Path)
    parser.add_argument("--expected-cell", required=True)
    args = parser.parse_args()

    cell, shard_class, profile = map(load, (args.cell, args.shard_class, args.profile))
    if nested(cell, "metadata", "name") != args.expected_cell:
        raise ValueError("RivetCell identity does not match the release target")
    class_name = nested(cell, "spec", "className")
    if nested(shard_class, "metadata", "name") != class_name:
        raise ValueError("ShardClass does not match RivetCell.spec.className")
    profile_ref = nested(shard_class, "spec", "profileRef")
    if nested(profile, "metadata", "name") != profile_ref.get("name"):
        raise ValueError("RivetCellProfile does not match ShardClass.spec.profileRef.name")
    actual_digest = digest_spec(profile)
    if profile_ref.get("digest") != actual_digest:
        raise ValueError(
            f"RivetCellProfile digest mismatch: bound={profile_ref.get('digest')} actual={actual_digest}"
        )
    region = nested(profile, "spec", "region")
    if nested(cell, "spec", "region") != region:
        raise ValueError("RivetCell and RivetCellProfile regions differ")
    if not isinstance(region, str) or not region.startswith("ap-"):
        raise ValueError("RivetCellProfile region is invalid")

    policy = nested(profile, "spec", "gasolineRetention")
    history = integer(policy, "historyGraceSeconds", 60, 31_536_000)
    terminal = integer(policy, "terminalGraceSeconds", history, 31_536_000)
    interval = integer(policy, "pruneIntervalSeconds", 1, 86_400)
    soft = integer(policy, "fdbLogicalSoftBytes", 1_073_741_824, 9_223_372_036_854_775_807)
    hard = integer(policy, "fdbLogicalHardBytes", soft + 1, 9_223_372_036_854_775_807)
    print(json.dumps({
        "profile_name": nested(profile, "metadata", "name"),
        "profile_digest": actual_digest,
        "history_grace_seconds": history,
        "terminal_grace_seconds": terminal,
        "prune_interval_seconds": interval,
        "fdb_logical_soft_bytes": soft,
        "fdb_logical_hard_bytes": hard,
        "cold_region": region,
        "cold_endpoint": f"https://cos.{region}.myqcloud.com",
    }, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
