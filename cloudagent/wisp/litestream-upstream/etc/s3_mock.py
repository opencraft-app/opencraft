#!/usr/bin/env python3
import sys
import os
import time
from moto.server import ThreadedMotoServer
import boto3
import subprocess


def validate_command(command):
    if not command:
        print(f"usage: {sys.argv[0]} <command> [arguments]", file=sys.stderr)
        sys.exit(1)
    if not all(isinstance(part, str) and part for part in command):
        raise ValueError("command must be a list of non-empty strings")
    if any("\x00" in part for part in command):
        raise ValueError("command arguments must not contain NUL bytes")
    return command


cmd = validate_command(sys.argv[1:])

env = os.environ.copy() | {
    "LITESTREAM_S3_ACCESS_KEY_ID": "lite",
    "LITESTREAM_S3_SECRET_ACCESS_KEY": "stream",
    "LITESTREAM_S3_BUCKET": f"test{int(time.time())}",
    "LITESTREAM_S3_ENDPOINT": "http://127.0.0.1:5000",
    "LITESTREAM_S3_FORCE_PATH_STYLE": "true",
}

server = ThreadedMotoServer()
server.start()

s3 = boto3.client(
    "s3",
    aws_access_key_id=env["LITESTREAM_S3_ACCESS_KEY_ID"],
    aws_secret_access_key=env["LITESTREAM_S3_SECRET_ACCESS_KEY"],
    endpoint_url=env["LITESTREAM_S3_ENDPOINT"]
).create_bucket(Bucket=env["LITESTREAM_S3_BUCKET"])

# This developer test helper intentionally runs the caller-supplied litestream command
# with an isolated moto S3 environment.
proc = subprocess.run(cmd, env=env)  # nosemgrep: dangerous-subprocess-use-audit

server.stop()
sys.exit(proc.returncode)
