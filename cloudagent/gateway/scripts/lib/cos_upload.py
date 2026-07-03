#!/usr/bin/env python3
"""Small COS uploader used by CloudAgent release scripts.

The release scripts still own artifact naming, signing, registry generation, and
public URL checks. This helper only wraps COS data-plane operations so CI does
not depend on coscmd's long-running upload behavior.
"""

from __future__ import annotations

import argparse
import configparser
import os
import sys
from dataclasses import dataclass
from typing import Optional

try:
    from qcloud_cos import CosClientError, CosConfig, CosS3Client, CosServiceError
except Exception as exc:  # pragma: no cover - depends on CI venv installation.
    print(f"missing qcloud_cos SDK: {exc}", file=sys.stderr)
    sys.exit(2)


@dataclass(frozen=True)
class CosSettings:
    bucket: str
    region: str
    secret_id: str
    secret_key: str
    scheme: str
    timeout: int
    max_thread: int
    part_size: int


def _read_config(path: str) -> CosSettings:
    parser = configparser.ConfigParser()
    if not parser.read(path):
        raise RuntimeError(f"failed to read COS config: {path}")
    section = parser["common"]

    def required(name: str) -> str:
        value = section.get(name, fallback="").strip()
        if not value:
            raise RuntimeError(f"missing COS config key: {name}")
        return value

    def int_value(name: str, default: int) -> int:
        raw = section.get(name, fallback=str(default)).strip()
        try:
            value = int(raw)
        except ValueError as exc:
            raise RuntimeError(f"invalid integer COS config key {name}: {raw}") from exc
        return value

    return CosSettings(
        bucket=required("bucket"),
        region=required("region"),
        secret_id=required("secret_id"),
        secret_key=required("secret_key"),
        scheme=section.get("schema", fallback="https").strip() or "https",
        timeout=int_value("timeout", 600),
        max_thread=max(1, int_value("max_thread", 4)),
        part_size=max(1, int_value("part_size", 8)),
    )


def _object_key(value: str) -> str:
    return value.lstrip("/")


def _client(settings: CosSettings) -> CosS3Client:
    config = CosConfig(
        Region=settings.region,
        SecretId=settings.secret_id,
        SecretKey=settings.secret_key,
        Scheme=settings.scheme,
        Timeout=settings.timeout,
        PoolConnections=max(10, settings.max_thread),
        PoolMaxSize=max(10, settings.max_thread),
    )
    return CosS3Client(config)


def _is_not_found(exc: CosServiceError) -> bool:
    status = str(exc.get_status_code())
    code = ""
    try:
        code = str(exc.get_error_code())
    except Exception:
        pass
    return status == "404" or code in {"NoSuchResource", "NoSuchKey", "NotFound"}


def _size(client: CosS3Client, settings: CosSettings, key: str) -> Optional[int]:
    try:
        head = client.head_object(Bucket=settings.bucket, Key=key)
    except CosServiceError as exc:
        if _is_not_found(exc):
            return None
        raise
    raw = head.get("Content-Length") or head.get("content-length")
    if raw is None:
        raise RuntimeError(f"COS HEAD did not include Content-Length object={key}")
    return int(raw)


def _cmd_size(client: CosS3Client, settings: CosSettings, args: argparse.Namespace) -> int:
    size = _size(client, settings, _object_key(args.object))
    if size is not None:
        print(size)
    return 0


def _cmd_upload(client: CosS3Client, settings: CosSettings, args: argparse.Namespace) -> int:
    key = _object_key(args.object)
    local_path = args.local_path
    size = os.path.getsize(local_path)
    print(
        "[cos-upload] upload start "
        f"object={key} size={size} part_size_mb={settings.part_size} max_thread={settings.max_thread}",
        file=sys.stderr,
    )
    client.upload_file(
        Bucket=settings.bucket,
        Key=key,
        LocalFilePath=local_path,
        PartSize=settings.part_size,
        MAXThread=settings.max_thread,
    )
    remote_size = _size(client, settings, key)
    if remote_size != size:
        raise RuntimeError(f"COS upload size mismatch object={key} local={size} remote={remote_size}")
    print(f"[cos-upload] upload done object={key} size={size}", file=sys.stderr)
    return 0


def _cmd_acl(client: CosS3Client, settings: CosSettings, args: argparse.Namespace) -> int:
    key = _object_key(args.object)
    client.put_object_acl(Bucket=settings.bucket, Key=key, ACL="public-read")
    print(f"[cos-upload] public-read set object={key}", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CloudAgent COS release helper")
    parser.add_argument("--config", required=True, help="coscmd-compatible config file")
    subparsers = parser.add_subparsers(dest="command", required=True)

    size_parser = subparsers.add_parser("size")
    size_parser.add_argument("object")

    upload_parser = subparsers.add_parser("upload")
    upload_parser.add_argument("local_path")
    upload_parser.add_argument("object")

    acl_parser = subparsers.add_parser("public-read")
    acl_parser.add_argument("object")

    args = parser.parse_args(argv)
    try:
        settings = _read_config(args.config)
        client = _client(settings)
        if args.command == "size":
            return _cmd_size(client, settings, args)
        if args.command == "upload":
            return _cmd_upload(client, settings, args)
        if args.command == "public-read":
            return _cmd_acl(client, settings, args)
        raise RuntimeError(f"unsupported command: {args.command}")
    except (CosClientError, CosServiceError, OSError, RuntimeError) as exc:
        print(f"cos helper failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
