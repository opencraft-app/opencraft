#!/usr/bin/env python3
"""Fail-closed verification for fresh Beijing COS buckets with no versioning.

Run on the Beijing qualification host. Credentials are read by the AWS CLI
from its environment/credential provider chain and are never accepted as this
script's arguments or copied into the receipt.
"""

import argparse
import json
import os
import pathlib
import re
import subprocess
from typing import Any, Dict


BUCKET_PATTERN = re.compile(
    r"^actor-(?:depot-cold|fdb-backup)-prod-bj-[a-z][0-9]{2}-nv[0-9]+-[0-9]+$"
)


def aws_json(args: argparse.Namespace, operation: str, bucket: str) -> Dict[str, Any]:
    result = subprocess.run(
        [
            args.aws,
            "--region",
            "ap-beijing",
            "--endpoint-url",
            args.endpoint,
            "s3api",
            operation,
            "--bucket",
            bucket,
            "--output",
            "json",
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        timeout=args.timeout_seconds,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "COS {} failed for {}: {}".format(
                operation, bucket, result.stderr[-2000:]
            )
        )
    try:
        return json.loads(result.stdout or "{}")
    except json.JSONDecodeError as error:
        raise RuntimeError("COS {} returned malformed JSON".format(operation)) from error


def validate_bucket_documents(
    bucket: str,
    location: Dict[str, Any],
    versioning: Dict[str, Any],
    encryption: Dict[str, Any],
) -> Dict[str, Any]:
    if not BUCKET_PATTERN.fullmatch(bucket):
        raise ValueError("bucket does not use the fresh Beijing no-versioning name contract")
    if location.get("LocationConstraint") != "ap-beijing":
        raise RuntimeError("bucket is not in ap-beijing")
    # S3/COS returns an empty versioning document only when versioning has never
    # been configured. Enabled and Suspended both carry a Status and are rejected.
    if versioning:
        raise RuntimeError(
            "bucket versioning is not NeverEnabled: {}".format(versioning.get("Status"))
        )
    rules = encryption.get("ServerSideEncryptionConfiguration", {}).get("Rules")
    algorithms = []
    if isinstance(rules, list):
        for rule in rules:
            default = rule.get("ApplyServerSideEncryptionByDefault", {})
            algorithm = default.get("SSEAlgorithm")
            if isinstance(algorithm, str):
                algorithms.append(algorithm)
    if "AES256" not in algorithms:
        raise RuntimeError("bucket does not report default SSE-COS AES256 encryption")
    return {
        "bucket": bucket,
        "region": "ap-beijing",
        "versioning": "NeverEnabled",
        "default_encryption": "AES256",
    }


def run(args: argparse.Namespace) -> Dict[str, Any]:
    actual_cell = args.execution_site_file.read_text().strip()
    if actual_cell != args.cell_id or not args.cell_id.startswith("actor-bj-"):
        raise ValueError("COS verification must run on the matching Beijing Cell")
    if args.cold_bucket == args.backup_bucket:
        raise ValueError("cold and backup buckets must be distinct")
    buckets = []
    for bucket in (args.cold_bucket, args.backup_bucket):
        buckets.append(
            validate_bucket_documents(
                bucket,
                aws_json(args, "get-bucket-location", bucket),
                aws_json(args, "get-bucket-versioning", bucket),
                aws_json(args, "get-bucket-encryption", bucket),
            )
        )
    return {
        "verdict": "passed",
        "cell_id": args.cell_id,
        "endpoint": args.endpoint,
        "buckets": buckets,
        "multi_az_contract": (
            "fresh ordinary buckets created by Terraform with multi_az=false; never import an "
            "older bucket into these resource addresses"
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cell-id", required=True)
    parser.add_argument("--execution-site-file", type=pathlib.Path, required=True)
    parser.add_argument("--cold-bucket", required=True)
    parser.add_argument("--backup-bucket", required=True)
    parser.add_argument("--endpoint", default="https://cos.ap-beijing.myqcloud.com")
    parser.add_argument("--aws", default="aws")
    parser.add_argument("--timeout-seconds", type=float, default=30)
    parser.add_argument("--output", type=pathlib.Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = run(args)
    encoded = json.dumps(result, indent=2, sort_keys=True)
    print(encoded)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(encoded + "\n")
        os.replace(str(temporary), str(args.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
