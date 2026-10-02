#!/usr/bin/env python3
"""Idempotently provision ordinary or dedicated Beijing COS qualification buckets."""

import argparse
import json
import os
import re

from qcloud_cos import CosConfig, CosS3Client, CosServiceError


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--appid", required=True)
    parser.add_argument(
        "--backup-restore-qualification-bucket",
        help="Provision one empty-by-contract bucket dedicated to the physical restore gate",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    if not re.fullmatch(r"[0-9]+", args.appid):
        raise SystemExit("--appid must be numeric")
    secret_id = os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not secret_id or not secret_key:
        raise SystemExit("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be injected")

    client = CosS3Client(
        CosConfig(
            Region="ap-beijing",
            SecretId=secret_id,
            SecretKey=secret_key,
            Scheme="https",
        )
    )
    if args.backup_restore_qualification_bucket:
        bucket = args.backup_restore_qualification_bucket
        if (
            not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket)
            or "backup-restore" not in bucket
            or "qualification" not in bucket
            or not bucket.endswith(f"-{args.appid}")
        ):
            raise SystemExit(
                "dedicated bucket must contain backup-restore and qualification and end in --appid"
            )
        buckets = [bucket]
    else:
        buckets = [
            f"actor-depot-cold-dev-bj-local-{suffix}-{args.appid}"
            for suffix in ("a", "b")
        ]

    for bucket in buckets:
        try:
            client.head_bucket(Bucket=bucket)
            created = False
        except CosServiceError as error:
            if error.get_status_code() != 404:
                raise
            client.create_bucket(Bucket=bucket, ACL="private")
            created = True
        client.put_bucket_encryption(
            Bucket=bucket,
            ServerSideEncryptionConfiguration={
                "Rule": {
                    "ApplyServerSideEncryptionByDefault": {
                        "SSEAlgorithm": "AES256"
                    }
                }
            },
        )
        location = client.get_bucket_location(Bucket=bucket).get("LocationConstraint")
        versioning = client.get_bucket_versioning(Bucket=bucket).get(
            "VersioningConfiguration"
        )
        encryption = client.get_bucket_encryption(Bucket=bucket)
        algorithm = encryption["Rule"][0]["ApplyServerSideEncryptionByDefault"][
            "SSEAlgorithm"
        ]
        if location != "ap-beijing" or versioning is not None or algorithm != "AES256":
            raise RuntimeError(f"{bucket} does not satisfy the local COS contract")
        print(
            json.dumps(
                {
                    "bucket": bucket,
                    "created": created,
                    "location": location,
                    "versioning": "NeverEnabled",
                    "default_encryption": algorithm,
                }
            )
        )


if __name__ == "__main__":
    main()
