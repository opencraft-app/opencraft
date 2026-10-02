#!/usr/bin/env python3
"""Run one Beijing qualification command and seal its production identity receipt.

The child command's argv is hashed but never copied into the receipt. This keeps
environment-variable credential names and future sensitive arguments out of the
artifact while binding results to the exact invocation, release artifacts, Cell,
FDB cluster file, and both COS buckets.
"""

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time
from typing import Any, Dict, List


SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
BUCKET_PATTERN = re.compile(
    r"^actor-(?:depot-cold|fdb-backup)-prod-bj-[a-z][0-9]{2}-nv[0-9]+-[0-9]+$"
)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_release_manifest(path: pathlib.Path, cell_id: str) -> Dict[str, Any]:
    raw = path.read_bytes()
    document = json.loads(raw)
    if document.get("schema_version") != 1 or document.get("cell_id") != cell_id:
        raise ValueError("release manifest does not belong to the requested Cell")
    artifacts = document.get("artifacts")
    required = ("workerd_sha256", "workerd_host_sha256", "engine_sha256")
    if not isinstance(artifacts, dict) or any(
        not SHA256_PATTERN.fullmatch(str(artifacts.get(name, "")))
        for name in required
    ):
        raise ValueError("release manifest has invalid artifact SHA-256 values")
    release_id = document.get("release_id")
    if not isinstance(release_id, str) or not release_id:
        raise ValueError("release manifest has no release_id")
    return {
        "path": str(path.resolve()),
        "manifest_sha256": sha256_bytes(raw),
        "release_id": release_id,
        "artifacts": {name: artifacts[name] for name in required},
        "runtime_role": document.get("runtime_role"),
        "runner_pool_name": document.get("runner_pool_name"),
    }


def validate_site(cell_id: str, site_file: pathlib.Path) -> None:
    actual = site_file.read_text().strip()
    if actual != cell_id or not cell_id.startswith("actor-bj-"):
        raise ValueError("qualification receipt must run on the matching Beijing Cell")


def read_cos_verification(
    path: pathlib.Path, cell_id: str, cold_bucket: str, backup_bucket: str
) -> Dict[str, Any]:
    raw = path.read_bytes()
    document = json.loads(raw)
    if document.get("verdict") != "passed" or document.get("cell_id") != cell_id:
        raise ValueError("COS no-versioning receipt is not a passed receipt for this Cell")
    buckets = document.get("buckets")
    if not isinstance(buckets, list):
        raise ValueError("COS no-versioning receipt has no bucket proofs")
    proofs = {
        item.get("bucket"): item
        for item in buckets
        if isinstance(item, dict) and isinstance(item.get("bucket"), str)
    }
    if set(proofs) != {cold_bucket, backup_bucket} or any(
        proof.get("region") != "ap-beijing"
        or proof.get("versioning") != "NeverEnabled"
        or proof.get("default_encryption") != "AES256"
        for proof in proofs.values()
    ):
        raise ValueError("COS no-versioning receipt does not prove the exact production buckets")
    return {"path": str(path.resolve()), "receipt_sha256": sha256_bytes(raw)}


def command_receipt(command: List[str]) -> Dict[str, Any]:
    encoded = json.dumps(command, separators=(",", ":")).encode("utf-8")
    return {
        "executable": pathlib.Path(command[0]).name,
        "argument_count": len(command) - 1,
        "argv_sha256": sha256_bytes(encoded),
    }


def run(args: argparse.Namespace) -> Dict[str, Any]:
    validate_site(args.cell_id, args.execution_site_file)
    if not BUCKET_PATTERN.fullmatch(args.cold_bucket):
        raise ValueError("cold bucket violates the fresh no-versioning name contract")
    if not BUCKET_PATTERN.fullmatch(args.backup_bucket):
        raise ValueError("backup bucket violates the fresh no-versioning name contract")
    if args.cold_bucket == args.backup_bucket:
        raise ValueError("cold and backup buckets must be distinct")
    command = list(args.command)
    if command and command[0] == "--":
        command.pop(0)
    if not command:
        raise ValueError("qualification command is empty")

    release = read_release_manifest(args.release_manifest, args.cell_id)
    cos_verification = read_cos_verification(
        args.cos_verification_receipt,
        args.cell_id,
        args.cold_bucket,
        args.backup_bucket,
    )
    cluster_file = getattr(args, "cluster_file", None)
    cluster_identity = getattr(args, "cluster_identity_sha256", None)
    if cluster_file is not None:
        cluster_raw = cluster_file.read_bytes()
        cluster_text = cluster_raw.decode("utf-8").strip()
        if "@" not in cluster_text or ":" not in cluster_text.split("@", 1)[0]:
            raise ValueError("FDB cluster file is malformed")
        cluster_proof = {
            "cluster_file": str(cluster_file.resolve()),
            "cluster_identity_sha256": sha256_bytes(cluster_raw),
            "identity_source": "local-cluster-file",
        }
    else:
        if not SHA256_PATTERN.fullmatch(str(cluster_identity or "")):
            raise ValueError("cluster-identity-sha256 must be 64 lowercase hex digits")
        cluster_proof = {
            "cluster_identity_sha256": cluster_identity,
            "identity_source": "trusted-primary-receipt",
        }

    started_wall = datetime.datetime.now(datetime.timezone.utc)
    started = time.monotonic()
    child = subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )
    ended_wall = datetime.datetime.now(datetime.timezone.utc)
    if child.returncode != 0:
        raise RuntimeError(
            "qualification command {} exited {}: {}".format(
                pathlib.Path(command[0]).name,
                child.returncode,
                child.stderr[-4000:],
            )
        )
    try:
        result = json.loads(child.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("qualification command did not return one JSON document") from error
    if not isinstance(result, dict) or result.get("verdict") != "passed":
        raise RuntimeError("qualification child result is not a passed receipt")

    receipt = {
        "schema_version": 1,
        "verdict": "passed",
        "cell_id": args.cell_id,
        "region": "ap-beijing",
        "started_at": started_wall.isoformat(),
        "ended_at": ended_wall.isoformat(),
        "duration_seconds": time.monotonic() - started,
        "release": release,
        "foundationdb": cluster_proof,
        "cos": {
            "cold_bucket": args.cold_bucket,
            "backup_bucket": args.backup_bucket,
            "versioning_contract": "NeverEnabled; proven by separate remote API receipt",
            "verification": cos_verification,
        },
        "command": command_receipt(command),
        "result": result,
    }
    canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode("utf-8")
    receipt["receipt_sha256"] = sha256_bytes(canonical)
    return receipt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cell-id", required=True)
    parser.add_argument("--execution-site-file", type=pathlib.Path, required=True)
    parser.add_argument("--release-manifest", type=pathlib.Path, required=True)
    cluster = parser.add_mutually_exclusive_group(required=True)
    cluster.add_argument("--cluster-file", type=pathlib.Path)
    cluster.add_argument("--cluster-identity-sha256")
    parser.add_argument("--cos-verification-receipt", type=pathlib.Path, required=True)
    parser.add_argument("--cold-bucket", required=True)
    parser.add_argument("--backup-bucket", required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    receipt = run(args)
    encoded = json.dumps(receipt, indent=2, sort_keys=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(encoded + "\n")
    os.replace(str(temporary), str(args.output))
    print(encoded)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
